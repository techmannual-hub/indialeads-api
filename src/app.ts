import express from 'express';
import cors from 'cors';

const app = express();

// CORS - allow everything
app.use(cors());
app.options('*', cors());

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString(), env: process.env.NODE_ENV });
});

// Routes
import('./modules/auth/auth.routes').then(m => app.use('/api/auth', m.default));
import('./modules/tenant/tenant.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/tenant', a.authMiddleware, m.default));
});
import('./modules/leads/leads.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/leads', a.authMiddleware, m.default));
});
import('./modules/broadcasts/broadcasts.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/broadcasts', a.authMiddleware, m.default));
});
import('./modules/templates/templates.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/templates', a.authMiddleware, m.default));
});
import('./modules/inbox/inbox.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/inbox', a.authMiddleware, m.default));
});
import('./modules/analytics/analytics.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/analytics', a.authMiddleware, m.default));
});
import('./modules/catalog/catalog.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/catalog', a.authMiddleware, m.default));
});
import('./modules/automations/automations.routes').then(m => {
  import('./middleware/auth').then(a => app.use('/api/automations', a.authMiddleware, m.default));
});
import('./modules/followups/followups.service').then(m => {
  import('./middleware/auth').then(a => app.use('/api/followups', a.authMiddleware, m.followupsRouter));
});
import('./modules/whatsapp/whatsapp.routes').then(m => {
  app.use('/api/whatsapp', m.whatsappRouter);
  app.use('/webhooks/whatsapp', m.webhookRouter);
});
import('./modules/storage/storage.service').then(m => {
  import('./middleware/auth').then(a => app.use('/api/storage', a.authMiddleware, m.default));
});
import('./modules/license/license.service').then(m => {
  import('./middleware/auth').then(a => app.use('/api/license', a.authMiddleware, m.default));
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message });
});

export function createApp() { return app; }
export default app;
```

Commit → wait for Railway to redeploy → then check:
```
https://indialeads-api-production.up.railway.app/health
