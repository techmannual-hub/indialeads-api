import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import prisma from '../config/database';
import { JwtPayload } from '../types';
import { UnauthorizedError } from '../lib/errors';

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { tenant: true },
    });

    if (!user || !user.is_active) {
      throw new UnauthorizedError('User not found or inactive');
    }

    if (!user.tenant.is_active) {
      throw new UnauthorizedError('Tenant account is inactive');
    }

    req.user = user;
    req.tenant = user.tenant;
    req.tenantId = user.tenant_id;

    next();
  } catch (err) {
    next(err);
  }
}
