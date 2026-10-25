import { env } from '../env';
import { openAiText, openAiTextResult, type OpenAiUsage } from './openaiChat';

export type TerraEffort = 'low' | 'medium' | 'high';
export interface TerraTextParams {
  model?: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: TerraEffort;
  verbosity?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

/** The model actually answering — for journal rows and admin surfaces. */
export const primaryTextModel = (): string => env.OPENAI_CHAT_MODEL;

/** True when the primary text model can be reached at all. */
export const primaryTextModelConfigured = (): boolean => Boolean(env.OPENAI_API_KEY);

/**
 * Primary text completion for every backend AI path (moderation, Community
 * Manager, Community Core, research, planning). Direct OpenAI, nothing else.
 *
 * Replicate used to sit behind this as a fallback. It was removed: the model we
 * run (gpt-5.6-terra) IS OpenAI's — Replicate only resold it, and throttles to
 * ~6 requests/min once the account balance drops below $5, which took down
 * moderation, CM replies, activities and digests at the same time. A fallback
 * onto the exact thing that fails first is not a safety net, so the transport is
 * now single-provider with a retry (see openAiText) instead.
 */
export async function terraText(p: TerraTextParams): Promise<string | null> {
  if (!env.OPENAI_API_KEY) return null;
  const direct = await openAiText({
    model: p.model,
    system: p.system,
    prompt: p.prompt,
    effort: p.effort ?? 'low',
    verbosity: p.verbosity ?? 'medium',
    maxTokens: p.maxTokens ?? 1024,
    timeoutMs: p.timeoutMs ?? 90_000,
  });
  return direct?.trim() || null;
}

// terraTextStream is gone. It was Replicate-only and served just one caller —
// the assistant's legacy fallback. Streaming for the assistant's real path comes
// from runOpenAiChat (openaiChat.ts), which streams over the Responses API.

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    return start >= 0 && end > start ? JSON.parse(clean.slice(start, end + 1)) as Record<string, unknown> : null;
  } catch { return null; }
}

export async function terraJson(p: Omit<TerraTextParams, 'verbosity'>): Promise<Record<string, unknown> | null> {
  const raw = await terraText({ ...p, verbosity: 'low' });
  return raw ? extractJsonObject(raw) : null;
}

export async function terraStructured<T>(p: TerraTextParams & {
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<{ value: T; usage: OpenAiUsage } | null> {
  if (!env.OPENAI_API_KEY) return null;
  const result = await openAiTextResult({
    model: p.model,
    system: p.system,
    prompt: p.prompt,
    effort: p.effort ?? 'low',
    verbosity: p.verbosity ?? 'low',
    maxTokens: p.maxTokens ?? 1024,
    timeoutMs: p.timeoutMs ?? 90_000,
    format: { type: 'json_schema', name: p.schemaName, schema: p.schema, strict: true },
  });
  if (!result) return null;
  try {
    return { value: JSON.parse(result.text) as T, usage: result.usage };
  } catch {
    return null;
  }
}
