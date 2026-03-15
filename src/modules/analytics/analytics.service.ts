import prisma from '../../config/database';
import { Prisma } from '@prisma/client';

type EventType =
  | 'LEAD_CREATED'
  | 'LEAD_STATUS_CHANGED'
  | 'MESSAGE_SENT'
  | 'MESSAGE_DELIVERED'
  | 'MESSAGE_READ'
  | 'BROADCAST_STARTED'
  | 'BROADCAST_COMPLETED'
  | 'FOLLOWUP_SENT'
  | 'AUTOMATION_RUN';

export class AnalyticsService {
  // ─── Event tracking ─────────────────────────────────────────────────────────

  async track(
    tenantId: string,
    eventType: EventType,
    entityId?: string,
    metadata?: Record<string, unknown>
  ) {
    // Fire-and-forget: never block the caller
    prisma.analyticsEvent
      .create({
        data: {
          tenant_id: tenantId,
          event_type: eventType,
          entity_id: entityId,
          metadata: metadata as Prisma.InputJsonValue ?? Prisma.JsonNull,
        },
      })
      .catch((err) => console.error('Analytics track error:', err));
  }

  // ─── Dashboard overview ──────────────────────────────────────────────────────

  async getDashboard(tenantId: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [
      leadsByStatus,
      leadsOverTime,
      messageStats,
      broadcastStats,
      topStages,
      recentActivity,
    ] = await Promise.all([
      this._leadsByStatus(tenantId),
      this._leadsOverTime(tenantId, since),
      this._messageStats(tenantId, since),
      this._broadcastStats(tenantId, since),
      this._topStages(tenantId),
      this._recentActivity(tenantId),
    ]);

    return {
      leads_by_status: leadsByStatus,
      leads_over_time: leadsOverTime,
      message_stats: messageStats,
      broadcast_stats: broadcastStats,
      top_stages: topStages,
      recent_activity: recentActivity,
      period_days: days,
    };
  }

  private async _leadsByStatus(tenantId: string) {
    const rows = await prisma.lead.groupBy({
      by: ['status'],
      where: { tenant_id: tenantId },
      _count: { _all: true },
    });

    const result: Record<string, number> = { PENDING: 0, LIVE: 0, DEAD: 0, COOLING: 0 };
    rows.forEach((r) => { result[r.status] = r._count._all; });
    return result;
  }

  private async _leadsOverTime(tenantId: string, since: Date) {
    // Group leads created per day using raw SQL for date truncation
    const rows = await prisma.$queryRaw<{ date: Date; count: bigint }[]>`
      SELECT
        DATE_TRUNC('day', created_at) AS date,
        COUNT(*) AS count
      FROM "Lead"
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${since}
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY date ASC
    `;

    return rows.map((r) => ({
      date: r.date.toISOString().split('T')[0],
      count: Number(r.count),
    }));
  }

  private async _messageStats(tenantId: string, since: Date) {
    const [sent, delivered, read, failed] = await Promise.all([
      prisma.message.count({
        where: { tenant_id: tenantId, direction: 'OUTBOUND', created_at: { gte: since } },
      }),
      prisma.message.count({
        where: {
          tenant_id: tenantId,
          direction: 'OUTBOUND',
          status: 'DELIVERED',
          created_at: { gte: since },
        },
      }),
      prisma.message.count({
        where: {
          tenant_id: tenantId,
          direction: 'OUTBOUND',
          status: 'READ',
          created_at: { gte: since },
        },
      }),
      prisma.message.count({
        where: {
          tenant_id: tenantId,
          direction: 'OUTBOUND',
          status: 'FAILED',
          created_at: { gte: since },
        },
      }),
    ]);

    return {
      sent,
      delivered,
      read,
      failed,
      delivery_rate: sent > 0 ? Math.round((delivered / sent) * 100) : 0,
      read_rate: sent > 0 ? Math.round((read / sent) * 100) : 0,
    };
  }

  private async _broadcastStats(tenantId: string, since: Date) {
    const broadcasts = await prisma.broadcast.findMany({
      where: { tenant_id: tenantId, created_at: { gte: since } },
      select: {
        status: true,
        total_count: true,
        sent_count: true,
        delivered_count: true,
        read_count: true,
        failed_count: true,
      },
    });

    const total = broadcasts.length;
    const completed = broadcasts.filter((b) => b.status === 'COMPLETED').length;
    const totalMessages = broadcasts.reduce((s, b) => s + b.total_count, 0);
    const totalSent = broadcasts.reduce((s, b) => s + b.sent_count, 0);
    const totalRead = broadcasts.reduce((s, b) => s + b.read_count, 0);

    return {
      total,
      completed,
      total_messages: totalMessages,
      total_sent: totalSent,
      avg_read_rate:
        totalSent > 0 ? Math.round((totalRead / totalSent) * 100) : 0,
    };
  }

  private async _topStages(tenantId: string) {
    const rows = await prisma.lead.groupBy({
      by: ['stage'],
      where: { tenant_id: tenantId, stage: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { stage: 'desc' } },
      take: 10,
    });

    return rows.map((r) => ({ stage: r.stage, count: r._count._all }));
  }

  private async _recentActivity(tenantId: string) {
    const events = await prisma.analyticsEvent.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { event_type: true, entity_id: true, metadata: true, created_at: true },
    });
    return events;
  }

  // ─── Broadcast analytics ─────────────────────────────────────────────────────

  async getBroadcastAnalytics(tenantId: string, broadcastId: string) {
    const broadcast = await prisma.broadcast.findFirst({
      where: { id: broadcastId, tenant_id: tenantId },
    });
    if (!broadcast) return null;

    const recipientsByStatus = await prisma.broadcastRecipient.groupBy({
      by: ['status'],
      where: { broadcast_id: broadcastId },
      _count: { _all: true },
    });

    const statusCounts: Record<string, number> = {};
    recipientsByStatus.forEach((r) => {
      statusCounts[r.status] = r._count._all;
    });

    return {
      broadcast,
      recipients_by_status: statusCounts,
      delivery_rate:
        broadcast.total_count > 0
          ? Math.round((broadcast.delivered_count / broadcast.total_count) * 100)
          : 0,
      read_rate:
        broadcast.sent_count > 0
          ? Math.round((broadcast.read_count / broadcast.sent_count) * 100)
          : 0,
    };
  }
}

export const analyticsService = new AnalyticsService();
