import { Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../../config/database';
import { getIo } from '../../socket';
import { automationsService } from '../automations/automations.service';
import { followupsService } from '../followups/followups.service';
import { templatesService } from '../templates/templates.service';
import { normalizePhone } from '../../lib/phone';
import { asyncHandler } from '../../lib/errors';

// ─── Webhook verification (GET) ───────────────────────────────────────────────

export const verifyWebhook = (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Forbidden' });
  }
};

// ─── Webhook event handler (POST) ─────────────────────────────────────────────

export const handleWebhook = asyncHandler(async (req: Request, res: Response) => {
  // Always respond 200 immediately — WA retries if we don't
  res.status(200).json({ status: 'ok' });

  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value;

      // Find tenant by phone_number_id
      const tenant = await prisma.tenant.findFirst({
        where: { phone_number_id: value.metadata?.phone_number_id },
      });
      if (!tenant) continue;

      // Process inbound messages
      for (const msg of value.messages ?? []) {
        await handleInboundMessage(tenant.id, msg, value.contacts ?? []);
      }

      // Process delivery status updates
      for (const status of value.statuses ?? []) {
        await handleStatusUpdate(tenant.id, status);
      }

      // Process template status updates
      if (value.message_template_status_update) {
        await handleTemplateStatusUpdate(value.message_template_status_update);
      }
    }
  }
});

// ─── HMAC signature verification middleware ───────────────────────────────────

export function verifyHmacSignature(req: Request, res: Response, next: () => void): void {
  const signature = req.headers['x-hub-signature-256'] as string;
  if (!signature) {
    res.status(401).json({ error: 'Missing signature' });
    return;
  }

  // Tenant-level webhook secret is not available here (we don't know tenant yet).
  // Use app-level secret for initial verification.
  const appSecret = process.env.WA_APP_SECRET ?? '';
  if (!appSecret) {
    next(); // skip in dev if not configured
    return;
  }

  const expected = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(JSON.stringify(req.body))
    .digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}

// ─── Inbound message handler ──────────────────────────────────────────────────

async function handleInboundMessage(
  tenantId: string,
  msg: WaInboundMessage,
  contacts: WaContact[]
) {
  const io = getIo();

  // Normalize sender phone
  const rawPhone = `+${msg.from}`;
  const phone = normalizePhone(rawPhone) ?? rawPhone;

  // Find or create lead
  let lead = await prisma.lead.findUnique({
    where: { tenant_id_phone: { tenant_id: tenantId, phone } },
  });

  const waContactName = contacts.find((c) => c.wa_id === msg.from)?.profile?.name;

  if (!lead) {
    // Auto-create lead from inbound message
    lead = await prisma.lead.create({
      data: {
        tenant_id: tenantId,
        name: waContactName ?? phone,
        phone,
        source: 'WEBHOOK',
        status: 'LIVE',
      },
    });
  } else {
    // Mark lead LIVE when they reply
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'LIVE', last_contacted_at: new Date() },
    });
  }

  // Find or create conversation
  let conversation = await prisma.conversation.findUnique({
    where: { tenant_id_lead_id: { tenant_id: tenantId, lead_id: lead.id } },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        tenant_id: tenantId,
        lead_id: lead.id,
        status: 'OPEN',
        wa_contact_name: waContactName,
      },
    });
  }

  // Build message content
  const messageType = resolveMessageType(msg.type);
  const content = buildMessageContent(msg);

  // Store message
  const message = await prisma.message.create({
    data: {
      tenant_id: tenantId,
      conversation_id: conversation.id,
      wa_message_id: msg.id,
      direction: 'INBOUND',
      type: messageType,
      content,
      status: 'DELIVERED',
      delivered_at: new Date(),
    },
  });

  // Update conversation: bump unread + last_message_at
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      last_message_at: new Date(),
      unread_count: { increment: 1 },
      status: 'OPEN',
      wa_contact_name: waContactName ?? conversation.wa_contact_name,
    },
  });

  // Mark any sent followups as REPLIED
  await followupsService.markReplied(tenantId, lead.id);

  // Emit to tenant socket room
  io.to(`tenant:${tenantId}`).emit('message:new', {
    message,
    lead: { id: lead.id, name: lead.name, phone: lead.phone },
    conversation_id: conversation.id,
  });

  // Trigger automations
  await automationsService.triggerFor(tenantId, 'MESSAGE_RECEIVED', lead.id, {
    message_type: msg.type,
    phone,
  });
}

// ─── Delivery status handler ──────────────────────────────────────────────────

