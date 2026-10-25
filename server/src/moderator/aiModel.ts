import { env } from '../env';

export const moderatorTextModel = (): string => env.OPENAI_MODERATOR_MODEL;

/** Standard short-context estimate, in microdollars; never a customer charge. */
export function moderatorCostMicros(inputTokens: number, outputTokens: number, cachedInputTokens = 0): number {
  const rates = moderatorTextModel() === 'gpt-6.1-sol' ? [2, 10, .1]
    : moderatorTextModel() === 'gpt-5.6-terra' ? [2, 12, .2] : [2.5, 15, 2.5];
  return Math.round((inputTokens - cachedInputTokens) * rates[0]! + outputTokens * rates[1]! + cachedInputTokens * rates[2]!);
}
