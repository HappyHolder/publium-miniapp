import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { env } from './env';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import channelsRouter from './routes/channels';
import chatsRouter from './routes/chats';
import brandkitsRouter from './routes/brandkits';
import botRouter from './routes/bot';
import moderatorRouter from './routes/moderator';
import moderatorConfigRouter from './routes/moderatorConfig';
import communityManagerRouter from './routes/communityManager';
import communityCoreRouter from './routes/communityCore';
import sourcesRouter from './routes/sources';
import postsRouter from './routes/posts';
import chatRouter from './routes/chat';
import adminRouter from './routes/admin';
import promoRouter from './routes/promo';
import paymentsRouter from './routes/payments';
import stylesRouter from './routes/styles';
import projectDocsRouter from './routes/projectDocs';
import roleKnowledgeDocsRouter from './routes/roleKnowledgeDocs';
import contentPlanRouter from './routes/contentPlan';
import ogRouter from './routes/og';
import { startScheduler } from './lib/scheduler';
import { resumeGeneratingPlans } from './lib/contentWorker';
import { rateLimit } from './lib/rateLimit';
import { startCommunityManagerWorker } from './communityManager/engine';
import { startCommunityActivityScheduler } from './communityManager/activityScheduler';
import { startCommunityCoreRuntime } from './communityCore/engine';

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');
const productionOrigin = new URL(env.PUBLIC_BASE_URL).origin;
app.use(cors({
  origin: (origin, callback) => callback(null, !origin || env.NODE_ENV !== 'production' || origin === productionOrigin),
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '128kb' }));
const moderatorSessionLimit = rateLimit({ windowMs: 60_000, max: 15 });
const moderatorApiLimit = rateLimit({ windowMs: 60_000, max: 120, skip: req => req.path.startsWith('/webhook') });
app.use('/api/auth/moderator-session', moderatorSessionLimit);
app.use('/api/moderator', moderatorApiLimit);
app.use('/api/moderator-config', moderatorApiLimit);

// ─── Static file storage (replaces Vercel Blob) ─────────────────────────────────
// Serve uploaded/generated files at /uploads. In production nginx serves this
// path directly from the same volume for speed; this handler is the dev server
// and a safe fallback. The directory is created on boot so static serving works
// before the first upload.
fs.mkdirSync(env.STORAGE_DIR, { recursive: true });
app.use('/uploads', (req, res, next) => { if (/\.(html?|xhtml)$/i.test(req.path)) { res.sendStatus(404); return; } next(); });
app.use('/uploads', express.static(env.STORAGE_DIR, {
  maxAge: '30d',
  immutable: true,
  // Stored-XSS guard: never serve uploaded HTML/SVG as executable content.
  // (In production Caddy does the same; this covers the dev server and is a
  // defense-in-depth fallback.) Templates are only fetched server-side.
  setHeaders: (res, filePath) => {
    if (/\.(html?|xhtml|svg)$/i.test(filePath)) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  },
}));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/health',   healthRouter);
app.use('/api/auth',     authRouter);
app.use('/api/channels',  channelsRouter);
app.use('/api/chats',     chatsRouter);
app.use('/api/brandkits', brandkitsRouter);
app.use('/api/bot',       botRouter);
app.use('/api/moderator', moderatorRouter);
app.use('/api/moderator-config', moderatorConfigRouter);
app.use('/api/community-manager', moderatorApiLimit, communityManagerRouter);
app.use('/api/community-core', moderatorApiLimit, communityCoreRouter);
app.use('/api/sources',   sourcesRouter);
app.use('/api/posts',     postsRouter);
app.use('/api/chat',      chatRouter);
app.use('/api/admin',     adminRouter);
app.use('/api/promo',     promoRouter);
app.use('/api/payments',  paymentsRouter);
app.use('/api/styles',    stylesRouter);
app.use('/api/project-docs', projectDocsRouter);
app.use('/api/role-knowledge-docs', moderatorApiLimit, roleKnowledgeDocsRouter);
app.use('/api/content-plan', contentPlanRouter);
app.use('/api/og',        ogRouter);

app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(error); return; }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  console.error('[api] request failed:', error instanceof Error ? error.message : 'Unknown error');
  res.status(status).json({ error: status < 500 ? error.message : 'Ошибка сервера. Повторите запрос.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  console.log(
    `[publium-api] Running on port ${env.PORT} (${env.NODE_ENV})`
  );
  startScheduler();
  startCommunityManagerWorker();
  startCommunityActivityScheduler();
  startCommunityCoreRuntime().catch(err => console.error('[community-core] boot failed:', (err as Error).message));
  setInterval(() => { void resumeGeneratingPlans().catch(error => console.error('[content-worker] resume failed', error.message)); }, 60_000).unref();
  // Resume any content-manager plans interrupted by a restart.
  resumeGeneratingPlans().catch(err =>
    console.error('[content-worker] resume failed:', (err as Error).message));
});

export default app;
