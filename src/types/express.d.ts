import { Tenant, User } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      tenant: Tenant;
      user: User;
      tenantId: string;
    }
  }
}

export {};
