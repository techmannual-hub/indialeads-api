import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { waService } from './whatsapp.service';
import { verifyWebhook, handleWebhook, verifyHmacSignature } from './whatsapp.webhook';
import { authMiddleware } from '../../middleware/auth';
import { asyncHandler } from '../../lib/errors';
import { success } from '../../lib/response';

// ── Schemas ──────────────────────────────────────────────────────────────────

const sendTextSchema = z.object({
  lead_id: z.string(),
  phone: z.string(),
  text: z.string().min(1).max(4096),
});

const sendTemplateSchema = z.object({
  phone: z.string(),
  template_id: z.string(),
  variable_values: z.record(z.string()).optional(),
});

const sendMediaSchema = z.object({
  phone: z.string(),
  media_id: z.string(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

const sendButtonsSchema = z.object({
  phone: z.string(),
  body_text: z.string(),
  buttons: z.array(z.object({ id: z.string(), title: z.string().max(20) })).min(1).max(3),
});

const sendCatalogSchema = z.object({
  phone: z.string(),
  catalog_id: z.string(),
  product_retailer_id: z.string(),
  body_text: z.string().optional(),
});

// ── Protected send routes ─────────────────────────────────────────────────────

const protectedRouter = Router();
protectedRouter.use(authMiddleware);

protectedRouter.post('/send/text', asyncHandler(async (req: Request, res: Response) => {
  const { phone, text } = sendTextSchema.parse(req.body);
  const messageId = await waService.sendText(req.tenantId, phone, text);
  return success(res, { wa_message_id: messageId }, 'Message sent');
}));

protectedRouter.post('/send/template', asyncHandler(async (req: Request, res: Response) => {
  const { phone, template_id, variable_values } = sendTemplateSchema.parse(req.body);

  const { prisma } = await import('../../config/database');
  const template = await prisma.template.findFirst({
    where: { id: template_id, tenant_id: req.tenantId },
  });
  if (!template) {
    return res.status(404).json({ success: false, message: 'Template not found' });
  }

  const messageId = await waService.sendTemplateMessage(
    req.tenantId, phone, template, variable_values
  );
  return success(res, { wa_message_id: messageId }, 'Template message sent');
}));

protectedRouter.post('/send/image', asyncHandler(async (req: Request, res: Response) => {
  const { phone, media_id, caption } = sendMediaSchema.parse(req.body);
  const messageId = await waService.sendImage(req.tenantId, phone, media_id, caption);
  return success(res, { wa_message_id: messageId }, 'Image sent');
}));

protectedRouter.post('/send/document', asyncHandler(async (req: Request, res: Response) => {
  const { phone, media_id, caption, filename } = sendMediaSchema.parse(req.body);
  const messageId = await waService.sendDocument(
    req.tenantId, phone, media_id, filename ?? 'document', caption
  );
  return success(res, { wa_message_id: messageId }, 'Document sent');
}));

protectedRouter.post('/send/buttons', asyncHandler(async (req: Request, res: Response) => {
  const { phone, body_text, buttons } = sendButtonsSchema.parse(req.body);
  const messageId = await waService.sendInteractiveButtons(
    req.tenantId, phone, body_text, buttons
  );
  return success(res, { wa_message_id: messageId }, 'Interactive message sent');
}));

protectedRouter.post('/send/catalog', asyncHandler(async (req: Request, res: Response) => {
  const { phone, catalog_id, product_retailer_id, body_text } = sendCatalogSchema.parse(req.body);
  const messageId = await waService.sendCatalogProduct(
    req.tenantId, phone, catalog_id, product_retailer_id, body_text
  );
  return success(res, { wa_message_id: messageId }, 'Catalog product sent');
}));

// ── Public webhook routes (no auth — verified by HMAC/token) ─────────────────

const webhookRouter = Router();
webhookRouter.get('/', verifyWebhook);
webhookRouter.post('/', verifyHmacSignature as unknown as Parameters<typeof webhookRouter.post>[1], handleWebhook);

export { protectedRouter as whatsappRouter, webhookRouter };
