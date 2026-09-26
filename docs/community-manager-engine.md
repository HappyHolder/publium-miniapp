# Community Manager: полная архитектура движка

Актуально для unified runtime после релиза 2 августа 2026 года. Документ является техническим источником истины по исполнению, памяти, инициативам, данным и эксплуатации Community Manager (КМ).

## 1. Главный принцип

КМ работает одним движком принятия решений. Человеческое сообщение, комментарий к публикации, автоматическая инициатива, ручная активность и дайджест проходят через `runCommunityManagerAgent` и одну строгую схему результата. Старый набор отдельных генераторов ответов не участвует в production-исполнении.

Контекст представлен графом:

- `CommunityManagerThread` — Telegram-ветка или логический корень разговора;
- `CommunityManagerSegment` — смысловой диалог внутри ветки;
- `CommunityManagerMessage` — точные сообщения людей и контентные корни;
- `CommunityManagerAction` — ответы, реакции и активности КМ;
- `CommunityManagerEpisode` и participant claims — долговременная память событий и фактов о конкретном человеке.

Текущий сегмент раскрывается точными репликами обеих сторон. Параллельно агент получает индекс всех сохранённых сегментов. До четырёх релевантных прошлых веток выбираются по совпадению темы и открываются точными сообщениями по требованию. Несвязанные ветки запрещено смешивать.

## 2. Поток входящего сообщения

1. Telegram webhook проверяет секрет, исполнителя бота, сообщество и активную опубликованную конфигурацию.
2. Сообщение дедуплицируется по bot namespace и update id. Цитируемое человеческое сообщение сохраняется как контекст.
3. Отдельная digest-копия получает увеличенный срок хранения.
4. Обновляются профиль участника, счётчики и relationship state.
5. Создаётся job с небольшой задержкой для склейки burst-сообщений и ожидания Moderator.
6. Worker проверяет результат модерации, точный reply target, mention и адресата.
7. Жёстко применяются выключенные reply-пути, user cooldown, ambient cooldown, quiet hours и лимиты.
8. Conversation Coordinator находит thread/segment. Текущий root, родитель и недавняя история не теряются из-за token budget.
9. Обновляется personal inner state; agent получает событие, личность, ветку, участников, память, индекс веток, BrandKit-about и доступные знания.
10. Structured decision валидируется, неизвестные ссылки отбрасываются, действие сверяется с типом события.
11. Перед отправкой повторно проверяются версия разговора, активность КМ и quota. После Telegram send атомарно пишется audit и обновляется граф.

## 3. Контекст и память

### Текущая ветка

`read_current_thread` возвращает точный source root, reply parent, сообщения людей и ответы КМ в хронологическом порядке. При длинной ветке сохраняются обязательные root/parent и максимально свежий хвост в ограниченном бюджете.

### Другие ветки

Полный conversation index содержит идентификатор, статус, origin, topic key, summary, открытые вопросы и время обновления каждого сохранённого сегмента. `read_related_branches` раскрывает совпавшие ветки с точными репликами людей и КМ. Summary служит индексом, а не заменой сообщений и не инструкцией для модели.

### Память человека

Для участников текущего разговора доступны:

- стабильный Telegram user id, имя и username;
- relationship class и числовой relationship state;
- message/exchange counts;
- подтверждённые ROLE, EXPERTISE, PREFERENCE и FACT claims;
- прошлые episodes с outcome.

Новые claims сохраняются только при confidence не ниже 0.7 и только с точной evidence-ссылкой `msg:<telegram id>`. Evidence excerpt переживает удаление сырого сообщения: FK становится nullable с `ON DELETE SET NULL`. Данные разных пользователей никогда не объединяются.

### Личное состояние КМ

`personalState` хранит valence, arousal, dominance, energy, stress, irritation, confidence, curiosity и active goal. Состояние постепенно затухает и меняется от прямого вопроса, конфликта, позитивного обмена и разрешения ситуации. Оно влияет на тон, но не отменяет безопасность или настройки.

OpenAI SDK session items больше не являются источником диалоговой памяти. Сессия остаётся audit-контейнером и хранит summary/привязку; авторитетный контекст каждый запуск собирается из графа, поэтому старый SDK transcript не может загрязнить новую ветку.

## 4. Личность и естественность

