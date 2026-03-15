import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { analyticsService } from './analytics.service';
import { asyncHandler } from '../../lib/errors';
import { success } from '../../lib/response';

const router = Router();

router.get('/dashboard', asyncHandler(async (req: Request, res: Response) => {
  const { days } = z.object({ days: z.string().optional() }).parse(req.query);
  const data = await analyticsService.getDashboard(req.tenantId, days ? parseInt(days) : 30);
  return success(res, data);
}));

router.get('/broadcasts/:id', asyncHandler(async (req: Request, res: Response) => {
  const data = await analyticsService.getBroadcastAnalytics(req.tenantId, req.params.id);
  return success(res, data);
}));

export default router;
