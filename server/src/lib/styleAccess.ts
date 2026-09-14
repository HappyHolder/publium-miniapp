import { prisma } from '../db';
import { env } from '../env';
import { storagePath } from './storage';

function urls(value: unknown): string[] {
  if (typeof value === 'string') {
    const local = storagePath(value);
    if (local) return [`/uploads/${local}`];
    try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? [decodeURIComponent(u.pathname)] : []; } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(urls);
  if (value && typeof value === 'object') return Object.values(value).flatMap(urls);
  return [];
}

/** Check protected pack resources on the server even when a client bypasses the shop UI. */
export async function assertStyleAccess(userId: string, visualKit: unknown) {
  const requested = new Set(urls(visualKit));
  if (!requested.size) return;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { telegramId: true } });
  if (user.telegramId && env.ADMIN_TELEGRAM_IDS.includes(user.telegramId)) return;
  const styles = await prisma.style.findMany({ include: { purchases: { where: { userId }, select: { id: true } } } });
  for (const style of styles) {
    if (!urls([style.templates, style.carouselTemplate]).some(url => requested.has(url))) continue;
    if (style.showcaseOnly || !style.published || (style.priceKind === 'PAID' && !style.purchases.length)) throw Object.assign(new Error('Для использования этого шаблона приобретите стиль.'), { status: 403 });
  }
}