`personalityPrompt` подключён к каждому agent run. Он включает identity, social roles, traits, speech/humor style, profanity level, debate style, psychology, reactions, relationship style, strengths, weaknesses, boundaries, triggers и contradictions.

Калибровочные правила:

- отвечать конкретному человеку и его вопросу;
- 1–3 коротких разговорных абзаца по умолчанию;
- не превращать каждую новость в рыночный анализ;
- не добавлять искусственный вопрос ради engagement;
- не использовать заголовки, канцелярские переходы, лозунги и длинное тире;
- молчание или реакция допустимы;
- факты только из ветки, project knowledge или web research;
- незнание обозначается явно, контекст не выдумывается.

## 5. Матрица настроек

### Support

- `useBrandKit`: добавляет только channelAbout (тема, аудитория, цель), без визуальных и постовых шаблонов.
- `useProjectDocs`: включает ProjectDoc и role knowledge docs.
- `useFaq`: включает enabled FAQ с приоритетом; работает независимо от docs.
- `answerProductQuestions + replyToProductQuestion`: совместно разрешают ответы по продукту; отключение передаётся как hard policy.

### Replies

- direct reply, mention, ambient и thematic conversation проверяются до AI-вызова;
- `conversationMemory` включает индекс веток, claims, episodes и запись новой долговременной памяти;
- `ambientCooldownMinutes` запрещает повторное фоновое вмешательство в окно cooldown;
- `userCooldownSeconds` ограничивает частые ответы одному человеку;
- `replyToUnansweredQuestion` после `unansweredAfterMinutes` повторно поднимает только реально оставшийся без ответа человеческий вопрос в исходном сегменте;
- `moderatorFollowups` запускается только если после сигнала Moderator разговор продолжился минимум двумя человеческими сообщениями.

### Activities

`activities.enabled` и `requireApproval` управляют автоматическими инициативами. Reply-followups являются продолжением разговора, а не случайной инициативой. Intensity задаёт окно паузы; ignored backoff увеличивает паузу после отсутствия реакции.

Контракты форматов:

- DISCUSSION — один конкретный обсуждаемый вопрос, не монолог;
- POLL — Telegram regular poll, 2–4 уникальных варианта;
- QUIZ — Telegram quiz с корректным индексом ответа и объяснением;
- LIGHT — короткая тематическая лёгкая механика;
- HOT_NEWS — сначала актуальный research, затем проверяемая тема;
- DIGEST — только реально предоставленные ветки;
- PREDICTION — проверяемое условие, срок и критерий resolution;
- CHALLENGE/CONTEST — правила, срок и настроенная награда; автоматически не запускаются;
- CONTENT_RELEASE — только конкретная добавленная мысль к source post.

После отправки самостоятельной инициативы создаются thread и segment. Ответы участников оцениваются именно внутри этой активности. Engagement считает только человеческие сообщения, исключает CONTEXT и при наличии threadId не захватывает соседние разговоры.

## 6. Планировщик и защита от спама

Scheduler запускается раз в 7 минут и выполняет в порядке приоритета:

1. lifecycle длинных активностей;
2. оценку завершённых инициатив;
3. отложенные content release;
4. daily digest;
5. moderator follow-up;
6. unanswered question;
7. контентный сигнал;
8. обычную инициативу после тишины.

Используются quiet hours, configured timezone, active-chat suppression, topic dedupe, deterministic chance для content teaser и backoff 6/18/36/72 часов с поправкой intensity. После двух проигнорированных инициатив content lifecycle не создаёт новую цепочку.

## 7. Публикации и дайджест

Автоматический forward канала создаёт CONTEXT root и отложенный CONTENT_RELEASE. Любой человеческий ответ в discussion thread отменяет «комментарий в тишину». Комментарий проходит отдельный editorial review, обязан отвечать точному discussion root и добавлять проверяемую мысль. Лимит: не более трёх успешных content comments за 24 часа и не чаще одного за 4 часа.

Daily digest читает `CommunityManagerDigestMessage`, а не короткоживущую conversational таблицу. Ночная очистка сообщений не уничтожает материал предыдущего дня. Кластеры строятся по reply chains и Telegram topics; одиночные реплики не выдаются за дискуссии.

## 8. Надёжность и данные

