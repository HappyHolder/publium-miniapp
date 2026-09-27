import { getBotIdFromToken, getChatMember } from '../lib/telegramBot';
import { moderatorTokenForCommunity } from '../moderator/managedBotCrypto';

/** Telegram guarantees other users' membership only to a chat administrator.
 * Keep the CM as sender, but use this community's moderator for reliable reads
 * when the shared CM is an ordinary member. Never trust a non-admin's "left".
 */
export async function membershipReaderToken(
  communityId: string,
  chatId: string,
  executorToken: string,
  deps = { getMember: getChatMember, moderatorToken: moderatorTokenForCommunity },
): Promise<string> {
  const isAdmin = async (token: string) => {
    if (!token) return false;
    try {
      const botId = getBotIdFromToken(token);
      const self = await deps.getMember(chatId, botId, token);
      return self.user.id === botId && ['administrator', 'creator'].includes(self.status);
    } catch { return false; }
  };
  if (await isAdmin(executorToken)) return executorToken;
  const moderatorToken = await deps.moderatorToken(communityId).catch(() => '');
  if (moderatorToken !== executorToken && await isAdmin(moderatorToken)) return moderatorToken;
  throw new Error('Не удалось подтвердить участников: подключённый бот-модератор или CM должен быть администратором этого чата.');
}
