import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../../config/database';
import { env } from '../../config/env';
import { asyncHandler, AppError, UnauthorizedError } from '../../lib/errors';
import { success } from '../../lib/response';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';

// ── Admin auth middleware ─────────────────────────────────────────────────────

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@indialeadscrm.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin@secure2025';

async function adminAuthMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing Authorization header');
    }
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string; role: string };
    if (payload.role !== 'superadmin') {
      throw new UnauthorizedError('Not an admin');
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

const router = Router();

// ── Admin Login ──────────────────────────────────────────────────────────────

router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }).parse(req.body);

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    throw new UnauthorizedError('Invalid admin credentials');
  }

  const token = jwt.sign(
    { sub: 'superadmin', role: 'superadmin', email },
    env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  return success(res, { access_token: token, email }, 'Admin login successful');
}));

// All routes below require admin auth
router.use(adminAuthMiddleware);

// ── Dashboard Stats ──────────────────────────────────────────────────────────

router.get('/stats', asyncHandler(async (_req: Request, res: Response) => {
  const [
    totalTenants,
    activeTenants,
    totalLeads,
    totalMessages,
    planCounts,
    recentSignups,
  ] = await Promise.all([
    prisma.tenant.count(),
    prisma.tenant.count({ where: { is_active: true } }),
    prisma.lead.count(),
    prisma.message.count(),
    prisma.license.groupBy({
      by: ['plan'],
      _count: true,
    }),
    prisma.tenant.findMany({
      orderBy: { created_at: 'desc' },
      take: 5,
      include: { user: { select: { email: true, name: true } }, license: true },
    }),
  ]);

  // Revenue calculation (from plan prices)
  const planPrices: Record<string, number> = {
    FREE: 0,
    STARTER: 999,
    GROWTH: 2499,
    ENTERPRISE: 5000,
  };

  const monthlyRevenue = planCounts.reduce((sum, p) => {
    return sum + (planPrices[p.plan] ?? 0) * p._count;
  }, 0);

  const planBreakdown = planCounts.map(p => ({
    plan: p.plan,
    count: p._count,
    revenue: (planPrices[p.plan] ?? 0) * p._count,
  }));

  return success(res, {
    total_tenants: totalTenants,
    active_tenants: activeTenants,
    total_leads: totalLeads,
    total_messages: totalMessages,
    monthly_revenue: monthlyRevenue,
    plan_breakdown: planBreakdown,
    recent_signups: recentSignups.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      plan: t.plan,
      user_email: t.user?.email,
      user_name: t.user?.name,
      license_status: t.license?.status,
      created_at: t.created_at,
    })),
  });
}));

// ── Customers (Tenants) ──────────────────────────────────────────────────────

router.get('/customers', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPaginationParams(req.query.page, req.query.limit);
  const search = (req.query.search as string) ?? '';
  const planFilter = req.query.plan as string | undefined;
  const statusFilter = req.query.status as string | undefined;

  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
      { user: { email: { contains: search, mode: 'insensitive' } } },
    ];
  }

  if (planFilter && planFilter !== 'ALL') {
    where.plan = planFilter;
  }

  if (statusFilter === 'active') where.is_active = true;
  if (statusFilter === 'inactive') where.is_active = false;

  const [customers, total] = await Promise.all([
    prisma.tenant.findMany({
      where: where as any,
      include: {
        user: { select: { id: true, email: true, name: true, last_login_at: true, created_at: true } },
        license: true,
        _count: { select: { leads: true, messages: true, broadcasts: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.tenant.count({ where: where as any }),
  ]);

  const pagination = buildPaginationMeta(total, { page, limit, skip });

  return success(res, {
    customers: customers.map(c => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      plan: c.plan,
      is_active: c.is_active,
      is_demo: c.is_demo,
      wa_configured: !!(c.phone_number_id && c.wa_access_token),
      onboarding_done: c.onboarding_done,
      user: c.user,
      license: c.license ? {
        id: c.license.id,
        plan: c.license.plan,
        status: c.license.status,
        max_leads: c.license.max_leads,
        max_messages: c.license.max_messages,
        expires_at: c.license.expires_at,
      } : null,
      stats: {
        leads: c._count.leads,
        messages: c._count.messages,
        broadcasts: c._count.broadcasts,
      },
      created_at: c.created_at,
    })),
    pagination,
  });
}));

