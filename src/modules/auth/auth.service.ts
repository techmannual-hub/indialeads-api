import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../../config/database';
import { env } from '../../config/env';
import { hashString } from '../../lib/encryption';
import { AppError, ConflictError, UnauthorizedError } from '../../lib/errors';
import { JwtPayload, RefreshTokenPayload } from '../../types';
import { RegisterInput, LoginInput } from './auth.schema';

const SALT_ROUNDS = 12;

export class AuthService {
  async register(input: RegisterInput) {
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (existingUser) {
      throw new ConflictError('An account with this email already exists');
    }

    const existingTenant = await prisma.tenant.findUnique({
      where: { slug: input.company_slug },
    });
    if (existingTenant) {
      throw new ConflictError('This company slug is already taken');
    }

    const password_hash = await bcrypt.hash(input.password, SALT_ROUNDS);

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.company_name,
          slug: input.company_slug,
        },
      });

      const user = await tx.user.create({
        data: {
          tenant_id: tenant.id,
          email: input.email,
          password_hash,
          name: input.name,
        },
      });

      // Create a default FREE license
      await tx.license.create({
        data: {
          tenant_id: tenant.id,
          license_key: `FREE-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
          plan: 'FREE',
          status: 'TRIAL',
          max_leads: 500,
          max_messages: 200,
        },
      });

      return { tenant, user };
    });

    const tokens = await this._generateTokens(result.user.id, result.tenant.id, input.email);

    return {
      user: this._sanitizeUser(result.user),
      tenant: result.tenant,
      ...tokens,
    };
  }

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
      include: { tenant: true },
    });

    if (!user) {
      throw new UnauthorizedError('Invalid email or password');
    }

    const passwordValid = await bcrypt.compare(input.password, user.password_hash);
    if (!passwordValid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    if (!user.is_active) {
      throw new UnauthorizedError('Your account has been deactivated');
    }

    if (!user.tenant.is_active) {
      throw new UnauthorizedError('Your company account is inactive. Please contact support.');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });

    const tokens = await this._generateTokens(user.id, user.tenant_id, user.email);

    return {
      user: this._sanitizeUser(user),
      tenant: user.tenant,
      ...tokens,
    };
  }

  async refresh(refreshToken: string) {
    let payload: RefreshTokenPayload;
    try {
      payload = jwt.verify(refreshToken, env.REFRESH_TOKEN_SECRET) as RefreshTokenPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const tokenHash = hashString(refreshToken);
    const stored = await prisma.refreshToken.findUnique({
      where: { token_hash: tokenHash },
    });

    if (!stored || stored.expires_at < new Date()) {
      throw new UnauthorizedError('Refresh token not found or expired');
    }

    // Rotate: delete old, issue new
    await prisma.refreshToken.delete({ where: { id: stored.id } });

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { tenant: true },
    });

    if (!user || !user.is_active) {
      throw new UnauthorizedError('User not found or inactive');
    }

    return this._generateTokens(user.id, user.tenant_id, user.email);
  }

  async logout(refreshToken: string) {
    const tokenHash = hashString(refreshToken);
    await prisma.refreshToken.deleteMany({ where: { token_hash: tokenHash } });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) throw new UnauthorizedError('Current password is incorrect');

    const password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { password_hash } });

    // Invalidate all refresh tokens for this user
    await prisma.refreshToken.deleteMany({ where: { user_id: userId } });
  }

  private async _generateTokens(userId: string, tenantId: string, email: string) {
    const accessPayload: JwtPayload = { sub: userId, tenantId, email };
    const access_token = jwt.sign(accessPayload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });

    const tokenId = crypto.randomUUID();
    const rawRefresh = crypto.randomBytes(64).toString('hex');
    const refresh_token = jwt.sign(
      { sub: userId, tokenId } satisfies RefreshTokenPayload,
      env.REFRESH_TOKEN_SECRET,
      { expiresIn: env.REFRESH_TOKEN_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await prisma.refreshToken.create({
      data: {
        user_id: userId,
        token_hash: hashString(refresh_token),
        expires_at: expiresAt,
      },
    });

    return { access_token, refresh_token };
  }

  private _sanitizeUser(user: { id: string; email: string; name: string; avatar_url: string | null; tenant_id: string }) {
    const { id, email, name, avatar_url, tenant_id } = user;
    return { id, email, name, avatar_url, tenant_id };
  }
}

export const authService = new AuthService();
