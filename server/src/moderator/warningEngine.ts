import { prisma } from '../db';
import { banChatUser, getChatMember, restrictChatUser } from '../lib/telegramBot';

export type WarningPolicy = {
  warningExpiryDays: number;
  muteAfterWarnings: number;
  muteDurationSeconds: number;
  banAfterWarnings: number;
};

type ApplyInput = {
  communityId: string;
  chatId: string | number;
  tgUserId: string;
  telegramMessageId: number;
  reason: string;
  source: string;
  eventId?: string;
  policy: WarningPolicy;
  token: string;
};

export type WarningScope = 'GENERAL' | 'PROFANITY' | 'CONVERSATION';
export const warningScope = (source: string): WarningScope => source === 'AI_CONVERSATION' ? 'CONVERSATION'
  : ['AI', 'AI_PROFANITY'].includes(source) ? 'PROFANITY' : 'GENERAL';

export async function activeWarningCount(communityId: string, tgUserId: string, scope: WarningScope = 'GENERAL'): Promise<number> {
  return prisma.moderationWarning.count({
    where: { communityId, tgUserId, scope, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  });
}

export async function issueWarning(input: ApplyInput): Promise<{ count: number; action: 'WARN' | 'MUTE' | 'BAN'; muteUntil?: Date }> {
  const role = await getChatMember(String(input.chatId), Number(input.tgUserId), input.token);
  if (role.user?.is_bot || !['member', 'restricted'].includes(role.status)) throw new Error('SANCTION_TARGET_PROTECTED');
  const expiresAt = input.policy.warningExpiryDays > 0
    ? new Date(Date.now() + input.policy.warningExpiryDays * 86_400_000)
    : null;
  const scope = warningScope(input.source);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.communityId + ':warning:' + input.tgUserId}))`;
    const existing = input.eventId ? await tx.moderationWarning.findUnique({ where: { eventId_tgUserId: { eventId: input.eventId, tgUserId: input.tgUserId } } }) : null;
    if (!existing) await tx.moderationWarning.create({ data: { communityId: input.communityId, tgUserId: input.tgUserId, reason: input.reason.slice(0, 500), source: input.source, scope, eventId: input.eventId, expiresAt } });
    const count = await tx.moderationWarning.count({ where: { communityId: input.communityId, tgUserId: input.tgUserId, scope, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
    return { count, duplicate: Boolean(existing) };
  });
  const { count } = result;
  if (result.duplicate) return { count, action: 'WARN' };
  if (input.policy.banAfterWarnings > 0 && count >= input.policy.banAfterWarnings) {
    await banChatUser(input.chatId, Number(input.tgUserId), input.token);
    await prisma.communityMember.upsert({ where: { communityId_tgUserId: { communityId: input.communityId, tgUserId: input.tgUserId } }, create: { communityId: input.communityId, tgUserId: input.tgUserId, status: 'BANNED', bannedAt: new Date() }, update: { status: 'BANNED', bannedAt: new Date(), muteUntil: null } });
    return { count, action: 'BAN' };
  }
  if (input.policy.muteAfterWarnings > 0 && count >= input.policy.muteAfterWarnings) {
    const muteUntil = new Date(Date.now() + input.policy.muteDurationSeconds * 1000);
    await restrictChatUser(input.chatId, Number(input.tgUserId), true, input.token, muteUntil);
    await prisma.communityMember.upsert({ where: { communityId_tgUserId: { communityId: input.communityId, tgUserId: input.tgUserId } }, create: { communityId: input.communityId, tgUserId: input.tgUserId, status: 'MUTED', muteUntil }, update: { status: 'MUTED', muteUntil } });
    await prisma.scheduledModerationAction.upsert({
      where: { tgChatId_telegramMessageId_actionType: { tgChatId: String(input.chatId), telegramMessageId: input.telegramMessageId, actionType: 'UNMUTE_USER' } },
      create: { communityId: input.communityId, actionType: 'UNMUTE_USER', tgChatId: String(input.chatId), telegramMessageId: input.telegramMessageId, tgUserId: input.tgUserId, executeAt: muteUntil },
      update: { executeAt: muteUntil, status: 'PENDING', attempts: 0, completedAt: null, lastError: null },
    });
    return { count, action: 'MUTE', muteUntil };
  }
  return { count, action: 'WARN' };
}

export async function revokeWarnings(communityId: string, tgUserId: string): Promise<number> {
  const result = await prisma.moderationWarning.updateMany({ where: { communityId, tgUserId, revokedAt: null }, data: { revokedAt: new Date() } });
  return result.count;
}
