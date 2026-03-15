import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { broadcastsService } from './broadcasts.service';
import { asyncHandler } from '../../lib/errors';
import { success, created, paginated } from '../../lib/response';

// ── Schemas ──────────────────────────────────────────────────────────────────

const createBroadcastSchema = z.object({
  name: z.string().min(1).max(200),
  template_id: z.string().min(1),
  variable_map: z.record(z.string()).optional(),
  filters: z.record(z.unknown()).optional(),
  scheduled_at: z.string().datetime().optional(),
});

// ── Handlers ─────────────────────────────────────────────────────────────────

const listBroadcasts = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query;
  const { broadcasts, pagination } = await broadcastsService.list(req.tenantId, page, limit);
  return paginated(res, broadcasts, pagination);
});

const getBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const broadcast = await broadcastsService.getById(req.tenantId, req.params.id);
  return success(res, broadcast);
});

const createBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const input = createBroadcastSchema.parse(req.body);
  const broadcast = await broadcastsService.create(req.tenantId, input);
  return created(res, broadcast, 'Broadcast created');
});

const startBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const result = await broadcastsService.start(req.tenantId, req.params.id);
  return success(res, result, 'Broadcast started');
});

const pauseBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const broadcast = await broadcastsService.pause(req.tenantId, req.params.id);
  return success(res, broadcast, 'Broadcast paused');
});

const resumeBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const result = await broadcastsService.resume(req.tenantId, req.params.id);
  return success(res, result, 'Broadcast resumed');
});

const getRecipients = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = req.query;
  const { recipients, pagination } = await broadcastsService.getRecipients(
    req.tenantId, req.params.id, page, limit
  );
  return paginated(res, recipients, pagination);
});

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();

router.get('/', listBroadcasts);
router.post('/', createBroadcast);
router.get('/:id', getBroadcast);
router.post('/:id/start', startBroadcast);
router.post('/:id/pause', pauseBroadcast);
router.post('/:id/resume', resumeBroadcast);
router.get('/:id/recipients', getRecipients);

export default router;
