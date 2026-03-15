import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4000').transform(Number),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('30d'),

  // AWS S3
  AWS_REGION: z.string().default('ap-south-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(1),

  // WhatsApp Cloud API
  WA_APP_ID: z.string().optional(),
  WA_APP_SECRET: z.string().optional(),
  WA_VERIFY_TOKEN: z.string().min(1, 'WA_VERIFY_TOKEN is required for webhook setup'),
  WA_API_VERSION: z.string().default('v19.0'),
  WA_BASE_URL: z.string().default('https://graph.facebook.com'),

  // Encryption key for wa_access_token (32-byte hex = 64 chars)
  ENCRYPTION_KEY: z.string().min(32),

  // Rate limiting
  WA_MESSAGES_PER_SECOND: z.string().default('3').transform(Number),
  DAILY_MESSAGE_LIMIT: z.string().default('1000').transform(Number),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100').transform(Number),

  // URLs
  API_URL: z.string().default('http://localhost:4000'),
  DASHBOARD_URL: z.string().default('http://localhost:3001'),
  WEB_URL: z.string().default('http://localhost:3000'),

  // Broadcast delays (ms)
  BROADCAST_DELAY_MIN_MS: z.string().default('20000').transform(Number),
  BROADCAST_DELAY_MAX_MS: z.string().default('40000').transform(Number),

  // Cooling period
  COOLING_PERIOD_DAYS: z.string().default('7').transform(Number),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  parsed.error.errors.forEach((err) => {
    console.error(`  ${err.path.join('.')}: ${err.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
