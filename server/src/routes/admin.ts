import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { putObject } from '../lib/storage';
import { renderHtmlPreview } from '../lib/playwrightRenderer';
import { serializeStyle } from '../lib/styles';
import { Prisma } from '@prisma/client';
import type { PlanTier } from '@prisma/client';

const router = Router();

// Multer for admin HTML template uploads (text/html, max 500 KB) — mirrors the
// brandkits uploader.
const uploadHtml = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 , files: 1, fields: 20, parts: 25, fieldSize: 64 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'text/html' || file.originalname.endsWith('.html');
    ok ? cb(null, true) : cb(new Error('Only .html files are accepted.'));
  },
});

/** Strips non-safe characters from an original filename and caps length. */
function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
}

const VALID_TIERS: PlanTier[] = ['STARTER', 'CREATOR', 'STUDIO_PRO'];

// Unambiguous alphabet (no 0/O/1/I) for human-friendly codes.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCodeSegment(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    // crypto.randomInt — cryptographically secure, unbiased over the alphabet
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/** Builds a readable code like "CF-AB3K-9XQ2". */
function buildCode(): string {
  return `CF-${generateCodeSegment(4)}-${generateCodeSegment(4)}`;
}

/**
 * Resolves the authenticated Telegram user and verifies admin membership.
 * Returns the telegramId on success, or writes an error response and returns null.
 */
function requireAdmin(initData: unknown, res: Response): string | null {
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' });
    return null;
  }
  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : 'Invalid initData' });
    return null;
  }
  const telegramId = String(parsed.user.id);
  if (!env.ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return telegramId;
}

// ─── POST /api/admin/promo/create ─────────────────────────────────────────────
// Generates a single-use promo code granting `tier` for `durationDays` days.
// Admin-only. Request body: { initData, tier, durationDays }
// Response 200: { code: { code, tier, durationDays, createdAt } }

