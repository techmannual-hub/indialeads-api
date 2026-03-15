import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { Template } from '@prisma/client';
import { env } from '../../config/env';
import { tenantService } from '../tenant/tenant.service';
import { AppError } from '../../lib/errors';
import { phoneToWaFormat } from '../../lib/phone';
import {
  WaMessagePayload,
  WaTemplateMessage,
  WaTemplateComponent,
} from '../../types';

interface WaSendResponse {
  messages: { id: string }[];
  contacts: { input: string; wa_id: string }[];
}

export class WhatsAppService {
  private _getClient(accessToken: string): AxiosInstance {
    return axios.create({
      baseURL: `${env.WA_BASE_URL}/${env.WA_API_VERSION}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
  }

  private async _getCredentials(tenantId: string) {
    const tenant = await tenantService.getProfile(tenantId) as {
      phone_number_id?: string;
      wa_configured?: boolean;
    };
    if (!tenant.wa_configured || !tenant.phone_number_id) {
      throw new AppError('WhatsApp is not configured for this account', 400);
    }
    const accessToken = await tenantService.getDecryptedAccessToken(tenantId);
    return { phoneNumberId: tenant.phone_number_id, accessToken };
  }

  // ─── Core send ─────────────────────────────────────────────────────────────

  async sendMessage(
    tenantId: string,
    to: string,
    payload: WaMessagePayload
  ): Promise<string> {
    const { phoneNumberId, accessToken } = await this._getCredentials(tenantId);
    return this.sendMessageDirect(phoneNumberId, accessToken, to, payload);
  }

  /**
   * Direct send — accepts pre-decrypted credentials.
   * Used by queue workers to avoid repeated DB lookups.
   */
  async sendMessageDirect(
    phoneNumberId: string,
    accessToken: string,
    to: string,
    payload: WaMessagePayload
  ): Promise<string> {
    const client = this._getClient(accessToken);
    const waTo = phoneToWaFormat(to);

    try {
      const response = await client.post<WaSendResponse>(
        `/${phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to: waTo, ...payload }
      );
      return response.data.messages[0].id;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const detail = err.response?.data?.error?.message ?? err.message;
        throw new AppError(`WhatsApp API error: ${detail}`, 502);
      }
      throw err;
    }
  }

  // ─── Message type helpers ──────────────────────────────────────────────────

  async sendText(tenantId: string, to: string, text: string): Promise<string> {
    return this.sendMessage(tenantId, to, {
      type: 'text',
      text: { body: text, preview_url: false },
    });
  }

  async sendTemplateMessage(
    tenantId: string,
    to: string,
    template: Template,
    variableValues?: Record<string, string>
  ): Promise<string> {
    if (!template.wa_template_id && !template.name) {
      throw new AppError('Template has no WhatsApp template name', 400);
    }

    const components: WaTemplateComponent[] = [];
    const variables = (template.variables ?? []) as { key: string; example: string }[];

    if (variables.length > 0 && variableValues) {
      components.push({
        type: 'body',
        parameters: variables.map((v) => ({
          type: 'text',
          text: variableValues[v.key] ?? v.example,
        })),
      });
    }

    const payload: WaTemplateMessage = {
      type: 'template',
      template: {
        name: template.name.toLowerCase().replace(/\s+/g, '_'),
        language: { code: template.language },
        ...(components.length > 0 && { components }),
      },
    };

    return this.sendMessage(tenantId, to, payload);
  }

  async sendImage(
    tenantId: string,
    to: string,
    mediaId: string,
    caption?: string
  ): Promise<string> {
    return this.sendMessage(tenantId, to, {
      type: 'image',
      image: { id: mediaId, ...(caption && { caption }) },
    });
  }

  async sendDocument(
    tenantId: string,
    to: string,
    mediaId: string,
    filename: string,
    caption?: string
  ): Promise<string> {
    return this.sendMessage(tenantId, to, {
      type: 'document',
      document: { id: mediaId, filename, ...(caption && { caption }) },
    });
  }

  async sendInteractiveButtons(
    tenantId: string,
    to: string,
    bodyText: string,
    buttons: { id: string; title: string }[]
  ): Promise<string> {
    return this.sendMessage(tenantId, to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    });
  }

  async sendCatalogProduct(
    tenantId: string,
    to: string,
    catalogId: string,
    productRetailerId: string,
    bodyText?: string
  ): Promise<string> {
    return this.sendMessage(tenantId, to, {
      type: 'interactive',
      interactive: {
        type: 'product',
        body: { text: bodyText ?? 'Check out this product' },
        action: {
          catalog_id: catalogId,
          product_retailer_id: productRetailerId,
        },
      },
    });
  }

  // ─── Media upload ──────────────────────────────────────────────────────────

  /**
   * Upload media buffer to WhatsApp Media API.
   * Returns wa_media_id for use in messages.
   */
  async uploadMedia(
    tenantId: string,
    buffer: Buffer,
    filename: string,
    mimeType: string
  ): Promise<string> {
    const { phoneNumberId, accessToken } = await this._getCredentials(tenantId);
    const client = this._getClient(accessToken);

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { filename, contentType: mimeType });
    form.append('type', mimeType);

    try {
      const response = await client.post<{ id: string }>(
        `/${phoneNumberId}/media`,
        form,
        { headers: form.getHeaders() }
      );
      return response.data.id;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const detail = err.response?.data?.error?.message ?? err.message;
        throw new AppError(`WhatsApp media upload error: ${detail}`, 502);
      }
      throw err;
    }
  }

  // ─── Template submission ───────────────────────────────────────────────────

  async submitTemplate(tenantId: string, template: Template): Promise<string> {
    const { accessToken } = await this._getCredentials(tenantId);

    // Get WA business account ID
    const tenantRecord = await tenantService.getProfile(tenantId) as { wa_business_id?: string };
    if (!tenantRecord.wa_business_id) {
      throw new AppError('WhatsApp Business Account ID not configured', 400);
    }

    const client = this._getClient(accessToken);
    const components: unknown[] = [];

    // Build header component
    const header = template.header as { type?: string; value?: string } | null;
    if (header?.type) {
      const comp: Record<string, unknown> = { type: 'HEADER', format: header.type };
      if (header.type === 'TEXT' && header.value) {
        comp.text = header.value;
        comp.example = { header_text: [header.value] };
      }
      components.push(comp);
    }

    // Body
    const variables = (template.variables ?? []) as { key: string; example: string }[];
    const bodyComp: Record<string, unknown> = { type: 'BODY', text: template.body };
    if (variables.length > 0) {
      bodyComp.example = { body_text: [variables.map((v) => v.example)] };
    }
    components.push(bodyComp);

    // Footer
    if (template.footer) {
      components.push({ type: 'FOOTER', text: template.footer });
    }

    // Buttons
    const buttons = template.buttons as unknown[];
    if (buttons && buttons.length > 0) {
      components.push({ type: 'BUTTONS', buttons });
    }

    try {
      const response = await client.post<{ id: string }>(
        `/${tenantRecord.wa_business_id}/message_templates`,
        {
          name: template.name.toLowerCase().replace(/\s+/g, '_'),
          language: template.language,
          category: template.category,
          components,
        }
      );
      return response.data.id;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const detail = err.response?.data?.error?.message ?? err.message;
        throw new AppError(`Template submission error: ${detail}`, 502);
      }
      throw err;
    }
  }
}

export const waService = new WhatsAppService();
