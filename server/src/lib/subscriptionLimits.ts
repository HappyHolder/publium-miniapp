import type { Prisma } from '@prisma/client';
import type { PlanTier, Subscription } from '@prisma/client';
import { prisma } from '../db';

export interface TierLimits {
  textGenerationsLimit: number;
  visualGenerationsLimit: number;
  channelLimit: number;
  communityChatLimit: number;
  assistantMessagesLimit: number;
  contentManagerPostsLimit: number;
  aiModeratorChecksLimit: number;
  communityManagerActionsLimit: number;
  communityCorePersonaLimit: number;
  customBotChatLimit: number;
  canSchedule: boolean;
  canUseAiAssistant: boolean;
  canUseContentManager: boolean;
  canUseAiVisuals: boolean;
  canUseHtmlCovers: boolean;
  canUseAiModerator: boolean;
  canUseCommunityManager: boolean;
  canUseCommunityCore: boolean;
}

/** The single authoritative product catalogue used by every route and the UI API. */
export const TIER_LIMITS: Record<PlanTier, TierLimits> = {
  FREE: {
    textGenerationsLimit: 30, visualGenerationsLimit: 0, channelLimit: 1, communityChatLimit: 1,
    assistantMessagesLimit: 100, contentManagerPostsLimit: 7, aiModeratorChecksLimit: 0,
    communityManagerActionsLimit: 0, communityCorePersonaLimit: 0, customBotChatLimit: 0,
    canSchedule: true, canUseAiAssistant: true, canUseContentManager: true, canUseAiVisuals: false,
    canUseHtmlCovers: false, canUseAiModerator: false, canUseCommunityManager: false, canUseCommunityCore: false,
  },
  STARTER: {
    textGenerationsLimit: 150, visualGenerationsLimit: 45, channelLimit: 2, communityChatLimit: 2,
    assistantMessagesLimit: 1_000, contentManagerPostsLimit: 45, aiModeratorChecksLimit: 5_000,
    communityManagerActionsLimit: 300, communityCorePersonaLimit: 2, customBotChatLimit: 1,
    canSchedule: true, canUseAiAssistant: true, canUseContentManager: true, canUseAiVisuals: true,
    canUseHtmlCovers: true, canUseAiModerator: true, canUseCommunityManager: true, canUseCommunityCore: true,
  },
  CREATOR: {
    textGenerationsLimit: 600, visualGenerationsLimit: 200, channelLimit: 5, communityChatLimit: 5,
    assistantMessagesLimit: 3_000, contentManagerPostsLimit: 200, aiModeratorChecksLimit: 25_000,
    communityManagerActionsLimit: 1_500, communityCorePersonaLimit: 5, customBotChatLimit: 2,
    canSchedule: true, canUseAiAssistant: true, canUseContentManager: true, canUseAiVisuals: true,
    canUseHtmlCovers: true, canUseAiModerator: true, canUseCommunityManager: true, canUseCommunityCore: true,
  },
  STUDIO_PRO: {
    textGenerationsLimit: 2_000, visualGenerationsLimit: 700, channelLimit: 10, communityChatLimit: 10,
    assistantMessagesLimit: 10_000, contentManagerPostsLimit: 700, aiModeratorChecksLimit: 100_000,
    communityManagerActionsLimit: 5_000, communityCorePersonaLimit: 20, customBotChatLimit: 10,
    canSchedule: true, canUseAiAssistant: true, canUseContentManager: true, canUseAiVisuals: true,
    canUseHtmlCovers: true, canUseAiModerator: true, canUseCommunityManager: true, canUseCommunityCore: true,
  },
};

export type SubscriptionQuota = 'text' | 'visual' | 'assistant' | 'contentManagerPosts' | 'communityManagerActions';
const USAGE_FIELD: Record<SubscriptionQuota, keyof Subscription> = {
  text: 'textGenerationsUsed',
  visual: 'visualGenerationsUsed',
  assistant: 'assistantMessagesUsed',
  contentManagerPosts: 'contentManagerPostsUsed',
  communityManagerActions: 'communityManagerActionsUsed',
};

const zeroUsage = {
  textGenerationsUsed: 0,
  visualGenerationsUsed: 0,
  assistantMessagesUsed: 0,
  contentManagerPostsUsed: 0,
  communityManagerActionsUsed: 0,
};

function addOneMonth(from: Date): Date {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  return next;
}

function quotaLimit(sub: Subscription, quota: SubscriptionQuota): number {
  const limits = TIER_LIMITS[sub.tier];
  if (quota === 'text') return limits.textGenerationsLimit;
  if (quota === 'visual') return limits.visualGenerationsLimit + sub.bonusVisualGenerations;
  if (quota === 'assistant') return limits.assistantMessagesLimit;
  if (quota === 'contentManagerPosts') return limits.contentManagerPostsLimit;
  return limits.communityManagerActionsLimit;
}

/**
 * Returns the effective subscription and performs expiry/monthly reset first.
 * Every paid feature route must use this function instead of reading tier raw.
 */
