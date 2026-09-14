import dotenv from 'dotenv';
import path from 'path';

// Load .env relative to the server/ working directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[env] Missing required environment variable: ${key}\n` +
        `      Copy server/.env.example to server/.env and fill in the values.`
    );
  }
  return value;
}

const configuredAIProvider = (): 'placeholder' | 'deepseek' => 'placeholder';
const AI_PROVIDER = configuredAIProvider();


if (process.env['NODE_ENV'] === 'production' && Buffer.byteLength(process.env['MANAGED_BOT_ENCRYPTION_KEY'] ?? '', 'utf8') < 32) {
  throw new Error('[env] MANAGED_BOT_ENCRYPTION_KEY must contain at least 32 random bytes in production.');
}

const IMAGE_PROVIDER = (process.env['IMAGE_PROVIDER'] ?? 'none') as 'none' | 'replicate';

// Retained compatibility values for old records; research runs through OpenAI.
const CONTENT_RESEARCH_BACKEND = 'deepseek' as const;
if (!process.env['OPENAI_API_KEY']) console.warn('[env] OPENAI_API_KEY is absent: AI text, vision and ordinary covers are unavailable.');

// Comma-separated Telegram numeric IDs allowed to access the admin panel.
// Example: ADMIN_TELEGRAM_IDS=123456789,987654321
const ADMIN_TELEGRAM_IDS = (process.env['ADMIN_TELEGRAM_IDS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

export const env = {
  DATABASE_URL:              requireEnv('DATABASE_URL'),
  DIRECT_URL:                requireEnv('DIRECT_URL'),
  TELEGRAM_BOT_TOKEN:        requireEnv('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_WEBHOOK_SECRET:   requireEnv('TELEGRAM_WEBHOOK_SECRET'),
  MODERATOR_BOT_TOKEN:      process.env['MODERATOR_BOT_TOKEN'] ?? '',
  MODERATOR_WEBHOOK_SECRET: process.env['MODERATOR_WEBHOOK_SECRET'] ?? '',
  MODERATOR_BOT_USERNAME:   (process.env['MODERATOR_BOT_USERNAME'] ?? 'publium_moder_bot').replace(/^@/, ''),
  COMMUNITY_MANAGER_BOT_TOKEN: process.env['COMMUNITY_MANAGER_BOT_TOKEN'] ?? '',
  COMMUNITY_MANAGER_WEBHOOK_SECRET: process.env['COMMUNITY_MANAGER_WEBHOOK_SECRET'] ?? '',
  COMMUNITY_MANAGER_BOT_USERNAME: (process.env['COMMUNITY_MANAGER_BOT_USERNAME'] ?? 'publium_community_bot').replace(/^@/, ''),
  MANAGED_BOT_ENCRYPTION_KEY: process.env['MANAGED_BOT_ENCRYPTION_KEY'] ?? '',
  PORT: parseInt(process.env['PORT'] ?? '8787', 10),
  NODE_ENV: (process.env['NODE_ENV'] ?? 'development') as
    | 'development'
    | 'production'
    | 'test',
  AI_PROVIDER,
  DEEPSEEK_API_KEY:  process.env['DEEPSEEK_API_KEY']  ?? '',
  DEEPSEEK_BASE_URL: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
  DEEPSEEK_MODEL:    process.env['DEEPSEEK_MODEL']    ?? 'deepseek-chat',
  // CM_TEXT_MODEL is gone: Moderator, Community Manager and Community Core all
  // run on OPENAI_CHAT_MODEL through terraText now, with no per-role override.
  // LAYOUT_PROVIDER / LAYOUT_MODEL are gone: the layout pass (richPostGenerator),
  // the image and carousel planners and the visual brief all run on
  // OPENAI_CHAT_MODEL through terraText now.
  // Image generation — all optional; server starts fine if absent.
  // IMAGE_MODEL is gone: it only ever fed a `?? env.IMAGE_MODEL` default that no
  // call site could reach, because every one of them passes HIGH_IMAGE_MODEL.
  // VISION_MODEL / WHISPER_MODEL are gone too — see OPENAI_VISION_MODEL and
  // OPENAI_TRANSCRIBE_MODEL below.
  IMAGE_PROVIDER,
  REPLICATE_API_TOKEN:               process.env['REPLICATE_API_TOKEN']               ?? '',
  // ─── Direct OpenAI API ──────────────────────────────────────────────────────
  // OPENAI_API_KEY is REQUIRED. Every text, vision, transcription and cover path
  // goes through it and has no second provider: Moderator, Community Manager,
  // Community Core, the assistant, research, planning, photo reading, voice input
  // and cover images. Without it those features report "not configured".
  // Replicate is now used by exactly one thing — panoramaGenerator (nano-banana,
  // the only model that renders 1:4 / 4:1 / 1:8 / 8:1 in a single pass).
  OPENAI_API_KEY:                    process.env['OPENAI_API_KEY']                    ?? '',
  OPENAI_CHAT_MODEL:                 process.env['OPENAI_CHAT_MODEL']                 ?? 'gpt-5.6-terra',
  // Reads photos sent to the bot and brand reference images (visionExtractor).
  // Default = the same model we used to rent through Replicate.
  OPENAI_VISION_MODEL:               process.env['OPENAI_VISION_MODEL']               ?? 'gpt-4o-mini',
  // Voice input (voiceTranscriber). whisper-1 hallucinates on near-silence;
  // gpt-4o-mini-transcribe returns empty. Set to 'whisper-1' to revert.
  OPENAI_TRANSCRIBE_MODEL:           process.env['OPENAI_TRANSCRIBE_MODEL']           ?? 'gpt-4o-mini-transcribe',
  // Cover images. gpt-image-2 caps at 16:9 — extreme ratios need panoramas.
  OPENAI_IMAGE_MODEL:                process.env['OPENAI_IMAGE_MODEL']                ?? 'gpt-image-2',
  // How long to wait for a Replicate prediction to finish (ms).
  // Imagen 4 typically takes 30–90 s on Replicate.
  // Set higher than your HTTP gateway timeout if you want to see the result;
  // keep lower if you prefer a fast explicit failure over a gateway 502.
  // Default: 120 000 ms (2 min). Override via IMAGE_GENERATION_POLL_TIMEOUT_MS.
  // Local filesystem object storage (replaces Vercel Blob).
  // STORAGE_DIR: where uploaded/generated files are written (a Docker volume in
  // prod). PUBLIC_BASE_URL: the public origin those files are served from, used
  // to build the URLs stored in the DB and sent to Telegram — set it to the real
  // https://<domain> in production.
  STORAGE_DIR:     process.env['STORAGE_DIR']     ?? path.resolve(process.cwd(), 'uploads'),
  PUBLIC_BASE_URL: (process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:8787').replace(/\/+$/, ''),
  IMAGE_GENERATION_POLL_TIMEOUT_MS:
    parseInt(process.env['IMAGE_GENERATION_POLL_TIMEOUT_MS'] ?? '300000', 10),
  ADMIN_TELEGRAM_IDS,
  // Optional: Mini App URL for the /start "Open app" button. If unset, the
  // welcome is sent without a button (users tap the bot's menu button instead).
  MINI_APP_URL: process.env['MINI_APP_URL'] ?? '',
  // TON payments
  TON_RECEIVING_WALLET: process.env['TON_RECEIVING_WALLET'] ?? '',
  TONCENTER_API_KEY:    process.env['TONCENTER_API_KEY']    ?? '',
  // Web search for the AI assistant (Tavily). Optional — search is disabled if absent.
  TAVILY_API_KEY:       process.env['TAVILY_API_KEY']       ?? '',
  // COVER_HTML_MODEL and HIGH_TEXT_MODEL are gone: AI-generated HTML covers and
  // post text now run on OPENAI_CHAT_MODEL through terraText. Post text used to
  // be Claude 4.5 Sonnet rented through Replicate, which tied the product's core
  // output to that account's balance.
  HIGH_IMAGE_MODEL: process.env['HIGH_IMAGE_MODEL'] ?? 'gpt-image-2',
  // Cover generation engine:
  //   'template' — always use HTML/Satori templates (free, instant, brand-perfect)
  //   'flux'     — always use Flux via Replicate (AI-generated artistic images)
  //   'auto'     — use template when brand kit is complete, fall back to flux
  COVER_ENGINE: (process.env['COVER_ENGINE'] ?? 'auto') as 'template' | 'flux' | 'auto',
  // ── AI content manager (deep research + post synthesis on Opus) ──────────────
  // ANTHROPIC_API_KEY unlocks the Anthropic SDK path (Opus 4.8 + native web
  // search/fetch). Optional — the engine falls back to DeepSeek/Serper without it.
  ANTHROPIC_API_KEY:       process.env['ANTHROPIC_API_KEY']       ?? '',
  CONTENT_RESEARCH_MODEL:  process.env['CONTENT_RESEARCH_MODEL']  ?? 'claude-opus-4-8',
  CONTENT_RESEARCH_BACKEND,
  // ── Community Core (AI personalities on real Telegram user accounts) ─────────
  // GramJS/MTProto needs an app api_id + api_hash from https://my.telegram.org.
  // Community Core is disabled at runtime unless both are set. Encrypted persona
  // sessions reuse MANAGED_BOT_ENCRYPTION_KEY.
  TELEGRAM_API_ID:   parseInt(process.env['TELEGRAM_API_ID'] ?? '0', 10),
  TELEGRAM_API_HASH: process.env['TELEGRAM_API_HASH'] ?? '',
} as const;
