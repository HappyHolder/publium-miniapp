import { prisma } from '../db';
import { env } from '../env';
import { banChatUser, deleteBotMessage, getBotIdFromToken, getChatMember, kickChatUser, restrictChatUser, sendBotMessage, unbanChatUser } from '../lib/telegramBot';
import { parseBlocks, type WarningPolicyBlock } from './config';
import { activeWarningCount, issueWarning, revokeWarnings } from './warningEngine';

type User = { id: number; first_name: string; username?: string; is_bot?: boolean };
export type CommandMessage = { message_id: number; chat: { id: number }; from?: User; text?: string; reply_to_message?: { message_id: number; from?: User } };

const durationSeconds = (raw?: string): number | null => {
  if (!raw) return null;
  const match = /^(\d+)(m|h|d|w)$/i.exec(raw);
  if (!match) return null;
  const value = Number(match[1]), unit = match[2]?.toLowerCase();
  return Math.min(2_592_000, value * ({ m: 60, h: 3600, d: 86400, w: 604800 }[unit as 'm' | 'h' | 'd' | 'w'] ?? 1));
};
const label = (user: User) => user.username ? `@${user.username}` : user.first_name;
export const canHandleManualCommand = (status: string | null | undefined): boolean => status === 'administrator' || status === 'creator';

