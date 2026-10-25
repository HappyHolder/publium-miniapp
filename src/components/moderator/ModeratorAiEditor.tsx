import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Loader2, MessagesSquare, Plus, Save, SpellCheck, X } from 'lucide-react'
import { API_BASE } from '@/lib/api'
import { getTelegramInitData, moderatorFetch } from '@/lib/telegram'
import { GlassCard } from '@/components/ui/GlassCard'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { ModeratorHelpSheet, ModeratorInfoButton } from './ModeratorHelpSheet'

type Personality = { archetype: 'calm'|'strict'|'insider'|'ironic'|'security'; character: string[]; manner: string[]; strictness: 0|1|2|3; humor: 0|1|2; slang: boolean; customInstructions: string }
type MessageSettings = { enabled: boolean; action: 'review'|'delete'|'delete_warn'|'delete_rewrite'|'delete_rewrite_warn'; confidenceThreshold: number; minLength: number; customRule: string; skipBots: boolean; skipAdmins: boolean; skipTrusted: boolean; allowedWords: string[]; noticeText: string }
type Category = 'conflict'|'toxicity'|'harassment'|'threat'|'fraud'|'semantic_spam'|'off_topic'
type ConversationSettings = { enabled: boolean; categories: Category[]; reaction: 'observe'|'respond'|'sanctions'; customRules: string; responseAutoDeleteSeconds: number; personality: Personality; minMessages: number; confidenceThreshold: number; sanctions: { warningExpiryDays: number; muteAfterWarnings: number; muteDurationSeconds: number; banAfterWarnings: number } }
type AiBlock = { type: 'ai_moderation'; messageModeration: MessageSettings; conversationAnalysis: ConversationSettings }
type Section = keyof Omit<AiBlock, 'type'>
const selectClass = 'mt-1.5 min-h-11 w-full rounded-[11px] border border-white/[0.08] bg-[#171719] px-3 text-[13px] text-white outline-none focus:border-[#FF6A00]/60 focus-visible:ring-2 focus-visible:ring-[#FF6A00]/30'
const textareaClass = 'mt-1.5 w-full resize-none rounded-[12px] border border-white/[0.08] bg-[#0B0B0D] px-3.5 py-3 text-[13px] leading-relaxed text-white outline-none focus:border-[#FF6A00]/60 focus-visible:ring-2 focus-visible:ring-[#FF6A00]/30'
const boxClass = 'space-y-3 rounded-[14px] border border-white/[0.07] bg-white/[0.025] p-3'
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const categories: Record<Category, string> = { conflict: 'Переходы на личности', toxicity: 'Унижение и личные выпады', harassment: 'Травля и давление', threat: 'Угрозы', fraud: 'Подозрительные предложения', semantic_spam: 'Навязчивые повторы', off_topic: 'Офтоп' }

