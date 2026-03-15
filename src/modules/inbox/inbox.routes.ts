import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { waService } from '../whatsapp/whatsapp.service';
import { asyncHandler } from '../../lib/errors';
import { success, paginated } from '../../lib/response';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';
import { getIo } from '../../socket';

const router = Router();

// List conversations
router.get('/conversations', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, status } = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
    status: z.enum(['OPEN', 'RESOLVED', 'PENDING']).optional(),
  }).parse(req.query);

  const params = getPaginationParams(page, limit);
  const where: Prisma.ConversationWhereInput = { tenant_id: req.tenantId };
  if (status) where.status = status;

  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where,
      skip: params.skip,
      take: params.limit,
      orderBy: { last_message_at: 'desc' },
      include: {
        lead: { select: { name: true, phone: true, status: true } },
        messages: { orderBy: { created_at: 'desc' }, take: 1 },
      },
    }),
    prisma.conversation.count({ where }),
  ]);

  return paginated(res, conversations, buildPaginationMeta(total, params));
}));

// Get messages in a conversation
router.get('/conversations/:id/messages', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = z.object({
    page: z.string().optional(),
    limit: z.string().optional(),
  }).parse(req.query);

  const params = getPaginationParams(page, limit);

  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, tenant_id: req.tenantId },
  });
  if (!conversation) {
    return res.status(404).json({ success: false, message: 'Conversation not found' });
  }

  // Mark as read
  await prisma.conversation.update({
    where: { id: req.params.id },
    data: { unread_count: 0 },
  });

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { conversation_id: req.params.id, tenant_id: req.tenantId },
      skip: params.skip,
      take: params.limit,
      orderBy: { created_at: 'desc' },
    }),
    prisma.message.count({ where: { conversation_id: req.params.id } }),
  ]);

  return paginated(res, messages, buildPaginationMeta(total, params));
}));

// Send a text reply
router.post('/conversations/:id/reply', asyncHandler(async (req: Request, res: Response) => {
  const { text } = z.object({ text: z.string().min(1).max(4096) }).parse(req.body);
  const io = getIo();

  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, tenant_id: req.tenantId },
    include: { lead: { select: { phone: true } } },
  });
  if (!conversation) {
    return res.status(404).json({ success: false, message: 'Conversation not found' });
  }

  const waMessageId = await waService.sendText(
    req.tenantId,
    conversation.lead.phone,
    text
  );

  const message = await prisma.message.create({
    data: {
      tenant_id: req.tenantId,
      conversation_id: req.params.id,
      wa_message_id: waMessageId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      content: { text },
      status: 'SENT',
      sent_at: new Date(),
    },
  });

  await prisma.conversation.update({
    where: { id: req.params.id },
    data: { last_message_at: new Date() },
  });

  io.to(`tenant:${req.tenantId}`).emit('message:new', {
    message,
    conversation_id: req.params.id,
  });

  return success(res, message, 'Message sent');
}));

// Resolve / reopen conversation
router.patch('/conversations/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const { status } = z.object({
    status: z.enum(['OPEN', 'RESOLVED', 'PENDING']),
  }).parse(req.body);

  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, tenant_id: req.tenantId },
  });
  if (!conversation) {
    return res.status(404).json({ success: false, message: 'Conversation not found' });
  }

  const updated = await prisma.conversation.update({
    where: { id: req.params.id },
    data: { status },
  });

  return success(res, updated, `Conversation ${status.toLowerCase()}`);
}));

export default router;
