import { Worker, Job } from 'bullmq';
import { createRedisConnection } from '../../config/redis';
import { QUEUE_NAMES, getWhatsappQueue } from '../../config/queues';
import { env } from '../../config/env';
import prisma from '../../config/database';
import { tenantService } from '../../modules/tenant/tenant.service';
import { BroadcastProcessJobData, SendMessageJobData } from '../../types';
import { getIo } from '../../socket';

export function createBroadcastWorker(): Worker {
  const worker = new Worker<BroadcastProcessJobData>(
    QUEUE_NAMES.BROADCAST_PROCESSOR,
    async (job: Job<BroadcastProcessJobData>) => {
      const { tenantId, broadcastId } = job.data;
      await processBroadcast(tenantId, broadcastId, job);
    },
    {
      connection: createRedisConnection(),
      concurrency: 2, // max 2 broadcasts running at once
    }
  );

  worker.on('completed', (job) => {
    console.log(`✅ Broadcast job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Broadcast job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function processBroadcast(
  tenantId: string,
  broadcastId: string,
  job: Job<BroadcastProcessJobData>
) {
  const io = getIo();

  // Re-check broadcast is still RUNNING (may have been paused)
  const broadcast = await prisma.broadcast.findFirst({
    where: { id: broadcastId, tenant_id: tenantId },
    include: { template: true },
  });

  if (!broadcast || broadcast.status !== 'RUNNING') {
    console.log(`Broadcast ${broadcastId} is not in RUNNING state, skipping`);
    return;
  }

  // Get all QUEUED recipients for this broadcast
  const recipients = await prisma.broadcastRecipient.findMany({
    where: { broadcast_id: broadcastId, status: 'QUEUED' },
    include: { lead: { select: { phone: true, name: true, products: true } } },
    orderBy: { created_at: 'asc' },
  });

  if (recipients.length === 0) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'COMPLETED', completed_at: new Date() },
    });
    io.to(`tenant:${tenantId}`).emit('broadcast:complete', { broadcastId });
    return;
  }

  // Check daily limit
  const { allowed, remaining } = await tenantService.checkDailyLimit(tenantId);
  if (!allowed) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'PAUSED' },
    });
    io.to(`tenant:${tenantId}`).emit('broadcast:paused', {
      broadcastId,
      reason: 'Daily message limit reached',
    });
    return;
  }

  // Get decrypted access token once (don't hit DB per message)
  const accessToken = await tenantService.getDecryptedAccessToken(tenantId);
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { phone_number_id: true },
  });

  if (!tenant?.phone_number_id) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'FAILED' },
    });
    return;
  }

  // Cap at daily remaining
  const recipientsToProcess = recipients.slice(0, remaining);

  const whatsappQueue = getWhatsappQueue();
  const variableMap = broadcast.variable_map as Record<string, string> | null;

  // Enqueue individual message jobs with staggered delay
  for (let i = 0; i < recipientsToProcess.length; i++) {
    const recipient = recipientsToProcess[i];

    // Random delay: 20–40 seconds between messages
    const delayMs =
      i === 0
        ? 0
        : Math.floor(
            Math.random() *
              (env.BROADCAST_DELAY_MAX_MS - env.BROADCAST_DELAY_MIN_MS + 1) +
              env.BROADCAST_DELAY_MIN_MS
          );

    // Build template payload with variable substitution
    const resolvedVariables = resolveVariables(
      variableMap,
      recipient.lead as { phone: string; name: string; products: string[] }
    );

    const jobData: SendMessageJobData = {
      tenantId,
      recipientId: recipient.id,
      broadcastId,
      leadId: recipient.lead_id,
      phone: recipient.lead.phone,
      phoneNumberId: tenant.phone_number_id,
      accessToken,
      payload: {
        type: 'template',
        template: {
          name: broadcast.template.name.toLowerCase().replace(/\s+/g, '_'),
          language: { code: broadcast.template.language },
          ...(Object.keys(resolvedVariables).length > 0 && {
            components: [
              {
                type: 'body',
                parameters: Object.values(resolvedVariables).map((v) => ({
                  type: 'text' as const,
                  text: v,
                })),
              },
            ],
          }),
        },
      },
    };

    await whatsappQueue.add(`send-${recipient.id}`, jobData, {
      delay: i === 0
        ? 0
        : // accumulate delays so messages are sent in order
          recipientsToProcess
            .slice(0, i)
            .reduce(
              (acc) =>
                acc +
                Math.floor(
                  Math.random() *
                    (env.BROADCAST_DELAY_MAX_MS - env.BROADCAST_DELAY_MIN_MS + 1) +
                    env.BROADCAST_DELAY_MIN_MS
                ),
              0
            ),
      jobId: `msg-${recipient.id}`, // idempotent: resume won't re-queue
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
    });

    // Update progress every 50 recipients
    if (i % 50 === 0) {
      await job.updateProgress(Math.round((i / recipientsToProcess.length) * 100));
      io.to(`tenant:${tenantId}`).emit('broadcast:progress', {
        broadcastId,
        queued: i + 1,
        total: recipientsToProcess.length,
      });
    }
  }

  // Increment tenant daily message count
  await tenantService.incrementMessageCount(tenantId, recipientsToProcess.length);

  io.to(`tenant:${tenantId}`).emit('broadcast:progress', {
    broadcastId,
    queued: recipientsToProcess.length,
    total: recipients.length,
  });
}

/**
 * Substitutes broadcast variable_map values with actual lead field data.
 * variable_map example: { "1": "lead.name", "2": "lead.phone" }
 */
function resolveVariables(
  variableMap: Record<string, string> | null,
  lead: { phone: string; name: string; products: string[] }
): Record<string, string> {
  if (!variableMap) return {};

  const result: Record<string, string> = {};
  for (const [key, fieldPath] of Object.entries(variableMap)) {
    if (fieldPath === 'lead.name') result[key] = lead.name;
    else if (fieldPath === 'lead.phone') result[key] = lead.phone;
    else if (fieldPath === 'lead.products') result[key] = lead.products.join(', ');
    else result[key] = fieldPath; // use literal if not a known path
  }
  return result;
}
