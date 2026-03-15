import prisma from '../../config/database';
import { NotFoundError, AppError } from '../../lib/errors';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';
import { waService } from '../whatsapp/whatsapp.service';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errors';
import { success, created, paginated } from '../../lib/response';

const STAGE_ORDER = ['TEMPLATE1', 'TEMPLATE2', 'TEMPLATE3'] as const;
type FollowupStage = (typeof STAGE_ORDER)[number];

// ── Service ───────────────────────────────────────────────────────────────────

export class FollowupsService {
  async list(
    tenantId: string,
    page: unknown,
    limit: unknown,
    filters?: { lead_id?: string; status?: string; stage?: string }
  ) {
    const params = getPaginationParams(page, limit);
    const where = {
      tenant_id: tenantId,
      ...(filters?.lead_id && { lead_id: filters.lead_id }),
      ...(filters?.status && { status: filters.status as 'PENDING' }),
      ...(filters?.stage && { stage: filters.stage as FollowupStage }),
    };

    const [followups, total] = await Promise.all([
      prisma.followup.findMany({
        where,
        skip: params.skip,
        take: params.limit,
        orderBy: { created_at: 'desc' },
        include: {
          lead: { select: { name: true, phone: true, status: true } },
          template: { select: { name: true } },
        },
      }),
      prisma.followup.count({ where }),
    ]);

    return { followups, pagination: buildPaginationMeta(total, params) };
  }

  /**
   * Create a followup for the NEXT stage.
   * Determines next stage automatically based on previous followups for this lead.
   */
  async createForLead(
    tenantId: string,
    leadId: string,
    templateId?: string,
    notes?: string,
    scheduledAt?: string
  ) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId } });
    if (!lead) throw new NotFoundError('Lead');

    // Find the highest stage already used for this lead
    const latestFollowup = await prisma.followup.findFirst({
      where: { lead_id: leadId, tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
    });

    let nextStage: FollowupStage;
    if (!latestFollowup) {
      nextStage = 'TEMPLATE1';
    } else if (latestFollowup.status === 'NO_REPLY' && latestFollowup.stage === 'TEMPLATE3') {
      // Already exhausted all stages and no reply → mark lead DEAD
      await prisma.lead.update({ where: { id: leadId }, data: { status: 'DEAD' } });
      throw new AppError('Lead has been marked DEAD after 3 unanswered followups', 400);
    } else {
      const currentIndex = STAGE_ORDER.indexOf(latestFollowup.stage as FollowupStage);
      if (currentIndex === STAGE_ORDER.length - 1) {
        throw new AppError('All followup stages have been used for this lead', 400);
      }
      nextStage = STAGE_ORDER[currentIndex + 1];
    }

    return prisma.followup.create({
      data: {
        tenant_id: tenantId,
        lead_id: leadId,
        template_id: templateId ?? null,
        stage: nextStage,
        status: 'PENDING',
        notes: notes ?? null,
        scheduled_at: scheduledAt ? new Date(scheduledAt) : null,
      },
    });
  }

  /**
   * Send a followup message via WhatsApp.
   * Must be called manually.
   */
  async send(tenantId: string, followupId: string) {
    const followup = await prisma.followup.findFirst({
      where: { id: followupId, tenant_id: tenantId },
      include: { lead: true, template: true },
    });
    if (!followup) throw new NotFoundError('Followup');
    if (followup.status !== 'PENDING') {
      throw new AppError(`Followup is already ${followup.status}`, 400);
    }
    if (followup.lead.opt_out) {
      throw new AppError('Lead has opted out of WhatsApp messages', 400);
    }
    if (!followup.template) {
      throw new AppError('No template assigned to this followup', 400);
    }

    // Send via WhatsApp
    const waMessageId = await waService.sendTemplateMessage(
      tenantId,
      followup.lead.phone,
      followup.template
    );

    // Update followup
    await prisma.followup.update({
      where: { id: followupId },
      data: {
        status: 'SENT',
        wa_message_id: waMessageId,
        sent_at: new Date(),
      },
    });

    // Mark lead as contacted
    await prisma.lead.update({
      where: { id: followup.lead_id },
      data: { last_contacted_at: new Date(), status: 'LIVE' },
    });

    return { sent: true, wa_message_id: waMessageId };
  }

  /**
   * Mark a followup as replied (called when inbound WA message received).
   * Triggered by webhook handler.
   */
  async markReplied(tenantId: string, leadId: string) {
    const pendingSent = await prisma.followup.findFirst({
      where: {
        tenant_id: tenantId,
        lead_id: leadId,
        status: 'SENT',
      },
      orderBy: { sent_at: 'desc' },
    });

    if (pendingSent) {
      await prisma.followup.update({
        where: { id: pendingSent.id },
        data: { status: 'REPLIED', replied_at: new Date() },
      });
    }

    // Mark lead LIVE on reply
    await prisma.lead.update({
      where: { id: leadId },
      data: { status: 'LIVE' },
    });
  }

  /**
   * Mark unanswered followups as NO_REPLY.
   * If stage was TEMPLATE3 → mark lead DEAD.
   * Called by cron job.
   */
  async expireFollowups(hoursWithoutReply = 48) {
    const cutoff = new Date(Date.now() - hoursWithoutReply * 60 * 60 * 1000);
    const stale = await prisma.followup.findMany({
      where: {
        status: 'SENT',
        sent_at: { lte: cutoff },
      },
      select: { id: true, lead_id: true, stage: true, tenant_id: true },
    });

    for (const f of stale) {
      await prisma.followup.update({
        where: { id: f.id },
        data: { status: 'NO_REPLY' },
      });

      // If final stage, mark lead DEAD
      if (f.stage === 'TEMPLATE3') {
        await prisma.lead.update({
          where: { id: f.lead_id },
          data: { status: 'DEAD' },
        });
      }
    }

    return { expired: stale.length };
  }
}

export const followupsService = new FollowupsService();

// ── Controller + Router (co-located for brevity) ─────────────────────────────

const createFollowupSchema = z.object({
  lead_id: z.string(),
  template_id: z.string().optional(),
  notes: z.string().optional(),
  scheduled_at: z.string().datetime().optional(),
});

const listFollowupsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  lead_id: z.string().optional(),
  status: z.string().optional(),
  stage: z.string().optional(),
});

const listFollowups = asyncHandler(async (req: Request, res: Response) => {
  const query = listFollowupsSchema.parse(req.query);
  const { followups, pagination } = await followupsService.list(
    req.tenantId,
    query.page,
    query.limit,
    { lead_id: query.lead_id, status: query.status, stage: query.stage }
  );
  return paginated(res, followups, pagination);
});

const createFollowup = asyncHandler(async (req: Request, res: Response) => {
  const { lead_id, template_id, notes, scheduled_at } = createFollowupSchema.parse(req.body);
  const followup = await followupsService.createForLead(
    req.tenantId, lead_id, template_id, notes, scheduled_at
  );
  return created(res, followup, 'Followup created');
});

const sendFollowup = asyncHandler(async (req: Request, res: Response) => {
  const result = await followupsService.send(req.tenantId, req.params.id);
  return success(res, result, 'Followup sent');
});

export const followupsRouter = Router();
followupsRouter.get('/', listFollowups);
followupsRouter.post('/', createFollowup);
followupsRouter.post('/:id/send', sendFollowup);
