import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { serializeStyle, ownedStyleIds } from '../lib/styles';

const router = Router();

// ─── POST /api/styles/list ────────────────────────────────────────────────────
// Returns the published style catalog plus the caller's owned style ids.
// initData is optional — without it the catalog is still browsable (owned: []).
//
// Body: { initData?: string }
// Response 200: { styles: PublicStyle[], owned: string[] }

router.post('/list', async (req: Request, res: Response): Promise<void> => {
  const { initData } = req.body as { initData?: unknown };

  // Resolve the user when initData is present (and valid). Never hard-fail here —
  // browsing the catalog must work even for an unauthenticated/expired session.
  let owned: string[] = [];
  let isAdmin = false;
  if (typeof initData === 'string' && initData.trim()) {
    try {
      const parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
      const telegramId = String(parsed.user.id);
      isAdmin = env.ADMIN_TELEGRAM_IDS.includes(telegramId);
      const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } }).catch(() => null);
      if (dbUser) owned = await ownedStyleIds(dbUser.id);
    } catch { /* unauthenticated browse — owned stays [] */ }
  }

  try {
    // Admins see everything — unpublished (internal) styles flagged `hidden` so
    // the client can badge them. Regular users get the published catalog PLUS
    // showcase-only packs (visible shop-window styles they can't apply).
    const styles = await prisma.style.findMany({
      where:   isAdmin ? {} : { OR: [{ published: true }, { showcaseOnly: true }] },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({
      // `hidden` is an admin-only badge for unpublished styles. Regular users
      // never see it — a showcase-only pack (published:false, showcaseOnly:true)
      // is visible to them and must not read as "скрыт".
      styles: styles.map(s => ({ ...serializeStyle(s), ...(!isAdmin && (s.showcaseOnly || (s.priceKind === 'PAID' && !owned.includes(s.id))) ? { templates: (Array.isArray(s.templates) ? s.templates : []).map((t: any) => ({ name: t.name, url: '' })), carouselTemplate: null } : {}), ...(isAdmin && !s.published ? { hidden: true } : {}) })),
      owned,
    });
  } catch (err) {
    console.error('[styles/list] DB error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