export async function handleManualCommand(updateId: string, message: CommandMessage, token: string, botId: number): Promise<{ handled: boolean; command?: string }> {
  const match = /^\/(warn|mute|unmute|ban|kick|unban|delete|info)(?:@\w+)?(?:\s+([^\s]+))?(?:\s+([\s\S]+))?$/i.exec(message.text?.trim() ?? '');
  if (!match || !message.from) return { handled: false };
  const command = match[1]!.toLowerCase();
  const actorRole = await getChatMember(String(message.chat.id), message.from.id, token).catch(() => null);
  // A command-looking message from an ordinary member is still ordinary chat
  // content. Returning handled=true here used to let `/warn <abuse>` bypass all
  // filters and AI moderation in the outer webhook pipeline.
  if (!actorRole || !canHandleManualCommand(actorRole.status)) return { handled: false };
  const actorIsCreator = actorRole.status === 'creator';
  const needsDelete = command === 'delete';
  const needsRestrict = ['warn', 'mute', 'unmute', 'ban', 'kick', 'unban'].includes(command);
  const actorAllowed = actorIsCreator
    || (needsDelete && actorRole.can_delete_messages === true)
    || (needsRestrict && actorRole.can_restrict_members === true)
    || (!needsDelete && !needsRestrict);
  if (!actorAllowed) {
    await sendBotMessage(message.chat.id, 'У вас недостаточно прав администратора для этой команды.', token).catch(() => undefined);
    return { handled: true, command };
  }
  const community = await prisma.community.findFirst({ where: { moderatorChat: { tgChatId: String(message.chat.id) }, moderator: { enabled: true, publishedVersion: { not: null } } }, include: { moderator: true, managedBot: true } });
  if (!community?.moderator?.publishedVersion) return { handled: true, command };
  const expectedBotId = community.moderator.executorType === 'CUSTOM' ? Number(community.managedBot?.tgBotId) : getBotIdFromToken(env.MODERATOR_BOT_TOKEN);
  if (!Number.isFinite(expectedBotId) || expectedBotId !== botId) return { handled: true, command };
  const config = await prisma.moderatorConfig.findUnique({ where: { moderatorId_version: { moderatorId: community.moderator.id, version: community.moderator.publishedVersion } } });
  const policy = parseBlocks(config?.blocks ?? []).find(b => b.type === 'warning_policy' && b.enabled) as WarningPolicyBlock | undefined;
  if (!policy) return { handled: true, command };
  const target = message.reply_to_message?.from;
  if (command === 'delete') {
    if (message.reply_to_message) await deleteBotMessage(message.chat.id, message.reply_to_message.message_id, token).catch(() => undefined);
    if (policy.deleteCommandMessages) await deleteBotMessage(message.chat.id, message.message_id, token).catch(() => undefined);
    await prisma.moderationEvent.create({ data: { communityId: community.id, telegramUpdateId: updateId, telegramMessageId: message.reply_to_message?.message_id, tgUserId: target ? String(target.id) : null, eventType: 'MANUAL_COMMAND', decision: 'DELETE', action: 'DELETE', status: 'PROCESSED', reversedById: String(message.from.id), metadata: { command } } });
    return { handled: true, command };
  }
  if (!target) { await sendBotMessage(message.chat.id, 'Ответьте этой командой на сообщение участника.', token).catch(() => undefined); return { handled: true, command }; }
  const targetRole = await getChatMember(String(message.chat.id), target.id, token).catch(() => null);
  if (!targetRole) {
    await sendBotMessage(message.chat.id, 'Не удалось безопасно проверить роль участника. Команда отменена.', token).catch(() => undefined);
    return { handled: true, command };
  }
  if (['administrator', 'creator'].includes(targetRole.status)) { await sendBotMessage(message.chat.id, 'Администраторов нельзя наказывать через Moderator.', token).catch(() => undefined); return { handled: true, command }; }
  const firstArg = match[2], rest = match[3];
  const reason = command === 'mute' && durationSeconds(firstArg) ? (rest || 'Ручное действие администратора') : [firstArg, rest].filter(Boolean).join(' ') || 'Ручное действие администратора';
  const event = await prisma.moderationEvent.create({ data: { communityId: community.id, telegramUpdateId: updateId, telegramMessageId: message.reply_to_message?.message_id, tgUserId: String(target.id), eventType: 'MANUAL_COMMAND', decision: command.toUpperCase(), reason: reason.slice(0, 500), action: command.toUpperCase(), status: 'RECEIVED', reversedById: String(message.from.id), metadata: { command, actorTgUserId: String(message.from.id) } } });
  let response = '';
  if (command === 'warn') {
    const result = await issueWarning({ communityId: community.id, chatId: message.chat.id, tgUserId: String(target.id), telegramMessageId: message.message_id, reason, source: 'MANUAL', eventId: event.id, policy, token });
    response = `${label(target)}: предупреждение ${result.count}. Действие: ${result.action.toLowerCase()}.`;
  } else if (command === 'mute') {
    const seconds = durationSeconds(firstArg) ?? policy.muteDurationSeconds, until = new Date(Date.now() + seconds * 1000);
    await restrictChatUser(message.chat.id, target.id, true, token, until);
    await prisma.communityMember.upsert({ where: { communityId_tgUserId: { communityId: community.id, tgUserId: String(target.id) } }, create: { communityId: community.id, tgUserId: String(target.id), status: 'MUTED', muteUntil: until }, update: { status: 'MUTED', muteUntil: until } });
    await prisma.scheduledModerationAction.upsert({ where: { tgChatId_telegramMessageId_actionType: { tgChatId: String(message.chat.id), telegramMessageId: message.message_id, actionType: 'UNMUTE_USER' } }, create: { communityId: community.id, actionType: 'UNMUTE_USER', tgChatId: String(message.chat.id), telegramMessageId: message.message_id, tgUserId: String(target.id), executeAt: until }, update: { executeAt: until, status: 'PENDING', attempts: 0 } });
    response = `${label(target)} ограничен до ${until.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.`;
  } else if (command === 'unmute') {
    await restrictChatUser(message.chat.id, target.id, false, token); await prisma.communityMember.updateMany({ where: { communityId: community.id, tgUserId: String(target.id) }, data: { status: 'ACTIVE', muteUntil: null } }); await prisma.scheduledModerationAction.updateMany({ where: { communityId: community.id, tgUserId: String(target.id), actionType: 'UNMUTE_USER', status: 'PENDING' }, data: { status: 'CANCELLED', completedAt: new Date() } }); response = `${label(target)} снова может писать.`;
  } else if (command === 'ban') {
    await banChatUser(message.chat.id, target.id, token); await prisma.communityMember.upsert({ where: { communityId_tgUserId: { communityId: community.id, tgUserId: String(target.id) } }, create: { communityId: community.id, tgUserId: String(target.id), status: 'BANNED', bannedAt: new Date() }, update: { status: 'BANNED', bannedAt: new Date(), muteUntil: null } }); response = `${label(target)} заблокирован.`;
  } else if (command === 'kick') {
    await kickChatUser(message.chat.id, target.id, token); await prisma.communityMember.updateMany({ where: { communityId: community.id, tgUserId: String(target.id) }, data: { status: 'REMOVED', muteUntil: null } }); response = `${label(target)} удалён из группы и может вернуться.`;
  } else if (command === 'unban') {
    await unbanChatUser(message.chat.id, target.id, token); await prisma.communityMember.updateMany({ where: { communityId: community.id, tgUserId: String(target.id) }, data: { status: 'ACTIVE', bannedAt: null } }); response = `${label(target)} разблокирован.`;
  } else if (command === 'info') {
    const [general, profanity, conversation, member] = await Promise.all([
      activeWarningCount(community.id, String(target.id)), activeWarningCount(community.id, String(target.id), 'PROFANITY'), activeWarningCount(community.id, String(target.id), 'CONVERSATION'),
      prisma.communityMember.findUnique({ where: { communityId_tgUserId: { communityId: community.id, tgUserId: String(target.id) } } }),
    ]);
    response = `${label(target)}: предупреждения за фильтры и команды — ${general}, за мат — ${profanity}, за конфликты — ${conversation}; статус — ${member?.status ?? 'ACTIVE'}.`;
  }
  if (command === 'unban') await revokeWarnings(community.id, String(target.id));
  await prisma.moderationEvent.update({ where: { id: event.id }, data: { status: 'PROCESSED', metadata: { command, actorTgUserId: String(message.from.id), response } } });
  if (policy.deleteCommandMessages) await deleteBotMessage(message.chat.id, message.message_id, token).catch(() => undefined);
  if (policy.notifyUser || command === 'info') await sendBotMessage(message.chat.id, response, token).catch(() => undefined);
  return { handled: true, command };
}
