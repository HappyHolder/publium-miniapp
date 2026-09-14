import { Router } from '../lib/asyncRouter';
/**
 * og.ts
 *
 * Technical OpenGraph page used to attach a post's cover image to a long text
 * post as a large Telegram link-preview card. When a post's text exceeds the
 * 1024-char photo-caption limit we send it as a normal message and point a
 * link preview at `${PUBLIC_BASE_URL}/api/og?i=<coverUrl>&t=<title>`. Telegram
 * fetches this page, reads its og:image and renders the cover above the text.
 *
 * Public (no auth) — Telegram's crawler is unauthenticated. To prevent the page
 * from becoming an open og:image reflector, only cover images served from our
 * own /uploads origin are accepted.
 */

import { Request, Response } from 'express';
import { env } from '../env';

const router = Router();

/** Escapes the five characters unsafe inside a double-quoted HTML attribute. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.get('/', (req: Request, res: Response): void => {
  const img   = typeof req.query['i'] === 'string' ? req.query['i'] : '';
  const title = typeof req.query['t'] === 'string' ? req.query['t'].slice(0, 200) : '';
  // og:site_name drives the accent-colored top line of Telegram's link preview.
  // Set to the channel's own name so the card reads as the channel, not "publium.ru".
  const site  = typeof req.query['s'] === 'string' ? req.query['s'].slice(0, 120) : '';

  // Only allow our own uploaded covers — never reflect an arbitrary external image.
  const allowedPrefix = `${env.PUBLIC_BASE_URL}/uploads/`;
  if (!img.startsWith(allowedPrefix)) {
    res.status(400).type('text/plain').send('Bad request');
    return;
  }

  const safeImg   = escapeHtml(img);
  const safeTitle = escapeHtml(title) || 'Publium';
  const safeSite  = escapeHtml(site);

  res
    .status(200)
    .type('text/html; charset=utf-8')
    // Short cache so Telegram can re-fetch if a cover is ever replaced.
    .setHeader('Cache-Control', 'public, max-age=300');
  res.send(
    `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="article">
${safeSite ? `<meta property="og:site_name" content="${safeSite}">` : ''}
<meta property="og:title" content="${safeTitle}">
<meta property="og:image" content="${safeImg}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:image" content="${safeImg}">
<title>${safeTitle}</title>
</head>
<body></body>
</html>`,
  );
});

export default router;
