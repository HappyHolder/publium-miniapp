import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import multer from 'multer';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { classifyDoc, extractDocText } from '../lib/docExtractor';

// ─── Project documents ────────────────────────────────────────────────────────
// A channel's knowledge base for the AI content manager. The user uploads a
// whitepaper / pitch deck / roadmap; we extract plain text (pdf-parse / mammoth)
// and store it so the assistant can base a post series on it. The raw file is
// NOT persisted — only the extracted text. See docs/content-manager-plan.md.

// Decks and whitepapers can be sizeable → 15 MB cap (only the text is kept).
const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_DOCS_PER_CHANNEL = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_FILE_SIZE_BYTES , files: 1, fields: 20, parts: 25, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Gate on the same kinds docExtractor understands (PDF/DOCX/MD/TXT).
    if (classifyDoc(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Use PDF, DOCX, Markdown or TXT.'));
    }
  },
});

const router = Router();

/**
 * Resolves the authenticated user and verifies they own `channelId`.
 * Writes the appropriate error response and returns null on any failure.
 */
async function authChannel(
  res: Response,
  initData: unknown,
  channelId: unknown,
): Promise<{ userId: string } | null> {
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' }); return null;
  }
  if (typeof channelId !== 'string' || !channelId.trim()) {
    res.status(400).json({ error: 'channelId is required' }); return null;
  }

  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' }); return null;
  }

  const telegramId = String(parsed.user.id);
  const dbUser = await prisma.user
    .findUnique({ where: { telegramId }, select: { id: true } })
    .catch(() => null);
  if (!dbUser) {
    res.status(401).json({ error: 'User not found. Please re-open the app.' }); return null;
  }

  const channel = await prisma.channel
    .findUnique({ where: { id: channelId }, select: { userId: true } })
    .catch(() => null);
  if (!channel) {
    res.status(404).json({ error: 'Channel not found.' }); return null;
  }
  if (channel.userId !== dbUser.id) {
    res.status(403).json({ error: 'This channel does not belong to your account.' }); return null;
  }

  return { userId: dbUser.id };
}

// ─── POST /api/project-docs/upload ────────────────────────────────────────────
// multipart: { initData, channelId, file }
// Response 200: { doc: { id, name, mime, sizeBytes, createdAt, truncated } }
router.post(
  '/upload',
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    const auth = await authChannel(res, req.body['initData'], req.body['channelId']);
    if (!auth) return;

    const channelId = req.body['channelId'] as string;
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'file is required' }); return; }

    // Enforce a per-channel cap so the knowledge base stays prompt-sized.
    const count = await prisma.projectDoc.count({ where: { channelId } }).catch(() => 0);
    if (count >= MAX_DOCS_PER_CHANNEL) {
      res.status(409).json({ error: `Limit reached: max ${MAX_DOCS_PER_CHANNEL} documents per channel.` });
      return;
    }

    let extracted;
    try {
      extracted = await extractDocText(file.buffer, file.mimetype, file.originalname);
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : 'Could not read the document.' });
      return;
    }

    try {
      const doc = await prisma.projectDoc.create({
        data: {
          channelId,
          name: file.originalname.slice(0, 200),
          mime: file.mimetype,
          sizeBytes: file.size,
          text: extracted.text,
        },
        select: { id: true, name: true, mime: true, sizeBytes: true, createdAt: true },
      });
      res.json({ doc: { ...doc, truncated: extracted.truncated } });
    } catch (err) {
      console.error('[project-docs/upload] create failed:', (err as Error).message);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ─── POST /api/project-docs/list ──────────────────────────────────────────────
// json: { initData, channelId }
// Response 200: { docs: [{ id, name, mime, sizeBytes, createdAt }] } (no full text)
router.post('/list', async (req: Request, res: Response): Promise<void> => {
  const auth = await authChannel(res, req.body?.['initData'], req.body?.['channelId']);
  if (!auth) return;

  const channelId = req.body['channelId'] as string;
  try {
    const docs = await prisma.projectDoc.findMany({
      where: { channelId },
      select: { id: true, name: true, mime: true, sizeBytes: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ docs });
  } catch (err) {
    console.error('[project-docs/list] failed:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/project-docs/delete ────────────────────────────────────────────
// json: { initData, channelId, docId }
// Response 200: { ok: true }
router.post('/delete', async (req: Request, res: Response): Promise<void> => {
  const auth = await authChannel(res, req.body?.['initData'], req.body?.['channelId']);
  if (!auth) return;

  const channelId = req.body['channelId'] as string;
  const docId = req.body['docId'] as unknown;
  if (typeof docId !== 'string' || !docId.trim()) {
    res.status(400).json({ error: 'docId is required' }); return;
  }

  try {
    // Scope the delete to the owned channel so a valid docId from another
    // channel can't be removed.
    const result = await prisma.projectDoc.deleteMany({ where: { id: docId, channelId } });
    if (result.count === 0) { res.status(404).json({ error: 'Document not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[project-docs/delete] failed:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