export async function getEffectiveSubscription(userId: string, db: Prisma.TransactionClient = prisma): Promise<Subscription> {
  const now = new Date();
  let sub = await db.subscription.upsert({
    where: { userId },
    create: { userId, tier: 'FREE', quotaResetAt: addOneMonth(now) },
    update: {},
  });

  const expired = sub.tier !== 'FREE' && sub.expiresAt !== null && sub.expiresAt <= now;
  const resetDue = sub.quotaResetAt === null || sub.quotaResetAt <= now;
  if (expired || resetDue) {
    let nextReset = sub.quotaResetAt ?? addOneMonth(now);
    while (nextReset <= now) nextReset = addOneMonth(nextReset);
    await db.subscription.updateMany({
      where: { userId, quotaResetAt: sub.quotaResetAt, expiresAt: sub.expiresAt },
      data: {
        ...(expired ? { tier: 'FREE' as const, expiresAt: null } : {}),
        ...zeroUsage,
        quotaResetAt: nextReset,
      },
    });
    sub = await db.subscription.findUniqueOrThrow({ where: { userId } });
  }
  return sub;
}

/** Atomically reserves quota before an external AI call. */
export async function reserveSubscriptionQuota(
  userId: string,
  quota: SubscriptionQuota,
  amount = 1,
): Promise<{ ok: boolean; subscription: Subscription; limit: number; used: number }> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Quota amount must be a positive integer');
  let sub = await getEffectiveSubscription(userId);
  const field = USAGE_FIELD[quota] as 'textGenerationsUsed' | 'visualGenerationsUsed' | 'assistantMessagesUsed' | 'contentManagerPostsUsed' | 'communityManagerActionsUsed';
  const limit = quotaLimit(sub, quota);
  const used = sub[field];
  if (limit <= 0 || used + amount > limit) return { ok: false, subscription: sub, limit, used };

  const claimed = await prisma.subscription.updateMany({
    where: { userId, tier: sub.tier, quotaResetAt: sub.quotaResetAt, [field]: { lte: limit - amount } },
    data: { [field]: { increment: amount } },
  });
  if (claimed.count !== 1) {
    sub = await getEffectiveSubscription(userId);
    return { ok: false, subscription: sub, limit: quotaLimit(sub, quota), used: sub[field] };
  }
  sub = await prisma.subscription.findUniqueOrThrow({ where: { userId } });
  return { ok: true, subscription: sub, limit: quotaLimit(sub, quota), used: sub[field] };
}

/** Returns reserved quota after a provider/transaction failure. */
export async function refundSubscriptionQuota(userId: string, quota: SubscriptionQuota, amount = 1): Promise<void> {
  const field = USAGE_FIELD[quota] as 'textGenerationsUsed' | 'visualGenerationsUsed' | 'assistantMessagesUsed' | 'contentManagerPostsUsed' | 'communityManagerActionsUsed';
  await prisma.subscription.updateMany({
    where: { userId, [field]: { gte: amount } },
    data: { [field]: { decrement: amount } },
  });
}

export function serializeSubscription(sub: Subscription) {
  const limits = TIER_LIMITS[sub.tier];
  return {
    tier: sub.tier,
    expiresAt: sub.expiresAt?.toISOString() ?? null,
    quotaResetAt: sub.quotaResetAt?.toISOString() ?? null,
    usage: {
      text: { used: sub.textGenerationsUsed, limit: limits.textGenerationsLimit },
      visuals: {
        used: sub.visualGenerationsUsed,
        included: limits.visualGenerationsLimit,
        bonus: sub.bonusVisualGenerations,
        limit: limits.visualGenerationsLimit + sub.bonusVisualGenerations,
      },
      assistant: { used: sub.assistantMessagesUsed, limit: limits.assistantMessagesLimit },
      contentManagerPosts: { used: sub.contentManagerPostsUsed, limit: limits.contentManagerPostsLimit },
      communityManagerActions: { used: sub.communityManagerActionsUsed, limit: limits.communityManagerActionsLimit },
    },
    limits,
  };
}

export async function hasCustomBotSlot(userId: string, communityId: string): Promise<{ ok: boolean; limit: number; used: number }> {
  const subscription = await getEffectiveSubscription(userId);
  const limit = TIER_LIMITS[subscription.tier].customBotChatLimit;
  const activeStatuses = ['REQUESTED', 'READY', 'ACTIVE'];
  const [moderatorBots, managerBots] = await Promise.all([
    prisma.managedModeratorBot.findMany({ where: { ownerUserId: userId, status: { in: activeStatuses } }, select: { communityId: true } }),
    prisma.managedCommunityManagerBot.findMany({ where: { ownerUserId: userId, status: { in: activeStatuses } }, select: { communityId: true } }),
  ]);
  const occupied = new Set([...moderatorBots, ...managerBots].map(bot => bot.communityId));
  return { ok: occupied.has(communityId) || occupied.size < limit, limit, used: occupied.size };
}
export function canUseHtmlCovers(tier: PlanTier): boolean {
  return TIER_LIMITS[tier].canUseHtmlCovers;
}

export const MAX_TEXT_REGENS_PER_POST = 3;
export const MAX_IMAGE_REGENS_PER_POST = 3;