router.post('/promo/create', async (req: Request, res: Response): Promise<void> => {
  const { initData, tier, durationDays } = req.body as {
    initData?: unknown; tier?: unknown; durationDays?: unknown;
  };

  const adminId = requireAdmin(initData, res);
  if (!adminId) return;

  if (typeof tier !== 'string' || !VALID_TIERS.includes(tier as PlanTier)) {
    res.status(400).json({ error: `tier must be one of: ${VALID_TIERS.join(', ')}` });
    return;
  }
  const days = Number(durationDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    res.status(400).json({ error: 'durationDays must be an integer between 1 and 3650' });
    return;
  }

  // Generate a unique code (retry on the rare collision).
  let code = buildCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const exists = await prisma.promoCode.findUnique({ where: { code }, select: { id: true } }).catch(() => null);
    if (!exists) break;
    code = buildCode();
  }

  try {
    const created = await prisma.promoCode.create({
      data: { code, tier: tier as PlanTier, durationDays: days, createdById: adminId },
      select: { code: true, tier: true, durationDays: true, createdAt: true },
    });
    res.json({ code: { ...created, createdAt: created.createdAt.toISOString() } });
  } catch (err) {
    console.error('[admin/promo/create] DB error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/admin/promo/list ───────────────────────────────────────────────
// Lists issued promo codes (newest first, capped). Admin-only.
// Request body: { initData }
// Response 200: { codes: PromoCodeRow[] }

router.post('/promo/list', async (req: Request, res: Response): Promise<void> => {
  const { initData } = req.body as { initData?: unknown };
  const adminId = requireAdmin(initData, res);
  if (!adminId) return;

  try {
    const rows = await prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
      take:    100,
      select:  { code: true, tier: true, durationDays: true, redeemedAt: true, createdAt: true },
    });
    res.json({
      codes: rows.map(r => ({
        code:         r.code,
        tier:         r.tier,
        durationDays: r.durationDays,
        redeemed:     r.redeemedAt !== null,
        redeemedAt:   r.redeemedAt?.toISOString() ?? null,
        createdAt:    r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('[admin/promo/list] DB error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Styles market admin ──────────────────────────────────────────────────────
// All admin-only. The catalog the public sees lives behind /api/styles/list;
// these manage it.

const VALID_MODES = ['html', 'ai', 'ai_html'];
const VALID_PRICE_KINDS = ['FREE', 'PAID'];

interface StyleInput {
  id?: string;
  slug?: string;
  nameRu?: string; nameEn?: string;
  descRu?: string; descEn?: string;
  tags?: unknown;
  priceKind?: string;
  priceStars?: unknown; priceGram?: unknown;
  brandAdaptive?: unknown;
  recommendedMode?: string;
  palette?: unknown;
  visualCoverStyle?: string;
  bgStyle?: unknown; bgDetail?: unknown; fontPreset?: unknown; logoUsage?: unknown;
  templates?: unknown;
  carouselTemplate?: unknown;
  published?: unknown;
  sortOrder?: unknown;
}

/** Coerces a value to a clean string array (drops non-strings). */
function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
/** Returns the value if it's a non-empty string, else null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

// POST /api/admin/styles/list — every style (incl. drafts), newest sortOrder first.
router.post('/styles/list', async (req: Request, res: Response): Promise<void> => {
  const { initData } = req.body as { initData?: unknown };
  if (!requireAdmin(initData, res)) return;
  try {
    const styles = await prisma.style.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    res.json({ styles: styles.map(s => ({ ...serializeStyle(s), published: s.published, createdBy: s.createdBy, updatedAt: s.updatedAt.toISOString() })) });
  } catch (err) {
    console.error('[admin/styles/list] DB error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/styles/upsert — create (no id) or update (id present).
router.post('/styles/upsert', async (req: Request, res: Response): Promise<void> => {
  const { initData, style } = req.body as { initData?: unknown; style?: StyleInput };
  const adminId = requireAdmin(initData, res);
  if (!adminId) return;
  if (!style || typeof style !== 'object') { res.status(400).json({ error: 'style object is required' }); return; }

  const slug = strOrNull(style.slug)?.trim().toLowerCase();
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) { res.status(400).json({ error: 'slug must be kebab-case (a-z, 0-9, -)' }); return; }
  if (!strOrNull(style.nameRu) || !strOrNull(style.nameEn)) { res.status(400).json({ error: 'nameRu and nameEn are required' }); return; }

  const priceKind = VALID_PRICE_KINDS.includes(style.priceKind ?? '') ? style.priceKind! : 'FREE';
  const priceStars = null; // legacy column; new purchases use TON only
  const priceGram = priceKind === 'PAID' && Number.isFinite(Number(style.priceGram)) && Number(style.priceGram) > 0 ? Number(style.priceGram) : null;
  if (priceKind === 'PAID' && !priceGram) { res.status(400).json({ error: 'A PAID style needs a TON price' }); return; }

  const data = {
    slug,
    nameRu: style.nameRu!.trim(), nameEn: style.nameEn!.trim(),
    descRu: typeof style.descRu === 'string' ? style.descRu : '',
    descEn: typeof style.descEn === 'string' ? style.descEn : '',
    tags: toStringArray(style.tags),
    priceKind, priceStars, priceGram,
    brandAdaptive: style.brandAdaptive !== false,
    recommendedMode: VALID_MODES.includes(style.recommendedMode ?? '') ? style.recommendedMode! : 'html',
    palette: Array.isArray(style.palette) ? style.palette : [],
    visualCoverStyle: typeof style.visualCoverStyle === 'string' ? style.visualCoverStyle : '',
    bgStyle: strOrNull(style.bgStyle), bgDetail: strOrNull(style.bgDetail),
    fontPreset: strOrNull(style.fontPreset), logoUsage: strOrNull(style.logoUsage),
    templates: Array.isArray(style.templates) ? style.templates : [],
    carouselTemplate: (style.carouselTemplate && typeof style.carouselTemplate === 'object' && !Array.isArray(style.carouselTemplate)) ? (style.carouselTemplate as Prisma.InputJsonValue) : Prisma.DbNull,
    published: style.published === true,
    sortOrder: Number.isInteger(Number(style.sortOrder)) ? Number(style.sortOrder) : 0,
  };

  try {
    let saved;
    if (strOrNull(style.id)) {
      saved = await prisma.style.update({ where: { id: style.id! }, data });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saved = await prisma.style.create({ data: { ...data, createdBy: adminId } as any });
    }
    res.json({ style: { ...serializeStyle(saved), published: saved.published } });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') { res.status(409).json({ error: 'A style with this slug already exists' }); return; }
    console.error('[admin/styles/upsert] DB error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/styles/delete — { id }.
router.post('/styles/delete', async (req: Request, res: Response): Promise<void> => {
  const { initData, id } = req.body as { initData?: unknown; id?: unknown };
  if (!requireAdmin(initData, res)) return;
  if (typeof id !== 'string' || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }
  try {
    await prisma.style.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/styles/delete] DB error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/admin/styles/upload-template — multipart .html → stored URL.
router.post('/styles/upload-template', uploadHtml.single('file'), async (req: Request, res: Response): Promise<void> => {
  const initData = req.body['initData'] as unknown;
  const file = req.file;
  if (!requireAdmin(initData, res)) return;
  if (!file) { res.status(400).json({ error: 'file is required' }); return; }
  try {
    const obj = await putObject(
      `styles/templates/tpl-${Date.now()}-${safeFileName(file.originalname)}`,
      file.buffer,
      { contentType: 'text/html; charset=utf-8' },
    );
    res.json({ url: obj.url });
  } catch (err) {
    console.error('[admin/styles/upload-template] upload failed:', (err as Error).message);
    res.status(500).json({ error: 'Upload failed. Try again.' });
  }
});

// POST /api/admin/styles/render-previews — renders each template with its demo
// slots + a demo brand into PNGs and saves them on the style.
// Body: { initData, id, aspectRatio? }
router.post('/styles/render-previews', async (req: Request, res: Response): Promise<void> => {
  const { initData, id, aspectRatio } = req.body as { initData?: unknown; id?: unknown; aspectRatio?: unknown };
  if (!requireAdmin(initData, res)) return;
  if (typeof id !== 'string' || !id.trim()) { res.status(400).json({ error: 'id is required' }); return; }

  const style = await prisma.style.findUnique({ where: { id } }).catch(() => null);
  if (!style) { res.status(404).json({ error: 'Style not found' }); return; }

  const templates = (Array.isArray(style.templates) ? style.templates : []) as { name?: string; url?: string; demoSlots?: Record<string, string> }[];
  if (templates.length === 0) { res.status(400).json({ error: 'Style has no templates to render' }); return; }

  // Demo brand: a fixed-palette style shows its own colors; a brand-adaptive one
  // shows a representative accent so the user sees how their channel color lands.
  const palette = (Array.isArray(style.palette) ? style.palette : []) as { hex?: string }[];
  const primaryColor = palette[0]?.hex && /^#[0-9A-Fa-f]{6}$/.test(palette[0].hex) ? palette[0].hex : '#FF6A00';
  const bgColor      = palette[1]?.hex && /^#[0-9A-Fa-f]{6}$/.test(palette[1].hex) ? palette[1].hex : '#0B0B0C';
  const ratio = typeof aspectRatio === 'string' ? aspectRatio : '16:9';

  const urls: string[] = [];
  for (const tpl of templates) {
    if (!tpl.url) continue;
    const url = await renderHtmlPreview({
      htmlTemplateUrl: tpl.url,
      brand:           { primaryColor, bgColor, logoUrl: null },
      slots:           tpl.demoSlots ?? {},
      aspectRatio:     ratio,
    });
    if (url) urls.push(url);
  }

  if (urls.length === 0) { res.status(502).json({ error: 'No previews could be rendered (check template URLs).' }); return; }

  try {
    const saved = await prisma.style.update({
      where: { id },
      data:  { previews: urls, heroPreview: urls[0] },
    });
    res.json({ style: { ...serializeStyle(saved), published: saved.published } });
  } catch (err) {
    console.error('[admin/styles/render-previews] DB error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