- Agent event имеет dedupe key и состояния RUNNING/COMPLETED/FAILED.
- Telegram-send отделён от persistence recovery: уже отправленное сообщение не посылается повторно при сбое audit-записи.
- Jobs используют lease, retry wait и ограниченное число попыток.
- Pause атомарно отменяет pending jobs и все незавершённые activities, снимает leases.
- Subscription quota резервируется перед внешним действием и возвращается, если отправка не состоялась.
- Raw conversation messages очищаются по `expiresAt`; digest copy и evidence имеют отдельную политику хранения.

Миграция `20260802170000_complete_community_manager_runtime`:

- сохраняет evidence после удаления raw message;
- заполняет session summary из сегмента;
- без удаления истории создаёт graph roots/segments для сохранённых старых сообщений;
- рекурсивно присоединяет reply chains;
- восстанавливает thread/segment ссылки audit actions.

## 9. Основные файлы

- `server/src/communityManager/engine.ts` — webhook intake, jobs, hard reply policy и delivery.
- `server/src/communityManager/agentRuntime.ts` — snapshot, tools, prompt, decision schema и agent events.
- `server/src/communityManager/conversationCoordinator.ts` — graph routing, segment evolution, claims и episodes.
- `server/src/communityManager/participantMemory.ts` — профили, relationship state и эксперты.
- `server/src/communityManager/activityScheduler.ts` — opportunities, follow-ups, backoff и engagement.
- `server/src/communityManager/activityRuntime.ts` — единое исполнение форматов и Telegram send.
- `server/src/communityManager/contentRelease.ts` — lifecycle поддержки публикаций.
- `server/src/communityManager/dailyDigest.ts` — дневное окно, clustering и digest delivery.
- `server/src/communityManager/personality.ts` и `personalityState.ts` — характер и внутреннее состояние.
- `server/src/communityManager/agentSession.ts` — audit session identity; не источник runtime-контекста.
- `server/src/routes/communityManager.ts` — управление, pause и API.

## 10. Наблюдаемость

Для каждого решения сохраняются intent, reason, decision, response, model, prompt version, token usage, latency, sources, threadId, segmentId, Telegram message id и agent event id. Activity result хранит automatic/evaluated/engaged, число сообщений и участников, quality issues и lifecycle metadata.

Production-диагностика:

```bash
docker compose ps
docker compose logs --tail=200 api
curl -fsS https://publium.ru/api/health
```

Deploy: `git pull origin main`, затем из `/opt/publium/deploy` выполнить `docker compose up -d --build`. API применяет `prisma migrate deploy` при старте.

## 11. Обязательная проверка

Перед deploy:

```bash
npm --prefix server test
npm --prefix server run build
npm run build
git diff --check
```

После deploy проверяются контейнеры, применённая миграция, API health и отсутствие новых ошибок в api logs.

Тесты покрывают decision schema, quiz contract, изоляцию thread/segment keys, participant memory projection, content quality gate, activity rotation/backoff, content cancellation, conversation routing, personality state, digest clustering/retention и Telegram routing.

## 12. Границы системы

КМ видит всё, что Telegram webhook доставил и что существует в долговременном графе. Он не может восстановить сообщения, которые Telegram никогда не прислал или которые были удалены до появления evidence/episode/summary. Web research не считается памятью сообщества и ограничен configured policy/лимитами. Moderator остаётся отдельным источником решений о блокировке; КМ не подменяет его enforcement.

## Collaber (21.09.2026)

Collaber — отключённая по умолчанию функция в `features.collaber`, с профилями, импортами, заданиями, запросами, приватными сессиями и взаимными приглашениями. Подробности: [отчёт реализации](collaber-release-2026-09-21.md).

Групповой агент получает `find_collaboration_partners` только при включённой функции; контекст менеджера и автора задаётся сервером. Результат передаётся в детерминированное rich-представление вместо второго обычного ответа агента. Приватные команды и фоновые инициативы обрабатываются модулем Collaber в CM worker с тем же исполнителем, общей паузой, квотой и журналом. Они не проходят через общий генератор активностей; перед инициативой проверяются тихие часы, лимиты, последняя активность людей, ожидающая модерация и другие текущие активности.

AI-вызовы извлечения/подбора используют общий OpenAI transport и отдельные записи usage в `CommunityManagerAction` с `intent=collaber_inference`. Отправки имеют `intent=collaber`; неопределённая доставка не повторяется автоматически. Существующие разговорные сценарии CM не зависят от включения Collaber.
