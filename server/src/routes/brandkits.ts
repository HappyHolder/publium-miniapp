import { assertStyleAccess } from '../lib/styleAccess';
import { assertMediaAccess } from '../lib/mediaAccess';
import { reserveSubscriptionQuota, refundSubscriptionQuota } from '../lib/subscriptionLimits';
import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import multer from 'multer';
import { putObject } from '../lib/storage';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { analyzeReferenceStyle } from '../lib/visionExtractor';
import { terraText } from '../lib/assistantModel';

// ─── Multer setup ─────────────────────────────────────────────────────────────
// Memory storage: file lives only in RAM (req.file.buffer), never on disk.
// Limit: 5 MB. Filter: JPEG, PNG, WebP only (SVG excluded — unsafe script risk).

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE_BYTES , files: 1, fields: 20, parts: 25, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Use JPEG, PNG or WebP.`));
    }
  },
});

// Separate multer for HTML template uploads (text/html, max 500 KB)
const uploadHtml = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 , files: 1, fields: 20, parts: 25, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'text/html' || file.originalname.endsWith('.html');
    ok ? cb(null, true) : cb(new Error('Only .html files are accepted for cover templates.'));
  },
});

// Multer for the Telegram channel export (result.json, max 30 MB — exports of
// channels with many posts can be large; only the message text is parsed out).
const uploadExport = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 30 * 1024 * 1024 , files: 1, fields: 20, parts: 25, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/json' || file.originalname.endsWith('.json');
    ok ? cb(null, true) : cb(new Error('Only the Telegram export result.json file is accepted.'));
  },
});

/**
 * Flattens a Telegram export message `text` field into a plain string.
 * In result.json `text` is either a string, or an array of (string | {text}).
 */
function flattenExportText(text: unknown): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) {
    return text
      .map(part => typeof part === 'string'
        ? part
        : (part && typeof part === 'object' && typeof (part as Record<string, unknown>)['text'] === 'string'
            ? (part as Record<string, unknown>)['text'] as string
            : ''))
      .join('');
  }
  return '';
}

/**
 * Extracts up to `limit` recent post texts from a Telegram channel export
 * (result.json). Keeps real posts (type 'message', non-trivial text), newest
 * first, each capped to ~1000 chars. Returns [] on any parse failure.
 */
function extractPostsFromExport(buf: Buffer, limit: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf-8'));
  } catch {
    return [];
  }
  const messages = (parsed && typeof parsed === 'object')
    ? (parsed as Record<string, unknown>)['messages']
    : null;
  if (!Array.isArray(messages)) return [];

  const posts: string[] = [];
  // Export lists messages oldest-first → walk from the end for the newest posts.
  for (let i = messages.length - 1; i >= 0 && posts.length < limit; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    if (msg['type'] !== 'message') continue; // skip service messages
    const text = flattenExportText(msg['text']).trim();
    // Skip empty / very short captions (links, single emoji, etc.)
    if (text.length < 30) continue;
    posts.push(text.slice(0, 1000));
  }
  return posts;
}


/** Strips non-safe characters from an original filename and caps length. */
function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
}

const router = Router();

// The 7 Channel Style section keys stored as Json? columns in BrandKit.
// Only keys in this list are accepted from the client — unknown keys are ignored.
const VALID_SECTIONS = [
  'channelAbout',
  'voiceProfile',
  'linkKit',
  'visualKit',
  'signature',
  'postRules',
] as const;

// ─── POST /api/brandkits/upload-asset ────────────────────────────────────────
//
// Uploads a BrandKit visual asset (logo or reference image) to local storage and
// returns the public URL. Does NOT write to the DB — the caller adds the URL to
// visualKit locally and persists via the existing PATCH endpoint.
//
// Request: multipart/form-data
//   initData   — Telegram WebApp initData string
//   channelId  — channel the asset belongs to
//   assetType  — "logo" | "reference"
//   file       — image file (JPEG / PNG / WebP, max 5 MB)
//
// Response 200: { url: string }
// Response 400: missing fields / unsupported file type
// Response 401: invalid initData / user not found
// Response 403: channel belongs to another user
// Response 404: channel not found
// Response 500: upload or DB error

router.post(
  '/upload-asset',
  upload.single('file'),   // multer parses multipart; populates req.file + req.body
  async (req: Request, res: Response): Promise<void> => {

    // ── 1. Extract fields from multipart body ───────────────────────────────
    const initData   = req.body['initData']   as unknown;
    const channelId  = req.body['channelId']  as unknown;
    const assetType  = req.body['assetType']  as unknown;
    const file       = req.file;

    // ── 2. Input validation ─────────────────────────────────────────────────
    if (typeof initData !== 'string' || !initData.trim()) {
      res.status(400).json({ error: 'initData is required' }); return;
    }
    if (typeof channelId !== 'string' || !channelId.trim()) {
      res.status(400).json({ error: 'channelId is required' }); return;
    }
    if (assetType !== 'logo' && assetType !== 'reference') {
      res.status(400).json({ error: 'assetType must be "logo" or "reference"' }); return;
    }
    if (!file) {
      res.status(400).json({ error: 'file is required' }); return;
    }

    // ── 3. Validate Telegram initData ───────────────────────────────────────
    let parsed;
    try {
      parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' }); return;
    }

    // ── 4. Resolve authenticated user ───────────────────────────────────────
    const telegramId = String(parsed.user.id);
    let dbUser: { id: string } | null = null;
    try {
      dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    } catch (err) {
      console.error('[brandkits/upload-asset] User lookup failed:', (err as Error).message);
      res.status(500).json({ error: 'Internal server error' }); return;
    }
    if (!dbUser) {
      res.status(401).json({ error: 'User not found. Please re-open the app.' }); return;
    }

    // ── 5. Confirm channel ownership ────────────────────────────────────────
    let channel: { userId: string } | null = null;
    try {
      channel = await prisma.channel.findUnique({
        where:  { id: channelId },
        select: { userId: true },
      });
    } catch (err) {
      console.error('[brandkits/upload-asset] Channel lookup failed:', (err as Error).message);
      res.status(500).json({ error: 'Internal server error' }); return;
    }
    if (!channel) {
      res.status(404).json({ error: 'Channel not found.' }); return;
    }
    if (channel.userId !== dbUser.id) {
      res.status(403).json({ error: 'This channel does not belong to your account.' }); return;
    }

    // ── 6. Build Blob storage path ──────────────────────────────────────────
    const safeName = safeFileName(file.originalname);
    const timestamp = Date.now();
    const pathname = assetType === 'logo'
      ? `brandkits/${channelId}/logo-${timestamp}-${safeName}`
      : `brandkits/${channelId}/references/ref-${timestamp}-${safeName}`;

    // ── 7. Upload to local storage ───────────────────────────────────────────
    let blobUrl: string;
    try {
      const obj = await putObject(pathname, file.buffer, {
        contentType: file.mimetype,
      });
      blobUrl = obj.url;
    } catch (err) {
      console.error('[brandkits/upload-asset] Blob upload failed:', (err as Error).message);
      res.status(500).json({ error: 'File upload failed. Try again.' }); return;
    }

    if (assetType === 'reference') {
      const description = await analyzeReferenceStyle(blobUrl);
      res.json({ url: blobUrl, description: description ?? undefined });
    } else {
      res.json({ url: blobUrl });
    }
  },
);

// ─── POST /api/brandkits/upload-html-template ────────────────────────────────
//
// Uploads a user-designed HTML cover template to local storage.
// The HTML is stored as-is; the renderer fetches it at cover-generation time
// and replaces {{slot}} placeholders with actual post content.
//
// Request: multipart/form-data
//   initData  — Telegram WebApp initData string
//   channelId — channel the template belongs to
//   file      — .html file (max 500 KB)
//
// Response 200: { url: string }
// Response 400/401/403/404/500: error

router.post(
  '/upload-html-template',
  uploadHtml.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    const initData  = req.body['initData']  as unknown;
    const channelId = req.body['channelId'] as unknown;
    const file      = req.file;

    if (typeof initData  !== 'string' || !initData.trim())  { res.status(400).json({ error: 'initData is required' });  return; }
    if (typeof channelId !== 'string' || !channelId.trim()) { res.status(400).json({ error: 'channelId is required' }); return; }
    if (!file) { res.status(400).json({ error: 'file is required' }); return; }

    let parsed;
    try {
      parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' }); return;
    }

    const telegramId = String(parsed.user.id);
    const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } }).catch(() => null);
    if (!dbUser) { res.status(401).json({ error: 'User not found.' }); return; }

    const channel = await prisma.channel.findUnique({ where: { id: channelId as string }, select: { userId: true } }).catch(() => null);
    if (!channel)                    { res.status(404).json({ error: 'Channel not found.' }); return; }
    if (channel.userId !== dbUser.id) { res.status(403).json({ error: 'Access denied.' }); return; }

    try {
      const safeName = safeFileName(file.originalname);
      const obj = await putObject(
        `brandkits/${channelId}/templates/cover-${Date.now()}-${safeName}`,
        file.buffer,
        { contentType: 'text/html; charset=utf-8' },
      );
      res.json({ url: obj.url });
    } catch (err) {
      console.error('[brandkits/upload-html-template] Blob upload failed:', (err as Error).message);
      res.status(500).json({ error: 'Upload failed. Try again.' });
    }
  },
);

// ─── POST /api/brandkits/upload-posts-export ─────────────────────────────────
//
// Parses a Telegram channel export (result.json) and returns the most recent
// post texts to use as few-shot voice examples. Does NOT write to the DB — the
// client stores the returned posts in voiceProfile.examplePosts via PATCH.
//
// Request: multipart/form-data { initData, channelId, file (result.json) }
// Response 200: { posts: string[] }

router.post(
  '/upload-posts-export',
  uploadExport.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    const initData  = req.body['initData']  as unknown;
    const channelId = req.body['channelId'] as unknown;
    const file      = req.file;

    if (typeof initData  !== 'string' || !initData.trim())  { res.status(400).json({ error: 'initData is required' });  return; }
    if (typeof channelId !== 'string' || !channelId.trim()) { res.status(400).json({ error: 'channelId is required' }); return; }
    if (!file) { res.status(400).json({ error: 'file is required' }); return; }

    let parsed;
    try {
      parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' }); return;
    }

    const telegramId = String(parsed.user.id);
    const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } }).catch(() => null);
    if (!dbUser) { res.status(401).json({ error: 'User not found.' }); return; }

    const channel = await prisma.channel.findUnique({ where: { id: channelId as string }, select: { userId: true } }).catch(() => null);
    if (!channel)                     { res.status(404).json({ error: 'Channel not found.' }); return; }
    if (channel.userId !== dbUser.id) { res.status(403).json({ error: 'Access denied.' }); return; }

    // Extract up to 10 newest posts; the client picks 5/10 to actually use.
    const posts = extractPostsFromExport(file.buffer, 10);
    if (posts.length === 0) {
      res.status(422).json({ error: 'Не удалось найти тексты постов в файле. Убедись, что это result.json экспорта канала.' });
      return;
    }
    res.json({ posts });
  },
);

// ─── PATCH /api/brandkits/:channelId ─────────────────────────────────────────
// Persists one or more Channel Style sections for the given channel.
// Only the keys present in `sections` are written — other columns are left as-is.
//
// Request body:  { initData: string, sections: Partial<BrandKit sections> }
// Response 200:  { ok: true }
// Response 400:  missing / invalid body, or no recognised section keys
// Response 401:  invalid initData signature, or user not in DB
// Response 403:  channel belongs to a different user
// Response 404:  channel not found in DB
// Response 500:  DB error

router.patch('/:channelId', async (req: Request, res: Response): Promise<void> => {
  const { channelId } = req.params as { channelId: string };
  const { initData, sections } = req.body as {
    initData?: unknown;
    sections?: unknown;
  };

  // ── 1. Basic input validation ─────────────────────────────────────────────
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' });
    return;
  }
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    res.status(400).json({ error: 'sections must be a non-null object' });
    return;
  }

  // ── 2. Extract only valid section keys, discard everything else ───────────
  const sectionsObj = sections as Record<string, unknown>;
  const updateData: Record<string, unknown> = {};
  for (const key of VALID_SECTIONS) {
    if (key in sectionsObj && sectionsObj[key] !== undefined) {
      updateData[key] = sectionsObj[key];
    }
  }
  if (Object.keys(updateData).length === 0) {
    res.status(400).json({ error: 'No valid section keys provided' });
    return;
  }

  // ── 3. Validate Telegram initData ────────────────────────────────────────
  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid initData',
    });
    return;
  }

  // ── 4. Resolve authenticated user ────────────────────────────────────────
  const telegramId = String(parsed.user.id);
  let dbUser: { id: string } | null = null;
  try {
    dbUser = await prisma.user.findUnique({
      where:  { telegramId },
      select: { id: true },
    });
  } catch (err) {
    console.error('[brandkits/patch] User lookup failed:', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
  if (!dbUser) {
    res.status(401).json({ error: 'User not found. Please re-open the app.' });
    return;
  }

  // ── 5. Find channel and verify ownership ─────────────────────────────────
  let channel: { id: string; userId: string } | null = null;
  try {
    channel = await prisma.channel.findUnique({
      where:  { id: channelId },
      select: { id: true, userId: true },
    });
  } catch (err) {
    console.error('[brandkits/patch] Channel lookup failed:', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
  if (!channel) {
    res.status(404).json({ error: 'Channel not found.' });
    return;
  }
  if (channel.userId !== dbUser.id) {
    res.status(403).json({ error: 'This channel does not belong to your account.' });
    return;
  }

  await assertStyleAccess(dbUser.id, updateData.visualKit);
  await assertMediaAccess(updateData, dbUser.id);

  // ── 6. Upsert BrandKit — write only the provided sections ────────────────
  // The values are JSON-parsed objects from Express, compatible with Prisma's
  // Json? column type at runtime. `as any` avoids re-typing the generated
  // Prisma input shape for nullable JSON fields.
  try {
    await prisma.brandKit.upsert({
      where:  { channelId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: updateData as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: { channelId, ...(updateData as any) },
    });
  } catch (err) {
    console.error('[brandkits/patch] BrandKit upsert failed:', err);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  res.json({ ok: true });
});

// ─── POST /api/brandkits/generate-cover-style ────────────────────────────────
// Uses the unified primary model to generate a visualCoverStyle string from the channel's
// current BrandKit settings (colors, topic, mood).
router.post('/generate-cover-style', async (req: Request, res: Response): Promise<void> => {
  const { initData, channelId, visualKit } = req.body as {
    initData?:  unknown;
    channelId?: unknown;
    visualKit?: unknown;
  };

  if (typeof initData  !== 'string' || !initData.trim())  { res.status(400).json({ error: 'initData required' });  return; }
  if (typeof channelId !== 'string' || !channelId.trim()) { res.status(400).json({ error: 'channelId required' }); return; }

  let parsed;
  try { parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN); }
  catch (err) { res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' }); return; }

  const telegramId = String(parsed.user.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } }).catch(() => null);
  if (!dbUser) { res.status(401).json({ error: 'User not found' }); return; }

  const channel = await prisma.channel.findFirst({ where: { id: channelId, userId: dbUser.id }, select: { id: true } });
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return; }
  // Load BrandKit for context
  const bk = await prisma.brandKit.findUnique({
    where:  { channelId: channelId as string },
    select: { channelAbout: true, visualKit: true },
  }).catch(() => null);

  if (!env.OPENAI_API_KEY) { res.status(503).json({ error: 'AI not configured' }); return; }

  // Build context from BrandKit
  const vk = (visualKit ?? bk?.visualKit ?? {}) as Record<string, unknown>;
  const about = (bk?.channelAbout ?? {}) as Record<string, unknown>;

  const contextParts: string[] = [];
  if (typeof about['topic'] === 'string' && about['topic'])
    contextParts.push(`Channel topic: ${about['topic']}`);
  if (typeof about['targetAudience'] === 'string' && about['targetAudience'])
    contextParts.push(`Audience: ${about['targetAudience']}`);

  const rawColors = vk['brandColors'];
  if (Array.isArray(rawColors) && rawColors.length > 0) {
    const colorParts: string[] = [];
    for (const c of rawColors.slice(0, 5) as { name?: unknown; hex?: unknown }[]) {
      if (typeof c.hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c.hex)) {
        const name = typeof c.name === 'string' && c.name ? c.name : c.hex;
        colorParts.push(`${name} ${c.hex}`);
      }
    }
    if (colorParts.length > 0) contextParts.push(`Brand colors: ${colorParts.join(', ')}`);
  }

  const avoidList = vk['avoidList'];
  if (Array.isArray(avoidList) && avoidList.length > 0)
    contextParts.push(`Avoid in visuals: ${(avoidList as string[]).join(', ')}`);

  const hasLogo = typeof vk['logoUrl'] === 'string' && (vk['logoUrl'] as string).startsWith('http');
  if (hasLogo) contextParts.push('Brand has a logo that will be placed in the top-right corner of covers.');

  const systemPrompt =
    'You are a visual art director. Given a brand\'s style profile, write a concise cover style description (50-80 words) ' +
    'that will be used as the base prompt for all AI-generated post covers. ' +
    'Include: background style, dominant colors with exact hex codes, visual mood, key visual elements. ' +
    'Write in English. Output ONLY the style description, nothing else.';

  const userPrompt = contextParts.join('\n') + '\n\nWrite the cover style description:';

  const quota = await reserveSubscriptionQuota(dbUser.id, 'assistant');
  if (!quota.ok) { res.status(429).json({ error: 'Лимит AI исчерпан.' }); return; }
  try {
    const style = (await terraText({
      system: systemPrompt,
      prompt: userPrompt,
      maxTokens: 200,
      timeoutMs: 30_000,
      effort: 'low',
    }))?.trim() ?? '';
    res.json({ style });
  } catch (err) {
    await refundSubscriptionQuota(dbUser.id, 'assistant');
    console.error('[brandkits/generate-cover-style] Error:', (err as Error).message);
    res.status(500).json({ error: 'Generation failed' });
  }
});

export default router;