// ── Get single customer ──────────────────────────────────────────────────────

router.get('/customers/:id', asyncHandler(async (req: Request, res: Response) => {
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.params.id },
    include: {
      user: { select: { id: true, email: true, name: true, last_login_at: true, created_at: true } },
      license: true,
      _count: { select: { leads: true, messages: true, broadcasts: true, templates: true, automations: true } },
    },
  });

  if (!tenant) throw new AppError('Customer not found', 404);

  return success(res, {
    ...tenant,
    wa_configured: !!(tenant.phone_number_id && tenant.wa_access_token),
    wa_access_token: undefined, // never expose
    wa_webhook_secret: undefined,
  });
}));

// ── Update customer ──────────────────────────────────────────────────────────

router.patch('/customers/:id', asyncHandler(async (req: Request, res: Response) => {
  const data = z.object({
    name: z.string().optional(),
    is_active: z.boolean().optional(),
    daily_message_limit: z.number().optional(),
  }).parse(req.body);

  const tenant = await prisma.tenant.update({
    where: { id: req.params.id },
    data,
  });

  return success(res, tenant, 'Customer updated');
}));

// ── Upgrade / Downgrade customer plan ────────────────────────────────────────

router.post('/customers/:id/change-plan', asyncHandler(async (req: Request, res: Response) => {
  const { plan, max_leads, max_messages, expires_at } = z.object({
    plan: z.enum(['FREE', 'STARTER', 'GROWTH', 'ENTERPRISE']),
    max_leads: z.number().optional(),
    max_messages: z.number().optional(),
    expires_at: z.string().datetime().optional(),
  }).parse(req.body);

  const planDefaults: Record<string, { max_leads: number; max_messages: number }> = {
    FREE:       { max_leads: 500,    max_messages: 200  },
    STARTER:    { max_leads: 5000,   max_messages: 1000 },
    GROWTH:     { max_leads: 25000,  max_messages: 5000 },
    ENTERPRISE: { max_leads: 999999, max_messages: 10000 },
  };

  const defaults = planDefaults[plan];
  const licenseKey = `${plan}-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  // Update tenant plan
  await prisma.tenant.update({
    where: { id: req.params.id },
    data: { plan: plan as any },
  });

  // Upsert license
  const license = await prisma.license.upsert({
    where: { tenant_id: req.params.id },
    update: {
      plan: plan as any,
      status: 'ACTIVE',
      max_leads: max_leads ?? defaults.max_leads,
      max_messages: max_messages ?? defaults.max_messages,
      expires_at: expires_at ? new Date(expires_at) : null,
      activated_at: new Date(),
    },
    create: {
      tenant_id: req.params.id,
      license_key: licenseKey,
      plan: plan as any,
      status: 'ACTIVE',
      max_leads: max_leads ?? defaults.max_leads,
      max_messages: max_messages ?? defaults.max_messages,
      expires_at: expires_at ? new Date(expires_at) : null,
    },
  });

  // Log the activity
  await prisma.analyticsEvent.create({
    data: {
      tenant_id: req.params.id,
      event_type: 'PLAN_CHANGED',
      entity_id: license.id,
      metadata: { new_plan: plan, max_leads: license.max_leads, max_messages: license.max_messages },
    },
  });

  return success(res, license, `Plan changed to ${plan}`);
}));

// ── Suspend / Reactivate customer ────────────────────────────────────────────

router.post('/customers/:id/suspend', asyncHandler(async (req: Request, res: Response) => {
  await prisma.tenant.update({
    where: { id: req.params.id },
    data: { is_active: false },
  });

  await prisma.license.updateMany({
    where: { tenant_id: req.params.id },
    data: { status: 'SUSPENDED' },
  });

  return success(res, null, 'Customer suspended');
}));

router.post('/customers/:id/reactivate', asyncHandler(async (req: Request, res: Response) => {
  await prisma.tenant.update({
    where: { id: req.params.id },
    data: { is_active: true },
  });

  await prisma.license.updateMany({
    where: { tenant_id: req.params.id },
    data: { status: 'ACTIVE' },
  });

  return success(res, null, 'Customer reactivated');
}));

// ── Delete customer ──────────────────────────────────────────────────────────

router.delete('/customers/:id', asyncHandler(async (req: Request, res: Response) => {
  // Cascade delete — Prisma schema has onDelete: Cascade
  await prisma.tenant.delete({ where: { id: req.params.id } });
  return success(res, null, 'Customer deleted permanently');
}));

// ── Activity Log ─────────────────────────────────────────────────────────────

router.get('/activity', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, skip } = getPaginationParams(req.query.page, req.query.limit, 50);

  const [events, total] = await Promise.all([
    prisma.analyticsEvent.findMany({
      where: {
        event_type: { in: ['PLAN_CHANGED', 'LEAD_CREATED', 'BROADCAST_COMPLETED'] },
      },
      include: {
        tenant: { select: { name: true, slug: true } },
      },
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    }),
    prisma.analyticsEvent.count({
      where: {
        event_type: { in: ['PLAN_CHANGED', 'LEAD_CREATED', 'BROADCAST_COMPLETED'] },
      },
    }),
  ]);

  // Also get recent logins
  const recentLogins = await prisma.user.findMany({
    where: { last_login_at: { not: null } },
    orderBy: { last_login_at: 'desc' },
    take: 20,
    select: {
      email: true,
      name: true,
      last_login_at: true,
      tenant: { select: { name: true, plan: true } },
    },
  });

  const pagination = buildPaginationMeta(total, { page, limit, skip });

  return success(res, { events, recent_logins: recentLogins, pagination });
}));

// ── Plan Configuration (read/write plan pricing from a config table) ────────
// Since plans are an enum in Prisma, we store pricing config as JSON in a simple key-value approach
// For now, we'll use a static config that admin can update

const DEFAULT_PLAN_CONFIG = [
  { id: 'FREE',       name: 'Free',       monthly_price: 0,    yearly_price: 0,    max_leads: 500,    max_messages: 200,   features: ['Excel import', 'Manual followups', 'WhatsApp inbox', 'Basic analytics'] },
  { id: 'STARTER',    name: 'Starter',    monthly_price: 999,  yearly_price: 799,  max_leads: 5000,   max_messages: 1000,  features: ['Everything in Free', 'Broadcasts', 'Templates', '3-stage followups', 'Automations'] },
  { id: 'GROWTH',     name: 'Growth',     monthly_price: 2499, yearly_price: 1999, max_leads: 25000,  max_messages: 5000,  features: ['Everything in Starter', 'Catalog', 'Advanced analytics', 'Priority support', 'Custom fields'] },
  { id: 'ENTERPRISE', name: 'Enterprise', monthly_price: 5000, yearly_price: 4000, max_leads: 999999, max_messages: 10000, features: ['Everything in Growth', 'Dedicated support', 'Custom integrations', 'API access'] },
];

// In-memory plan config (persists until server restart; in production, store in DB)
let planConfig = [...DEFAULT_PLAN_CONFIG];

router.get('/plans', asyncHandler(async (_req: Request, res: Response) => {
  return success(res, planConfig);
}));

router.put('/plans/:planId', asyncHandler(async (req: Request, res: Response) => {
  const { planId } = req.params;
  const updates = z.object({
    name: z.string().optional(),
    monthly_price: z.number().optional(),
    yearly_price: z.number().optional(),
    max_leads: z.number().optional(),
    max_messages: z.number().optional(),
    features: z.array(z.string()).optional(),
  }).parse(req.body);

  const index = planConfig.findIndex(p => p.id === planId);
  if (index === -1) throw new AppError('Plan not found', 404);

  planConfig[index] = { ...planConfig[index], ...updates };
  return success(res, planConfig[index], 'Plan updated');
}));

export default router;
