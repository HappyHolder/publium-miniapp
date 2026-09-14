import { useEffect, useRef, useState } from 'react'
import { Plus, Loader2, Trash2, Upload, Image as ImageIcon, X, Pencil } from 'lucide-react'
import { useApp } from '@/context/AppContext'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { OptionPills } from '@/components/ui/OptionPills'
import {
  adminListStyles, adminUpsertStyle, adminDeleteStyle, adminUploadTemplate, adminRenderPreviews,
} from '@/lib/styles'
import type { MarketStyle, BrandColor, HtmlTemplateItem, CarouselTemplate } from '@/types'
import { cn } from '@/lib/utils'

interface AdminStylesScreenProps { onBack: () => void }

type Draft = Partial<MarketStyle>

const EMPTY_DRAFT: Draft = {
  slug: '', nameRu: '', nameEn: '', descRu: '', descEn: '', tags: [],
  priceKind: 'FREE', priceGram: null,
  brandAdaptive: true, recommendedMode: 'html', palette: [], visualCoverStyle: '',
  templates: [], published: false, sortOrder: 0,
}

export function AdminStylesScreen({ onBack }: AdminStylesScreenProps) {
  const { showToast, language } = useApp()
  const isRu = language === 'ru'
  const [list, setList]   = useState<MarketStyle[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)   // null = list view
  const [saving, setSaving] = useState(false)
  const [rendering, setRendering] = useState(false)
  const htmlInputRef = useRef<HTMLInputElement>(null)

  const load = () => {
    setLoading(true)
    adminListStyles()
      .then(setList)
      .catch(e => showToast((e as Error).message, 'error'))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => d ? { ...d, [k]: v } : d)

  // ── Palette helpers ──────────────────────────────────────────────────────────
  const palette = (): BrandColor[] => draft?.palette ?? []
  const addColor = () => set('palette', [...palette(), { name: '', hex: '#FF6A00', usage: '' }])
  const updColor = (i: number, patch: Partial<BrandColor>) => set('palette', palette().map((c, idx) => idx === i ? { ...c, ...patch } : c))
  const delColor = (i: number) => set('palette', palette().filter((_, idx) => idx !== i))

  // ── Template helpers ─────────────────────────────────────────────────────────
  const tpls = (): HtmlTemplateItem[] => draft?.templates ?? []
  const addTpl = () => set('templates', [...tpls(), { name: '', url: '' }])
  const updTpl = (i: number, patch: Partial<HtmlTemplateItem>) => set('templates', tpls().map((t, idx) => idx === i ? { ...t, ...patch } : t))
  const delTpl = (i: number) => set('templates', tpls().filter((_, idx) => idx !== i))
  const [uploadIdx, setUploadIdx] = useState<number | null>(null)

  const uploadTpl = async (file: File, idx: number) => {
    setUploadIdx(idx)
    try {
      const url = await adminUploadTemplate(file)
      updTpl(idx, { url })
      showToast(isRu ? 'Загружено' : 'Uploaded')
    } catch (e) {
      showToast((e as Error).message, 'error')
    } finally {
      setUploadIdx(null)
    }
  }

  // ── Carousel template (one universal slide, separate from rubrics) ────────────
  const [uploadingCar, setUploadingCar] = useState<null | 'cover' | 'item' | 'outro'>(null)
  const carInputRef = useRef<HTMLInputElement>(null)
  const updCar = (patch: Partial<CarouselTemplate>) =>
    set('carouselTemplate', { ...(draft?.carouselTemplate ?? {}), ...patch })
  const uploadCarousel = async (file: File, part: 'cover' | 'item' | 'outro') => {
    setUploadingCar(part)
    try { updCar({ [part]: await adminUploadTemplate(file) }); showToast(isRu ? 'Загружено' : 'Uploaded') }
    catch (e) { showToast((e as Error).message, 'error') }
    finally { setUploadingCar(null) }
  }

  // ── Save / delete / render ─────────────────────────────────────────────────────
  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = await adminUpsertStyle(draft)
      showToast(isRu ? 'Сохранено' : 'Saved')
      setDraft(saved)   // keep editing with the real id (enables render-previews)
      load()
    } catch (e) {
      showToast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const renderPreviews = async () => {
    if (!draft?.id) { showToast(isRu ? 'Сначала сохрани стиль' : 'Save the style first', 'error'); return }
    setRendering(true)
    try {
      const updated = await adminRenderPreviews(draft.id)
      setDraft(updated)
      showToast(isRu ? 'Превью готовы' : 'Previews rendered')
      load()
    } catch (e) {
      showToast((e as Error).message, 'error')
    } finally {
      setRendering(false)
    }
  }

  const del = async (id: string) => {
    try { await adminDeleteStyle(id); showToast(isRu ? 'Удалено' : 'Deleted'); load() }
    catch (e) { showToast((e as Error).message, 'error') }
  }

  // ── List view ──────────────────────────────────────────────────────────────────
  if (!draft) {
    return (
      <div className="pb-8">
        <PageHeader title={isRu ? 'Стили — маркет' : 'Styles — market'} subtitle={isRu ? 'Управление каталогом' : 'Manage the catalog'} onBack={onBack} />
        <div className="px-4 mt-2">
          <Button variant="primary" size="md" fullWidth onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            <Plus size={15} /> {isRu ? 'Новый стиль' : 'New style'}
          </Button>

          {loading ? (
            <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-[#FF6A00]" /></div>
          ) : (
            <div className="mt-3 space-y-2">
              {list.map(s => (
                <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-[14px] bg-white/[0.03] border border-white/[0.06]">
                  <div className="w-14 h-10 rounded-[8px] bg-[#0B0B0C] overflow-hidden shrink-0 flex items-center justify-center">
                    {s.heroPreview ? <img src={s.heroPreview} className="w-full h-full object-cover" /> : <ImageIcon size={14} className="text-[#44444C]" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-white truncate">{isRu ? s.nameRu : s.nameEn} <span className="text-[#55555D]">/{s.slug}</span></p>
                    <p className="text-[11px] text-[#55555D]">
                      {s.published ? (isRu ? 'Опубликован' : 'Published') : (isRu ? 'Черновик' : 'Draft')} · {s.priceKind === 'FREE' ? 'Free' : (s.priceGram ? `${s.priceGram} TON` : '')} · {s.templates.length} tpl
                    </p>
                  </div>
                  <button onClick={() => setDraft(s)} className="p-2 text-[#A1A1AA] hover:text-white"><Pencil size={14} /></button>
                  <button onClick={() => del(s.id)} className="p-2 text-[#55555D] hover:text-red-400"><Trash2 size={14} /></button>
                </div>
              ))}
              {list.length === 0 && <p className="text-center text-[12px] text-[#55555D] py-8">{isRu ? 'Пока пусто' : 'Empty'}</p>}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Editor view ────────────────────────────────────────────────────────────────
  return (
    <div className="pb-8">
      <PageHeader title={draft.id ? (isRu ? 'Редактировать стиль' : 'Edit style') : (isRu ? 'Новый стиль' : 'New style')} onBack={() => setDraft(null)} />
      <div className="px-4 mt-2 space-y-4">

        {/* Hidden html upload input */}
        <input
          ref={htmlInputRef}
          type="file"
          accept=".html,text/html"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            const idx  = Number(htmlInputRef.current?.dataset['idx'] ?? 0)
            if (file) uploadTpl(file, idx)
            e.target.value = ''
          }}
        />

        {/* Basics */}
        <Field label="slug">
          <input value={draft.slug ?? ''} onChange={e => set('slug', e.target.value)} placeholder="crypto" className="glass-input w-full px-3 py-2 text-sm font-mono" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={isRu ? 'Название RU' : 'Name RU'}>
            <input value={draft.nameRu ?? ''} onChange={e => set('nameRu', e.target.value)} className="glass-input w-full px-3 py-2 text-sm" />
          </Field>
          <Field label={isRu ? 'Название EN' : 'Name EN'}>
            <input value={draft.nameEn ?? ''} onChange={e => set('nameEn', e.target.value)} className="glass-input w-full px-3 py-2 text-sm" />
          </Field>
        </div>
        <Field label={isRu ? 'Описание RU' : 'Description RU'}>
          <textarea value={draft.descRu ?? ''} onChange={e => set('descRu', e.target.value)} rows={2} className="glass-input w-full px-3 py-2 text-sm resize-none" />
        </Field>
        <Field label={isRu ? 'Описание EN' : 'Description EN'}>
          <textarea value={draft.descEn ?? ''} onChange={e => set('descEn', e.target.value)} rows={2} className="glass-input w-full px-3 py-2 text-sm resize-none" />
        </Field>
        <Field label={isRu ? 'Теги (через запятую)' : 'Tags (comma-separated)'}>
          <input value={(draft.tags ?? []).join(', ')} onChange={e => set('tags', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} className="glass-input w-full px-3 py-2 text-sm" />
        </Field>

        {/* Pricing */}
        <OptionPills<'FREE' | 'PAID'>
          label={isRu ? 'Цена' : 'Price'}
          value={draft.priceKind ?? 'FREE'}
          onChange={v => set('priceKind', v)}
          options={[{ value: 'FREE', label: isRu ? 'Бесплатно' : 'Free' }, { value: 'PAID', label: isRu ? 'Платно' : 'Paid' }]}
        />
        {draft.priceKind === 'PAID' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="TON">
              <input type="number" step="0.1" value={draft.priceGram ?? ''} onChange={e => set('priceGram', e.target.value ? Number(e.target.value) : null)} className="glass-input w-full px-3 py-2 text-sm" />
            </Field>
          </div>
        )}

        {/* Behaviour */}
        <Switch label={isRu ? 'Подстраивать цвет под бренд' : 'Adapt color to brand'} value={draft.brandAdaptive ?? true} onChange={v => set('brandAdaptive', v)} />
        <OptionPills<'html' | 'ai' | 'ai_html'>
          label={isRu ? 'Режим' : 'Mode'}
          value={draft.recommendedMode ?? 'html'}
          onChange={v => set('recommendedMode', v)}
          options={[{ value: 'html', label: 'HTML' }, { value: 'ai', label: 'AI' }, { value: 'ai_html', label: 'AI+HTML' }]}
        />

        {/* Palette */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-[#55555D] uppercase tracking-wider">{isRu ? 'Палитра' : 'Palette'}</p>
            <button onClick={addColor} className="text-[12px] font-medium text-[#FF6A00]">+ {isRu ? 'Цвет' : 'Color'}</button>
          </div>
          <div className="space-y-2">
            {palette().map((c, i) => (
              <div key={i} className="flex gap-2 items-center p-2 rounded-[12px] bg-white/[0.03] border border-white/[0.06]">
                <input type="color" value={/^#[0-9A-Fa-f]{6}$/.test(c.hex) ? c.hex : '#FF6A00'} onChange={e => updColor(i, { hex: e.target.value })} className="w-8 h-8 shrink-0 bg-transparent border-0 p-0" />
                <input value={c.name} onChange={e => updColor(i, { name: e.target.value })} placeholder={isRu ? 'Имя' : 'Name'} className="glass-input flex-1 min-w-0 px-2 py-1.5 text-[12px]" />
                <input value={c.hex} onChange={e => updColor(i, { hex: e.target.value })} placeholder="#FF6A00" className="glass-input w-24 px-2 py-1.5 text-[12px] font-mono" />
                <button onClick={() => delColor(i)} className="text-[#55555D] hover:text-red-400 shrink-0"><X size={14} /></button>
              </div>
            ))}
          </div>
        </div>

        {/* visualCoverStyle */}
        <Field label="visualCoverStyle (AI)">
          <textarea value={draft.visualCoverStyle ?? ''} onChange={e => set('visualCoverStyle', e.target.value)} rows={3} className="glass-input w-full px-3 py-2 text-sm resize-none" />
        </Field>

        {/* Optional hints */}
        <div className="grid grid-cols-2 gap-2">
          <Field label="bgStyle"><input value={draft.bgStyle ?? ''} onChange={e => set('bgStyle', e.target.value || null)} className="glass-input w-full px-3 py-2 text-sm" /></Field>
          <Field label="bgDetail"><input value={draft.bgDetail ?? ''} onChange={e => set('bgDetail', e.target.value || null)} className="glass-input w-full px-3 py-2 text-sm" /></Field>
          <Field label="fontPreset"><input value={draft.fontPreset ?? ''} onChange={e => set('fontPreset', e.target.value || null)} className="glass-input w-full px-3 py-2 text-sm" /></Field>
          <Field label="logoUsage"><input value={draft.logoUsage ?? ''} onChange={e => set('logoUsage', e.target.value || null)} className="glass-input w-full px-3 py-2 text-sm" /></Field>
        </div>

        {/* Templates */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-[#55555D] uppercase tracking-wider">{isRu ? 'Шаблоны' : 'Templates'}</p>
            <button onClick={addTpl} className="text-[12px] font-medium text-[#FF6A00]">+ {isRu ? 'Шаблон' : 'Template'}</button>
          </div>
          <div className="space-y-3">
            {tpls().map((tpl, i) => (
              <div key={i} className="p-3 rounded-[12px] bg-white/[0.03] border border-white/[0.06] space-y-2">
                <div className="flex items-center gap-2">
                  <input value={tpl.name} onChange={e => updTpl(i, { name: e.target.value })} placeholder={isRu ? 'Рубрика (news, signal…)' : 'Rubric (news, signal…)'} className="glass-input flex-1 px-2 py-1.5 text-[12px]" />
                  <button onClick={() => delTpl(i)} className="text-[#55555D] hover:text-red-400"><X size={14} /></button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input value={tpl.rubricName ?? ""} onChange={e => updTpl(i, { rubricName: e.target.value })} placeholder={isRu ? "Название рубрики" : "Rubric name"} className="glass-input px-2 py-1.5 text-[12px]" />
                  <select value={tpl.rubricMode ?? draft.recommendedMode ?? "html"} onChange={e => updTpl(i, { rubricMode: e.target.value as HtmlTemplateItem["rubricMode"] })} className="glass-input px-2 py-1.5 text-[12px]">
                    <option value="ai">AI</option>
                    <option value="html">HTML</option>
                    <option value="ai_html">AI+HTML</option>
                  </select>
                </div>
                <textarea
                  value={tpl.rubricDescription ?? ""}
                  onChange={e => updTpl(i, { rubricDescription: e.target.value })}
                  placeholder={isRu ? "Описание рубрики: когда выбирать этот шаблон" : "Rubric description: when this template should be used"}
                  rows={2}
                  className="glass-input w-full px-2 py-1.5 text-[11px] resize-none"
                />
                <textarea
                  value={tpl.hybridPrompt ?? ""}
                  onChange={e => updTpl(i, { hybridPrompt: e.target.value })}
                  placeholder={isRu ? "AI+HTML: как фону лечь под этот шаблон" : "AI+HTML: how the background should fit this template"}
                  rows={2}
                  className="glass-input w-full px-2 py-1.5 text-[11px] resize-none"
                />
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] text-[#55555D] truncate font-mono">{tpl.url ? tpl.url.split('/').pop() : (isRu ? 'нет файла' : 'no file')}</span>
                  <button
                    onClick={() => { if (htmlInputRef.current) { htmlInputRef.current.dataset['idx'] = String(i); htmlInputRef.current.click() } }}
                    disabled={uploadIdx === i}
                    className="flex items-center gap-1 text-[11px] font-medium text-[#FF6A00] disabled:opacity-40"
                  >
                    {uploadIdx === i ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                    {tpl.url ? (isRu ? 'Заменить' : 'Replace') : (isRu ? 'Загрузить' : 'Upload')}
                  </button>
                </div>
                <textarea
                  value={tpl.demoSlots ? JSON.stringify(tpl.demoSlots, null, 0) : ''}
                  onChange={e => {
                    const raw = e.target.value.trim()
                    if (!raw) { updTpl(i, { demoSlots: undefined }); return }
                    try { updTpl(i, { demoSlots: JSON.parse(raw) }) } catch { /* keep typing */ }
                  }}
                  placeholder={'demoSlots JSON: {"TITLE_WHITE":"Bitcoin","TAG":"crypto"}'}
                  rows={2}
                  className="glass-input w-full px-2 py-1.5 text-[11px] font-mono resize-none"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Carousel — a set of slides: cover → item → outro */}
        <div>
          <p className="text-xs font-semibold text-[#55555D] uppercase tracking-wider mb-2">{isRu ? 'Карусель · завязка / пункт / концовка' : 'Carousel · cover / item / outro'}</p>
          <div className="p-3 rounded-[12px] bg-white/[0.03] border border-white/[0.06] space-y-2">
            {(['cover', 'item', 'outro'] as const).map(part => (
              <div key={part} className="flex items-center gap-2">
                <span className="w-14 text-[11px] text-[#55555D] uppercase font-mono">{part}</span>
                <span className="flex-1 text-[11px] text-[#55555D] truncate font-mono">{draft.carouselTemplate?.[part] ? draft.carouselTemplate[part]!.split('/').pop() : (isRu ? 'нет файла' : 'no file')}</span>
                <button
                  onClick={() => { if (carInputRef.current) { carInputRef.current.dataset['part'] = part; carInputRef.current.click() } }}
                  disabled={uploadingCar === part}
                  className="flex items-center gap-1 text-[11px] font-medium text-[#FF6A00] disabled:opacity-40"
                >
                  {uploadingCar === part ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
                  {draft.carouselTemplate?.[part] ? (isRu ? 'Заменить' : 'Replace') : (isRu ? 'Загрузить' : 'Upload')}
                </button>
              </div>
            ))}
            {draft.carouselTemplate && (
              <button onClick={() => set('carouselTemplate', null)} className="text-[11px] text-[#55555D] hover:text-red-400">{isRu ? 'Убрать карусель' : 'Remove carousel'}</button>
            )}
          </div>
          <input ref={carInputRef} type="file" accept=".html,text/html" className="hidden" onChange={e => { const f = e.target.files?.[0]; const part = (carInputRef.current?.dataset['part'] ?? 'item') as 'cover' | 'item' | 'outro'; if (f) uploadCarousel(f, part); e.target.value = '' }} />
        </div>

        {/* Publish + sortOrder */}
        <Switch label={isRu ? 'Опубликован' : 'Published'} value={draft.published ?? false} onChange={v => set('published', v)} />
        <Field label="sortOrder">
          <input type="number" value={draft.sortOrder ?? 0} onChange={e => set('sortOrder', Number(e.target.value))} className="glass-input w-full px-3 py-2 text-sm" />
        </Field>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button variant="primary" size="md" onClick={save} disabled={saving} className="flex-1">
            {saving ? <Loader2 size={14} className="animate-spin" /> : (isRu ? 'Сохранить' : 'Save')}
          </Button>
          <Button variant="secondary" size="md" onClick={renderPreviews} disabled={rendering || !draft.id} className={cn('flex-1', !draft.id && 'opacity-40')}>
            {rendering ? <Loader2 size={14} className="animate-spin" /> : (isRu ? 'Превью' : 'Previews')}
          </Button>
        </div>
        {!draft.id && <p className="text-[11px] text-[#55555D] text-center">{isRu ? 'Сохрани, чтобы рендерить превью' : 'Save to enable preview rendering'}</p>}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-[#66666E] uppercase tracking-wide mb-1">{label}</p>
      {children}
    </div>
  )
}
