import { API_BASE } from '@/lib/api'
import { getTelegramInitData } from '@/lib/telegram'
import type {
  MarketStyle, VisualKit, CoverBgStyle, CoverBgDetail, LogoUsage,
} from '@/types'

// ─── Public catalog ────────────────────────────────────────────────────────────

export interface StylesCatalog {
  styles: MarketStyle[]
  owned:  string[]   // style ids the user has purchased (FREE styles are owned implicitly)
}

/** Fetches the published style catalog + the caller's owned style ids. */
export async function fetchStyles(): Promise<StylesCatalog> {
  const initData = getTelegramInitData() ?? undefined
  const res = await fetch(`${API_BASE}/api/styles/list`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ initData }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<StylesCatalog>
}

/** True when the user can apply a style: it's free, or they own it. */
export function isStyleOwned(style: MarketStyle, owned: string[]): boolean {
  return style.priceKind === 'FREE' || owned.includes(style.id)
}

// ─── Purchase ──────────────────────────────────────────────────────────────────

// ─── Apply ─────────────────────────────────────────────────────────────────────

/**
 * Merges a style into a channel's VisualKit. Cover-related fields are REPLACED
 * by the style; the channel's own logo (logoUrl) and unrelated fields are kept.
 */
function defaultRubricDescription(name: string): string {
  const n = name.trim().toLowerCase()
  if (/новост|news/.test(n)) return 'Новости, важные события, объявления, изменения рынка, запуск продуктов и заметные инфоповоды.'
  if (/сигнал|signal/.test(n)) return 'Торговые идеи, сигналы, сетапы, уровни входа, цели, стопы и краткие рыночные рекомендации.'
  if (/листинг|listing/.test(n)) return 'Листинги, новые монеты, добавление токенов на биржи, запуск торгов и объявления площадок.'
  if (/мнени|opinion|quote|insight/.test(n)) return 'Авторское мнение, цитаты, позиция эксперта, субъективный взгляд или короткий тезис.'
  if (/аналит|analysis/.test(n)) return 'Аналитика, разбор графиков, метрик, причин движения, сценариев и рыночного контекста.'
  if (/дайджест|recap|digest/.test(n)) return 'Дайджесты, итоги дня или недели, подборки нескольких важных событий в одном посте.'
  if (/гайд|guide|how/.test(n)) return 'Гайды, инструкции, обучающие материалы, пошаговые объяснения и разборы для читателя.'
  if (/топ|top|rating|list/.test(n)) return 'Топы, рейтинги, списки проектов, монет, инструментов, событий или идей.'
  if (/партн|partner|sponsor/.test(n)) return 'Партнерские материалы, интеграции, спонсорские объявления и совместные запуски.'
  return ''
}

function defaultHybridPrompt(name: string, visualStyle?: string): string {
  const n = name.trim().toLowerCase()
  const style = (visualStyle ?? '').toLowerCase()
  const darkRule = /dark|near-black|black|темн|тёмн|noir|night/.test(style)
    ? ' Keep the generated background dark, low-key, premium, and consistent with the pack mood; use light and contrast inside the scene, not a flat black overlay.'
    : ''
  if (/мнени|opinion|quote|insight/.test(n)) return 'Create a calm abstract background or premium texture without literal objects, so the quote card remains the main focus.' + darkRule
  if (/дайджест|recap|digest|топ|top|rating|list/.test(n)) return 'Create a low-detail abstract or atmospheric background with no strong focal object, leaving the template cards and list items visually dominant.' + darkRule
  return 'Create a clean text-free background that leaves visual breathing room for the template header, central headline area, bottom tags, and channel handle. Do not add text, logos, UI labels, or competing interface elements.' + darkRule
}
function rubricIdFromTemplate(styleSlug: string, index: number, name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return `style-${styleSlug || 'pack'}-${slug || index + 1}`
}

