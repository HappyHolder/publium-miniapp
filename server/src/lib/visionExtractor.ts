import { publicFetch } from './publicFetch';
/**
 * visionExtractor.ts
 *
 * Reads a photo sent to the bot: downloads it from Telegram, sends it to the
 * vision model (OPENAI_VISION_MODEL) and returns a faithful text description /
 * transcription. That text then feeds the normal generation pipeline, exactly
 * like the link-content extractor.
 *
 * Direct OpenAI — the same model we used to rent through Replicate, minus the
 * prediction/polling round trip. Never throws; returns null on any failure so
 * the caller can fall back to the message caption.
 */

import { env } from '../env';
import { openAiVision } from './openaiChat';
import { getFilePath } from './telegramBot';

const MAX_OUT_CHARS = 3_000;
const MAX_STYLE_CHARS = 500;

const STYLE_PROMPT =
  'Опиши визуальный стиль этого изображения как референса для обложек Telegram-канала. ' +
  '2-3 предложения: цветовая палитра, визуальное настроение, ключевые дизайн-элементы, общая эстетика. ' +
  'Конкретно и лаконично.';

const EXTRACT_PROMPT =
  'Извлеки содержимое этого изображения для создания поста в Telegram-канал. ' +
  'Если на картинке есть текст — приведи его дословно. Опиши ключевые объекты, ' +
  'числа, бренды, что происходит. Не придумывай того, чего нет на изображении. ' +
  'Ответь связным текстом на языке текста с картинки (по умолчанию русский). ' +
  'Без вступлений вроде «на изображении» — сразу содержание.';

/** Downloads the Telegram file bytes for a file_id. */
async function downloadTelegramFile(fileId: string): Promise<{ buf: Buffer; mime: string }> {
  const filePath = await getFilePath(fileId, env.TELEGRAM_BOT_TOKEN);
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res = await publicFetch(url);
  if (!res.ok) throw new Error(`Telegram file download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (filePath.split('.').pop() ?? 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { buf, mime };
}

/**
 * Fetches an image from a public URL and returns a visual style description,
 * or null on failure / when vision isn't configured.
 *
 * The bytes are inlined as a data URI rather than passing the URL through: the
 * source may be our own private storage, which OpenAI cannot fetch.
 */
export async function analyzeReferenceStyle(imageUrl: string): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const imgRes = await publicFetch(imageUrl);
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(contentType) ? contentType : 'image/jpeg';
    const text = await openAiVision({
      prompt: STYLE_PROMPT,
      image: `data:${mime};base64,${buf.toString('base64')}`,
      maxTokens: 300,
    });
    return text?.slice(0, MAX_STYLE_CHARS) || null;
  } catch (err) {
    console.warn('[visionExtractor] analyzeReferenceStyle failed:', (err as Error).message);
    return null;
  }
}

/**
 * Reads an image (by Telegram file_id) and returns extracted text, or null on
 * failure / when image reading isn't configured.
 */
export async function extractImageContent(fileId: string): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const { buf, mime } = await downloadTelegramFile(fileId);
    const text = await openAiVision({
      prompt: EXTRACT_PROMPT,
      image: `data:${mime};base64,${buf.toString('base64')}`,
    });
    return text?.slice(0, MAX_OUT_CHARS) || null;
  } catch (err) {
    console.warn('[visionExtractor] file read failed:', (err as Error).message);
    return null;
  }
}

/** Extracts text/content from an image at a public URL (e.g. an uploaded screenshot). */
export async function extractImageContentFromUrl(imageUrl: string): Promise<string | null> {
  if (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl)) return null;
  if (!env.OPENAI_API_KEY) return null;
  const response = await publicFetch(imageUrl, { maxBytes: 10 * 1024 * 1024 });
  if (!response.ok) return null;
  const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return null;
  const image = `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  const text = await openAiVision({ prompt: EXTRACT_PROMPT, image });
  return text?.slice(0, MAX_OUT_CHARS) || null;
}
