import { Request, Response } from 'express';
import { z } from 'zod';
import { tenantService } from './tenant.service';
import { asyncHandler } from '../../lib/errors';
import { success } from '../../lib/response';

const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
});

const waSettingsSchema = z.object({
  phone_number_id: z.string().min(1),
  wa_business_id: z.string().min(1),
  wa_access_token: z.string().min(1),
  wa_webhook_secret: z.string().min(8),
});

const onboardingSchema = z.object({
  step: z.number().int().min(0).max(5),
});

export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const profile = await tenantService.getProfile(req.tenantId);
  return success(res, profile);
});

export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const data = updateProfileSchema.parse(req.body);
  const tenant = await tenantService.updateProfile(req.tenantId, data);
  return success(res, tenant, 'Profile updated');
});

export const updateWaSettings = asyncHandler(async (req: Request, res: Response) => {
  const data = waSettingsSchema.parse(req.body);
  const tenant = await tenantService.updateWaSettings(req.tenantId, data);
  return success(res, tenant, 'WhatsApp settings saved');
});

export const getStats = asyncHandler(async (req: Request, res: Response) => {
  const stats = await tenantService.getStats(req.tenantId);
  return success(res, stats);
});

export const advanceOnboarding = asyncHandler(async (req: Request, res: Response) => {
  const { step } = onboardingSchema.parse(req.body);
  const tenant = await tenantService.advanceOnboarding(req.tenantId, step);
  return success(res, tenant, 'Onboarding progress saved');
});