export function applyStyleToVisualKit(style: MarketStyle, current: VisualKit): VisualKit {
  const htmlTemplates = style.templates
    .filter(t => t.url)
    .map(t => ({ name: t.name, url: t.url, demoSlots: t.demoSlots }))

  const rubrics = style.templates
    .filter(t => t.url)
    .map((t, i) => {
      const name = (t.rubricName || t.name || `Rubric ${i + 1}`).trim()
      const mode = t.rubricMode === 'ai' || t.rubricMode === 'html' || t.rubricMode === 'ai_html'
        ? t.rubricMode
        : style.recommendedMode
      return {
        id: rubricIdFromTemplate(style.slug, i, name),
        name,
        description: t.rubricDescription || defaultRubricDescription(name),
        mode,
        templateUrl: t.url,
        templateName: t.name || t.url.split('/').pop()?.split('?')[0],
        hybridPrompt: t.hybridPrompt || defaultHybridPrompt(name, style.visualCoverStyle),
      }
    })

  // The pack's carousel slide set. A pack without one clears the channel's, so
  // applying a style never leaves slides from the previous pack behind.
  const carouselTemplate = style.carouselTemplate?.item
    ? {
        cover:    style.carouselTemplate.cover,
        item:     style.carouselTemplate.item,
        outro:    style.carouselTemplate.outro,
        previews: style.carouselTemplate.previews,
      }
    : undefined

  return {
    ...current,
    coverMode:        style.recommendedMode,
    brandColors:      style.palette,
    visualCoverStyle: style.visualCoverStyle || current.visualCoverStyle,
    htmlTemplates,
    rubrics,
    carouselTemplate,
    coverBgStyle:     (style.bgStyle as CoverBgStyle | null) ?? current.coverBgStyle,
    coverBgDetail:    (style.bgDetail as CoverBgDetail | null) ?? current.coverBgDetail,
    visualFontPreset: (style.fontPreset as VisualKit['visualFontPreset']) ?? current.visualFontPreset,
    logoUsage:        (style.logoUsage as LogoUsage | null) ?? current.logoUsage,
    // logoUrl, aspectRatio, watermark, textOnCover, references, avoidList — preserved.
  }
}

// ─── Admin ─────────────────────────────────────────────────────────────────────

interface AdminListResp { styles: MarketStyle[] }

export async function adminListStyles(): Promise<MarketStyle[]> {
  const initData = getTelegramInitData()
  const res = await fetch(`${API_BASE}/api/admin/styles/list`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json() as AdminListResp).styles
}

export async function adminUpsertStyle(style: Partial<MarketStyle>): Promise<MarketStyle> {
  const initData = getTelegramInitData()
  const res = await fetch(`${API_BASE}/api/admin/styles/upsert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, style }),
  })
  const data = await res.json().catch(() => ({})) as { style?: MarketStyle; error?: string }
  if (!res.ok || !data.style) throw new Error(data.error ?? 'Save failed')
  return data.style
}

export async function adminDeleteStyle(id: string): Promise<void> {
  const initData = getTelegramInitData()
  const res = await fetch(`${API_BASE}/api/admin/styles/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, id }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? 'Delete failed')
  }
}

export async function adminUploadTemplate(file: File): Promise<string> {
  const initData = getTelegramInitData()
  const form = new FormData()
  form.append('initData', initData ?? '')
  form.append('file', file)
  const res = await fetch(`${API_BASE}/api/admin/styles/upload-template`, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({})) as { url?: string; error?: string }
  if (!res.ok || !data.url) throw new Error(data.error ?? 'Upload failed')
  return data.url
}

export async function adminRenderPreviews(id: string, aspectRatio = '16:9'): Promise<MarketStyle> {
  const initData = getTelegramInitData()
  const res = await fetch(`${API_BASE}/api/admin/styles/render-previews`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, id, aspectRatio }),
  })
  const data = await res.json().catch(() => ({})) as { style?: MarketStyle; error?: string }
  if (!res.ok || !data.style) throw new Error(data.error ?? 'Render failed')
  return data.style
}
