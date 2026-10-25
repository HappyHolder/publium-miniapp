import { blocksToRichHtml, type PostBlock } from '../lib/richPost';
import { sendBotMessage, sendRichMessage, TelegramApiError } from '../lib/telegramBot';
import { conversationMention, escapeModeratorHtml, moderatorAuthorLabel, type ConversationMessage } from './conversationPolicy';

type NoticeInput = Pick<ConversationMessage, 'tgUserId' | 'username' | 'displayName'> & {
  notice: string; rewrite: string | null; warning?: string;
};
export type ProfanityNotice = { text: string; html: string };

/** Split before rendering: markup stays balanced and no source text is truncated. */
export function profanityNotices(input: NoticeInput): ProfanityNotice[] {
  const heading = `${moderatorAuthorLabel(input)}, ${input.notice.trim() || 'Пиши без мата.'}`;
  const warning = input.warning ?? '';
  const limit = Math.max(1000, 3900 - heading.length - warning.length - 10);
  const quotes: string[] = [];
  let rest = input.rewrite ?? '';
  while (rest.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1]!)) end--;
    quotes.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  quotes.push(rest);
  return quotes.map((quote, index) => {
    const blocks: PostBlock[] = [];
    if (quote) blocks.push({ type: 'quote', runs: [{ t: quote }] });
    if (warning && index === quotes.length - 1) blocks.push({ type: 'paragraph', runs: [{ t: warning }] });
    // The author is a Telegram user mention; all remaining strings use the shared escaped renderer.
    const htmlHeading = index === 0 ? `<p>${conversationMention(input)}, ${escapeModeratorHtml(input.notice.trim() || 'Пиши без мата.')}</p>` : '';
    return {
      text: [index === 0 ? heading : '', quote ? `«${quote}»` : '', index === quotes.length - 1 ? warning : ''].filter(Boolean).join('\n\n'),
      html: htmlHeading + blocksToRichHtml(blocks),
    };
  });
}

export async function sendProfanityNotices(chatId: number, notices: ProfanityNotice[], token: string): Promise<void> {
  for (const notice of notices) {
    try {
      if (!await sendRichMessage(chatId, notice.html, token)) throw Error('PROFANITY_NOTICE_NOT_CONFIRMED');
    } catch (error) {
      // A definite format/endpoint rejection is safe to retry as plain text.
      // Network failures have unknown delivery status: never create a duplicate.
      if (!(error instanceof TelegramApiError) || ![400, 404, 413].includes(error.code ?? 0)) throw error;
      await sendBotMessage(chatId, notice.text, token);
    }
  }
}
