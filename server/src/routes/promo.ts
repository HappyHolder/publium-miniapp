import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { validateAndParseTelegramInitData } from '../lib/telegram';
import { serializeSubscription } from '../lib/subscriptionLimits';

const router = Router();
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX_ATTEMPTS = 6;
const attempts = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(userId) ?? []).filter((timestamp) => now - timestamp < RL_WINDOW_MS);
  recent.push(now);
  attempts.set(userId, recent);
  return recent.length > RL_MAX_ATTEMPTS;
}

function addDays(from: Date, days: number): Date {
  const result = new Date(from);
  result.setDate(result.getDate() + days);
  return result;
}

function addOneMonth(from: Date): Date {
  const result = new Date(from);
  result.setMonth(result.getMonth() + 1);
  return result;
}

router.post('/redeem', async (req: Request, res: Response): Promise<void> => {
  const { initData, code } = req.body as { initData?: unknown; code?: unknown };
  if (typeof initData !== 'string' || !initData.trim()) {
    res.status(400).json({ error: 'initData is required' });
    return;
  }
  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: 'Введите промокод' });
    return;
  }

  let parsed;
  try {
    parsed = validateAndParseTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN);
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid initData' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: String(parsed.user.id) },
    select: { id: true },
  }).catch(() => null);
  if (!user) {
    res.status(401).json({ error: 'User not found. Please re-open the app.' });
    return;
  }
  if (rateLimited(user.id)) {
    res.status(429).json({ error: 'Слишком много попыток. Подождите и попробуйте снова.' });
    return;
  }

  const normalized = code.trim().toUpperCase();
  const now = new Date();
  try {
    const subscription = await prisma.$transaction(async (tx) => {
      const burned = await tx.promoCode.updateMany({
        where: { code: normalized, redeemedAt: null },
        data: { redeemedAt: now, redeemedById: user.id },
      });
      if (burned.count === 0) throw new Error('INVALID_CODE');

      const promo = await tx.promoCode.findUnique({
        where: { code: normalized },
        select: { tier: true, durationDays: true },
      });
      if (!promo) throw new Error('INVALID_CODE');

      return tx.subscription.upsert({
        where: { userId: user.id },
        update: {
          tier: promo.tier,
          textGenerationsUsed: 0,
          visualGenerationsUsed: 0,
          assistantMessagesUsed: 0,
          contentManagerPostsUsed: 0,
          communityManagerActionsUsed: 0,
          quotaResetAt: addOneMonth(now),
          expiresAt: addDays(now, promo.durationDays),
        },
        create: {
          userId: user.id,
          tier: promo.tier,
          quotaResetAt: addOneMonth(now),
          expiresAt: addDays(now, promo.durationDays),
        },
      });
    });
    res.json({ subscription: serializeSubscription(subscription) });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CODE') {
      res.status(400).json({ error: 'Промокод недействителен или уже использован.', code: 'INVALID_CODE' });
      return;
    }
    console.error('[promo/redeem] DB error:', (error as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;