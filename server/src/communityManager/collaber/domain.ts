import { createHash } from 'crypto';

export type IntroMessage = { id: string; userId: string; name: string; username: string|null; text: string; at: string };
export type Fact = { kind:'project'|'skill'|'offer'|'need'; value:string; evidence:string; at:string; expiresAt:string|null; sourceMessageId?:string };
export const hash = (s:string) => createHash('sha256').update(s).digest('hex');
export const safeUsername = (v:unknown) => typeof v==='string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v.replace(/^@/,'')) ? v.replace(/^@/,'') : null;
const flatten = (v:unknown):string => typeof v==='string'?v:Array.isArray(v)?v.map(x=>typeof x==='string'?x:x&&typeof x.text==='string'?x.text:'').join(''):'';

/** Telegram Desktop JSON or a normalized {chatId,messages} export. No name-based identity guesses. */
export function parseArchive(raw:unknown, expectedChatId:string) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('Нужен JSON-объект с chatId/id и массивом messages (экспорт Telegram Desktop).');
  const root=raw as Record<string,any>, chat=String(root.chatId??root.id??'');
  const normalized=expectedChatId.replace(/^-100/,'');
  if(chat!==expectedChatId && chat!==normalized)throw new Error('История относится к другому чату. Проверьте ID выбранного сообщества.');
  if(!Array.isArray(root.messages)||root.messages.length>50000)throw new Error('Ожидается массив messages, не более 50 000 сообщений за импорт.');
  const messages:IntroMessage[]=[], seen=new Set<string>();let skipped=0;
  for(const row of root.messages){
    if(!row||typeof row!=='object'){skipped++;continue}
    const userId=String(row.from_id??row.userId??'').replace(/^user/,'');
    const id=String(row.id??''),text=flatten(row.text).trim();
    const date=row.date_unixtime?new Date(Number(row.date_unixtime)*1000):new Date(row.at??row.date);
    if(row.type==='service'||row.forwarded_from||row.forward_from||row.is_bot||!/^\d+$/.test(userId)||!/^\d+$/.test(id)||!text||!Number.isFinite(date.getTime())||date.getTime()>Date.now()+86400000||seen.has(id)){skipped++;continue}
    seen.add(id);messages.push({id,userId,name:String(row.from??row.name??'Участник '+userId).slice(0,160),username:safeUsername(row.username),text:text.slice(0,12000),at:date.toISOString()});
  }
  messages.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
  return {messages,skipped,total:root.messages.length};
}
export function preferenceCommand(text:string):'hide'|'show'|'forget'|'no_mentions'|null {
  const t=text.trim().toLowerCase().replace(/[.!]+$/,'');
  if(/^(?:\/forget|удали мои данные collaber|забудь мой профиль)$/.test(t))return'forget';
  if(/^(?:\/hide|не предлагай(?:те)? меня|не предлагать меня)$/.test(t))return'hide';
  if(/^(?:\/show|предлагай меня|хочу участвовать в подборе)$/.test(t))return'show';
  if(/^(?:не упоминай(?:те)? меня|не тегай меня)$/.test(t))return'no_mentions';
  return null;
}
// Relay announcements describe a subject, not their sender. Exports often omit
// is_bot, so do not let an intro tag turn the relay account into that person.
export function isThirdPartyIntro(text:string){return /^[^\n]{1,200}\s+has joined the chat!\s*(?:\n|$)/iu.test(text.trim())||(/^[^\n]*Что обсуждалось вчера\s+\d/iu.test(text.trim())&&/#dailysummary\b/iu.test(text))}
export function possibleIntro(text:string){return !isThirdPartyIntro(text)&&text.length>=25 && /(?:#интро|#intro|меня зовут|занимаюсь|разрабатыва(?:ю|ем)|основатель|мой проект|наш проект|ищу|предлагаю|могу помочь|больше не ищу|уже наш[её]л|i am|i'm|looking for|founder|my project|(?:^|\n)\s*(?:я\s+)?(?:CEO|СЕО|CTO|фаундер)(?=\s|[,:—–-]|$))/imu.test(text)}
export function validateFacts(value:unknown, source:IntroMessage, freshnessDays:number):Fact[]{
  if(!Array.isArray(value))return[];
  return value.slice(0,12).flatMap(f=>{
    if(!f||!['project','skill','offer','need'].includes(f.kind)||typeof f.value!=='string'||typeof f.evidence!=='string')return[];
    const evidence=f.evidence.trim(), val=f.value.trim();
    if(evidence.length<8||!source.text.includes(evidence)||!val)return[];
    // AI paraphrases cannot introduce unsupported profile facts: display the actual excerpt.
    return [{kind:f.kind,value:evidence.slice(0,500),evidence,at:source.at,sourceMessageId:source.id,expiresAt:['offer','need'].includes(f.kind)?new Date(new Date(source.at).getTime()+freshnessDays*86400000).toISOString():null}];
  });
}
export function factsOf(raw:unknown):Fact[]{return Array.isArray(raw)?raw.filter(f=>f&&typeof f.value==='string'&&typeof f.evidence==='string'&&['project','skill','offer','need'].includes(f.kind)) as Fact[]:[]}
export function activeFacts(raw:unknown,now=new Date()){return factsOf(raw).filter(f=>!f.expiresAt||new Date(f.expiresAt)>now)}
/** Historical evidence stays searchable; freshness controls wording, not eligibility. */
export function factNeedsConfirmation(fact:Fact,freshnessDays:number,now=new Date()){
  return !Number.isFinite(Date.parse(fact.at))||Date.parse(fact.at)<now.getTime()-freshnessDays*86400000||Boolean(fact.expiresAt&&Date.parse(fact.expiresAt)<=now.getTime());
}
const stop=new Set(['который','которые','можно','нужно','ищу','найди','найти','партнера','партнёра','партнеров','партнёров','коллаборации','привет','помоги','для','это','как','мне','меня','есть','with','that','looking','help','collaber']);
export function terms(text:string){return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[]).filter(t=>!stop.has(t)).map(t=>t.length>5?t.slice(0,-2):t))].slice(0,60)}
export function rankFacts(query:string,facts:Fact[]){
  const words=terms(query);return facts.map(f=>({fact:f,score:terms(f.value).filter(t=>words.includes(t)).length*(f.kind==='offer'||f.kind==='skill'?2:1)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
}
export function contactUrl(username:string|null,query:string){return username&&safeUsername(username)?'https://t.me/'+username+'?text='+encodeURIComponent('Привет! Collaber предложил познакомиться. Хочу обсудить: '+query.slice(0,180)):null}
export function canAct(authorId:string,actorId:string){return authorId===actorId}
