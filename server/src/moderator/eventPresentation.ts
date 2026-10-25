type Identity = { tgUserId: string; username?: string | null; displayName?: string | null };
type EventRow = { id: string; tgUserId: string | null; eventType: string; decision: string | null; action: string | null; reason: string | null;
  status: string; confidence: number | null; metadata: unknown; feedback: string | null; reversedAt: Date | null; createdAt: Date };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const value = (v: unknown) => typeof v === 'string' ? v : '';
const categories: Record<string, string> = { profanity: 'Мат', conflict: 'Личный конфликт', toxicity: 'Личные выпады', harassment: 'Травля и давление', threat: 'Угроза',
  insult: 'Оскорбление', hate: 'Разжигание ненависти', spam: 'Спам', promotion: 'Самореклама',
  fraud: 'Подозрение на обман', semantic_spam: 'Навязчивые повторы', off_topic: 'Офтоп', ALLOW: 'Нарушений нет', BELOW_THRESHOLD: 'Недостаточно уверенности',
  QUOTA_EXHAUSTED: 'Лимит проверок исчерпан', MODEL_ERROR: 'Ошибка проверки', PENDING: 'Идёт проверка' };
const labels: Record<string, string> = { AI_INTERVENTION: 'Замечание в разговоре', CONVERSATION_EPISODE: 'Анализ разговора', AI_MODERATION_TRIGGERED: 'Проверка мата',
  AI_CONVERSATION_CHECKED: 'Проверка разговора',
  AI_MODERATION_CHECKED: 'Проверка мата', ANTISPAM_TRIGGERED: 'Антиспам', ANTISPAM_EDITED: 'Антиспам: изменение', CONTENT_FILTER_TRIGGERED: 'Фильтр контента',
  CONTENT_FILTER_EDITED: 'Фильтр: изменение', PROBATION_TRIGGERED: 'Ограничение новичка', RAID_GUARD_TRIGGERED: 'Защита от рейда', MANUAL_COMMAND: 'Команда администратора',
  TRIGGER_MATCHED: 'Автоответ', CAPTCHA_PASSED: 'Проверка пройдена', CAPTCHA_TIMEOUT: 'Проверка не пройдена', MEMBER_JOINED: 'Вступление в чат',
  SANCTION_EXPIRED: 'Ограничение завершено', APPEAL: 'Обращение участника', RAID_DETECTED: 'Наплыв участников', GLOBAL_BLACKLIST: 'Чёрный список' };
const reasons: Record<string, string> = {
  FLOOD: 'Слишком много сообщений за короткое время', DUPLICATE: 'Повтор сообщения', LINK_BLOCKED: 'Ссылка запрещена правилами',
  VIA_BOT_BLOCKED: 'Публикация через запрещённого бота', BOT_REFERENCE_BLOCKED: 'Упоминание запрещённого бота',
  LINK: 'Ссылка недоступна новичку', FORWARD: 'Пересылка недоступна новичку', MEDIA: 'Медиа недоступно новичку',
  CAPS: 'Слишком много заглавных букв', MENTIONS: 'Слишком много упоминаний', EMOJI: 'Слишком много эмодзи',
  STOP_WORD: 'Запрещённое слово или фраза', REGEX: 'Совпадение с текстовым фильтром', DOMAIN_BLOCKED: 'Запрещённый сайт',
  MEDIA_BLOCKED: 'Этот тип вложения запрещён', FORWARD_BLOCKED: 'Пересылки запрещены',
};

