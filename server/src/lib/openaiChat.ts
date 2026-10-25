/**
 * openaiChat.ts
 *
 * Direct OpenAI **Responses API** (/v1/responses) with NATIVE tool calling and
 * reasoning — the assistant's proper agentic loop. The model reasons, decides
 * when to search / create a post / check the schedule, and the server executes
 * the tool and feeds the result back until the model produces a final answer.
 * Text is streamed as it arrives.
 *
 * We use /v1/responses (not /v1/chat/completions) because gpt-5.6-terra rejects
 * function tools + reasoning together on chat/completions. Responses keeps both,
 * and reasoning models plan smarter multi-tool calls there.
 *
 * Thin: raw fetch, no SDK, store:false (OpenAI keeps nothing).
 *
 * runOpenAiChat() (tools + streaming) drives the assistant chat and the
 * Community Core personas. openAiText() (below) is the plain transport behind
 * terraText — moderation, Community Manager and research all run on it. Only
 * image/cover generation still uses Replicate.
 */

import { env } from '../env';

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const POST_MARKER = '[[POST]]';

export interface OaiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** Result of executing one tool call. */
export interface ToolOutcome {
  result: string;                     // fed back to the model so it can reply
  action?: Record<string, unknown>;   // captured by the caller (client executes it)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan?: any;                         // a content-plan DTO to attach to the reply
  createWorthy?: boolean;             // the produced content is publishable post material
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;

export interface RunOpenAiChatOpts {
  system: string;
  history: { role: string; content: string }[];
  userMessage: string;
  tools: OaiTool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  effort?: 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
  maxRounds?: number;
  maxTokens?: number;
  timeoutMs?: number;
  onDelta: (text: string) => void;
}

export interface OpenAiTextParams {
  model?: string;
  system: string;
  prompt: string;
  effort?: 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  timeoutMs?: number;
  format?: {
    type: 'json_schema';
    name: string;
    schema: Record<string, unknown>;
    strict: true;
  };
}

export interface OpenAiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface OpenAiTextResult {
  text: string;
  usage: OpenAiUsage;
}

/** Rate limits and 5xx are transient; a bad key or a malformed request is not. */
const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;
/** Leave enough of the caller's budget for a second attempt to be worth making. */
const RETRY_FLOOR_MS = 4_000;
const RETRY_BACKOFF_MS = 1_200;

/** One Responses call. Returns the text, or a retry hint when it failed. */
async function textOnce(p: OpenAiTextParams, deadline: number): Promise<{ result: OpenAiTextResult | null; retryable: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, deadline - Date.now()));
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model ?? env.OPENAI_CHAT_MODEL,
        instructions: p.system,
        input: [{ role: 'user', content: p.prompt }],
        reasoning: { effort: p.effort ?? 'low' },
        text: { verbosity: p.verbosity ?? 'low', ...(p.format ? { format: p.format } : {}) },
        max_output_tokens: p.maxTokens ?? 1200,
        store: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[openAiText] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return { result: null, retryable: retryableStatus(res.status) };
    }
    const data = await res.json() as {
      output?: Item[];
      output_text?: string;
      status?: string;
      incomplete_details?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      };
    };
    // `output_text` is a convenience field this model does not send — the item
    // walk below is what actually produces the text. Keep both.
    const text = typeof data.output_text === 'string' && data.output_text.trim()
      ? data.output_text
      : textOf(Array.isArray(data.output) ? data.output : []);
    if (!text.trim()) {
      console.warn(`[openAiText] empty output (status=${data.status ?? '?'} incomplete=${JSON.stringify(data.incomplete_details ?? null)})`);
      return { result: null, retryable: false }; // a truncated/refused answer will not fix itself
    }
    const usage = data.usage;
    return {
      result: {
        text: text.trim(),
        usage: {
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          totalTokens: usage?.total_tokens ?? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
          cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
        },
      },
      retryable: false,
    };
  } catch (err) {
    // Network drop or our own timeout — worth one more try if the budget allows.
    console.warn('[openAiText] failed:', (err as Error).message);
    return { result: null, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Plain, non-streaming text completion through the same Responses API — no
 * tools, no streaming. This is the transport every backend caller wants
 * (moderator decisions, CM replies, digests): one prompt in, one text out.
 *
 * Retries once on a transient failure (429, 5xx, dropped connection), but only
 * while the caller's own timeout budget still allows it: `timeoutMs` is the
 * total wall-clock budget across attempts, never per attempt. Returns null when
 * both attempts fail — there is no second provider behind this any more.
 */
export async function openAiText(p: OpenAiTextParams): Promise<string | null> {
  return (await openAiTextResult(p))?.text ?? null;
}

export async function openAiTextResult(p: OpenAiTextParams): Promise<OpenAiTextResult | null> {
  if (!env.OPENAI_API_KEY) return null;
  const deadline = Date.now() + (p.timeoutMs ?? 60_000);

  const first = await textOnce(p, deadline);
  if (first.result) return first.result;
  if (!first.retryable || deadline - Date.now() < RETRY_FLOOR_MS) return null;

  await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS));
  console.warn('[openAiText] retrying once');
  return (await textOnce(p, deadline)).result;
}

