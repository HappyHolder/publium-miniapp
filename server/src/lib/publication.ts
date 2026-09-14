import { prisma } from '../db';
import { env } from '../env';
import { buildInlineKeyboard, sendChannelPost, sendRichChannelPost } from './telegramBot';
import { normalizePostBlocks } from './richPost';
import { queuePublishedPostContentSupport } from '../communityManager/contentRelease';

export async function publishPost(postId: string, scheduledOnly = false) {
  const post = await prisma.$transaction(async tx => {
    const claim = await tx.generatedPost.updateMany({ where: { id: postId, publishState: 'IDLE', status: scheduledOnly ? 'SCHEDULED' : { in: ['NEW', 'SCHEDULED', 'FAILED'] }, ...(scheduledOnly ? { scheduledAt: { lte: new Date() } } : {}) }, data: { publishState: 'SENDING' } });
    if (!claim.count) throw Object.assign(new Error('Публикация уже началась, выполнена или отменена. Обновите список.'), { status: 409 });
    const post = await tx.generatedPost.findUniqueOrThrow({ where: { id: postId }, include: { channel: true, variants: { orderBy: { variantIndex: 'asc' } } } });
    const variant = post.variants.find(v => v.id === post.selectedVariantId) ?? post.variants[0];
    if (!variant || (!variant.text.trim() && !normalizePostBlocks(variant.blocks)?.length) || (!post.channel.tgChatId && !post.channel.handle)) throw Object.assign(new Error('Нет содержимого или адреса канала.'), { status: 400 });
    await tx.publicationRecord.upsert({ where: { postId }, create: { postId, channelId: post.channelId, userId: post.channel.userId, status: 'SENDING' }, update: { status: 'SENDING', startedAt: new Date(), error: null } });
    return post;
  });
  const variant = post.variants.find(v => v.id === post.selectedVariantId) ?? post.variants[0]!;
  const blocks = normalizePostBlocks(variant.blocks);
  const common = { chatId: post.channel.tgChatId ?? `@${post.channel.handle}`, title: post.title, siteName: post.channel.name, token: env.TELEGRAM_BOT_TOKEN, replyMarkup: buildInlineKeyboard(post.linkButtons) };
  try {
    const sent = blocks?.length ? await sendRichChannelPost({ ...common, blocks }) : await sendChannelPost({ ...common, text: variant.text, bannerUrl: variant.bannerUrl });
    const publishedAt = new Date();
    await prisma.$transaction(async tx => {
      const reference = { tgChatId: sent ? String(sent.chatId) : null, tgMessageId: sent?.messageId ?? null };
      await tx.generatedPost.update({ where: { id: postId }, data: { status: 'PUBLISHED', publishState: 'IDLE', publishedAt, ...reference } });
      await tx.publicationRecord.update({ where: { postId }, data: { status: 'PUBLISHED', publishedAt, ...reference } });
      if (sent?.chatId && !post.channel.tgChatId) await tx.channel.update({ where: { id: post.channelId }, data: { tgChatId: String(sent.chatId) } });
    });
    await queuePublishedPostContentSupport(postId).catch(error => console.error('[publication] content support failed', error.message));
    return publishedAt;
  } catch (error) {
    // Never blindly resend after an ambiguous network/DB failure. Reconcile with Telegram first.
    await prisma.generatedPost.updateMany({ where: { id: postId, publishState: 'SENDING' }, data: { publishState: 'UNCERTAIN' } }).catch(() => undefined);
    await prisma.publicationRecord.updateMany({ where: { postId, status: 'SENDING' }, data: { status: 'UNCERTAIN', error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown delivery outcome' } }).catch(() => undefined);
    throw Object.assign(new Error('Результат отправки требует проверки в канале. Автоматический повтор остановлен, чтобы не создать дубликат.'), { status: 502 });
  }
}
