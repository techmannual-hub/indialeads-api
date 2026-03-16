import http from 'http';
import { createApp } from './app';
import { initSocket } from './socket';
import { startCronJobs } from './cron';
import { env } from './config/env';
import prisma from './config/database';
import { getRedisClient } from './config/redis';

async function runSeed() {
  try {
    const bcrypt = await import('bcryptjs');
    const crypto = await import('crypto');

    // Check if demo user already exists
    const existing = await prisma.user.findUnique({
      where: { email: 'demo@indialeadscrm.com' },
    });

    if (existing) {
      console.log('✅ Demo account already exists, skipping seed');
      return;
    }

    console.log('🌱 Seeding demo account...');

    const tenant = await prisma.tenant.upsert({
      where: { slug: 'demo' },
      update: {},
      create: {
        name: 'Demo Company',
        slug: 'demo',
        is_demo: true,
        plan: 'STARTER',
        onboarding_done: true,
      },
    });

    const passwordHash = await bcrypt.default.hash('demo@1234', 12);
    const user = await prisma.user.upsert({
      where: { email: 'demo@indialeadscrm.com' },
      update: {},
      create: {
        tenant_id: tenant.id,
        email: 'demo@indialeadscrm.com',
        password_hash: passwordHash,
        name: 'Demo User',
      },
    });

    await prisma.license.upsert({
      where: { tenant_id: tenant.id },
      update: {},
      create: {
        tenant_id: tenant.id,
        license_key: `STARTER-${crypto.default.randomBytes(4).toString('hex').toUpperCase()}-DEMO`,
        plan: 'STARTER',
        status: 'ACTIVE',
        max_leads: 5000,
        max_messages: 1000,
      },
    });

    console.log(`✅ Seeded: ${user.email} / demo@1234`);
  } catch (err) {
    console.error('⚠️ Seed failed (non-fatal, app continues):', err);
    // Do NOT process.exit — let the app start anyway
  }
}

async function bootstrap() {
  try {
    await prisma.$connect();
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err);
    process.exit(1);
  }

  try {
    const redis = getRedisClient();
    await redis.ping();
    console.log('✅ Redis connected');
  } catch (err) {
    console.error('❌ Redis connection failed:', err);
    process.exit(1);
  }

  // Run seed (safe — won't crash the app if it fails)
  await runSeed();

  const app = createApp();
  const server = http.createServer(app);

  initSocket(server);
  startCronJobs();

  server.listen(env.PORT, () => {
    console.log(`🚀 IndiaLeads API running on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n⏳ ${signal} received — shutting down gracefully...`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
  process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); process.exit(1); });
}

bootstrap();
