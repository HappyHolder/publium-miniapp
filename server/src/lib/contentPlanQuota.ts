import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getEffectiveSubscription, TIER_LIMITS } from './subscriptionLimits';

export async function confirmPlan(planId: string, userId: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ContentPlan" WHERE id = ${planId} FOR UPDATE`;
    const plan = await tx.contentPlan.findUniqueOrThrow({ where: { id: planId }, include: { items: true } });
    if (plan.status !== 'DRAFT') throw Object.assign(new Error('План уже запущен.'), { status: 409 });
    const pending = plan.items.filter(i => !['DONE', 'SKIPPED'].includes(i.status));
    if (!pending.length) throw Object.assign(new Error('План пуст.'), { status: 400 });
    const sub = await getEffectiveSubscription(userId, tx);
    const limits = TIER_LIMITS[sub.tier];
    const amount = pending.length;
    if (!limits.canUseContentManager) throw Object.assign(new Error('Content Manager недоступен на текущем тарифе.'), { status: 403 });
    const claim = await tx.subscription.updateMany({ where: { userId, quotaResetAt: sub.quotaResetAt, contentManagerPostsUsed: { lte: limits.contentManagerPostsLimit - amount }, ...(limits.canUseAiVisuals ? { visualGenerationsUsed: { lte: limits.visualGenerationsLimit + sub.bonusVisualGenerations - amount } } : {}) }, data: { contentManagerPostsUsed: { increment: amount }, ...(limits.canUseAiVisuals ? { visualGenerationsUsed: { increment: amount } } : {}) } });
    if (!claim.count) throw Object.assign(new Error('Недостаточно лимита для всего плана.'), { status: 429 });
    await tx.contentPlanItem.updateMany({ where: { id: { in: pending.map(i => i.id) } }, data: { contentReserved: true, visualReserved: limits.canUseAiVisuals, quotaPeriod: sub.quotaResetAt } });
    await tx.contentPlan.update({ where: { id: planId }, data: { status: 'GENERATING', generateVisuals: limits.canUseAiVisuals, errorMessage: null } });
  });
}

export async function refundItem(tx: Prisma.TransactionClient, itemId: string, userId: string) {
  await tx.$queryRaw`SELECT id FROM "ContentPlanItem" WHERE id = ${itemId} FOR UPDATE`;
  const item = await tx.contentPlanItem.findUniqueOrThrow({ where: { id: itemId } });
  if (item.contentReserved) await tx.subscription.updateMany({ where: { userId, quotaResetAt: item.quotaPeriod, contentManagerPostsUsed: { gte: 1 } }, data: { contentManagerPostsUsed: { decrement: 1 } } });
  if (item.visualReserved) await tx.subscription.updateMany({ where: { userId, quotaResetAt: item.quotaPeriod, visualGenerationsUsed: { gte: 1 } }, data: { visualGenerationsUsed: { decrement: 1 } } });
  await tx.contentPlanItem.update({ where: { id: itemId }, data: { contentReserved: false, visualReserved: false } });
}

export async function cancelPlan(planId: string, userId: string) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ContentPlan" WHERE id = ${planId} FOR UPDATE`;
    await tx.contentPlan.update({ where: { id: planId }, data: { status: 'CANCELLED' } });
    const items = await tx.contentPlanItem.findMany({ where: { planId }, orderBy: { id: 'asc' } });
    for (const item of items) {
      await refundItem(tx, item.id, userId);
      if (item.generatedPostId) await tx.generatedPost.updateMany({ where: { id: item.generatedPostId, status: 'SCHEDULED', publishState: 'IDLE' }, data: { status: 'ARCHIVED', scheduledAt: null } });
    }
  }, { timeout: 30_000 });
}
