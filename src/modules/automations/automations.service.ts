import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { NotFoundError } from '../../lib/errors';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';
import { getAutomationQueue } from '../../config/queues';
import { AutomationCondition, AutomationAction } from '../../types';

export class AutomationsService {
  async list(tenantId: string, page: unknown, limit: unknown) {
    const params = getPaginationParams(page, limit);
    const [automations, total] = await Promise.all([
      prisma.automation.findMany({
        where: { tenant_id: tenantId },
        skip: params.skip,
        take: params.limit,
        orderBy: { created_at: 'desc' },
        include: {
          _count: { select: { logs: true } },
        },
      }),
      prisma.automation.count({ where: { tenant_id: tenantId } }),
    ]);
    return { automations, pagination: buildPaginationMeta(total, params) };
  }

  async getById(tenantId: string, id: string) {
    const automation = await prisma.automation.findFirst({
      where: { id, tenant_id: tenantId },
      include: { logs: { orderBy: { created_at: 'desc' }, take: 20 } },
    });
    if (!automation) throw new NotFoundError('Automation');
    return automation;
  }

  async create(
    tenantId: string,
    data: {
      name: string;
      description?: string;
      trigger: string;
      conditions?: AutomationCondition[];
      actions: AutomationAction[];
    }
  ) {
    return prisma.automation.create({
      data: {
        tenant_id: tenantId,
        name: data.name,
        description: data.description,
        trigger: data.trigger as 'LEAD_CREATED',
        conditions: data.conditions ? (data.conditions as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        actions: data.actions as unknown as Prisma.InputJsonValue,
        is_active: true,
      },
    });
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<{
      name: string;
      description: string;
      conditions: AutomationCondition[];
      actions: AutomationAction[];
      is_active: boolean;
    }>
  ) {
    const existing = await prisma.automation.findFirst({ where: { id, tenant_id: tenantId } });
    if (!existing) throw new NotFoundError('Automation');

    return prisma.automation.update({
      where: { id },
      data: {
        ...data,
        conditions: data.conditions
          ? (data.conditions as unknown as Prisma.InputJsonValue)
          : undefined,
        actions: data.actions ? (data.actions as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async delete(tenantId: string, id: string) {
    const existing = await prisma.automation.findFirst({ where: { id, tenant_id: tenantId } });
    if (!existing) throw new NotFoundError('Automation');
    await prisma.automation.delete({ where: { id } });
  }

  /**
   * Trigger all active automations that match the given trigger event.
   * Called by services (leads, whatsapp webhook) when events happen.
   */
  async triggerFor(
    tenantId: string,
    trigger: string,
    leadId: string,
    context: Record<string, unknown> = {}
  ) {
    const automations = await prisma.automation.findMany({
      where: {
        tenant_id: tenantId,
        is_active: true,
        trigger: trigger as 'LEAD_CREATED',
      },
    });

    const queue = getAutomationQueue();
    for (const automation of automations) {
      await queue.add(
        'run-automation',
        { tenantId, automationId: automation.id, leadId, trigger, context },
        { attempts: 2 }
      );
    }
  }

  /**
   * Execute one automation against one lead.
   * Called by the automation queue worker.
   */
  async execute(
    tenantId: string,
    automationId: string,
    leadId: string,
    context: Record<string, unknown>
  ) {
    const automation = await prisma.automation.findFirst({
      where: { id: automationId, tenant_id: tenantId, is_active: true },
    });
    if (!automation) return;

    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenant_id: tenantId } });
    if (!lead) return;

    let logStatus = 'SUCCESS';
    let logError: string | undefined;
    const results: string[] = [];

    try {
      // Evaluate conditions
      const conditions = (automation.conditions ?? []) as unknown as AutomationCondition[];
      const conditionsMet = this._evaluateConditions(conditions, lead, context);

      if (!conditionsMet) {
        logStatus = 'SKIPPED';
        results.push('Conditions not met');
      } else {
        const actions = automation.actions as unknown as AutomationAction[];
        for (const action of actions) {
          const result = await this._executeAction(tenantId, leadId, action);
          results.push(result);
        }
      }
    } catch (err) {
      logStatus = 'FAILED';
      logError = err instanceof Error ? err.message : 'Unknown error';
    }

    // Write log
    await prisma.automationLog.create({
      data: {
        tenant_id: tenantId,
        automation_id: automationId,
        lead_id: leadId,
        status: logStatus,
        result: results as unknown as Prisma.InputJsonValue,
        error: logError,
      },
    });

    // Increment run count
    if (logStatus === 'SUCCESS') {
      await prisma.automation.update({
        where: { id: automationId },
        data: { run_count: { increment: 1 } },
      });
    }
  }

  private _evaluateConditions(
    conditions: AutomationCondition[],
    lead: Record<string, unknown>,
    context: Record<string, unknown>
  ): boolean {
    if (!conditions || conditions.length === 0) return true;

    return conditions.every((cond) => {
      const fieldValue = (lead[cond.field] ?? context[cond.field]) as string | number | undefined;
      if (fieldValue === undefined) return false;

      switch (cond.operator) {
        case 'eq': return String(fieldValue) === String(cond.value);
        case 'neq': return String(fieldValue) !== String(cond.value);
        case 'contains':
          return String(fieldValue).toLowerCase().includes(String(cond.value).toLowerCase());
        case 'in':
          return Array.isArray(cond.value) && cond.value.includes(String(fieldValue));
        case 'gt': return Number(fieldValue) > Number(cond.value);
        case 'lt': return Number(fieldValue) < Number(cond.value);
        default: return false;
      }
    });
  }

  private async _executeAction(
    tenantId: string,
    leadId: string,
    action: AutomationAction
  ): Promise<string> {
    switch (action.type) {
      case 'UPDATE_STATUS':
        await prisma.lead.update({
          where: { id: leadId },
          data: { status: action.status as 'LIVE' },
        });
        return `Status updated to ${action.status}`;

      case 'UPDATE_STAGE':
        await prisma.lead.update({
          where: { id: leadId },
          data: { stage: action.stage },
        });
        return `Stage updated to ${action.stage}`;

      case 'ADD_TAG':
        if (action.tagId) {
          await prisma.leadTag.upsert({
            where: { lead_id_tag_id: { lead_id: leadId, tag_id: action.tagId } },
            create: { lead_id: leadId, tag_id: action.tagId },
            update: {},
          });
          return `Tag ${action.tagId} added`;
        }
        return 'No tag ID provided';

      case 'SEND_MESSAGE':
        if (action.templateId) {
          // Import dynamically to avoid circular deps
          const { waService } = await import('../whatsapp/whatsapp.service');
          const lead = await prisma.lead.findUnique({ where: { id: leadId } });
          const template = await prisma.template.findUnique({ where: { id: action.templateId } });
          if (lead && template) {
            await waService.sendTemplateMessage(tenantId, lead.phone, template);
            return `Message sent via template ${template.name}`;
          }
        }
        return 'Message skipped: missing template or lead';

      case 'WAIT':
        // Delay is handled by the queue's delay option — no DB action needed here
        return `Wait action logged (${action.delayHours}h)`;

      default:
        return `Unknown action type: ${(action as AutomationAction).type}`;
    }
  }
}

export const automationsService = new AutomationsService();
