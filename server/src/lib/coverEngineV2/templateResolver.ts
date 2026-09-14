import { templateFetch } from '../templateFetch';
import { publicFetch } from '../publicFetch';
﻿import { selectHtmlTemplate } from '../aiGenerator';
import type { CoverContextV2, HtmlTemplateRef, RubricRef } from './types';

export async function resolveTemplateV2(
  ctx: CoverContextV2,
  rubric: RubricRef | null,
  dryRun = false,
): Promise<HtmlTemplateRef | null> {
  if (ctx.explicitTemplate) return ctx.explicitTemplate;
  if (rubric?.templateUrl) return { name: rubric.name, url: rubric.templateUrl };
  if (ctx.rubricSelected) return null;
  if (ctx.htmlTemplates.length === 0) return null;
  if (ctx.htmlTemplates.length === 1 || dryRun) return ctx.htmlTemplates[0] ?? null;
  return selectHtmlTemplate(ctx.htmlTemplates, ctx.title, ctx.sourceSummary);
}

export async function fetchTemplateHtmlV2(template: HtmlTemplateRef | null): Promise<string | null> {
  if (!template) return null;
  try {
    const response = await templateFetch(template.url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export function templateHasSlotsV2(referenceHtml: string | null): boolean {
  return !!referenceHtml && /\{\{\w+\}\}/.test(referenceHtml);
}

export function inferBackgroundKindV2(referenceHtml: string | null, templateName?: string | null): 'photo' | 'abstract' {
  const haystack = `${templateName ?? ''}\n${referenceHtml ?? ''}`.toLowerCase();
  const isQuote = /quote_|author_|opinion|quote|04-/.test(haystack);
  const isDenseUi = /class="[^"]*(card|cards|grid|list|row|recap)[^"]*"/.test(haystack) ||
    /(^|[\\/\\s_-])(top|recap)([\\s_.-]|$)/.test(haystack);
  return isQuote || isDenseUi ? 'abstract' : 'photo';
}

