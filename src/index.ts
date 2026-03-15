import http from 'http';
import { createApp } from './app';
import { initSocket } from './socket';
import { startCronJobs } from './cron';
import { env } from './config/env';
import prisma from './config/database';
import { getRedisClient } from './config/redis';

async function bootstrap() {
  // Validate DB + Redis connections before accepting traffic
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

  const app = createApp();
  const server = http.createServer(app);

  // Socket.io
  initSocket(server);

  // Cron jobs
  startCronJobs();

  server.listen(env.PORT, () => {
    console.log(`🚀 IndiaLeads API running on port ${env.PORT} [${env.NODE_ENV}]`);
    console.log(`   API:     ${env.API_URL}`);
    console.log(`   Health:  ${env.API_URL}/health`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n⏳ ${signal} received — shutting down gracefully...`);
    server.close(async () => {
      await prisma.$disconnect();
      console.log('👋 Server closed');
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      console.error('🔥 Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
  });
}

bootstrap();
