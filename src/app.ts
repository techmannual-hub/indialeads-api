import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { requestLogger } from './middleware/requestLogger';
import { globalRateLimiter } from './middleware/rateLimiter';
import { authMiddleware } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { env } from './config/env';

// Route imports
import authRoutes from './modules/auth/auth.routes';
import tenantRoutes from './modules/tenant/tenant.routes';
import leadsRoutes from './modules/leads/leads.routes';
import templatesRoutes from './modules/templates/templates.routes';
import broadcastsRoutes from './modules/broadcasts/broadcasts.routes';
import { followupsRouter } from './modules/followups/followups.service';
import automationsRoutes from './modules/automations/automations.routes';
import { whatsappRouter, webhookRouter } from './modules/whatsapp/whatsapp.routes';
import catalogRoutes from './modules/catalog/catalog.routes';
import analyticsRoutes from './modules/analytics/analytics.routes';
import storageRoutes from './modules/storage/storage.service';
import licenseRoutes from './modules/license/license.service';
import inboxRoutes from './modules/inbox/inbox.routes';

export function createApp(): Application {
  const app = express();

  // ── Security & parsing ─────────────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(cors());
app.options('*', cors());
  app.use(compression());
  app.use(requestLogger);

  // Raw body for webhook HMAC verification
  app.use('/webhooks', express.raw({ type: 'application/json' }));

  // JSON parsing for all other routes
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Global rate limiter ────────────────────────────────────────────────────
  app.use('/api', globalRateLimiter);

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString(), env: env.NODE_ENV });
  });

  // ── Public routes ──────────────────────────────────────────────────────────
  app.use('/api/auth', authRoutes);

  // WhatsApp webhook — public, HMAC-verified inside the handler
  app.use('/webhooks/whatsapp', webhookRouter);

  // ── Protected routes (all require auth) ───────────────────────────────────
  app.use('/api/tenant',      authMiddleware, tenantRoutes);
  app.use('/api/leads',       authMiddleware, leadsRoutes);
  app.use('/api/templates',   authMiddleware, templatesRoutes);
  app.use('/api/broadcasts',  authMiddleware, broadcastsRoutes);
  app.use('/api/followups',   authMiddleware, followupsRouter);
  app.use('/api/automations', authMiddleware, automationsRoutes);
  app.use('/api/whatsapp',    whatsappRouter);   // auth applied inside router
  app.use('/api/catalog',     authMiddleware, catalogRoutes);
  app.use('/api/analytics',   authMiddleware, analyticsRoutes);
  app.use('/api/storage',     authMiddleware, storageRoutes);
  app.use('/api/license',     authMiddleware, licenseRoutes);
  app.use('/api/inbox',       authMiddleware, inboxRoutes);

  // ── Error handling ─────────────────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
