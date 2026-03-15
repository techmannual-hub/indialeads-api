import prisma from '../../config/database';
import { encrypt, decrypt } from '../../lib/encryption';
import { AppError } from '../../lib/errors';
import { Tenant } from '@prisma/client';

export class TenantService {
  async getProfile(tenantId: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { license: true },
    });
    if (!tenant) throw new AppError('Tenant not found', 404);
    return this._sanitize(tenant);
  }

  async updateProfile(tenantId: string, data: { name?: string }) {
    const tenant = await prisma.tenant.update({
      where: { id: tenantId },
      data,
    });
    return this._sanitize(tenant);
  }

  async updateWaSettings(
    tenantId: string,
    data: {
      phone_number_id: string;
      wa_business_id: string;
      wa_access_token: string;
      wa_webhook_secret: string;
    }
  ) {
    const encrypted_token = encrypt(data.wa_access_token);

    const tenant = await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        phone_number_id: data.phone_number_id,
        wa_business_id: data.wa_business_id,
        wa_access_token: encrypted_token,
        wa_webhook_secret: data.wa_webhook_secret,
        waba_verified: false, // reset; re-verify after update
      },
    });
    return this._sanitize(tenant);
  }

  async getDecryptedAccessToken(tenantId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { wa_access_token: true },
    });
    if (!tenant?.wa_access_token) {
      throw new AppError('WhatsApp is not configured for this account', 400);
    }
    return decrypt(tenant.wa_access_token);
  }

  async markWabaVerified(tenantId: string) {
    return prisma.tenant.update({
      where: { id: tenantId },
      data: { waba_verified: true },
    });
  }

  async advanceOnboarding(tenantId: string, step: number) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new AppError('Tenant not found', 404);

    const newStep = Math.max(tenant.onboarding_step, step);
    const done = newStep >= 5; // 5 steps total

    return prisma.tenant.update({
      where: { id: tenantId },
      data: { onboarding_step: newStep, onboarding_done: done },
    });
  }

  async getStats(tenantId: string) {
    const [leads, conversations, broadcasts] = await Promise.all([
      prisma.lead.groupBy({
        by: ['status'],
        where: { tenant_id: tenantId },
        _count: true,
      }),
      prisma.conversation.count({
        where: { tenant_id: tenantId, status: 'OPEN' },
      }),
      prisma.broadcast.count({
        where: { tenant_id: tenantId, status: 'COMPLETED' },
      }),
    ]);

    const leadCounts = Object.fromEntries(
      leads.map((l) => [l.status.toLowerCase(), l._count])
    );

    return {
      leads: leadCounts,
      open_conversations: conversations,
      completed_broadcasts: broadcasts,
    };
  }

  async resetDailyMessageCount(tenantId: string) {
    return prisma.tenant.update({
      where: { id: tenantId },
      data: { messages_sent_today: 0, messages_reset_at: new Date() },
    });
  }

  async incrementMessageCount(tenantId: string, count = 1) {
    return prisma.tenant.update({
      where: { id: tenantId },
      data: { messages_sent_today: { increment: count } },
    });
  }

  async checkDailyLimit(tenantId: string): Promise<{ allowed: boolean; remaining: number }> {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { daily_message_limit: true, messages_sent_today: true, messages_reset_at: true },
    });
    if (!tenant) throw new AppError('Tenant not found', 404);

    // Reset if it's a new day
    const resetDate = new Date(tenant.messages_reset_at);
    const now = new Date();
    if (
      resetDate.getDate() !== now.getDate() ||
      resetDate.getMonth() !== now.getMonth() ||
      resetDate.getFullYear() !== now.getFullYear()
    ) {
      await this.resetDailyMessageCount(tenantId);
      return { allowed: true, remaining: tenant.daily_message_limit };
    }

    const remaining = tenant.daily_message_limit - tenant.messages_sent_today;
    return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
  }

  private _sanitize(tenant: Tenant & Record<string, unknown>) {
    // Never expose encrypted token or webhook secret
    const { wa_access_token, wa_webhook_secret, ...safe } = tenant as Tenant & {
      wa_access_token: unknown;
      wa_webhook_secret: unknown;
    };
    void wa_access_token;
    void wa_webhook_secret;
    return {
      ...safe,
      wa_configured: !!(tenant.phone_number_id && tenant.wa_access_token),
    };
  }
}

export const tenantService = new TenantService();
