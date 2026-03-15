import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { NotFoundError, AppError } from '../../lib/errors';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';
import { waService } from '../whatsapp/whatsapp.service';

interface CreateTemplateInput {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language?: string;
  header?: { type: string; value?: string };
  body: string;
  footer?: string;
  buttons?: unknown[];
  variables?: { key: string; example: string }[];
}

export class TemplatesService {
  async list(tenantId: string, page: unknown, limit: unknown, status?: string) {
    const params = getPaginationParams(page, limit);
    const where: Prisma.TemplateWhereInput = { tenant_id: tenantId };
    if (status) where.status = status as 'DRAFT';

    const [templates, total] = await Promise.all([
      prisma.template.findMany({
        where,
        skip: params.skip,
        take: params.limit,
        orderBy: { created_at: 'desc' },
      }),
      prisma.template.count({ where }),
    ]);

    return { templates, pagination: buildPaginationMeta(total, params) };
  }

  async getById(tenantId: string, id: string) {
    const template = await prisma.template.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!template) throw new NotFoundError('Template');
    return template;
  }

  async create(tenantId: string, input: CreateTemplateInput) {
    return prisma.template.create({
      data: {
        tenant_id: tenantId,
        name: input.name,
        category: input.category,
        language: input.language ?? 'en',
        header: input.header ?? Prisma.JsonNull,
        body: input.body,
        footer: input.footer,
        buttons: input.buttons ? input.buttons : Prisma.JsonNull,
        variables: input.variables ? input.variables : Prisma.JsonNull,
        status: 'DRAFT',
      },
    });
  }

  async update(tenantId: string, id: string, input: Partial<CreateTemplateInput>) {
    const template = await prisma.template.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!template) throw new NotFoundError('Template');
    if (template.status === 'PENDING_APPROVAL') {
      throw new AppError('Cannot edit a template that is pending approval', 400);
    }

    return prisma.template.update({
      where: { id },
      data: {
        ...input,
        status: 'DRAFT', // editing resets to draft
        wa_template_id: null,
        rejection_reason: null,
      },
    });
  }

  async delete(tenantId: string, id: string) {
    const template = await prisma.template.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!template) throw new NotFoundError('Template');

    // Check if used by active broadcasts
    const activeBroadcast = await prisma.broadcast.findFirst({
      where: { template_id: id, status: { in: ['RUNNING', 'SCHEDULED'] } },
    });
    if (activeBroadcast) {
      throw new AppError('Cannot delete a template used by an active broadcast', 400);
    }

    await prisma.template.delete({ where: { id } });
  }

  /**
   * Submit template to Meta for approval.
   * Builds the WA API payload from our stored template format.
   */
  async submitForApproval(tenantId: string, id: string) {
    const template = await prisma.template.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!template) throw new NotFoundError('Template');
    if (template.status === 'APPROVED') {
      throw new AppError('Template is already approved', 400);
    }

    const waTemplateId = await waService.submitTemplate(tenantId, template);

    return prisma.template.update({
      where: { id },
      data: {
        status: 'PENDING_APPROVAL',
        wa_template_id: waTemplateId,
      },
    });
  }

  async syncStatusFromWebhook(waTemplateId: string, status: string, reason?: string) {
    const template = await prisma.template.findFirst({
      where: { wa_template_id: waTemplateId },
    });
    if (!template) return;

    const mappedStatus =
      status === 'APPROVED'
        ? 'APPROVED'
        : status === 'REJECTED'
        ? 'REJECTED'
        : 'PENDING_APPROVAL';

    await prisma.template.update({
      where: { id: template.id },
      data: { status: mappedStatus, rejection_reason: reason ?? null },
    });
  }
}

export const templatesService = new TemplatesService();
