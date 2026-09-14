# Publium — Feature Inventory (current production)

- **Community workspace** — Moderator, unified Community Manager, Community Core personas and Pulse analytics share one channel-level entry point.
- **Moderator** — Welcome, CAPTCHA, anti-spam, content filters, triggers, sanctions, manual commands, journal and fail-open AI moderation.
- **Managed executors** — Moderator and Community Manager can use shared bots or encrypted personal Telegram bots with their own webhook secrets.

Living catalog of everything Publium does. Grouped by area; each item notes the
main backing endpoint(s) / module(s). Use this as the source of truth for release
notes and channel update posts. When you ship something, add it here **and** to
[CHANGELOG.md](CHANGELOG.md).

Publium is a Telegram Mini App + bot (`@Publiumbot`) that turns an idea into a
finished, formatted, on-brand Telegram post — text, cover, and layout — and
publishes or schedules it to the user's channel.

---

## 1. Onboarding & Auth
- **Telegram Mini App auth** — validates `initData` server-side; auto-creates the user on first open. `POST /api/auth/telegram`.
- **Onboarding slides** — first-run intro (`OnboardingSlides`).
- **Active channel** — remembers the last-used channel per user. `POST /api/auth/active-channel`.

## 2. Channels & Brand Kit
- **Connect a channel** — links a public channel where the bot is admin. `POST /api/channels/connect`.
- **Brand Kit** (`BrandKitScreen`) — the channel's identity, 6 parts: channel about, voice profile, post rules, link kit (buttons), signature, visual kit. `GET/POST/PATCH /api/brandkits/:channelId`.
- **Cover settings** — cover mode (AI / HTML / AI+HTML), aspect ratio, background style/detail, cover language, logo usage, brand colors, reference images.
- **Rubrics** — content types per channel (`{name, description, mode, templateUrl?}`); an AI classifier routes each post into a rubric, whose mode + template decide how the cover is built. `classifyPostRubric`.
- **AI cover-style generation** — generate a channel visual style. `POST /api/brandkits/generate-cover-style`.
## 2.1 Community & Moderator
- **Вход из карточки канала** — экран сообщества с вкладками Moderator / Community Manager.
- **Два уровня продукта** — `@Publiumbot` открывает Mini App и хранит настройки; отдельный бот-исполнитель работает администратором группы обсуждений.
- **Draft / publish** — изменения блоков сохраняются в черновик и начинают исполняться только после публикации.
- **Welcome** — Rich Message, изображение, кнопки, переменные, повторный вход и автоудаление.
- **CAPTCHA** — персональная кнопка, временное ограничение, durable timeout и kick/restrict.
- **Anti-spam** — flood, повторы, ссылки и allowlist доменов.
- **Content Filters** — категории стоп-слов и фраз, ручные ответы, regex, домены, CAPS, emoji, пересылки и типы вложений.
- **Триггеры** — exact/prefix/contains автоответы с Rich Message, изображением, кнопками, cooldown и передачей знаний Terra.
- **Правила и санкции** — предупреждения со сроком, warn → mute → ban, авто-unmute и ручные reply-команды администраторов.
- **AI-модерация Terra** — классификация отдельных сообщений и контекстные вмешательства в затяжной оффтопик, политику, конфликт, травлю и рекламу; симулятор и trial-квота.
- **Журнал** — последние решения и отмена warn/mute/ban; общая пауза Moderator.
- **Контекстная помощь** — bottom-sheet инструкции, примеры и рекомендации для всех блоков и бота-исполнителя.

## 2.2 Community Manager, Community Core & Pulse
- **Unified Community Manager runtime** — one structured agent handles human messages, post comments, initiatives, manual activities and daily digests.
- **Conversation graph** — exact Telegram threads and semantic segments, with evidence-backed participant claims and episodic memory.
- **Activities** — discussions, polls, quizzes, light formats, hot news, digests, predictions and controlled content support with cooldown/backoff.
- **Community Core personas** — configurable AI personalities on connected Telegram user accounts, with independent memory, relationships and pacing.
- **Pulse analytics** — activity, engagement, retention, cohorts, joins/leaves and moderation signals, deduplicated across all chat observers.

## 3. Content creation — Create tab (`CreateScreen`)
- **AI generation** from a single input: free text, a pasted link (article auto-extracted via `fetchArticle`), or a screenshot (vision-extracted via `extractImageContentFromUrl`). `POST /api/posts/generate`.
- **Manual "from scratch"** — empty post, no AI/quota, opens straight into the block editor. `POST /api/posts/create-blank`.
- Progress UI + Create-mode monthly quota.

## 4. AI assistant (`ChatScreen`)
- **Chat assistant** with real web research — Serper (Google, ru) primary, Tavily fallback; forced pre-search + no-fabrication rule (no hallucinated news). `POST /api/chat`, history `GET /api/chat/history`.
- **Assistant → Create handoff** — "Отправить в Create" prefills Create and auto-generates a post from an assistant reply.