function Select({ label, value, onChange, children }: { label: string; value: string|number; onChange: (value: string) => void; children: ReactNode }) {
  return <label className="block min-w-0 text-[11px] text-[#A1A1AA]">{label}<select value={value} onChange={e => onChange(e.target.value)} className={selectClass}>{children}</select></label>
}
function Details({ title, children }: { title: string; children: ReactNode }) {
  return <details className={boxClass}><summary className="flex min-h-11 cursor-pointer items-center text-[12px] font-medium text-[#A1A1AA]">{title}</summary><div className="space-y-3 pt-2">{children}</div></details>
}
function SectionCard<S extends Section>({ moderatorId, section, initial, applied, children }: { moderatorId: string; section: S; initial: AiBlock[S]; applied?: AiBlock[S]; children: (settings: AiBlock[S], patch: (patch: Partial<AiBlock[S]>) => void) => ReactNode }) {
  const [settings, setSettings] = useState(initial), [published, setPublished] = useState(applied), [saved, setSaved] = useState(initial)
  const [collapsed, setCollapsed] = useState(Boolean(applied && equal(initial, applied))), [busy, setBusy] = useState<'save'|'publish'|null>(null), [message, setMessage] = useState(''), [help, setHelp] = useState(false)
  const isApplied = Boolean(published && equal(settings, published)), dirty = !equal(settings, saved)
  const isMessage = section === 'messageModeration'
  const patch = (change: Partial<AiBlock[S]>) => { setSettings(current => ({ ...current, ...change })); setMessage('') }
  const persist = async (publish: boolean) => {
    if (busy || !getTelegramInitData()) return
    setBusy(publish ? 'publish' : 'save'); setMessage('')
    try {
      const r = await moderatorFetch(`${API_BASE}/api/moderator-config/${moderatorId}/draft`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiSection: section, settings }) })
      const d = await r.json() as { draft?: { blocks?: AiBlock[] }; error?: string }
      if (!r.ok) throw new Error(d.error ?? 'Не удалось сохранить раздел')
      const normalized = d.draft?.blocks?.find(b => b.type === 'ai_moderation')?.[section] ?? settings
      setSettings(normalized); setSaved(normalized)
      if (publish) {
        const p = await moderatorFetch(`${API_BASE}/api/moderator-config/${moderatorId}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blockType: 'ai_moderation', aiSection: section }) })
        const result = await p.json() as { error?: string }
        if (!p.ok) throw new Error(result.error ?? 'Не удалось применить раздел')
        setPublished(normalized)
      }
      setMessage(publish ? 'Этот раздел применён' : 'Черновик этого раздела сохранён')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Не удалось сохранить') } finally { setBusy(null) }
  }
  return <GlassCard>
    <div className="flex items-center gap-1">
      <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(v => !v)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-[14px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6A00]">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-[#FF6A00]/10 text-[#FF6A00]">{isMessage ? <SpellCheck size={18}/> : <MessagesSquare size={18}/>}</span>
        <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 text-[14px] font-semibold text-white">{isMessage ? 'Мат' : 'Конфликты и травля'}{isApplied && <span className="flex items-center gap-1 text-[10px] font-normal text-emerald-400"><Check size={11}/> применено</span>}</span><span className="mt-0.5 block text-[11px] text-[#777780]">{isMessage ? 'Удаление и исправление сообщений' : 'Контекст, адресные замечания и санкции'}</span></span>
        <ChevronDown size={18} className={`shrink-0 text-[#66666E] transition-transform ${collapsed ? '-rotate-90' : ''}`}/>
      </button>
      <ModeratorInfoButton onClick={() => setHelp(true)} label={`Справка: ${isMessage ? 'Мат' : 'Конфликты и травля'}`}/>
    </div>
    {!collapsed && <fieldset disabled={busy !== null} className="mt-4 min-w-0 space-y-4 disabled:opacity-70">
      {children(settings, patch)}
      <p className="text-[11px] leading-relaxed text-[#777780]">Сохранение и применение меняют только этот раздел.{dirty && ' Есть несохранённые изменения.'}</p>
      {message && <p role="status" className="text-[12px] text-[#A1A1AA]">{message}</p>}
      <div className="grid grid-cols-2 gap-2"><Button variant="secondary" size="sm" fullWidth onClick={() => void persist(false)} disabled={busy !== null}>{busy === 'save' ? <Loader2 size={14} className="animate-spin"/> : <><Save size={14}/> Сохранить</>}</Button><Button variant="primary" size="sm" fullWidth onClick={() => void persist(true)} disabled={busy !== null}>{busy === 'publish' ? <Loader2 size={14} className="animate-spin"/> : 'Применить'}</Button></div>
    </fieldset>}
    <ModeratorHelpSheet kind="ai" open={help} onClose={() => setHelp(false)}/>
  </GlassCard>
}
function AllowedWords({ words, onChange }: { words: string[]; onChange: (words: string[]) => void }) {
  const [input, setInput] = useState(''), [error, setError] = useState('')
  const add = () => {
    const added = input.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').split(/[,;\n]/).map(w => w.trim()).filter(Boolean)
    if (!added.length) return
    if (added.some(w => w.length > 60 || !/^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u.test(w))) { setError('Введите слово или короткую фразу без спецсимволов'); return }
    const next = [...new Set([...words, ...added])]
    if (next.length > 100) { setError('Можно добавить до 100 слов'); return }
    onChange(next); setInput(''); setError('')
  }
  return <div className={boxClass}><p className="text-[12px] font-medium text-white">Разрешённые слова</p><p className="text-[11px] leading-relaxed text-[#8A8A93]">Например, «хер» или «херня». Совпадение по целому слову; другие формы добавляйте отдельно. Личный выпад с таким словом всё ещё может быть конфликтом.</p>
    <div className="flex gap-2"><input aria-label="Новое разрешённое слово" maxLength={300} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }} placeholder="Слово или несколько через запятую" className={`${selectClass} mt-0 min-w-0 flex-1`}/><button type="button" onClick={add} aria-label="Добавить разрешённое слово" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] bg-[#FF6A00]/10 text-[#FF6A00]"><Plus size={18}/></button></div>
    {error && <p role="alert" className="text-[11px] text-amber-300">{error}</p>}
    {words.length > 0 && <div className="flex flex-wrap gap-1.5">{words.map(word => <button type="button" key={word} onClick={() => onChange(words.filter(w => w !== word))} aria-label={`Удалить разрешённое слово ${word}`} className="flex min-h-11 max-w-full items-center gap-2 break-all rounded-[11px] border border-white/[0.08] px-3 text-[12px] text-[#A1A1AA]">{word}<X size={13} className="shrink-0"/></button>)}</div>}
  </div>
}
function ProfanityFields({ settings: s, patch }: { settings: MessageSettings; patch: (p: Partial<MessageSettings>) => void }) {
  return <>
    <Switch label="Проверять мат" description="Отдельная проверка лексики, без оценки споров между людьми" value={s.enabled} onChange={enabled => patch({ enabled })}/>
    <Select label="Действие при мате" value={s.action} onChange={action => patch({ action: action as MessageSettings['action'] })}>
      <option value="review">Только записывать в журнал</option><option value="delete_rewrite">Удалить, исправить и попросить без мата</option><option value="delete">Только удалить</option><option value="delete_warn">Удалить и выдать предупреждение</option><option value="delete_rewrite_warn">Удалить, исправить и выдать предупреждение</option>
    </Select>
    <p className="text-[11px] leading-relaxed text-[#8A8A93]">{s.action.includes('warn') ? 'Предупреждения за мат считаются отдельно от конфликтов. Пороги берутся из раздела «Фильтры и команды».' : 'За мат предупреждения не начисляются. Санкции за конфликты не меняют это действие.'}</p>
    <AllowedWords words={s.allowedWords} onChange={allowedWords => patch({ allowedWords })}/>
    <div className={boxClass}><label className="block text-[12px] font-medium text-white">Текст замечания<textarea rows={2} maxLength={300} value={s.noticeText} onChange={e => patch({ noticeText: e.target.value })} className={textareaClass}/></label><p className="text-[11px] leading-relaxed text-[#8A8A93]">Обращение добавится автоматически. Исправленный текст сообщения формирует AI отдельно. Опасный текст повторно не публикуется.</p><div className="whitespace-pre-wrap break-words rounded-[11px] border border-[#FF6A00]/15 bg-[#FF6A00]/[0.04] px-3 py-3 text-[12px] leading-relaxed text-[#A1A1AA]">@участник, {s.noticeText.trim() || 'Пиши без мата.'}{'\n\n'}«Пример исправленного сообщения»</div></div>
    <Details title="Точность и исключения">
      <div className="grid grid-cols-2 gap-3"><Select label="Уверенность AI" value={s.confidenceThreshold} onChange={v => patch({ confidenceThreshold: Number(v) })}>{[.8,.85,.9,.95,.99].map(v => <option key={v} value={v}>{Math.round(v*100)}%</option>)}</Select><label className="text-[11px] text-[#A1A1AA]">Минимум символов<input type="number" min={1} max={100} value={s.minLength} onChange={e => patch({ minLength: Number(e.target.value) })} className={selectClass}/></label></div>
      <Switch label="Пропускать администраторов" value={s.skipAdmins} onChange={skipAdmins => patch({ skipAdmins })}/><Switch label="Пропускать доверенных" value={s.skipTrusted} onChange={skipTrusted => patch({ skipTrusted })}/>
      <label className="block text-[11px] text-[#A1A1AA]">Дополнение к правилам проверки мата<textarea rows={3} maxLength={1000} value={s.customRule} onChange={e => patch({ customRule: e.target.value })} className={textareaClass}/></label>
    </Details>
  </>
}
function ConversationFields({ settings: s, patch }: { settings: ConversationSettings; patch: (p: Partial<ConversationSettings>) => void }) {
  const toggle = (category: Category, enabled: boolean) => patch({ categories: enabled ? [...new Set([...s.categories, category])] : s.categories.filter(c => c !== category) })
  const sanctions = (p: Partial<ConversationSettings['sanctions']>) => patch({ sanctions: { ...s.sanctions, ...p } })
  const personality = (p: Partial<Personality>) => patch({ personality: { ...s.personality, ...p } })
  return <>
    <Switch label="Анализировать разговор" description="Замечать личные выпады, травлю и угрозы в контексте" value={s.enabled} onChange={enabled => patch({ enabled })}/>
    <div className={boxClass}>{(['conflict','toxicity','harassment','threat'] as Category[]).map(c => <Switch key={c} label={categories[c]} value={s.categories.includes(c)} onChange={v => toggle(c,v)}/>)}</div>
    <Select label="Реакция на конфликт" value={s.reaction} onChange={v => patch({ reaction: v as ConversationSettings['reaction'] })}><option value="observe">Только наблюдать и вести журнал</option><option value="respond">Адресные замечания без санкций</option><option value="sanctions">Замечание, затем санкции за продолжение</option></Select>
    <p className="text-[11px] leading-relaxed text-[#8A8A93]">Бот обращается к автору свежего личного выпада, ответом на сообщение. Мат сам по себе, несогласие, цитаты и примеры не должны становиться конфликтом. Передачи спора администратору нет.</p>
    <div className="grid grid-cols-2 gap-3"><Select label="Начать после сообщений" value={s.minMessages} onChange={v => patch({ minMessages: Number(v) })}>{[2,3,4,5,6,8].map(v => <option key={v} value={v}>{v}</option>)}</Select><Select label="Уверенность AI" value={s.confidenceThreshold} onChange={v => patch({ confidenceThreshold: Number(v) })}>{[.85,.9,.95,.99].map(v => <option key={v} value={v}>{Math.round(v*100)}%</option>)}</Select></div>
    {s.reaction === 'sanctions' && <div className={boxClass}><p className="text-[12px] font-medium text-white">Санкции только за конфликты</p><p className="text-[11px] leading-relaxed text-[#8A8A93]">Первое замечание без наказания. Предупреждение — за новый подтверждённый личный выпад после доставленного замечания. Администраторы и доверенные защищены.</p><div className="grid grid-cols-2 gap-3">
      <Select label="Срок предупреждения" value={s.sanctions.warningExpiryDays} onChange={v => sanctions({ warningExpiryDays: Number(v) })}>{[0,1,7,14,30,60,90].map(v => <option key={v} value={v}>{v ? `${v} дн.` : 'Без срока'}</option>)}</Select>
      <Select label="Ограничить после" value={s.sanctions.muteAfterWarnings} onChange={v => sanctions({ muteAfterWarnings: Number(v) })}>{[0,1,2,3,4,5,7,10].map(v => <option key={v} value={v}>{v ? `${v} предупреждений` : 'Не ограничивать'}</option>)}</Select>
      <Select label="Срок ограничения" value={s.sanctions.muteDurationSeconds} onChange={v => sanctions({ muteDurationSeconds: Number(v) })}>{[[600,'10 минут'],[3600,'1 час'],[21600,'6 часов'],[86400,'1 день'],[604800,'7 дней']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</Select>
      <Select label="Заблокировать после" value={s.sanctions.banAfterWarnings} onChange={v => sanctions({ banAfterWarnings: Number(v) })}>{[0,3,5,7,10,15,20].map(v => <option key={v} value={v}>{v ? `${v} предупреждений` : 'Не блокировать'}</option>)}</Select>
    </div></div>}
    <label className="block text-[11px] text-[#A1A1AA]">Правила общения для вашего чата<textarea rows={3} maxLength={3000} value={s.customRules} onChange={e => patch({ customRules: e.target.value })} className={textareaClass} placeholder="Что важно учитывать в спорах и общении"/></label>
    <Details title="Другие ситуации"><div className="space-y-3">{(['fraud','semantic_spam','off_topic'] as Category[]).map(c => <Switch key={c} label={categories[c]} value={s.categories.includes(c)} onChange={v => toggle(c,v)}/>)}</div></Details>
    <Details title="Характер и тон замечаний">
      <Select label="Стиль" value={s.personality.archetype} onChange={v => personality({ archetype: v as Personality['archetype'] })}>{[['calm','Спокойный'],['strict','Строгий'],['insider','Свой в чате'],['ironic','Ироничный'],['security','Сдержанный']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</Select>
      <div className="grid grid-cols-2 gap-3"><Select label="Строгость" value={s.personality.strictness} onChange={v => personality({ strictness: Number(v) as Personality['strictness'] })}>{[0,1,2,3].map(v => <option key={v} value={v}>{['Мягкая','Умеренная','Уверенная','Строгая'][v]}</option>)}</Select><Select label="Юмор" value={s.personality.humor} onChange={v => personality({ humor: Number(v) as Personality['humor'] })}>{[0,1,2].map(v => <option key={v} value={v}>{['Без шуток','Редко','Умеренно'][v]}</option>)}</Select></div>
      <Switch label="Разговорная лексика" value={s.personality.slang} onChange={slang => personality({ slang })}/>
      <label className="block text-[11px] text-[#A1A1AA]">Характер<textarea rows={2} value={s.personality.character.join(', ')} onChange={e => personality({ character: e.target.value.split(',') })} className={textareaClass}/></label>
      <label className="block text-[11px] text-[#A1A1AA]">Манера речи<textarea rows={2} value={s.personality.manner.join(', ')} onChange={e => personality({ manner: e.target.value.split(',') })} className={textareaClass}/></label>
      <label className="block text-[11px] text-[#A1A1AA]">Дополнительные пожелания<textarea rows={3} maxLength={600} value={s.personality.customInstructions} onChange={e => personality({ customInstructions: e.target.value })} className={textareaClass}/></label>
      <Select label="Удалять замечания через" value={s.responseAutoDeleteSeconds} onChange={v => patch({ responseAutoDeleteSeconds: Number(v) })}>{[0,60,300,600,1800,3600].map(v => <option key={v} value={v}>{v ? `${v/60} мин.` : 'Оставлять в чате'}</option>)}</Select>
    </Details>
  </>
}
export function ModeratorAiEditor({ moderatorId }: { moderatorId: string }) {
  const [data, setData] = useState<{ draft: AiBlock; published?: AiBlock }>(), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const initData = getTelegramInitData()
  useEffect(() => {
    let active = true
    setLoading(true)
    if (!initData) { setError('Откройте приложение через Telegram'); setLoading(false); return }
    moderatorFetch(`${API_BASE}/api/moderator-config/${moderatorId}/draft`).then(async r => {
      const d = await r.json() as { draft?: { blocks?: AiBlock[] }; published?: { blocks?: AiBlock[] }; error?: string }
      if (!r.ok) throw new Error(d.error ?? 'Не удалось загрузить настройки')
      const draft = d.draft?.blocks?.find(b => b.type === 'ai_moderation')
      if (!draft) throw new Error('Настройки AI отсутствуют. Обновите страницу')
      if (active) { setData({ draft, published: d.published?.blocks?.find(b => b.type === 'ai_moderation') }); setError('') }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [moderatorId, initData, retry])
  if (loading) return <div className="flex justify-center py-6 text-[#66666E]"><Loader2 size={20} className="animate-spin"/></div>
  if (error || !data) return <GlassCard><p role="alert" className="text-[12px] text-amber-300">{error}</p><button type="button" onClick={() => setRetry(v => v+1)} className="mt-2 min-h-11 text-[12px] text-[#FF6A00]">Повторить загрузку</button></GlassCard>
  return <div className="space-y-3" key={moderatorId}><SectionCard moderatorId={moderatorId} section="messageModeration" initial={data.draft.messageModeration} applied={data.published?.messageModeration}>{(settings, patch) => <ProfanityFields settings={settings} patch={patch}/>}</SectionCard><SectionCard moderatorId={moderatorId} section="conversationAnalysis" initial={data.draft.conversationAnalysis} applied={data.published?.conversationAnalysis}>{(settings, patch) => <ConversationFields settings={settings} patch={patch}/>}</SectionCard></div>
}
