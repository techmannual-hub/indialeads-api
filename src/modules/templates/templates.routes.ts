import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { templatesService } from './templates.service';
import { asyncHandler } from '../../lib/errors';
import { success, created, paginated } from '../../lib/response';

// ── Schemas ─────────────────────────────────────────────────────────────────

const createTemplateSchema = z.object({
  name: z.string().min(1).max(512),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  language: z.string().default('en'),
  header: z
    .object({ type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']), value: z.string().optional() })
    .optional(),
  body: z.string().min(1).max(1024),
  footer: z.string().max(60).optional(),
  buttons: z.array(z.record(z.unknown())).optional(),
  variables: z.array(z.object({ key: z.string(), example: z.string() })).optional(),
});

// ── Controller handlers ──────────────────────────────────────────────────────

const listTemplates = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, status } = req.query;
  const { templates, pagination } = await templatesService.list(
    req.tenantId, page, limit, status as string
  );
  return paginated(res, templates, pagination);
});

const getTemplate = asyncHandler(async (req: Request, res: Response) => {
  const template = await templatesService.getById(req.tenantId, req.params.id);
  return success(res, template);
});

const createTemplate = asyncHandler(async (req: Request, res: Response) => {
  const input = createTemplateSchema.parse(req.body);
  const template = await templatesService.create(req.tenantId, input);
  return created(res, template, 'Template created');
});

const updateTemplate = asyncHandler(async (req: Request, res: Response) => {
  const input = createTemplateSchema.partial().parse(req.body);
  const template = await templatesService.update(req.tenantId, req.params.id, input);
  return success(res, template, 'Template updated');
});

const deleteTemplate = asyncHandler(async (req: Request, res: Response) => {
  await templatesService.delete(req.tenantId, req.params.id);
  return success(res, null, 'Template deleted');
});

const submitForApproval = asyncHandler(async (req: Request, res: Response) => {
  const template = await templatesService.submitForApproval(req.tenantId, req.params.id);
  return success(res, template, 'Template submitted for approval');
});

// ── Router ───────────────────────────────────────────────────────────────────

const router = Router();

router.get('/', listTemplates);
router.post('/', createTemplate);
router.get('/:id', getTemplate);
router.put('/:id', updateTemplate);
router.delete('/:id', deleteTemplate);
router.post('/:id/submit', submitForApproval);

export default router;
