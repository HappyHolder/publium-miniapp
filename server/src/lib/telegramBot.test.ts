import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../env';
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerInlinePostQuery, buildPreparedRichMessage, savePreparedPostMessage } from './telegramBot';

test('moves external photos into InputRichMessage.media', () => {
  const result = buildPreparedRichMessage(
    '<h3>Title</h3>\n<tg-slideshow><img src="https://publium.ru/a.png?x=1&amp;y=2"><img src="https://publium.ru/b.png"></tg-slideshow>',
  );

  assert.equal(
    result.html,
    '<h3>Title</h3>\n<tg-slideshow><img src="tg://photo?id=photo_1"><img src="tg://photo?id=photo_2"></tg-slideshow>',
  );
  assert.deepEqual(result.media, [
    { id: 'photo_1', media: { type: 'photo', media: 'https://publium.ru/a.png?x=1&y=2' } },
    { id: 'photo_2', media: { type: 'photo', media: 'https://publium.ru/b.png' } },
  ]);
});

test('moves external video into media and removes its external poster', () => {
  const result = buildPreparedRichMessage(
    '<video src="https://publium.ru/video.mp4" poster="https://publium.ru/poster.jpg"></video>',
  );

  assert.equal(result.html, '<video src="tg://video?id=video_1"></video>');
  assert.deepEqual(result.media, [
    { id: 'video_1', media: { type: 'video', media: 'https://publium.ru/video.mp4' } },
  ]);
});

test('leaves text-only Rich HTML unchanged', () => {
  assert.deepEqual(buildPreparedRichMessage('<p>Hello</p>'), { html: '<p>Hello</p>' });
});
test('retries transient Telegram gateway failures', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async (): Promise<Response> => {
    attempts += 1;
    if (attempts < 3) {
      return new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      result: { id: 'prepared-after-retry', expiration_date: 1234567890 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const prepared = await savePreparedPostMessage({
      userId: 1,
      title: 'Retry probe',
      html: '<p>Hello</p>',
      token: 'TEST_TOKEN',
    });

    assert.equal(prepared.id, 'prepared-after-retry');
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caches a 4x4 gallery in Telegram and prepares it with file_ids', async () => {
  const originalFetch = globalThis.fetch;
  let telegramRequest: RequestInit | undefined;
  let albumCalls = 0;
  let deleteCalls = 0;
  let nextMessageId = 100;
  const prefix = `audit-test-${randomUUID()}`;
  const names = Array.from({ length: 16 }, (_, index) => `${prefix}-${index}.png`);
  const urls = names.map(name => `${env.PUBLIC_BASE_URL}/uploads/${name}`);
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

  await fs.mkdir(env.STORAGE_DIR, { recursive: true });
  await Promise.all(names.map(name => fs.writeFile(path.join(env.STORAGE_DIR, name), tinyPng)));

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('https://media.test/')) {
      return new Response(new Uint8Array(tinyPng), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    if (url.includes('/botTEST_TOKEN/sendMediaGroup')) {
      albumCalls += 1;
      assert.ok(init?.body instanceof FormData);
      const items = JSON.parse(String(init.body.get('media'))) as Array<{ type: string }>;
      const result = items.map(() => {
        nextMessageId += 1;
        return {
          message_id: nextMessageId,
          photo: [{ file_id: `telegram-file-${nextMessageId}` }],
        };
      });
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/botTEST_TOKEN/deleteMessages')) {
      deleteCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/botTEST_TOKEN/savePreparedInlineMessage')) {
      telegramRequest = init;
      return new Response(JSON.stringify({
        ok: true,
        result: { id: 'prepared-id', expiration_date: 1234567890 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const html = `<tg-slideshow>${urls.map(url => `<img src="${url}">`).join('')}</tg-slideshow>`;
    const prepared = await savePreparedPostMessage({
      userId: 1,
      title: '4x4 gallery',
      html,
      token: 'TEST_TOKEN',
    });

    assert.equal(prepared.id, 'prepared-id');
    assert.equal(albumCalls, 2);
    assert.equal(deleteCalls, 2);
    assert.equal(typeof telegramRequest?.body, 'string');
    const request = JSON.parse(String(telegramRequest?.body)) as {
      result: { input_message_content: { rich_message: { html: string; media: Array<{ media: { media: string } }> } } };
    };
    const rich = request.result.input_message_content.rich_message;
    assert.equal(rich.media.length, 16);
    assert.equal(rich.media[0]?.media.media, 'telegram-file-101');
    assert.equal(rich.media[15]?.media.media, 'telegram-file-116');
    assert.ok(rich.html.includes('tg://photo?id=photo_16'));
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all(names.map(name => fs.unlink(path.join(env.STORAGE_DIR, name)).catch(() => undefined)));
  }
});

test('answers an inline query with the prepared post result', async () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init): Promise<Response> => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = { type: 'article', id: 'post', title: 'Post' };
    await answerInlinePostQuery('inline-query-id', result, 'TEST_TOKEN');

    assert.equal(payload?.['inline_query_id'], 'inline-query-id');
    assert.deepEqual(payload?.['results'], [result]);
    assert.equal(payload?.['cache_time'], 0);
    assert.equal(payload?.['is_personal'], true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
