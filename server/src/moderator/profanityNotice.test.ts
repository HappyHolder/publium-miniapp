import assert from 'node:assert/strict';
import test from 'node:test';
import { redactProfanity } from './profanityPolicy';
import { profanityNotices } from './profanityNotice';
import { conversationMention } from './conversationPolicy';

const author = { tgUserId: '20', username: 'person_20', displayName: 'Миша Петров' };

test('fallback replaces all verified occurrences while retaining facts, case and permitted words', () => {
  assert.equal(redactProfanity('Хер, БЛЯТЬ, релиз 2.4: https://example.com @team, блять!', ['блять', 'хер'], ['хер']),
    'Хер, [мат удалён], релиз 2.4: https://example.com @team, [мат удалён]!');
  assert.equal(redactProfanity('Нет, иди нахуй', ['нахуй'], []), 'Нет, иди [мат удалён]');
  assert.equal(redactProfanity('блять', ['блять'], []), '[мат удалён]');
});

test('fallback tracks original offsets across Unicode normalization and merges overlapping evidence', () => {
  assert.equal(redactProfanity('😀 ﬃ БЛЯТЬ, бл*ть и п1здец', ['блять', 'бл*ть', 'п1здец'], []), '😀 ﬃ [мат удалён], [мат удалён] и [мат удалён]');
  assert.equal(redactProfanity('Вот блять да!', ['блять', 'блять да'], []), 'Вот [мат удалён]!');
  assert.equal(redactProfanity('Не блятье, а ёбаный', ['блять', 'ебаный', 'выдумка'], []), 'Не блятье, а [мат удалён]');
});

test('rich notice identifies the actual author and escapes names, owner wording and rewritten text', () => {
  const [notice] = profanityNotices({ ...author, displayName: '<Миша>', notice: 'Пиши без <мата>.', rewrite: 'Нет, оставь меня в покое. <b>Текст</b>' });
  assert.equal(notice!.text, '@person_20 (<Миша>), Пиши без <мата>.\n\n«Нет, оставь меня в покое. <b>Текст</b>»');
  assert.match(notice!.html, /<a href="tg:\/\/user\?id=20"><b>@person_20 \(&lt;Миша&gt;\)<\/b><\/a>/);
  assert.match(notice!.html, /Пиши без &lt;мата&gt;\./);
  assert.match(notice!.html, /<blockquote>Нет, оставь меня в покое\. &lt;b&gt;Текст&lt;\/b&gt;<\/blockquote>/);
  assert.equal(conversationMention({ tgUserId: '20', displayName: 'Миша' }), '<a href="tg://user?id=20"><b>Миша</b></a>');
});

test('long fallback is delivered in complete balanced chunks, without losing emoji or message text', () => {
  const rewrite = '😀[мат удалён] '.repeat(650);
  const notices = profanityNotices({ ...author, notice: 'Пиши без мата.', rewrite, warning: 'Предупреждение 1.' });
  assert.ok(notices.length > 1);
  assert.ok(notices.every(n => n.text.length <= 3900));
  const quoted = notices.map(n => n.html.match(/<blockquote>([\s\S]*)<\/blockquote>/)![1]).join('');
  assert.equal(quoted, rewrite);
  assert.equal(notices.filter(n => n.html.includes('Предупреждение 1.')).length, 1);
});
