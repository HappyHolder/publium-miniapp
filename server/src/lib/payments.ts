import type { PlanTier, Prisma, Subscription } from '@prisma/client';
import { prisma } from '../db';
import { serializeSubscription } from './subscriptionLimits';

export interface PlanPrice { usd: number; ton: number }

// Provisional unified prices. LOW/HIGH no longer exists; this is the only catalogue.
export const PLAN_PRICING: Record<Exclude<PlanTier, 'FREE'>, PlanPrice> = {
  STARTER: { usd: 30, ton: 20 },
  CREATOR: { usd: 60, ton: 40 },
  STUDIO_PRO: { usd: 250, ton: 167 },
};

export const GRANT_DURATION_DAYS = 30;
export type PaidTier = Exclude<PlanTier, 'FREE'>;

export function isPaidTier(t: unknown): t is PaidTier {
  return t === 'STARTER' || t === 'CREATOR' || t === 'STUDIO_PRO';
}

export function pricingFor(tier: PaidTier): PlanPrice {
  return PLAN_PRICING[tier];
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Grants one unified plan. Same-plan renewals preserve every remaining paid day. */
export async function grantSubscription(
  userId: string,
  tier: PaidTier,
  durationDays = GRANT_DURATION_DAYS,
  db: Pick<Prisma.TransactionClient, 'subscription'> = prisma,
): Promise<Subscription> {
  const now = new Date();
  const existing = await db.subscription.findUnique({ where: { userId } });
  const sameActiveTier = existing?.tier === tier && existing.expiresAt !== null && existing.expiresAt > now;
  const startsAt = sameActiveTier ? existing.expiresAt! : now;
  const expiresAt = addDays(startsAt, durationDays);
  const quotaResetAt = addDays(now, durationDays);

  const resetUsage = {
    textGenerationsUsed: 0,
    visualGenerationsUsed: 0,
    assistantMessagesUsed: 0,
    contentManagerPostsUsed: 0,
    communityManagerActionsUsed: 0,
  };

  return db.subscription.upsert({
    where: { userId },
    update: { tier, expiresAt, quotaResetAt, ...resetUsage },
    create: { userId, tier, expiresAt, quotaResetAt, ...resetUsage },
  });
}

export const serializeSub = serializeSubscription;