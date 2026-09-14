import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';

const router = Router();

// ─── POST /api/sources ────────────────────────────────────────────────────────
// Returns the authenticated user's recent bot-saved SourceInput rows.
//
// Request body:  { initData: string }
// Response 200:  { sources: SourceDTO[] }
// Response 400:  missing / non-string initData
// Response 401:  invalid initData signature, or user not in DB
// Response 500:  DB error

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { initData } = req.body as { initData?: unknown };

  // ── 1. Validate initData presence ────────────────────────────────────────
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' });
    return;
  }

  // ── 2. Validate Telegram signature ───────────────────────────────────────
  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid initData',
    });
    return;
  }

  // ── 3. Resolve user ──────────────────────────────────────────────────────
  const telegramId = String(parsed.user.id);
  let dbUser: { id: string } | null = null;
  try {
    dbUser = await prisma.user.findUnique({
      where:  { telegramId },
      select: { id: true },
    });
  } catch (err) {
    console.error('[sources/post] User lookup failed:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  if (!dbUser) {
    res.status(401).json({ error: 'User not found. Please re-open the app.' });
    return;
  }

  // ── 4. Fetch recent SourceInputs ─────────────────────────────────────────
  let rows: {
    id:        string;
    type:      string;
    content:   string;
    url:       string | null;
    metadata:  unknown;
    createdAt: Date;
  }[] = [];

  try {
    rows = await prisma.sourceInput.findMany({
      where:   { userId: dbUser.id },
      orderBy: { createdAt: 'desc' },
      take:    20,
      select:  { id: true, type: true, content: true, url: true, metadata: true, createdAt: true },
    });
  } catch (err) {
    console.error('[sources/post] SourceInput query failed:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  // ── 5. Map and return ────────────────────────────────────────────────────
  // Extract channelId from metadata so the frontend doesn't need to parse it.
  res.json({
    sources: rows.map(s => {
      const meta = s.metadata as Record<string, unknown> | null;
      return {
        id:        s.id,
        type:      s.type,           // 'URL' | 'TEXT' (Prisma enum serialised as string)
        content:   s.content,
        url:       s.url,            // string | null
        channelId: typeof meta?.channelId === 'string' ? meta.channelId : null,
        createdAt: s.createdAt.toISOString(),
      };
    }),
  });
});

export default router;
