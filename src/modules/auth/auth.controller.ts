import { Request, Response } from 'express';
import { authService } from './auth.service';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  changePasswordSchema,
} from './auth.schema';
import { asyncHandler } from '../../lib/errors';
import { success, created, error } from '../../lib/response';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { body } = registerSchema.parse({ body: req.body });
  const result = await authService.register(body);
  return created(res, result, 'Account created successfully');
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { body } = loginSchema.parse({ body: req.body });
  const result = await authService.login(body);
  return success(res, result, 'Login successful');
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const { body } = refreshTokenSchema.parse({ body: req.body });
  const tokens = await authService.refresh(body.refresh_token);
  return success(res, tokens, 'Token refreshed');
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { body } = refreshTokenSchema.parse({ body: req.body });
  await authService.logout(body.refresh_token);
  return success(res, null, 'Logged out successfully');
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  const { id, email, name, avatar_url, tenant_id } = req.user;
  return success(res, { id, email, name, avatar_url, tenant_id, tenant: req.tenant });
});

export const changePassword = asyncHandler(async (req: Request, res: Response) => {
  const { body } = changePasswordSchema.parse({ body: req.body });
  await authService.changePassword(req.user.id, body.current_password, body.new_password);
  return success(res, null, 'Password changed successfully');
});