async function handleStatusUpdate(tenantId: string, status: WaStatusUpdate) {
  const io = getIo();
  const now = new Date();

  const statusMap: Record<string, string> = {
    sent: 'SENT',
    delivered: 'DELIVERED',
    read: 'READ',
    failed: 'FAILED',
  };

  const mappedStatus = statusMap[status.status];
  if (!mappedStatus) return;

  const timestampField: Record<string, string> = {
    SENT: 'sent_at',
    DELIVERED: 'delivered_at',
    READ: 'read_at',
    FAILED: 'failed_at',
  };

  // Update Message table
  await prisma.message.updateMany({
    where: { wa_message_id: status.id, tenant_id: tenantId },
    data: {
      status: mappedStatus as 'SENT',
      [timestampField[mappedStatus]]: now,
      ...(status.errors?.[0] && { failure_reason: status.errors[0].title }),
    },
  });

  // Update BroadcastRecipient if this was a broadcast message
  await prisma.broadcastRecipient.updateMany({
    where: { wa_message_id: status.id },
    data: {
      status: mappedStatus as 'SENT',
      [timestampField[mappedStatus]]: now,
      ...(status.errors?.[0] && { failure_reason: status.errors[0].title }),
    },
  });

  // Update broadcast aggregate counters
  const recipient = await prisma.broadcastRecipient.findFirst({
    where: { wa_message_id: status.id },
    select: { broadcast_id: true },
  });

  if (recipient) {
    const counterField: Record<string, string> = {
      SENT: 'sent_count',
      DELIVERED: 'delivered_count',
      READ: 'read_count',
      FAILED: 'failed_count',
    };
    const field = counterField[mappedStatus];
    if (field) {
      await prisma.$executeRaw`
        UPDATE "Broadcast"
        SET ${field} = ${field} + 1
        WHERE id = ${recipient.broadcast_id}
      `;
    }

    // Trigger automation on read
    if (mappedStatus === 'READ') {
      const rec = await prisma.broadcastRecipient.findFirst({
        where: { wa_message_id: status.id },
        select: { lead_id: true, broadcast: { select: { tenant_id: true } } },
      });
      if (rec) {
        await automationsService.triggerFor(
          tenantId,
          'BROADCAST_READ',
          rec.lead_id,
          { broadcast_id: recipient.broadcast_id }
        );
      }
    }
  }

  // Emit status update to dashboard
  io.to(`tenant:${tenantId}`).emit('message:status', {
    wa_message_id: status.id,
    status: mappedStatus,
    timestamp: now,
  });
}

// ─── Template status handler ──────────────────────────────────────────────────

async function handleTemplateStatusUpdate(update: {
  message_template_id: string;
  event: string;
  reason?: string;
}) {
  await templatesService.syncStatusFromWebhook(
    String(update.message_template_id),
    update.event,
    update.reason
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveMessageType(type: string): 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'INTERACTIVE' | 'REACTION' | 'LOCATION' | 'STICKER' | 'UNSUPPORTED' {
  const map: Record<string, 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'INTERACTIVE' | 'REACTION' | 'LOCATION' | 'STICKER'> = {
    text: 'TEXT',
    image: 'IMAGE',
    video: 'VIDEO',
    audio: 'AUDIO',
    document: 'DOCUMENT',
    interactive: 'INTERACTIVE',
    reaction: 'REACTION',
    location: 'LOCATION',
    sticker: 'STICKER',
  };
  return map[type] ?? 'UNSUPPORTED';
}

function buildMessageContent(msg: WaInboundMessage): Record<string, unknown> {
  const content: Record<string, unknown> = { raw_type: msg.type };

  if (msg.text) content.text = msg.text.body;
  if (msg.image) content.image = msg.image;
  if (msg.video) content.video = msg.video;
  if (msg.audio) content.audio = msg.audio;
  if (msg.document) content.document = msg.document;
  if (msg.location) content.location = msg.location;
  if (msg.reaction) content.reaction = msg.reaction;
  if (msg.sticker) content.sticker = msg.sticker;
  if (msg.interactive) content.interactive = msg.interactive;
  if (msg.context) content.context = msg.context; // reply-to reference

  return content;
}

// ─── WA webhook payload types ─────────────────────────────────────────────────

interface WaContact {
  wa_id: string;
  profile?: { name?: string };
}

interface WaInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  document?: Record<string, unknown>;
  location?: Record<string, unknown>;
  reaction?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
  interactive?: Record<string, unknown>;
  context?: { from: string; id: string };
}

interface WaStatusUpdate {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: { code: number; title: string }[];
}
