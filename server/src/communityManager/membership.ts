import { getBotIdFromToken, getChatMember } from '../lib/telegramBot';
import { moderatorTokenForCommunity } from '../moderator/managedBotCrypto';
import { env } from '../env';

/** Telegram guarantees other users' membership only to a chat administrator.
 * Keep the CM as sender, but use this community's moderator for reliable reads
 * when the shared CM is an ordinary member. Never trust a non-admin's "left".
 */
export async function membershipReaderToken(
  communityId: string,
  chatId: string,
  executorToken: string,
  deps: {getMember:typeof getChatMember;moderatorToken:typeof moderatorTokenForCommunity;sharedModeratorToken?:()=>string} = { getMember: getChatMember, moderatorToken: moderatorTokenForCommunity, sharedModeratorToken:()=>env.MODERATOR_BOT_TOKEN },
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
  // A custom moderator may be selected while the shared moderator still administers
  // this exact group. Prove its own identity/role here; never trust stored botStatus.
  const sharedToken=deps.sharedModeratorToken?.()??'';
  if(sharedToken&&sharedToken!==executorToken&&sharedToken!==moderatorToken&&await isAdmin(sharedToken))return sharedToken;
  throw new Error('Не удалось подтвердить участников: подключённый бот-модератор или CM должен быть администратором этого чата.');
}
