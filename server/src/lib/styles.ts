import { prisma } from '../db';
import type { Style } from '@prisma/client';

// ─── Styles market helpers ────────────────────────────────────────────────────
// A Style is a curated cover-style PACK (see prisma Style model). These helpers
// shape a Style for the public catalog and record one-time ownership.

/** Public catalog shape returned to the mini-app (all fields needed to render
 *  the card, the detail sheet, and to "apply" the style to a channel). */
export function serializeStyle(s: Style) {
  return {
    id:               s.id,
    slug:             s.slug,
    nameRu:           s.nameRu,
    nameEn:           s.nameEn,
    descRu:           s.descRu,
    descEn:           s.descEn,
    tags:             s.tags,
    priceKind:        s.priceKind,                 // "FREE" | "PAID"
    priceGram:        s.priceGram ?? null,
    brandAdaptive:    s.brandAdaptive,
    recommendedMode:  s.recommendedMode,           // "html" | "ai" | "ai_html"
    palette:          s.palette,                    // BrandColor[]
    visualCoverStyle: s.visualCoverStyle,
    bgStyle:          s.bgStyle ?? null,
    bgDetail:         s.bgDetail ?? null,
    fontPreset:       s.fontPreset ?? null,
    logoUsage:        s.logoUsage ?? null,
    templates:        s.templates,                  // HtmlTemplateItem[]
    carouselTemplate: s.carouselTemplate ?? null,   // { name, url } — separate universal carousel slide
    previews:         s.previews,
    heroPreview:      s.heroPreview ?? null,
    showcaseOnly:     s.showcaseOnly,               // visible to all, applicable by admin only
    sortOrder:        s.sortOrder,
  };
}

export type StyleVia = 'STARS' | 'GRAM' | 'FREE' | 'ADMIN';

/**
 * Records one-time ownership of a style for a user. Idempotent: a duplicate
 * (same user+style) or a reused TON tx hash resolves to `alreadyOwned` instead
 * of throwing. Returns whether the row already existed.
 */
export async function grantStylePurchase(
  userId: string,
  styleId: string,
  via: StyleVia,
  txHash?: string | null,
): Promise<{ alreadyOwned: boolean }> {
  try {
    await prisma.stylePurchase.create({
      data: { userId, styleId, via, txHash: txHash ?? null },
    });
    return { alreadyOwned: false };
  } catch (e) {
    // P2002 — unique violation on (userId, styleId) or txHash → already granted.
    if ((e as { code?: string })?.code === 'P2002') return { alreadyOwned: true };
    throw e;
  }
}

/** Returns the set of style ids the user owns (FREE styles are owned implicitly,
 *  resolved on the client — this is only explicit purchases). */
export async function ownedStyleIds(userId: string): Promise<string[]> {
  const rows = await prisma.stylePurchase
    .findMany({ where: { userId }, select: { styleId: true } })
    .catch(() => [] as { styleId: string }[]);
  return rows.map(r => r.styleId);
}
