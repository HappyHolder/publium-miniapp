import { prisma } from '../db';

/** ChannelChatLink is authoritative for independent chats. A removed link stays removed. */
export async function hydrateLinkedChannel(community: any) {
  if (!community) return;
  const chatId = community.chatId ?? community.chat?.id;
  if (!chatId) return; // pre-split records only
  const link = await prisma.channelChatLink.findFirst({ where: { chatId, isPrimary: true }, orderBy: { updatedAt: 'desc' }, include: { channel: { include: { brandKit: true } } } });
  community.channel = link?.channel ?? null;
  community.channelId = link?.channelId ?? null;
}
