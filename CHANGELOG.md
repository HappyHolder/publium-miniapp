# Changelog

All notable changes to Publium are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). This file is the basis for the
update posts on the project channel — when you ship something, add it under
**[Unreleased]**, and on release move it into a dated version section.

Categories: **Added / Changed / Fixed / Removed**.

For the full always-current capability list, see [FEATURES.md](FEATURES.md).

---

## [Unreleased] — toward 1.5

### Added
- Collaber, an optional Community Manager function: Telegram JSON intro import, sourced participant profiles, partner search, consent-based introductions and draft/automatic suggestions.
- CM → Functions → Collaber settings reuse the dark/orange interface, with configurable cover, introduction, contact/action buttons and live preview.
- Scoped access, current membership checks, opt-out and erasure, durable import/jobs, usage journal and uncertain-delivery protection. See [implementation report](docs/collaber-release-2026-09-21.md).
- Collaber regression and isolated PostgreSQL integration coverage in CI. The real Collaborations archive and pilot quality evaluation remain pending.


### Changed
- Telegram auto-draft work is deferred to the next event-loop turn after the webhook acknowledgement, with rejected background tasks always logged.
- Pulse deduplication now skips expected duplicate claims without emitting Prisma error logs.
- Prisma schema now matches the nullable evidence message reference already deployed by the Community Manager runtime migration.

### Tests
- Added regression coverage for deferred webhook background work and rejection handling.
- Added a frontend smoke gate for the production build and core mock-mode navigation.

---

## [1.4.0] — 2026-07-23

Community Core release: AI personas on connected Telegram accounts, unified channel community workspace, shared role knowledge, participant memory, Community Pulse analytics and the expanded Community Manager runtime.

---

## [1.3.0] — 2026-07-15

Community Manager production release plus panorama generation, richer post formats, research controls, participant memory and terminology/security refinements after v1.2.1. Full notes: [docs/release-v1.3.0.md](docs/release-v1.3.0.md).

---

## [1.2.1] — 2026-07-13

Security hardening release: all 12 findings from the Moderator v1.2 audit are closed.

### Security
- **Moderator audit remediation (3 high, 6 medium, 3 low)** — command capability checks and fail-closed target roles; deterministic AI-sanction targets; Multer 2.2.0 plus multipart/edge limits; short-lived bearer sessions with no `initData` in Moderator URLs; rate limits and atomic Terra quotas; live executor-rights checks; isolated regex timeout; mandatory dedicated encryption key with versioned community-bound AAD; 30/90-day retention; production CORS/CSP/HSTS; non-root multi-stage API container with resource limits; expected-username correlation for personal bots.

### Tests
- Added a repeatable security smoke gate for safe/catastrophic regex behavior, Multer version, non-root runtime, CSP and request-body limits; both production builds and production dependency audits remain release gates.

---

## [1.2.0] — 2026-07-13

Everything below is live in production. This release adds the Community entry
point and the first usable Publium Moderator, and includes all content and
publishing improvements shipped after 1.1.

### Fixed
- **Moderator: понятный результат санкции фильтра** — к ручному ответу категории автоматически добавляется номер предупреждения, длительность mute или сообщение о ban; служебный статус работает и без ручного текста и учитывает настройку «Сообщать участнику результат».