export function presentModerationEvent(event: EventRow, identities: Map<string, Identity> = new Map()) {
  const m = object(event.metadata), scope = m['scope'] === 'CONVERSATION' || ['AI_INTERVENTION', 'CONVERSATION_EPISODE'].includes(event.eventType)
    ? 'CONVERSATION' : event.eventType.startsWith('AI_MODERATION') ? 'PROFANITY' : 'GENERAL';
  const identity = (source: Record<string, unknown>): Identity => {
    const id = value(source['tgUserId']) || event.tgUserId || '';
    const old = identities.get(id);
    return { tgUserId: id, username: value(source['username']) || old?.username || null, displayName: value(source['displayName']) || old?.displayName || null };
  };
  const rawMessages = scope === 'CONVERSATION' ? (Array.isArray(m['evidence']) ? m['evidence'] : []) : m['source'] ? [m['source']] : [];
  const messages = rawMessages.flatMap(raw => {
    const source = object(raw), text = value(source['text']);
    if (!text) return [];
    return [{ messageId: typeof source['messageId'] === 'number' ? source['messageId'] : null,
      author: identity(source), text, excerpt: value(source['excerpt']) || null }];
  });
  const action = event.action ?? '', sanctions = Array.isArray(m['sanctions']) ? m['sanctions'].map(object) : [];
  const hasBan = action.includes('BAN') && !action.includes('UNBAN'), hasMute = action.includes('MUTE') && !action.includes('UNMUTE'), hasWarn = action.includes('WARN');
  const deleted = action.includes('DELETE'), pending = deleted && m['deletePending'] === true;
  const rewrite = typeof m['suggestedRewrite'] === 'string' && Boolean(m['suggestedRewrite']);
  let actionLabel = action.includes('ALLOW_UNCHECKED') ? 'Пропущено без проверки' : action.includes('ALLOW_ON_ERROR') ? 'Оставлено из-за ошибки проверки'
    : action === 'ALLOW' ? 'Оставлено в чате' : action === 'REVIEW' ? 'Записано в журнал' : action === 'OBSERVE' || action === 'CHECK' ? 'Наблюдение'
    : action.includes('RESPOND_FAILED') ? 'Замечание не доставлено' : action.includes('RESPOND') ? 'Отправлено замечание' : 'Событие обработано';
  if (deleted) actionLabel = pending ? 'Удаление не подтверждено' : m['deletePending'] === false ? 'Сообщение удалено' : 'Запрошено удаление';
  if (rewrite && !m['notificationError']) actionLabel += ' · предложена замена';
  if (hasBan) actionLabel += ' · блокировка'; else if (hasMute) actionLabel += ' · временное ограничение'; else if (hasWarn) actionLabel += ' · предупреждение';
  const actorIds = Array.isArray(m['actorIds']) ? m['actorIds'].filter((x): x is string => typeof x === 'string') : event.tgUserId ? [event.tgUserId] : [];
  const actors = actorIds.map(id => messages.find(msg => msg.author.tgUserId === id)?.author ?? identity({ tgUserId: id, ...object(m['author']) }));
  return { id: event.id, eventType: event.eventType, label: labels[event.eventType] ?? 'Событие модерации', scope,
    categoryLabel: categories[event.decision ?? ''] ?? (value(m['categoryName']) || labels[event.eventType] || 'Правила сообщества'),
    reason: reasons[event.reason ?? ''] ?? event.reason, actionLabel, status: event.status,
    statusLabel: event.reversedAt ? m['preservedNewerSanction'] ? 'Это предупреждение отменено. Более новое ограничение сохранено.' : 'Санкция этого события отменена.'
      : event.status === 'FAILED' ? 'Ошибка' : event.status === 'SKIPPED' ? 'Пропущено' : event.status === 'RECEIVED' ? 'Обрабатывается' : 'Обработано',
    confidence: event.confidence, createdAt: event.createdAt, feedback: event.feedback, reversedAt: event.reversedAt,
    actors, messages, response: value(m['response']) || null, suggestedRewrite: value(m['suggestedRewrite']) || null,
    deliveryError: m['notificationError'] || m['deliveryStatus'] === 'FAILED' ? 'Не удалось доставить замечание. Проверьте права и доступность бота.' : null,
    canRate: !event.reversedAt && ['AI_INTERVENTION', 'AI_MODERATION_TRIGGERED', 'CONVERSATION_EPISODE'].includes(event.eventType) && Boolean(categories[event.decision ?? '']) && m['state'] !== 'RESOLVED',
    canReverse: !event.reversedAt && event.status === 'PROCESSED' && Boolean(event.tgUserId) && (hasWarn || hasMute || hasBan || sanctions.length > 0),
  };
}
