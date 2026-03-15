import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../../config/database';
import { AppError, asyncHandler } from '../../lib/errors';
import { success } from '../../lib/response';

// ── Service ───────────────────────────────────────────────────────────────────

class LicenseService {
  async getForTenant(tenantId: string) {
    return prisma.license.findUnique({
      where: { tenant_id: tenantId },
    });
  }

  /**
   * Validate that the tenant's license permits an action.
   * Throws if the license is expired, suspended, or over limit.
   */
  async validate(tenantId: string): Promise<{ valid: boolean; reason?: string }> {
    const license = await this.getForTenant(tenantId);

    if (!license) {
      return { valid: false, reason: 'No license found for this account' };
    }

    if (license.status === 'SUSPENDED') {
      return { valid: false, reason: 'Your account has been suspended' };
    }

    if (license.status === 'EXPIRED') {
      return { valid: false, reason: 'Your license has expired. Please renew.' };
    }

    if (license.expires_at && license.expires_at < new Date()) {
      // Auto-expire
      await prisma.license.update({
        where: { id: license.id },
        data: { status: 'EXPIRED' },
      });
      return { valid: false, reason: 'Your license has expired. Please renew.' };
    }

    return { valid: true };
  }

  async checkLeadLimit(tenantId: string): Promise<{ allowed: boolean; current: number; max: number }> {
    const [license, leadCount] = await Promise.all([
      this.getForTenant(tenantId),
      prisma.lead.count({ where: { tenant_id: tenantId } }),
    ]);

    const max = license?.max_leads ?? 500;
    return { allowed: leadCount < max, current: leadCount, max };
  }

  async checkMessageLimit(tenantId: string): Promise<{ allowed: boolean; current: number; max: number }> {
    const license = await this.getForTenant(tenantId);
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { messages_sent_today: true },
    });

    const max = license?.max_messages ?? 200;
    const current = tenant?.messages_sent_today ?? 0;
    return { allowed: current < max, current, max };
  }

  async activateLicense(tenantId: string, licenseKey: string) {
    // Find the license by key
    const license = await prisma.license.findUnique({ where: { license_key: licenseKey } });

    if (!license) throw new AppError('Invalid license key', 400);
    if (license.tenant_id !== tenantId) throw new AppError('License key belongs to another account', 403);
    if (license.status === 'ACTIVE') throw new AppError('License is already active', 400);
    if (license.status === 'SUSPENDED') throw new AppError('This license has been suspended', 403);

    return prisma.license.update({
      where: { id: license.id },
      data: { status: 'ACTIVE', activated_at: new Date() },
    });
  }

  /**
   * Generate a new license key for a tenant (admin use / upgrade flow).
   * In production this would be called by a payment webhook.
   */
  async generateLicense(
    tenantId: string,
    plan: 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE',
    expiresAt?: Date
  ) {
    const planLimits = {
      FREE:       { max_leads: 500,    max_messages: 200  },
      STARTER:    { max_leads: 5000,   max_messages: 1000 },
      GROWTH:     { max_leads: 25000,  max_messages: 5000 },
      ENTERPRISE: { max_leads: 999999, max_messages: 10000 },
    };

    const limits = planLimits[plan];
    const licenseKey = [
      plan.toUpperCase(),
      crypto.randomBytes(4).toString('hex').toUpperCase(),
      crypto.randomBytes(4).toString('hex').toUpperCase(),
      crypto.randomBytes(4).toString('hex').toUpperCase(),
    ].join('-');

    // Upsert: replace existing license for tenant
    const existing = await prisma.license.findUnique({ where: { tenant_id: tenantId } });

    if (existing) {
      return prisma.license.update({
        where: { tenant_id: tenantId },
        data: {
          license_key: licenseKey,
          plan,
          status: 'ACTIVE',
          max_leads: limits.max_leads,
          max_messages: limits.max_messages,
          expires_at: expiresAt ?? null,
          activated_at: new Date(),
        },
      });
    }

    return prisma.license.create({
      data: {
        tenant_id: tenantId,
        license_key: licenseKey,
        plan,
        status: 'ACTIVE',
        max_leads: limits.max_leads,
        max_messages: limits.max_messages,
        expires_at: expiresAt ?? null,
      },
    });
  }

  /**
   * Express middleware: block requests if license is invalid.
   */
  get validateMiddleware() {
    return asyncHandler(async (req: Request, res: Response, next: () => void) => {
      const { valid, reason } = await this.validate(req.tenantId);
      if (!valid) {
        res.status(403).json({ success: false, message: reason ?? 'License validation failed' });
        return;
      }
      next();
    });
  }
}

export const licenseService = new LicenseService();

// ── Routes ────────────────────────────────────────────────────────────────────

const activateSchema = z.object({ license_key: z.string().min(10) });

const router = Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const [license, leadLimit, messageLimit] = await Promise.all([
    licenseService.getForTenant(req.tenantId),
    licenseService.checkLeadLimit(req.tenantId),
    licenseService.checkMessageLimit(req.tenantId),
  ]);

  return success(res, {
    license,
    limits: { leads: leadLimit, messages: messageLimit },
  });
}));

router.post('/activate', asyncHandler(async (req: Request, res: Response) => {
  const { license_key } = activateSchema.parse(req.body);
  const license = await licenseService.activateLicense(req.tenantId, license_key);
  return success(res, license, 'License activated successfully');
}));

router.post('/validate', asyncHandler(async (req: Request, res: Response) => {
  const result = await licenseService.validate(req.tenantId);
  return success(res, result);
}));

export default router;
