import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { normalizePhone } from '../../lib/phone';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';
import { env } from '../../config/env';
import { CreateLeadInput, UpdateLeadInput, ListLeadsInput } from './leads.schema';

const COOLING_DAYS = env.COOLING_PERIOD_DAYS;
const DEDUP_WINDOW_DAYS = 30;

export class LeadsService {
  async list(tenantId: string, query: ListLeadsInput) {
    const { page, limit, skip } = getPaginationParams(query.page, query.limit);

    const where: Prisma.LeadWhereInput = { tenant_id: tenantId };

    if (query.status) where.status = query.status;
    if (query.stage) where.stage = query.stage;
    if (query.label) where.label = query.label;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.tag_id) {
      where.tags = { some: { tag_id: query.tag_id } };
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [query.sort_by]: query.sort_order },
        include: {
          tags: { include: { tag: true } },
          custom_values: { include: { field: true } },
        },
      }),
      prisma.lead.count({ where }),
    ]);

    return { leads, pagination: buildPaginationMeta(total, { page, limit, skip }) };
  }

  async getById(tenantId: string, leadId: string) {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      include: {
        tags: { include: { tag: true } },
        custom_values: { include: { field: true } },
        followups: { orderBy: { created_at: 'desc' }, take: 10 },
      },
    });
    if (!lead) throw new NotFoundError('Lead');
    return lead;
  }

  async create(tenantId: string, input: CreateLeadInput) {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ValidationError(`Invalid phone number: ${input.phone}`);

    // Check for existing lead with same phone (no time window for manual creation)
    const existing = await prisma.lead.findUnique({
      where: { tenant_id_phone: { tenant_id: tenantId, phone } },
    });

    if (existing) {
      // Same phone + new products: merge products
      if (input.products.length > 0) {
        const merged = Array.from(new Set([...existing.products, ...input.products]));
        return prisma.lead.update({
          where: { id: existing.id },
          data: { products: merged, updated_at: new Date() },
        });
      }
      throw new AppError(`Lead with phone ${phone} already exists`, 409);
    }

    return prisma.lead.create({
      data: {
        tenant_id: tenantId,
        name: input.name,
        phone,
        email: input.email || null,
        products: input.products,
        status: input.status,
        stage: input.stage,
        label: input.label,
        notes: input.notes,
        source: 'MANUAL',
      },
    });
  }

  async update(tenantId: string, leadId: string, input: UpdateLeadInput) {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
    });
    if (!lead) throw new NotFoundError('Lead');

    const updateData: Prisma.LeadUpdateInput = {};

    if (input.name !== undefined) updateData.name = input.name;
    if (input.email !== undefined) updateData.email = input.email || null;
    if (input.products !== undefined) updateData.products = input.products;
    if (input.stage !== undefined) updateData.stage = input.stage;
    if (input.label !== undefined) updateData.label = input.label;
    if (input.notes !== undefined) updateData.notes = input.notes;
    if (input.opt_out !== undefined) updateData.opt_out = input.opt_out;

    // Status transitions with business logic
    if (input.status && input.status !== lead.status) {
      updateData.status = input.status;

      if (input.status === 'COOLING') {
        // Apply cooling period unless manually overridden
        const coolingUntil = input.cooling_until
          ? new Date(input.cooling_until)
          : new Date(Date.now() + COOLING_DAYS * 24 * 60 * 60 * 1000);
        updateData.cooling_until = coolingUntil;
      } else {
        // Clear cooling when moving out of COOLING
        updateData.cooling_until = null;
      }
    }

    // Manual override of cooling_until
    if (input.cooling_until !== undefined) {
      updateData.cooling_until = input.cooling_until ? new Date(input.cooling_until) : null;
    }

    return prisma.lead.update({
      where: { id: leadId },
      data: updateData,
    });
  }

  async delete(tenantId: string, leadId: string) {
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
    });
    if (!lead) throw new NotFoundError('Lead');
    await prisma.lead.delete({ where: { id: leadId } });
  }

  async bulkUpdate(
    tenantId: string,
    leadIds: string[],
    updates: { status?: string; stage?: string; label?: string; tag_id?: string }
  ) {
    // Verify all leads belong to this tenant
    const count = await prisma.lead.count({
      where: { id: { in: leadIds }, tenant_id: tenantId },
    });
    if (count !== leadIds.length) {
      throw new AppError('Some leads not found or do not belong to your account', 400);
    }

    const updateData: Prisma.LeadUpdateManyMutationInput = {};
    if (updates.status) {
      updateData.status = updates.status as 'PENDING' | 'LIVE' | 'DEAD' | 'COOLING';
      if (updates.status === 'COOLING') {
        updateData.cooling_until = new Date(
          Date.now() + COOLING_DAYS * 24 * 60 * 60 * 1000
        );
      }
    }
    if (updates.stage) updateData.stage = updates.stage;
    if (updates.label) updateData.label = updates.label;

    const ops: Promise<unknown>[] = [
      prisma.lead.updateMany({
        where: { id: { in: leadIds }, tenant_id: tenantId },
        data: updateData,
      }),
    ];

    // Add tag to all leads
    if (updates.tag_id) {
      ops.push(
        prisma.$executeRaw`
          INSERT INTO "LeadTag" (lead_id, tag_id, created_at)
          SELECT id, ${updates.tag_id}, NOW()
          FROM "Lead"
          WHERE id = ANY(${leadIds}::text[])
          ON CONFLICT DO NOTHING
        `
      );
    }

    await Promise.all(ops);
    return { updated: leadIds.length };
  }

  /**
   * Core deduplication logic for Excel uploads.
   * Rules:
   *  1. Same phone within 30 days → skip (duplicate)
   *  2. Same phone + new product → merge products
   *  3. Phone not found → create new
   */
  async upsertFromUpload(
    tenantId: string,
    uploadId: string,
    row: { name: string; phone: string; product?: string }
  ): Promise<'created' | 'updated' | 'skipped' | 'error'> {
    const phone = normalizePhone(row.phone);
    if (!phone) return 'error';

    const product = row.product?.trim() || null;
    const windowStart = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    try {
      const existing = await prisma.lead.findUnique({
        where: { tenant_id_phone: { tenant_id: tenantId, phone } },
      });

      if (!existing) {
        // New lead
        await prisma.lead.create({
          data: {
            tenant_id: tenantId,
            upload_id: uploadId,
            name: row.name.trim(),
            phone,
            products: product ? [product] : [],
            source: 'EXCEL_UPLOAD',
            status: 'PENDING',
          },
        });
        return 'created';
      }

      // Lead exists — check 30-day dedup window
      const createdRecently = existing.created_at >= windowStart;

      if (createdRecently && (!product || existing.products.includes(product))) {
        // Exact duplicate within window
        return 'skipped';
      }

      if (product && !existing.products.includes(product)) {
        // Same phone, new product → merge
        await prisma.lead.update({
          where: { id: existing.id },
          data: {
            products: { push: product },
            updated_at: new Date(),
          },
        });
        return 'updated';
      }

      return 'skipped';
    } catch {
      return 'error';
    }
  }

  async addTag(tenantId: string, leadId: string, tagId: string) {
    const [lead, tag] = await Promise.all([
      prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId } }),
      prisma.tag.findFirst({ where: { id: tagId, tenant_id: tenantId } }),
    ]);
    if (!lead) throw new NotFoundError('Lead');
    if (!tag) throw new NotFoundError('Tag');

    await prisma.leadTag.upsert({
      where: { lead_id_tag_id: { lead_id: leadId, tag_id: tagId } },
      create: { lead_id: leadId, tag_id: tagId },
      update: {},
    });
  }

  async removeTag(tenantId: string, leadId: string, tagId: string) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId } });
    if (!lead) throw new NotFoundError('Lead');

    await prisma.leadTag.deleteMany({ where: { lead_id: leadId, tag_id: tagId } });
  }

  async markContacted(tenantId: string, leadId: string) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId } });
    if (!lead) throw new NotFoundError('Lead');

    return prisma.lead.update({
      where: { id: leadId },
      data: { last_contacted_at: new Date() },
    });
  }

  // Called by cron job to auto-expire cooling leads
  async expireCoolingLeads(tenantId?: string) {
    const where: Prisma.LeadWhereInput = {
      status: 'COOLING',
      cooling_until: { lte: new Date() },
    };
    if (tenantId) where.tenant_id = tenantId;

    return prisma.lead.updateMany({
      where,
      data: { status: 'PENDING', cooling_until: null },
    });
  }
}

export const leadsService = new LeadsService();