export interface OpenAiVisionParams {
  prompt: string;
  /** A public https URL or a `data:image/...;base64,` URI. */
  image: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Defaults to OPENAI_VISION_MODEL. */
  model?: string;
}

/**
 * Reads an image and returns text about it — the transport behind
 * visionExtractor. Same Responses API, with an `input_image` content part.
 * Returns null on any failure; callers degrade rather than throw.
 */
export async function openAiVision(p: OpenAiVisionParams): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? 60_000);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: p.model ?? env.OPENAI_VISION_MODEL,
        input: [{ role: 'user', content: [
          { type: 'input_text', text: p.prompt },
          { type: 'input_image', image_url: p.image },
        ] }],
        max_output_tokens: p.maxTokens ?? 800,
        store: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[openAiVision] HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as { output?: Item[]; output_text?: string };
    const text = typeof data.output_text === 'string' && data.output_text.trim()
      ? data.output_text
      : textOf(Array.isArray(data.output) ? data.output : []);
    return text.trim() || null;
  } catch (err) {
    console.warn('[openAiVision] failed:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface RunOpenAiChatResult {
  text: string;
  action?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plan?: any;
  createWorthy: boolean;
  ok: boolean; // false → nothing produced (caller falls back)
}

interface StreamResult { output: Item[]; failed: boolean }

/** One streamed Responses call. Streams text via onDelta; returns the final
 *  output item array (from response.completed) for the tool loop. */
async function streamOnce(input: Item[], opts: RunOpenAiChatOpts, onDelta: (t: string) => void): Promise<StreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL,
        instructions: opts.system,
        input,
        ...(opts.tools.length ? { tools: opts.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })) } : {}),
        reasoning: { effort: opts.effort ?? 'low' },
        text: { verbosity: opts.verbosity ?? 'medium' },
        max_output_tokens: opts.maxTokens ?? 3000,
        store: false,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      console.warn(`[openaiChat] HTTP ${res.status}: ${body.slice(0, 300)}`);
      throw new Error(`OPENAI_HTTP_${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output: Item[] = [];
    let failed = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // event: lines carry the same type in the JSON
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt: Item;
        try { evt = JSON.parse(data); } catch { continue; }
        const type = evt['type'];
        if (type === 'response.output_text.delta' && typeof evt['delta'] === 'string') {
          onDelta(evt['delta']);
        } else if (type === 'response.completed' && evt['response']?.['output']) {
          output = evt['response']['output'] as Item[];
        } else if (type === 'response.failed' || type === 'error' || type === 'response.incomplete') {
          console.warn('[openaiChat] stream event:', type, JSON.stringify(evt['response']?.['error'] ?? evt['error'] ?? '').slice(0, 200));
          if (type !== 'response.incomplete') failed = true;
          if (evt['response']?.['output']) output = evt['response']['output'] as Item[];
        }
      }
    }
    return { output, failed };
  } finally {
    clearTimeout(timer);
  }
}

/** Extracts plain assistant text from a Responses output array. */
function textOf(output: Item[]): string {
  let text = '';
  for (const item of output) {
    if (item['type'] === 'message' && Array.isArray(item['content'])) {
      for (const c of item['content']) if (c['type'] === 'output_text' && typeof c['text'] === 'string') text += c['text'];
    }
  }
  return text;
}

/**
 * Runs the agentic loop over the Responses API. Streams the final answer via
 * onDelta and executes any tool calls the model requests. `ok:false` means the
 * model produced nothing (caller should fall back to the Replicate path).
 */
export async function runOpenAiChat(opts: RunOpenAiChatOpts): Promise<RunOpenAiChatResult> {
  if (!env.OPENAI_API_KEY) return { text: '', createWorthy: false, ok: false };

  const input: Item[] = [
    ...opts.history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: opts.userMessage },
  ];

  let capturedAction: Record<string, unknown> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let capturedPlan: any;
  let createWorthy = false;

  // Withhold a possible leading [[POST]] marker from the stream until confirmed.
  let prefixBuf = '';
  let prefixDone = false;
  let streamedText = '';
  const gate = (delta: string) => {
    if (!delta) return;
    if (prefixDone) { streamedText += delta; opts.onDelta(delta); return; }
    prefixBuf += delta;
    const lead = prefixBuf.replace(/^\s+/, '');
    if (lead.startsWith(POST_MARKER)) {
      createWorthy = true; prefixDone = true;
      const rest = lead.slice(POST_MARKER.length).replace(/^\s+/, '');
      if (rest) { streamedText += rest; opts.onDelta(rest); }
    } else if (lead.length >= POST_MARKER.length || !POST_MARKER.startsWith(lead)) {
      prefixDone = true; streamedText += prefixBuf; opts.onDelta(prefixBuf);
    }
  };

  const finalize = (): RunOpenAiChatResult => {
    if (!prefixDone && prefixBuf) { streamedText += prefixBuf; opts.onDelta(prefixBuf); prefixDone = true; }
    const text = streamedText.trim();
    return { text, action: capturedAction, plan: capturedPlan, createWorthy, ok: text.length > 0 || !!capturedAction || !!capturedPlan };
  };

  const maxRounds = opts.maxRounds ?? 6;
  try {
    for (let round = 0; round < maxRounds; round++) {
      const { output, failed } = await streamOnce(input, opts, gate);
      if (failed && !output.length) return { ...finalize(), ok: false };

      const functionCalls = output.filter(it => it['type'] === 'function_call');
      if (functionCalls.length) {
        // Preserve the model's own items (reasoning + calls) then add the outputs.
        input.push(...output);
        for (const call of functionCalls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call['arguments'] || '{}'); } catch { /* bad args → empty */ }
          let outcome: ToolOutcome;
          try { outcome = await opts.execute(call['name'], args); }
          catch (err) { outcome = { result: `Tool failed: ${(err as Error).message}` }; }
          if (outcome.action) capturedAction = outcome.action;
          if (outcome.plan) capturedPlan = outcome.plan;
          if (outcome.createWorthy) createWorthy = true;
          input.push({ type: 'function_call_output', call_id: call['call_id'], output: outcome.result.slice(0, 8000) });
        }
        console.log(`[openaiChat] round=${round} tools=${functionCalls.map(c => c['name']).join(',')}`);
        continue; // ask the model again with tool results
      }

      // No tool calls → final answer. If nothing streamed (shouldn't happen), pull text from output.
      if (!streamedText && !prefixBuf) {
        const t = textOf(output);
        if (t) { createWorthy = createWorthy || /^\s*\[\[POST\]\]/.test(t); gate(t); }
      }
      return finalize();
    }
    return finalize(); // hit the round cap
  } catch (err) {
    console.warn('[openaiChat] loop failed:', (err as Error).message);
    return { ...finalize(), ok: false };
  }
}
