import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, Search, Users, X, Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Switch } from '@/components/ui/Switch'
import { NumberStepper } from '@/components/ui/NumberStepper'
import { moderatorFetch, getTelegramInitData } from '@/lib/telegram'
import { API_BASE } from '@/lib/api'

export type CollaberConfig = {
 version:1; enabled:boolean; communityType:string; goals:string; collectIntros:boolean; onDemand:boolean;
 initiatives:'off'|'drafts'|'auto'; periodicDays:number; maxInitiativesPerDay:number; freshnessDays:number;
 imageUrl:string; showImage:boolean; introduction:string;
 buttons:{contact:boolean;intro:boolean;introduce:boolean;refine:boolean};
}
export const DEFAULT_COLLABER:CollaberConfig={version:1,enabled:false,communityType:'Профессиональное сообщество',goals:'Совместные проекты, обмен опытом и продвижение',collectIntros:true,onDemand:true,initiatives:'drafts',periodicDays:7,maxInitiativesPerDay:1,freshnessDays:90,imageUrl:'',showImage:true,introduction:'Вот с кем можно обсудить сотрудничество:',buttons:{contact:true,intro:true,introduce:true,refine:true}}
type Profile={id:string;tgUserId:string;searchable:boolean;publicMentions:boolean;forgotten:boolean;sourceText:string;sourceAt:string|null;membership:string;participant:{displayName:string;username:string|null};facts:Array<{kind:string;value:string}>}
type RequestRow={id:string;query:string;status:string;response:string|null;error:string|null;initiative:boolean;sourceMessageId:number|null;createdAt:string;telegramMessageId:number|null;candidates:Array<{name:string;description:string;reason:string}>}
type Data={stats?:{searchable:number;publicProfiles:number;sent:number;matched:number;useful:number;introduced:number};profiles:Profile[];total:number;requests:RequestRow[];drafts:RequestRow[];entryUrl:string|null}
const input='mt-1.5 min-h-11 w-full rounded-[11px] border border-white/[0.08] bg-[#0B0B0D] px-3 py-2 text-[14px] text-white outline-none focus-visible:ring-2 focus-visible:ring-[#FF6A00]/50'
const label='block text-[12px] font-medium text-[#A1A1AA]'
const card='rounded-[14px] border border-white/[0.07] bg-white/[0.025] p-3.5'
const statuses:Record<string,string>={PREVIEW:'Предпросмотр',PENDING:'В очереди',PROCESSING:'Обрабатывается',COMPLETED:'Завершён',FAILED:'Ошибка',CANCELLED:'Отменён',EXPIRED:'Срок истёк',DRAFT:'Черновик',SENT:'Отправлено',READY:'Готово',SENDING:'Отправляется',UNCERTAIN:'Проверить доставку',DECLINED:'Отклонено',NO_MATCH:'Совпадений нет'}
export function CollaberPanel({managerId,value,onChange,managerEnabled,memoryEnabled}:{managerId:string;value:CollaberConfig;onChange:(v:CollaberConfig)=>void;managerEnabled:boolean;memoryEnabled:boolean}){
 const [tab,setTab]=useState<'settings'|'people'|'proposals'>('settings'),[data,setData]=useState<Data|null>(null),[page,setPage]=useState(0),[q,setQ]=useState(''),[query,setQuery]=useState(''),[preview,setPreview]=useState<string|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[editing,setEditing]=useState<string|null>(null),[intro,setIntro]=useState('')
 const [requestView,setRequestView]=useState<'history'|'drafts'>('history'),[showPreview,setShowPreview]=useState(false)
 const imageRef=useRef<HTMLInputElement>(null)
 const api=useCallback(async(path:string,options?:RequestInit)=>{const r=await moderatorFetch(`${API_BASE}/api/community-manager/${managerId}/collaber${path}`,options);const d=await r.json();if(!r.ok)throw new Error(d.error||'Не удалось выполнить действие');return d},[managerId])
 const load=useCallback(async()=>{try{setData(await api(`?page=${page}&q=${encodeURIComponent(q)}`))}catch(e){setError(e instanceof Error?e.message:'Не удалось загрузить')}},[api,page,q])
 useEffect(()=>{const t=setTimeout(()=>void load(),250);return()=>clearTimeout(t)},[load])
 const act=async(key:string,fn:()=>Promise<void>)=>{setBusy(key);setError('');setNotice('');try{await fn();await load()}catch(e){setError(e instanceof Error?e.message:'Не удалось выполнить действие')}finally{setBusy('')}}
 const post=(path:string,body?:unknown)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body??{})})
 const patch=(id:string,body:unknown)=>api('/profiles/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
 const update=(patch:Partial<CollaberConfig>)=>onChange({...value,...patch})
 const uploadImage=(file:File)=>act('image',async()=>{const form=new FormData();const initData=getTelegramInitData();if(!initData)throw new Error('Откройте Publium внутри Telegram');form.append('initData',initData);form.append('image',file);const r=await moderatorFetch(API_BASE+'/api/posts/upload-block-image',{method:'POST',body:form}),d=await r.json();if(!r.ok||!d.url)throw new Error(d.error||'Не удалось загрузить обложку');update({imageUrl:d.url});setNotice('Обложка загружена. Сохраните и примените настройки CM.')})
 return <div className="space-y-4">
  <Switch label="Collaber · Поиск партнёров" description="Помогает участникам находить людей для совместных проектов" value={value.enabled} onChange={enabled=>update({enabled})}/>
  <p className="text-[12px] leading-relaxed text-[#A1A1AA]">Переключатель функции и настройки вступают в силу после «Сохранить» → «Применить».</p>
  {!managerEnabled&&<p className={card+' text-[12px] text-amber-200'}>CM на паузе. Collaber не отправляет сообщения.</p>}
  {!memoryEnabled&&value.collectIntros&&<p className={card+' text-[12px] text-amber-200'}>Память беседы выключена: новые интро не сохраняются автоматически. Включите её в «Ответы и лимиты».</p>}
  <div role="tablist" aria-label="Collaber" className="grid grid-cols-3 gap-1 rounded-[12px] bg-black/20 p-1">{([['people','Участники'],['proposals','Подборы'],['settings','Настройки']] as const).map(([id,title])=><button key={id} role="tab" aria-selected={tab===id} aria-controls={'collaber-'+id} onClick={()=>setTab(id)} className={'min-h-11 rounded-[10px] px-1 text-[12px] focus-visible:ring-2 focus-visible:ring-[#FF6A00] '+(tab===id?'bg-[rgba(255,106,0,.12)] text-[#FF9A57]':'text-[#A1A1AA]')}>{title}</button>)}</div>
  {data?.stats&&<div className={card+' grid grid-cols-2 gap-3 text-[12px] text-[#A1A1AA]'}><span>Профилей для поиска: <strong className="text-white">{data.stats.searchable}</strong></span><span>Можно в группе: <strong className="text-white">{data.stats.publicProfiles}</strong></span><span>Ответов на поиск: <strong className="text-white">{data.stats.sent}</strong></span><span>С найденными людьми: <strong className="text-white">{data.stats.matched}</strong></span><span>Полезных откликов: <strong className="text-white">{data.stats.useful}</strong></span><span className="col-span-2">Взаимных согласий на знакомство: <strong className="text-white">{data.stats.introduced}</strong></span></div>}
  {error&&<p role="alert" className="rounded-xl bg-red-400/10 p-3 text-[13px] text-red-200">{error}</p>}
  {notice&&<p role="status" className={card+' text-[13px] text-[#A1A1AA]'}>{notice}</p>}
  {busy&&<p role="status" className="flex items-center gap-2 text-[12px] text-[#A1A1AA]"><Loader2 size={14} className="animate-spin"/> Выполняется…</p>}
  {tab==='settings'&&<div id="collaber-settings" role="tabpanel" className="space-y-4">
   <p className="text-[12px] leading-relaxed text-[#A1A1AA]">База пополняется из новых интро. При включённых предложениях бот спрашивает разрешение на публичный подбор прямо в группе и отвечает на интро, если найдёт подходящих людей.</p>
   <label className={label}>Тип сообщества<input className={input} value={value.communityType} maxLength={160} onChange={e=>update({communityType:e.target.value})}/></label>
   <label className={label}>Какие коллаборации искать<textarea className={input} rows={3} value={value.goals} maxLength={500} onChange={e=>update({goals:e.target.value})}/></label>
   <Switch label="Сохранять новые интро" value={value.collectIntros} onChange={collectIntros=>update({collectIntros})}/>
   <Switch label="Отвечать на запросы о партнёрах" value={value.onDemand} onChange={onDemand=>update({onDemand})}/>
   <label className={label}>Предложения от бота<select className={input} value={value.initiatives} onChange={e=>update({initiatives:e.target.value as CollaberConfig['initiatives']})}><option value="off">Только по запросу участника</option><option value="drafts">Готовить черновики для владельца</option><option value="auto">Предлагать автоматически</option></select></label>
   <label className={label}>Не более инициатив в сутки<NumberStepper value={value.maxInitiativesPerDay} min={0} max={5} onChange={maxInitiativesPerDay=>update({maxInitiativesPerDay})}/></label>
   <label className={label}>Периодическая проверка, дней (0 — выключена)<NumberStepper value={value.periodicDays} min={0} max={30} onChange={periodicDays=>update({periodicDays})}/></label>
   <label className={label}>Через сколько дней уточнять актуальность<NumberStepper value={value.freshnessDays} min={7} max={365} onChange={freshnessDays=>update({freshnessDays})}/></label>
   <p className="text-[12px] leading-relaxed text-[#A1A1AA]">Поиск использует все сохранённые интро. Старые интро остаются в подборе с пометкой об актуальности; истёкший запрос сам по себе не запускает инициативу.</p>
   <div className={card+' space-y-3'}><p className="text-[14px] font-semibold text-white">В группе</p><p className="text-[13px] leading-relaxed text-[#A1A1AA]">Короткий ответ без обложки: до двух людей и кнопки их интро. Для уточнения участник отвечает на сообщение бота.</p><p className="text-[14px] text-white">Анна<br/>«Разрабатываю приложение для изучения языков»</p><div className="flex min-h-11 items-center justify-center rounded-[10px] border border-white/[.07] bg-white/[.05] text-[13px] text-white">Интро: Анна</div></div>
   <div className={card+' space-y-3'}><p className="text-[14px] font-semibold text-white">В личном диалоге</p>
    <Switch label="Обложка в личном подборе" value={value.showImage} onChange={showImage=>update({showImage})}/>
    <input ref={imageRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e=>{const f=e.target.files?.[0];if(f)void uploadImage(f);e.target.value=''}}/>
    <Button className="min-h-11" fullWidth disabled={Boolean(busy)} onClick={()=>imageRef.current?.click()}><ImagePlus size={16}/>{value.imageUrl?'Заменить обложку':'Загрузить обложку'}</Button>
    {value.imageUrl&&<Button className="min-h-11" variant="ghost" onClick={()=>update({imageUrl:''})}><X size={15}/> Убрать обложку</Button>}
    <label className={label}>Вступительный текст<textarea className={input} rows={3} maxLength={300} value={value.introduction} onChange={e=>update({introduction:e.target.value})}/></label>
    {([['contact','Написать участнику'],['intro','Посмотреть интро'],['introduce','Помочь познакомиться'],['refine','Уточнить подбор и оценить']] as const).map(([key,title])=><Switch key={key} label={title} value={value.buttons[key]} onChange={v=>update({buttons:{...value.buttons,[key]:v}})}/>)}
   </div>
   <div className="overflow-hidden rounded-[18px] border border-white/[.08] bg-[#111114]">
    {value.showImage&&value.imageUrl&&<img src={value.imageUrl} alt="Обложка Collaber" className="max-h-48 w-full object-cover"/>}
    <div className="space-y-3 p-4"><p className="text-[11px] text-[#A1A1AA]">Личный диалог · вымышленный пример</p><p className="whitespace-pre-wrap text-[14px] text-white">{value.introduction}</p><p className="text-[14px] font-semibold text-white">Анна · приложение для языков</p><p className="text-[14px] leading-relaxed text-[#A1A1AA]">Открыта к обмену аудиторией. Можно обсудить совместный языковой челлендж.</p>
     {([['contact','Написать Анне'],['intro','Посмотреть интро'],['introduce','Помочь познакомиться'],['refine','Уточнить подбор / Оценить']] as const).filter(([key])=>value.buttons[key]).map(([key,title])=><div key={key} className="flex min-h-11 items-center justify-center rounded-[10px] border border-white/[.07] bg-white/[.05] px-2 text-center text-[13px] text-white">{title}</div>)}
    </div>
   </div><p className="text-[11px] leading-relaxed text-[#A1A1AA]">Вид кнопок в чате зависит от темы Telegram. «Написать» открывает контакт; сообщение отправляет сам участник.</p>
   <div className={card+' space-y-3'}><p className="text-[14px] font-semibold text-white">Кнопка «Найти партнёра»</p><p className="text-[12px] leading-relaxed text-[#A1A1AA]">Добавьте ссылку в приветствие Moderator или закреплённое сообщение. Она откроет личный диалог с CM. Ссылка постоянная; доступ проверяется по участию в сообществе.</p>{data?.entryUrl?<><input aria-label="Ссылка для поиска партнёра" className={input} value={data.entryUrl} readOnly/><Button className="min-h-11" fullWidth onClick={()=>void act('copy',async()=>{await navigator.clipboard.writeText(data.entryUrl!);setNotice('Ссылка скопирована')})}><Copy size={14}/> Скопировать ссылку</Button></>:<p className="text-[12px] text-amber-200">Сначала подключите исполнителя CM.</p>}</div>
  </div>}
  {tab==='people'&&<div id="collaber-people" role="tabpanel" className="space-y-3">
   <p className="text-[13px] leading-relaxed text-[#A1A1AA]">Это база для поиска партнёров. Участник пишет интро в группе или боту — здесь появляется его профиль. Список участников Telegram сам по себе не заполняет эту базу.</p>
   <p className="text-[12px] leading-relaxed text-[#A1A1AA]">Изменения профилей применяются сразу. Имя и контакт берутся из Telegram-аккаунта автора интро.</p>
   <label className={label}>Поиск по имени<input className={input} value={q} placeholder="Имя участника" onChange={e=>{setQ(e.target.value);setPage(0)}}/></label>
   {data?.profiles.length===0&&<div className={card+' text-[13px] leading-relaxed text-[#A1A1AA]'}><Users size={22} className="mb-2 text-[#FF9A57]"/>{q?'По этому имени никто не найден. Попробуйте другое имя.':'Профилей пока нет. Включите сбор интро и предложите участникам рассказать о себе в группе.'}</div>}
   {data?.profiles.map(p=><article key={p.id} className={card+' space-y-3'}><p className="break-words text-[14px] font-semibold text-white">{p.participant.displayName}</p><p className="text-[12px] text-[#A1A1AA]">{p.participant.username?'@'+p.participant.username:'Без публичного username'} · {p.sourceAt?new Date(p.sourceAt).toLocaleDateString('ru-RU'):'Нет интро'}</p>{p.forgotten?<p className="text-[12px] text-amber-200">Участник удалил данные. Профиль не участвует в подборе.</p>:<><div className="space-y-2">{p.facts.slice(0,5).map((f,i)=><p key={i} className="break-words text-[13px] leading-relaxed text-[#A1A1AA]"><span className="text-white">{{project:'Проект',skill:'Навык',offer:'Может помочь',need:'Ищет'}[f.kind]??'Из интро'}:</span> {f.value}</p>)}</div><details className="text-[13px] text-[#A1A1AA]"><summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-[#FF6A00]">Полное интро</summary><p className="whitespace-pre-wrap break-words leading-relaxed">{p.sourceText||'Интро ещё не заполнено'}</p></details><Switch label="Разрешены публичные рекомендации" description="Включайте только с разрешения участника" value={p.publicMentions} onChange={v=>void act('visibility',async()=>{await patch(p.id,{publicMentions:v})})}/><div className="flex flex-wrap gap-2"><Button className="min-h-11" onClick={()=>{setEditing(p.id);setIntro(p.sourceText)}}>Исправить интро</Button>{p.searchable&&<Button className="min-h-11" variant="ghost" disabled={Boolean(busy)} onClick={()=>void act('hide',async()=>{await patch(p.id,{searchable:false})})}>Скрыть из поиска</Button>}</div>{!p.searchable&&<p className="text-[12px] text-amber-200">Скрыт. Участник может включить поиск командой /show.</p>}{editing===p.id&&<div className="space-y-2"><label className={label}>Актуальное интро<textarea className={input} rows={6} maxLength={12000} value={intro} onChange={e=>setIntro(e.target.value)}/></label><Button className="min-h-11" disabled={Boolean(busy)||intro.trim().length<25} onClick={()=>void act('edit',async()=>{await patch(p.id,{sourceText:intro});setEditing(null)})}>Сохранить профиль</Button><Button className="min-h-11" variant="ghost" onClick={()=>setEditing(null)}>Отмена</Button></div>}</>}</article>)}
   <div className="flex items-center justify-between gap-2"><Button className="min-h-11" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Назад</Button><span className="text-[12px] text-[#A1A1AA]">{data?.total??0} участников</span><Button className="min-h-11" disabled={!data||(page+1)*25>=data.total} onClick={()=>setPage(p=>p+1)}>Далее</Button></div>
  </div>}
  {tab==='proposals'&&<div id="collaber-proposals" role="tabpanel" className="space-y-3">
   <p className="text-[14px] font-semibold text-white">Подборы и знакомства</p>
   <p className="text-[13px] leading-relaxed text-[#A1A1AA]">Здесь видно, кого бот нашёл по запросам и новым интро. Черновики ждут отправки; история показывает результат обработки. Найденный человек ещё не означает состоявшееся знакомство.</p>
   <div className="flex gap-2">{([['history','История'],['drafts','Черновики']] as const).map(([id,title])=><Button key={id} className="min-h-11 flex-1" variant={requestView===id?'secondary':'ghost'} aria-pressed={requestView===id} onClick={()=>setRequestView(id)}>{title}</Button>)}</div>
   <Button className="min-h-11" variant="ghost" disabled={Boolean(busy)} onClick={()=>void act('refresh',load)}><RefreshCw size={14}/> Обновить</Button>
   {(requestView==='drafts'?data?.drafts:data?.requests)?.length===0&&<p className={card+' text-[13px] leading-relaxed text-[#A1A1AA]'}>{requestView==='drafts'?'Черновиков пока нет. Они появятся при подходящем совпадении, если выбран режим «Готовить черновики для владельца».':'История пока пуста. Здесь появятся результаты запросов участников и подбора по интро.'}</p>}
   {(requestView==='drafts'?data?.drafts:data?.requests)?.map(r=><article key={r.id} className={card+' space-y-2'}>
    <p className="text-[12px] text-[#FF9A57]">{r.status==='SENT'?(r.candidates.length?'Найдены участники':'Совпадений нет'):statuses[r.status]??r.status}</p>
    <p className="text-[11px] text-[#A1A1AA]">{r.initiative?(r.sourceMessageId?'По новому интро':'Инициатива бота'):'Запрос участника'} · {new Date(r.createdAt).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</p>
    <p className="break-words text-[14px] text-white">{r.initiative&&r.sourceMessageId?'Возможное сотрудничество по интро':r.query}</p>
    {r.candidates.map((c,i)=><p key={i} className="break-words text-[13px] leading-relaxed text-[#A1A1AA]"><strong className="text-white">{c.name}</strong> · {c.reason}</p>)}
    {r.status==='SENT'&&<p className="text-[12px] text-[#A1A1AA]">{r.candidates.length?'Рекомендация отправлена.':'Участнику отправлен ответ без рекомендаций.'}</p>}
    {r.status==='NO_MATCH'&&<p className="text-[12px] text-[#A1A1AA]">Подходящих людей не найдено. Сообщение в группу не отправлялось.</p>}
    {r.error&&<p className="text-[12px] text-amber-200">{r.error}</p>}
    {r.status==='DRAFT'&&<div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={Boolean(busy)||!managerEnabled} onClick={()=>void act('send',async()=>{const d=await post('/requests/'+r.id+'/send');setNotice(d.request?.status==='SENT'?'Предложение отправлено':d.request?.status==='NO_MATCH'?'Участники больше не подходят. Сообщение не отправлено.':'Отправка отложена: проверьте тихие часы, лимиты и настройки инициатив.')})}>Отправить в чат</Button><Button className="min-h-11" variant="ghost" disabled={Boolean(busy)} onClick={()=>void act('dismiss',async()=>{await post('/requests/'+r.id+'/dismiss')})}>Отклонить</Button></div>}
   </article>)}
   <div className={card+' space-y-3'}>
    <Button className="min-h-11" fullWidth variant="ghost" aria-expanded={showPreview} onClick={()=>setShowPreview(v=>!v)}><Search size={15}/> {showPreview?'Скрыть проверку':'Проверить поиск без отправки'}</Button>
    {showPreview&&<><label className={label}>Для какой задачи ищем человека<textarea className={input} rows={3} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Например: ищу маркетолога для мини-приложения"/></label>
     <Button className="min-h-11" fullWidth disabled={Boolean(busy)||query.trim().length<4} onClick={()=>void act('preview',async()=>{const d=await post('/preview',{query});setPreview(d.presentation.text)})}>Проверить подбор</Button>
     {preview&&<p role="status" className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[#A1A1AA]">{preview}</p>}
     <p className="text-[12px] leading-relaxed text-[#A1A1AA]">Проверка видна только вам и не отправляет сообщений. Перед настоящей рекомендацией бот дополнительно проверит, что люди ещё состоят в сообществе.</p></>}
   </div>
  </div>}
 </div>
}
