import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { automationsService } from './automations.service';
import { asyncHandler } from '../../lib/errors';
import { success, created, paginated } from '../../lib/response';

const conditionSchema = z.object({
  field: z.string(),
  operator: z.enum(['eq', 'neq', 'contains', 'in', 'gt', 'lt']),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
});

const actionSchema = z.object({
  type: z.enum(['SEND_MESSAGE', 'UPDATE_STATUS', 'ADD_TAG', 'UPDATE_STAGE', 'WAIT']),
  templateId: z.string().optional(),
  status: z.string().optional(),
  tagId: z.string().optional(),
  stage: z.string().optional(),
  delayHours: z.number().optional(),
  messageText: z.string().optional(),
});

const createAutomationSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  trigger: z.enum([
    'LEAD_CREATED', 'LEAD_STATUS_CHANGED', 'LEAD_TAG_ADDED',
    'MESSAGE_RECEIVED', 'BROADCAST_READ', 'DATE_BASED',
  ]),
  conditions: z.array(conditionSchema).optional(),
  actions: z.array(actionSchema).min(1),
});

const router = Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query;
  const { automations, pagination } = await automationsService.list(req.tenantId, page, limit);
  return paginated(res, automations, pagination);
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const input = createAutomationSchema.parse(req.body);
  const automation = await automationsService.create(req.tenantId, input);
  return created(res, automation, 'Automation created');
}));

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const automation = await automationsService.getById(req.tenantId, req.params.id);
  return success(res, automation);
}));

router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const input = createAutomationSchema.partial().parse(req.body);
  const automation = await automationsService.update(req.tenantId, req.params.id, input);
  return success(res, automation, 'Automation updated');
}));

router.patch('/:id/toggle', asyncHandler(async (req: Request, res: Response) => {
  const { is_active } = z.object({ is_active: z.boolean() }).parse(req.body);
  const automation = await automationsService.update(req.tenantId, req.params.id, { is_active });
  return success(res, automation);
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await automationsService.delete(req.tenantId, req.params.id);
  return success(res, null, 'Automation deleted');
}));

export default router;