## 5. Post editor / composer (`RichPostEditor` + `RichPostPreview`)
- **Telegram-faithful preview** + **block editor** toggle (Превью / Редактор).
- **Block types:** heading, paragraph, list, quote, table, image, gallery, video, document, divider.
- **Inline formatting toolbar** (on paragraph, quote, **and list**): bold, italic, strikethrough, monospace, highlight, spoiler, link.
- **Table editor** — add/remove rows **and columns**, robust to ragged data.
- **Block ops** — reorder (↑/↓ + drag), delete, add block.
- **Images** — upload, or **AI illustration** with an editable prompt + regenerate. `upload-block-image`, `generate-block-image`.
- **Gallery** — multi-image carousel / grid; upload or AI photo one-at-a-time.
- **Video** (≤20 MB mp4) and **document** attachments. `upload-block-video`, `upload-block-document`.
- **Inline keyboard buttons** editor (url / copy-to-clipboard, styles, grid rows). `PATCH /api/posts/:postId/buttons`.
- Layout persisted per variant. `PATCH /api/posts/:postId/blocks`.

## 6. Formatted posts (Telegram Rich Messages)
- Every post auto-formats into native Telegram blocks (headings, lists, tables, expandable quotes, galleries) via `richPostGenerator` → `blocksToRichHtml` → `sendRichMessage`. Plain text is only an internal emergency fallback.
- Carousel / grid inside a post via `<tg-slideshow>` / `<tg-collage>`.

## 7. Covers — dual visual engine
- **Two engines**, chosen by a router (`coverEngineRouter`):
  - **Legacy** `coverBuilder` — for AI+HTML without a template: AI photo background + HTML overlay (dynamic, darkened text zone).
  - **Modular** `coverEngineV2` — rubric/template packs, hybrid template-over-photo, Satori fallback.
- **Modes:** `ai` (neural image + text overlay), `html` (branded template), `ai_html` (photo + template overlay).
- **Per-post rubric re-render** — swap only the cover under a chosen rubric. `POST /api/posts/set-rubric`.
- **Regenerate visual** / **restore previous cover** / **upload custom banner**. `regenerate-visual`, `set-banner`.
- **Editable cover headline** (text-only re-render on the saved clean base). `set-cover-text`.

## 8. Styles market (`StylesScreen`)
- **Cover-style packs** — browse & apply curated packs (Crypto, CYBR, Publium signature). `POST /api/styles/list`.
- **Purchase** via TON orders; free packs are available without purchase. Server checks paid and showcase pack access. `POST /api/payments/ton/orders`, `POST /api/payments/ton/orders/:id/verify`.
- **Apply** = replace the channel's cover fields, keep the channel logo.

## 9. Publishing & scheduling
- **Publish now** to the channel via Rich Message. `POST /api/posts/publish`.
- **5-hour edit window** — a published post stays editable and can be re-published **in place** (edits the same channel message, keeps views/reactions/position). `POST /api/posts/:postId/republish`.
- **Schedule** to a date/time; **auto-publish** by the background scheduler. `POST /api/posts/schedule` + `scheduler.ts`.
- **Fast Share** — send a post via Telegram's native share dialog to another destination from an existing post. `POST /api/posts/:postId/prepare-share`.
- **Posts tabs** — Новые / Отложка / **Архив**; Archive card has an **Edit** action within the 5-hour window.
- **Retention** — published posts (and their media) are purged after the 5-hour window so data doesn't accumulate.
- **Variants** — multiple AI text variants per post; select the one to publish. `select-variant`, `update-variant`, `regenerate-text`.

## 10. Monetization & plans (`PlansScreen`)
- **Subscription tiers** with monthly AI quotas (posts / creates). `POST /api/payments/subscription`.
- **Payments** — TON only. Orders fix the product, recipient, amount and unique comment; one shared transaction ledger prevents reuse across purchases.
- **Promo codes** — redeem for plan benefits. `POST /api/promo/redeem`.

## 11. Admin panel (`AdminPanelScreen`, admin-only)
- **Promo codes** — create/list. `admin/promo/*`.
- **Styles CRUD** — create/edit/delete packs, upload templates, render previews. `admin/styles/*` + `AdminStylesScreen`.

## 12. Bot & infra
- **Bot webhook** — messages to `@Publiumbot` auto-draft a post for the active channel. `POST /api/bot/webhook`.
- **OG preview page** — renders a cover as a large Telegram link-preview card. `GET /api/og`.
- **Storage** — cover/media uploads with cleanup on post delete.
- **Models** — direct OpenAI for text/agents, vision, transcription and standard covers; Replicate only for extreme-ratio panoramas; Serper/Tavily for web search.

---

_Last updated: 2026-08-03._

## Reliability update — 2026-09-12

Publication uses a shared database claim and retained publication history. Content-plan cancellation and quota refunds are transactional. Independent chat context follows ChannelChatLink. Configuration saves are confirmed by the server; heavy screens load on demand. See docs/audit-remediation-2026-09-12.md.
