import { Worker, Job } from 'bullmq';
import { createRedisConnection } from '../../config/redis';
import { QUEUE_NAMES } from '../../config/queues';
import { waService } from '../../modules/whatsapp/whatsapp.service';
import { SendMessageJobData } from '../../types';
import prisma from '../../config/database';

export function createWhatsappWorker(): Worker {
  const worker = new Worker<SendMessageJobData>(
    QUEUE_NAMES.WHATSAPP_MESSAGES,
    async (job: Job<SendMessageJobData>) => {
      await sendMessage(job.data, job);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,       // 5 concurrent sends
      limiter: {
        max: 80,            // max 80 jobs per second across all workers
        duration: 1000,
      },
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`❌ WA message job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function sendMessage(data: SendMessageJobData, job: Job<SendMessageJobData>) {
  const { recipientId, broadcastId, leadId, phone, phoneNumberId, accessToken, payload } = data;

  // Check if broadcast is still RUNNING (pause support)
  const broadcast = await prisma.broadcast.findUnique({
    where: { id: broadcastId },
    select: { status: true },
  });

  if (broadcast?.status === 'PAUSED' || broadcast?.status === 'FAILED') {
    // Discard job cleanly — don't fail it (it may be retried)
    await job.discard();
    return;
  }

  try {
    // Use direct send to avoid re-fetching credentials from DB for every message
    const waMessageId = await waService.sendMessageDirect(
      phoneNumberId,
      accessToken,
      phone,
      payload
    );

    // Mark recipient as SENT
    await prisma.broadcastRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'SENT',
        wa_message_id: waMessageId,
        sent_at: new Date(),
      },
    });

    // Store message in conversation
    await storeOutboundMessage(data.tenantId, leadId, waMessageId, payload);

    // Update last_contacted_at on lead
    await prisma.lead.update({
      where: { id: leadId },
      data: { last_contacted_at: new Date() },
    });

  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown send error';

    await prisma.broadcastRecipient.update({
      where: { id: recipientId },
      data: {
        status: 'FAILED',
        failed_at: new Date(),
        failure_reason: reason.slice(0, 500),
      },
    });

    // Re-throw so BullMQ can retry with backoff
    throw err;
  }
}

async function storeOutboundMessage(
  tenantId: string,
  leadId: string,
  waMessageId: string,
  payload: SendMessageJobData['payload']
) {
  try {
    // Find or create conversation
    const existing = await prisma.conversation.findFirst({
      where: { tenant_id: tenantId, lead_id: leadId },
    });

    const conversationId = existing
      ? existing.id
      : (
          await prisma.conversation.create({
            data: { tenant_id: tenantId, lead_id: leadId, status: 'OPEN' },
          })
        ).id;

    await prisma.message.create({
      data: {
        tenant_id: tenantId,
        conversation_id: conversationId,
        wa_message_id: waMessageId,
        direction: 'OUTBOUND',
        type: payload.type === 'template' ? 'TEMPLATE' : 'TEXT',
        content: payload as unknown as Record<string, unknown>,
        status: 'SENT',
        sent_at: new Date(),
      },
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { last_message_at: new Date() },
    });
  } catch (err) {
    // Non-fatal — don't fail the send job if conversation storage fails
    console.error('Failed to store outbound message:', err);
  }
}