### Added
- **Moderator: полная контекстная справка** — вопросики добавлены на общую карточку, триггеры и журнал, а внутри выбора бота появилась отдельная инструкция по стандартному и персональному исполнителю; все памятки открываются одинаковыми bottom sheets с примерами, подключением и рекомендациями. Кнопка изменения имени и аватара персонального бота получила явные интерактивные состояния, иконку и стрелку.
- **AI Moderator: персональный бот-исполнитель** — пользователь создаёт управляемого Telegram-бота прямо из карточки Moderator, задаёт имя, аватар и username, добавляет его администратором и безопасно переключает весь runtime с общего бота. Токен хранится в AES-256-GCM, каждый бот получает отдельный webhook/secret; update_id изолированы по bot id, а удаление бота ставит Moderator на паузу. Персональный бот и Terra объединены в один trial-аддон AI Moderator.
- **Moderator: категории текстовой фильтрации** — до 20 компактных категорий со своими словами и фразами, приоритетом, реакцией, ручным ответом, переменными и автоудалением; редактор открывается нижней модалкой, старые списки переносятся в «Без категории», а одно сообщение получает только одну наиболее подходящую реакцию.
- **Moderator: универсальные триггеры и автоответы** — до 50 сценариев с несколькими словами/фразами, режимами exact/prefix/contains, Rich Message, cooldown, автоудалением, защитой от bot-loop, аудитом и передачей выбранного содержания Terra как знаний сообщества.
- **Moderator: AI-вмешательства и экспериментальный AI-аддон** — Terra пакетно анализирует окно из 6–20 сообщений, распознаёт устойчивый офтопик/политику/конфликт/травлю/рекламу, умеет наблюдать или отвечать в стиле канала и выдавать warn при продолжении той же проблемы; добавлены атомарный claim, cooldown/rate limits, 60-минутный TTL контекста, автоудаление ответа, симулятор, месячная trial-квота 5 000 проверок и учёт токенов/себестоимости. В «Подписках» аддон пока бесплатный на этапе калибровки.
- **Moderator MVP: sanctions, admin commands, log and Terra** — warning expiry and warn→mute→ban escalation, durable auto-unmute, safe reply commands (`/warn`, `/mute`, `/unmute`, `/ban`, `/kick`, `/unban`, `/delete`, `/info`), Telegram command menu, moderation log with reversal, global pause, and fail-open GPT-5.6 Terra classification with Brand Kit context, confidence threshold and review/delete/delete+warn modes.
- **Moderator: встроенные памятки и навигация Community** — четыре карточки получили контекстные справочные bottom sheets с назначением, примерами и рекомендациями; политика ссылок Anti-spam отделена от чёрного списка доменов Filters, regex объяснён на примере; экран сообщества разделён на вкладки Moderator и Community Manager.
- **Moderator: Content Filters v1** — visual block for stop words/phrases, safe regex patterns, domain blacklist, mention/CAPS/emoji limits, forwarded messages and 11 attachment types; supports edited messages, admin/bot/trusted exceptions, delete or delete+warning, retryable enforcement and audit events.
- **Moderator: Anti-spam v1** — visual block for rate flood, duplicate messages and link policy (allow all, block all, domain allowlist), with admin/bot/trusted exceptions, delete or delete+warning actions, audit events, retryable deletion, hashed short-lived message samples, and automatic retention cleanup.
- **Moderator: CAPTCHA v1** — visual newcomer verification block with a personal callback button, temporary write restriction, configurable 1–30 minute deadline, kick/keep-restricted timeout action, bot/admin/trusted exceptions, foreign-click protection, durable Postgres timeouts, audit events, and Welcome delivery only after successful verification.
- **Moderator: Welcome v1** — visual Rich Message welcome block for discussion groups: formatting, image, URL buttons, variables (`{name}`, `{username}`, `{group}`, `{channel}`, `{rules}`), repeat-join modes, bot/admin exceptions, service-message cleanup, and durable auto-delete up to 48 hours. Settings use draft/publish versions and a collapsible editor.
- **Rich inline formatting everywhere** — the generator (and editor) now use the full marker set: `**bold**`, `__italic__`, `~~strike~~`, `` `mono` ``, `==highlight==`, `||spoiler||`, `[links](url)`. Same vocabulary in generation, the block editor and table cells.
- **Nested lists** — a list item can carry a nested numbered sub-list (Tab-indent in the editor).
- **Heading links** — a heading can be a clickable link.
- **Table cell formatting** — inline markers work inside cells (+ a shared formatting toolbar for the focused cell). Cell background color is NOT possible (Telegram strips it).
- **«Ссылка-рамка» (linkbox)** — a framed, filled CTA box with a centered link, rendered as a bordered single-cell table (`<table border="1"><th>`).
- **Checklists, collapsible «спойлер-секции» (`<details>`), and code blocks** — three manual editor blocks.
- **11 cover styles** — pixel, sci-fi, cyberpunk, vaporwave, isometric, minimal, low-poly, glitch, blueprint, watercolor, oil.
- **Panoramas** — a post-image split into stacked/carousel slides. Upload → slice, OR **generate via `google/nano-banana-2`** (Gemini, the one Replicate model doing true 1:4 / 4:1 / 1:8 / 8:1) → auto-slice + upscale to 1080. Gallery gains a `stack` layout.

