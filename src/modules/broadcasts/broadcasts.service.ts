import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { NotFoundError, AppError } from '../../lib/errors';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';
import { getBroadcastQueue } from '../../config/queues';
import { tenantService } from '../tenant/tenant.service';

interface CreateBroadcastInput {
  name: string;
  template_id: string;
  variable_map?: Record<string, string>;
  filters?: Record<string, unknown>;
  scheduled_at?: string;
}

export class BroadcastsService {
  async list(tenantId: string, page: unknown, limit: unknown) {
    const params = getPaginationParams(page, limit);
    const where: Prisma.BroadcastWhereInput = { tenant_id: tenantId };

    const [broadcasts, total] = await Promise.all([
      prisma.broadcast.findMany({
        where,
        skip: params.skip,
        take: params.limit,
        orderBy: { created_at: 'desc' },
        include: { template: { select: { name: true, status: true } } },
      }),
      prisma.broadcast.count({ where }),
    ]);

    return { broadcasts, pagination: buildPaginationMeta(total, params) };
  }

  async getById(tenantId: string, id: string) {
    const broadcast = await prisma.broadcast.findFirst({
      where: { id, tenant_id: tenantId },
      include: { template: true },
    });
    if (!broadcast) throw new NotFoundError('Broadcast');
    return broadcast;
  }

  async create(tenantId: string, input: CreateBroadcastInput) {
    const template = await prisma.template.findFirst({
      where: { id: input.template_id, tenant_id: tenantId },
    });
    if (!template) throw new NotFoundError('Template');
    if (template.status !== 'APPROVED') {
      throw new AppError('Template must be approved before use in a broadcast', 400);
    }

    return prisma.broadcast.create({
      data: {
        tenant_id: tenantId,
        name: input.name,
        template_id: input.template_id,
        variable_map: input.variable_map ?? Prisma.JsonNull,
        filters: input.filters ?? Prisma.JsonNull,
        scheduled_at: input.scheduled_at ? new Date(input.scheduled_at) : null,
        status: input.scheduled_at ? 'SCHEDULED' : 'DRAFT',
      },
    });
  }

  /**
   * Start a broadcast:
   * 1. Build the recipient list from leads (applying filters)
   * 2. Create BroadcastRecipient rows
   * 3. Enqueue the broadcast-processor job
   */
  async start(tenantId: string, broadcastId: string) {
    const broadcast = await prisma.broadcast.findFirst({
      where: { id: broadcastId, tenant_id: tenantId },
    });
    if (!broadcast) throw new NotFoundError('Broadcast');
    if (!['DRAFT', 'SCHEDULED', 'PAUSED'].includes(broadcast.status)) {
      throw new AppError(`Cannot start a broadcast in ${broadcast.status} status`, 400);
    }

    // Check daily limit
    const { allowed } = await tenantService.checkDailyLimit(tenantId);
    if (!allowed) {
      throw new AppError('Daily WhatsApp message limit reached. Try again tomorrow.', 429);
    }

    // Build lead filter from broadcast.filters
    const leadFilter = this._buildLeadFilter(tenantId, broadcast.filters as Record<string, unknown> | null);

    // Get leads eligible for this broadcast
    const leads = await prisma.lead.findMany({
      where: {
        ...leadFilter,
        opt_out: false,
        status: { not: 'DEAD' },
      },
      select: { id: true, phone: true },
    });

    if (leads.length === 0) {
      throw new AppError('No eligible leads found for this broadcast', 400);
    }

    // Delete any existing QUEUED recipients (for resume/restart scenarios)
    await prisma.broadcastRecipient.deleteMany({
      where: { broadcast_id: broadcastId, status: 'QUEUED' },
    });

    // Batch-create recipients
    const CHUNK = 500;
    for (let i = 0; i < leads.length; i += CHUNK) {
      const chunk = leads.slice(i, i + CHUNK);
      await prisma.broadcastRecipient.createMany({
        data: chunk.map((l) => ({
          broadcast_id: broadcastId,
          lead_id: l.id,
          status: 'QUEUED',
        })),
        skipDuplicates: true,
      });
    }

    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: 'RUNNING',
        total_count: leads.length,
        started_at: new Date(),
      },
    });

    // Enqueue processor job
    const queue = getBroadcastQueue();
    await queue.add(
      'process-broadcast',
      { tenantId, broadcastId },
      {
        jobId: `broadcast-${broadcastId}`, // idempotent
        removeOnComplete: false, // keep for status checks
      }
    );

    return { started: true, recipient_count: leads.length };
  }

  async pause(tenantId: string, broadcastId: string) {
    const broadcast = await prisma.broadcast.findFirst({
      where: { id: broadcastId, tenant_id: tenantId },
    });
    if (!broadcast) throw new NotFoundError('Broadcast');
    if (broadcast.status !== 'RUNNING') {
      throw new AppError('Only running broadcasts can be paused', 400);
    }

    return prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'PAUSED' },
    });
  }

  async resume(tenantId: string, broadcastId: string) {
    return this.start(tenantId, broadcastId);
  }

  async getRecipients(tenantId: string, broadcastId: string, page: unknown, limit: unknown) {
    const params = getPaginationParams(page, limit);
    const broadcast = await prisma.broadcast.findFirst({
      where: { id: broadcastId, tenant_id: tenantId },
    });
    if (!broadcast) throw new NotFoundError('Broadcast');

    const [recipients, total] = await Promise.all([
      prisma.broadcastRecipient.findMany({
        where: { broadcast_id: broadcastId },
        skip: params.skip,
        take: params.limit,
        include: { lead: { select: { name: true, phone: true } } },
        orderBy: { created_at: 'desc' },
      }),
      prisma.broadcastRecipient.count({ where: { broadcast_id: broadcastId } }),
    ]);

    return { recipients, pagination: buildPaginationMeta(total, params) };
  }

  private _buildLeadFilter(
    tenantId: string,
    filters: Record<string, unknown> | null
  ): Prisma.LeadWhereInput {
    const where: Prisma.LeadWhereInput = { tenant_id: tenantId };
    if (!filters) return where;

    if (filters.status) where.status = filters.status as 'PENDING';
    if (filters.stage) where.stage = filters.stage as string;
    if (filters.label) where.label = filters.label as string;
    if (filters.tag_id) {
      where.tags = { some: { tag_id: filters.tag_id as string } };
    }
    return where;
  }
}

export const broadcastsService = new BroadcastsService();