### Changed
- **Layout/formatting model → GPT-5.6 Terra** (`openai/gpt-5.6-terra` on Replicate), DeepSeek fallback. Richer output (actually uses highlight, nested lists, expandable quotes, linkbox), ~4s.

### Fixed
- **Moderator: массовый импорт стоп-слов и AI-эскалация** — списки теперь разбираются по переносам, запятым, точкам с запятой и табам (до 1000 элементов), включая уже опубликованные конфигурации; повторный harassment после вмешательства перепроверяется через минуту, использует fallback-политику warn→mute→ban для старых конфигураций и показывает санкцию в чате.
- **Publishing is rename-proof** — posts publish by the channel's stable numeric chat id (`tgChatId`), falling back to `@handle`; self-heals from a successful send. Renaming a channel no longer causes "chat not found". Raw Telegram errors → clear Russian messages.

---

## [1.1.0] — 2026-07-11

Everything below is live in production.

### Added
- **AI Content Manager** — the assistant turns one request into a whole SERIES of scheduled posts: chat → plan card → background worker researches each topic (Opus web_search/web_fetch, DeepSeek/Serper fallback), generates each post with a rubric cover, and drops them into Отложка. Asks for and honors the publish time (MSK). Project docs (PDF/DOCX) as a knowledge source in the Brand Kit.
- **Carousel engine** — a post that holds 3–7 parallel points becomes a swipeable slide **carousel** built from the channel pack's slide set (cover → item → outro), with a running bottom strip and a section label read from the post. Peer of the cover engines; degrades to a plain post when the pack has no slides or the post has no parallel points.
- **Publium carousel pack** — carousel slides in the Publium signature style (hand-painted orange dot ornament, glass cards, Onest).
- **Showcase-only style packs** — the internal **Publium** and **Stepan Logos** packs are now visible in the market to everyone, but only an admin can apply them (a shop window); regular users see a disabled CTA + "витрина" badge.
- **Private Stepan Logos cover pack** — dark blueprint rubrics (admin-only).

### Fixed
- **Content manager** — plans are built deterministically (a server-side intent classifier), not via a DeepSeek tool-call that never fired; the real current date is anchored across the whole pipeline (no more stale 2024/2025 facts); scheduling is in Moscow time, not server UTC.
- **Отложка** — the trash button really deletes and "publish now" really sends (were local-only); channel disconnect cascades (posts/brandkit/docs/plans).
- **Carousel** — the bottom ticker reads as one continuous band across slides; the section label is separated from the channel rubric; seed scripts no longer hang on Chromium (browser is closed on exit).

---

## [1.0.0] — 2026-07-03

First fixed public baseline. Everything below is live in production.

### Added
- **Telegram Mini App + bot** (`@Publiumbot`): idea → finished, formatted, on-brand Telegram post.
- **AI post generation** from text, a link (auto-extracted), or a screenshot (vision).
- **Manual "from scratch"** composition mode.
- **AI assistant** with real web research (Serper primary, Tavily fallback) and an "Отправить в Create" handoff.
- **Formatted posts (Telegram Rich Messages)** — auto layout into headings, lists, tables, expandable quotes, and slideshow/collage galleries.
- **Block composer** — heading / paragraph / list / quote / table / image / gallery / video / document / divider; inline formatting toolbar (bold, italic, strike, mono, highlight, spoiler, link) on paragraph, quote **and list**; full table row/column editing; drag-reorder; inline-keyboard button editor; AI illustrations per block.
- **Dual cover engine** — legacy (AI photo + HTML overlay) and modular (rubric/template packs, hybrid, Satori); modes AI / HTML / AI+HTML.
- **Rubrics** — per-channel content types that route the cover recipe.
- **Styles market** — curated cover-style packs (Crypto, CYBR, Publium), buy with Stars / TON, apply to a channel.
- **Publishing** — publish now, schedule + auto-publish, Fast Share (no channel needed).
- **5-hour edit window** — pull a published post back, edit, and re-publish **in place** (same channel message; views/reactions preserved); Archive card "Edit" action; auto-retention purge after the window.
- **Brand Kit** — channel about, voice, post rules, link kit, signature, visual kit + cover settings.
- **Monetization** — subscription tiers with monthly quotas, Telegram Stars + TON payments, promo codes.
- **Admin panel** — promo codes and styles CRUD (upload templates, render previews).

---

_Tag this commit: `v1.0.0`._
