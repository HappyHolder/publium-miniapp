import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '../../db';
import { env } from '../../env';
import { answerBotCallback, getChatMember, deleteBotMessage, TelegramApiError, telegramAction } from '../../lib/telegramBot';
import { communityManagerExecutor } from '../managedBot';
import { membershipReaderToken } from '../membership';
import { collaberContext, createMatch, enqueueCollaber, ingestIntro, profilePreference, type Candidate } from './service';
import { deliverMatch, deliverMessage, matchPresentation } from './delivery';
import { profileIntroLinks } from './sources';
import { canAct, preferenceCommand, safeUsername, type IntroMessage } from './domain';
import { classifyCollaborationQuery } from './routing';
import { navigateMatch, continueMatchInPrivate } from './pages';
import { withCollaberDeliveryLock } from './lock';

const signature=(text:string)=>createHmac('sha256',env.COMMUNITY_MANAGER_WEBHOOK_SECRET||env.TELEGRAM_BOT_TOKEN).update(text).digest('base64url').slice(0,16);
const menu=(id:string)=>({inline_keyboard:[[{text:'Заполнить интро',callback_data:`cm:${id}:edit`},{text:'Мой профиль',callback_data:`cm:${id}:profile`}],[{text:'Найти партнёра',callback_data:`cm:${id}:search`}]]});
export function retiredIntroductionCallback(data:unknown){return typeof data==='string'&&/^cb:(?:n|yes|no):/.test(data)}
export function entryPayload(managerId:string,now?:number){const data=managerId+'_'+(now===undefined?'0':Math.floor(now/1000).toString(36));return'co_'+data+'_'+signature(data)}
export function continuationPayload(requestId:string){return 'cs_'+requestId+'_'+signature('continue:'+requestId)}
export function parseContinuation(payload:string){const m=/^cs_([a-z0-9]+)_([A-Za-z0-9_-]{16})$/.exec(payload);return m&&timingSafeEqual(Buffer.from(m[2]),Buffer.from(signature('continue:'+m[1])))?m[1]:null}
export function refinementPayload(requestId:string){return 'cr_'+requestId+'_'+signature('refine:'+requestId)}
export function parseRefinement(payload:string){
  const m=/^cr_([a-z0-9]+)_([A-Za-z0-9_-]{16})$/.exec(payload);
  return m&&timingSafeEqual(Buffer.from(m[2]),Buffer.from(signature('refine:'+m[1])))?m[1]:null;
}
export function parseEntry(payload:string,now=Date.now()){
  const m=/^co_([a-z0-9]+)_([a-z0-9]+)_([A-Za-z0-9_-]{16})$/.exec(payload);if(!m)return null;
  const at=parseInt(m[2],36)*1000;if(!Number.isFinite(at)||(at!==0&&(at>now+60000||now-at>30*86400000)))return null;
  return timingSafeEqual(Buffer.from(m[3]),Buffer.from(signature(m[1]+'_'+m[2])))?m[1]:null;
}
export async function acceptCollaberUpdate(update:any,executor:{type:'SHARED'|'CUSTOM';botId:number;communityId?:string}){
  const callback=update.callback_query,m=update.message, userId=String(callback?.from?.id??m?.from?.id??'');
  if(!Number.isInteger(update.update_id)||!/^\d+$/.test(userId)||callback?.from?.is_bot||m?.from?.is_bot)return false;
  let managerId:string|undefined;
  if(callback?.data?.startsWith('cp:')){
    const row=await prisma.collaberProfile.findUnique({where:{id:String(callback.data).split(':')[1]}});
    if(row?.tgUserId===userId)managerId=row.communityManagerId;
  }else if(callback?.data?.startsWith('cm:')&&callback.message?.chat?.type==='private'){
    const [,id,action]=String(callback.data).split(':');
    const session=await prisma.collaberSession.findUnique({where:{botId_tgUserId:{botId:String(executor.botId),tgUserId:userId}}});
    if(session?.communityManagerId===id&&session.expiresAt>new Date()&&['edit','profile','search','public','private'].includes(action))managerId=id;
  }else if(callback?.data?.startsWith('cb:')){
    const parts=String(callback.data).split(':');
    const row=['yes','no'].includes(parts[1])?await prisma.collaberInvite.findUnique({where:{id:parts[2]}}):await prisma.collaberRequest.findUnique({where:{id:parts[2]}});
    managerId=row?.communityManagerId;
  }else if(m?.chat?.type!=='private'&&preferenceCommand(String(m?.text??''))){
    const manager=await prisma.communityManager.findFirst({where:{publishedVersion:{not:null},executorType:executor.type,community:{...(executor.communityId?{id:executor.communityId}:{}),moderatorChat:{tgChatId:String(m.chat.id)}}},select:{id:true}});
    managerId=manager?.id;
  }else if(m?.chat?.type==='private'){
    const payload=/^\/start(?:@\w+)?\s+(\S+)/.exec(m.text??'')?.[1];
    const continuationId=payload&&parseContinuation(payload);
    const refineId=payload&&parseRefinement(payload);
    managerId=continuationId?(await prisma.collaberRequest.findFirst({where:{id:continuationId,tgUserId:userId,status:'SENT',chatId:{startsWith:'-'},createdAt:{gt:new Date(Date.now()-7*86400000)}},select:{communityManagerId:true}}))?.communityManagerId:refineId?(await prisma.collaberRequest.findFirst({where:{id:refineId,tgUserId:userId,status:'SENT',createdAt:{gt:new Date(Date.now()-7*86400000)}},select:{communityManagerId:true}}))?.communityManagerId:payload?parseEntry(payload)??undefined:(await prisma.collaberSession.findUnique({where:{botId_tgUserId:{botId:String(executor.botId),tgUserId:userId}}}))?.communityManagerId;
  }else return false;
  if(!managerId)return Boolean(/^(cb|cp|cm):/.test(callback?.data??'')||/^\/start(?:@\w+)?\s+(?:co|cs)_/.test(m?.text??''));
  const ctx=await collaberContext(managerId);if(!ctx||ctx.manager.executorType!==executor.type||executor.communityId&&ctx.manager.communityId!==executor.communityId)return true;
  const currentExecutor=await communityManagerExecutor(ctx.manager.communityId);if(currentExecutor.botId!==executor.botId)return true;
  const commandTarget=/^\/\w+@([A-Za-z0-9_]+)/.exec(m?.text??'')?.[1];
  if(commandTarget&&commandTarget.toLowerCase()!==currentExecutor.username?.toLowerCase())return false;
  if(/^cb:(?:more|prev):/.test(callback?.data??'')){
    const [, ,id,version]=String(callback.data).split(':');
    const request=await prisma.collaberRequest.findFirst({where:{id,communityManagerId:managerId}});
    const alert=(text:string)=>answerBotCallback(callback.id,text,currentExecutor.token);
    if(!ctx.manager.enabled||!ctx.config.features.collaber.enabled||!ctx.config.features.collaber.onDemand){await alert('Collaber сейчас на паузе.');return true}
    if(!request||request.tgUserId!==userId){await alert('Эта кнопка для автора подбора. Сделай свой запрос к боту.');return true}
    if(String(callback.message?.chat?.id)!==request.chatId||Number(callback.message?.message_id)!==request.telegramMessageId||!/^\d{1,9}$/.test(version??'')){await alert('Подбор ещё обновляется или уже недоступен.');return true}
  }
  if(retiredIntroductionCallback(callback?.data)){
    await answerBotCallback(callback.id,'Знакомства через бота отключены. Используй кнопку «Написать» в подборе.',currentExecutor.token);
    return true;
  }
  if(callback)await answerBotCallback(callback.id,'Проверяю…',currentExecutor.token).catch(()=>undefined);
  await enqueueCollaber(managerId,'TELEGRAM','telegram:'+executor.botId+':'+update.update_id,{userId,botId:String(executor.botId),text:String(m?.text??'').slice(0,12000),chatId:m?.chat?.id?String(m.chat.id):null,name:[m?.from?.first_name,m?.from?.last_name].filter(Boolean).join(' '),username:m?.from?.username??null,messageId:m?.message_id??null,callback:callback?{data:String(callback.data),chatId:String(callback.message?.chat?.id??''),messageId:Number(callback.message?.message_id??0)}:null});
  return true;
}
export async function memberAccess(managerId:string,userId:string,allowInactive=false){
  const ctx=await collaberContext(managerId);if(!ctx||(!allowInactive&&(!ctx.manager.enabled||!ctx.config.features.collaber.enabled)))throw new Error('Collaber выключен');
  const executor=await communityManagerExecutor(ctx.manager.communityId);
  // A former member must still be able to remove a previously saved profile.
  if(allowInactive)return{...ctx,executor};
  const readerToken=await membershipReaderToken(ctx.manager.communityId,ctx.chatId,executor.token);
  const member=await getChatMember(ctx.chatId,Number(userId),readerToken);
  if(!['member','creator','administrator'].includes(member.status)&&!(member.status==='restricted'&&(member as any).is_member))throw new Error('Доступ только для участников сообщества');
  if(String(member.user.id)!==userId)throw new Error('Не удалось подтвердить участника');
  await prisma.communityManagerParticipant.updateMany({where:{communityManagerId:managerId,tgUserId:userId},data:{username:safeUsername(member.user.username)}});
  await prisma.collaberProfile.updateMany({where:{communityManagerId:managerId,tgUserId:userId,membership:{not:'MEMBER'}},data:{membership:'MEMBER'}});
  return{...ctx,executor};
}
export async function processTelegramTask(task:{id:string;communityManagerId:string;payload:unknown}){
  // Old queued callbacks must never revive retired invitation sends.
  if(retiredIntroductionCallback((task.payload as any)?.callback?.data))return;
  const p=task.payload as any, managerId=task.communityManagerId,userId=String(p.userId),privacyCommand=preferenceCommand(String(p.text??'')),ctx=await memberAccess(managerId,userId,Boolean(privacyCommand&&privacyCommand!=='show'));
  if(String(ctx.executor.botId)!==p.botId)throw new Error('Исполнитель изменился');
  const say=(text:string,keyboard?:any)=>deliverMessage(managerId,userId,text,keyboard,task.id);
  const sessionKey={botId_tgUserId:{botId:p.botId,tgUserId:userId}};
  if(p.callback?.data?.startsWith('cm:')){
    const [,id,action]=String(p.callback.data).split(':');
    if(id!==managerId||p.callback.chatId!==userId||!['edit','profile','search','public','private'].includes(action))return;
    p.text='/'+action;p.callback=null;
  }
  if(p.callback?.data?.startsWith('cp:')){
    const [,profileId,action]=String(p.callback.data).split(':');
    if(!['public','private'].includes(action)||p.callback.chatId!==ctx.chatId)return;
    const profile=await prisma.collaberProfile.findFirst({where:{id:profileId,communityManagerId:managerId,tgUserId:userId,searchable:true,forgotten:false}});if(!profile)return;
    const consent=await prisma.collaberTask.findUnique({where:{dedupeKey:'consent:'+managerId+':'+userId}});if(!consent)return;
    const alreadyAccepted=consent.status==='COMPLETED'&&(consent.payload as any).choice===action;
    if(alreadyAccepted&&(consent.payload as any).removed)return;
    if(consent.status!=='WAITING'&&!alreadyAccepted)return;
    const accepted=alreadyAccepted||await withCollaberDeliveryLock(managerId,()=>prisma.$transaction(async tx=>{
      const claim=await tx.collaberTask.updateMany({where:{id:consent.id,status:'WAITING'},data:{status:'COMPLETED',payload:{...(consent.payload as any),choice:action}}});if(!claim.count)return false;
      const current=await tx.collaberProfile.updateMany({where:{id:profile.id,searchable:true,forgotten:false},data:{publicMentions:action==='public'}});
      if(current.count&&action==='public')await tx.collaberTask.upsert({where:{dedupeKey:'consent-propose:'+consent.id},create:{communityManagerId:managerId,kind:'PROPOSE',dedupeKey:'consent-propose:'+consent.id,payload:{userId,sourceMessageId:(consent.payload as any).sourceMessageId}},update:{}});
      return Boolean(current.count);
    }));
    if(!accepted)return;
    const prompt=await prisma.collaberTask.findUnique({where:{dedupeKey:'consent-prompt:'+consent.id}});
    const sent=prompt?await prisma.communityManagerAction.findFirst({where:{communityManagerId:managerId,intent:'collaber',status:'COMPLETED',metadata:{path:['collaberKey'],equals:prompt.id}},select:{telegramMessageId:true}}):null;
    if(sent?.telegramMessageId){
      const current=await prisma.collaberProfile.findUnique({where:{id:profile.id}});
      if(!current?.searchable||current.forgotten)return;
      try{await deleteBotMessage(ctx.chatId,sent.telegramMessageId,ctx.executor.token)}
      catch(error){if(!(error instanceof TelegramApiError&&error.code===400&&/message to delete not found/i.test(error.message)))throw error}
      await prisma.collaberTask.update({where:{id:consent.id},data:{payload:{...(consent.payload as any),choice:action,confirmed:true,removed:true}}});
    }
    return;
  }
  if(p.callback){
    const [,kind,id,index]=String(p.callback.data).split(':');
    if(kind==='more'||kind==='prev'){
      if(!/^\d{1,9}$/.test(index??''))return;
      await navigateMatch(managerId,id,userId,p.callback.chatId,Number(p.callback.messageId),Number(index),kind==='more'?'next':'back');return;
    }
    const request=await prisma.collaberRequest.findFirst({where:{id,communityManagerId:managerId,status:'SENT',createdAt:{gt:new Date(Date.now()-7*86400000)}}});
    if(!request||!canAct(request.tgUserId,userId))return;
    const replyChat=request.chatId; // Never assume a group user has started a private conversation.
    const respond=(text:string,keyboard?:any)=>deliverMessage(managerId,replyChat,text,keyboard,task.id,undefined,request.telegramMessageId??undefined);
    if(kind==='f'||kind==='good'){if(!Array.isArray(request.candidates)||!request.candidates.length)return;await prisma.collaberRequest.update({where:{id},data:{feedback:kind==='good'?'USEFUL':'NOT_USEFUL'}});await respond(kind==='good'?'Спасибо, отметил полезный подбор.':'Отметил: подбор не подошёл. Уточни задачу, чтобы я изменил поиск.');return}
    if(kind==='r'){
      if(p.callback.chatId!==request.chatId)return;
      if(!replyChat.startsWith('-'))await prisma.collaberSession.upsert({where:sessionKey,create:{communityManagerId:managerId,tgUserId:userId,botId:p.botId,state:'REFINE',query:request.query,expiresAt:new Date(Date.now()+30*86400000)},update:{communityManagerId:managerId,state:'REFINE',query:request.query,expiresAt:new Date(Date.now()+30*86400000)}});
      // The group hint has its own durable context, independent of the callback payload.
      const context=await prisma.collaberTask.upsert({where:{dedupeKey:'refine:'+task.id},create:{communityManagerId:managerId,kind:'REFINEMENT',status:'WAITING',dedupeKey:'refine:'+task.id,payload:{userId,query:request.query,requestId:request.id}},update:{}});
      await deliverMessage(managerId,replyChat,'Уточняем задачу: '+request.query+'\nНапиши в ответ, что изменить: навыки, тематику или формат сотрудничества.',{inline_keyboard:[[{text:'Уточнить в личном диалоге',url:'https://t.me/'+ctx.executor.username+'?start='+refinementPayload(request.id)}]]},context.id,undefined,request.telegramMessageId??undefined);
      return;
    }
    const candidate=(request.candidates as unknown as Candidate[])[Number(index)];if(!candidate)return;
    const profile=await prisma.collaberProfile.findFirst({where:{id:candidate.id,communityManagerId:managerId,searchable:true,forgotten:false,...(replyChat.startsWith('-')?{publicMentions:true}:{})},include:{participant:true}});if(!profile)return;
    await memberAccess(managerId,profile.tgUserId);
    if(kind==='i'){
      // Upgrade legacy callback buttons in place; never repost an intro into the chat.
      if(!request.telegramMessageId||p.callback.chatId!==request.chatId)return;
      const candidates=request.candidates as unknown as Candidate[];
      const profiles=await prisma.collaberProfile.findMany({where:{id:{in:candidates.map(c=>c.id)},communityManagerId:managerId,searchable:true,forgotten:false,...(replyChat.startsWith('-')?{publicMentions:true}:{})}});
      const links=await profileIntroLinks(managerId,ctx.chatId,profiles);
      const refreshed=candidates.map(c=>({...c,introUrl:links.get(c.id)}));
      const {keyboard}=matchPresentation({...request,candidates:refreshed},ctx.config.features.collaber);
      await telegramAction('editMessageReplyMarkup',{chat_id:request.chatId,message_id:request.telegramMessageId,reply_markup:keyboard},ctx.executor.token);
      return;
    }
    return;
  }
  const text=String(p.text).trim();
  const command=preferenceCommand(text);
  if(command){await profilePreference(managerId,userId,command);if(ctx.manager.enabled&&ctx.config.features.collaber.enabled)await deliverMessage(managerId,p.chatId??userId,command==='forget'?'Данные Collaber удалены. Повторный импорт не восстановит профиль.':'Настройки участия обновлены.',undefined,task.id,undefined,p.chatId?.startsWith('-')?p.messageId:undefined);return}
  if(text.startsWith('/start')){
    const continuationId=parseContinuation(text.split(/\s+/)[1]??'');
    if(continuationId){
      await continueMatchInPrivate(managerId,continuationId,userId,p.botId);
      await prisma.collaberSession.upsert({where:sessionKey,create:{communityManagerId:managerId,tgUserId:userId,botId:p.botId,state:'SEARCH',query:'',expiresAt:new Date(Date.now()+30*86400000)},update:{communityManagerId:managerId,state:'SEARCH',query:'',expiresAt:new Date(Date.now()+30*86400000)}});return;
    }
    const refineId=parseRefinement(text.split(/\s+/)[1]??'');
    const refinement=refineId?await prisma.collaberRequest.findFirst({where:{id:refineId,communityManagerId:managerId,tgUserId:userId,status:'SENT',createdAt:{gt:new Date(Date.now()-7*86400000)}}}):null;
    const searchState={state:refinement?'REFINE':'SEARCH',query:refinement?.query??'',expiresAt:new Date(Date.now()+30*86400000)};
    const participant=await prisma.communityManagerParticipant.upsert({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}},create:{communityManagerId:managerId,tgUserId:userId,displayName:p.name||'Участник',username:p.username},update:{}});
    await prisma.collaberProfile.upsert({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}},create:{communityManagerId:managerId,participantId:participant.id,tgUserId:userId,membership:'MEMBER'},update:{membership:'MEMBER'}});
    await prisma.collaberSession.upsert({where:sessionKey,create:{communityManagerId:managerId,tgUserId:userId,botId:p.botId,...searchState},update:{communityManagerId:managerId,...searchState}});
    if(refinement){await say('Уточняем задачу: '+refinement.query+'\nНапиши, что изменить. /search — начать новый поиск.',menu(managerId));return}
    await say('Помогу найти людей в твоём сообществе. Напиши, какая помощь нужна — например: «Ищу маркетолога для мини-приложения».\n\nЧтобы тебя тоже могли найти, расскажи о себе через кнопку «Заполнить интро» или напиши интро в группе. /hide — скрыть профиль, /forget — удалить данные.',menu(managerId));return;
  }
  const session=await prisma.collaberSession.findUnique({where:sessionKey});if(!session||session.communityManagerId!==managerId||session.expiresAt<new Date())return;
  if(text==='/search'){await prisma.collaberSession.update({where:sessionKey,data:{state:'SEARCH',query:''}});await say('Напиши, для какой задачи ищешь человека и какая помощь нужна.');return}
  if(text==='/profile'){
    const profile=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}}});
    await say(`Твой профиль: ${profile?.searchable?'участвует в поиске':'скрыт'}. Публичные рекомендации: ${profile?.publicMentions?'разрешены':'выключены'}.\n${profile?.sourceText.slice(0,2500)||'Интро пока нет.'}`,{inline_keyboard:[...menu(managerId).inline_keyboard,[{text:profile?.publicMentions?'Запретить показ в группе':'Разрешить показ в группе',callback_data:`cm:${managerId}:${profile?.publicMentions?'private':'public'}`}]]});return;
  }
  if(text==='/public'||text==='/private'){await withCollaberDeliveryLock(managerId,()=>prisma.collaberProfile.updateMany({where:{communityManagerId:managerId,tgUserId:userId,forgotten:false},data:{publicMentions:text==='/public'}}));await say('Видимость публичных рекомендаций обновлена.');return}
  if(text==='/edit'){await prisma.collaberSession.update({where:sessionKey,data:{state:'EDIT'}});await say('Пришли новое интро: проекты, навыки, чем можешь помочь и кого ищешь. Оно заменит сохранённое описание.');return}
  if(session.state==='EDIT'){
    const message:IntroMessage={id:String(p.messageId),userId,name:p.name||'Участник',username:p.username,text,at:new Date().toISOString()};
    const updated=await ingestIntro(managerId,message,ctx.config.features.collaber,true,true);
    if(updated)await prisma.collaberSession.update({where:sessionKey,data:{state:'SEARCH'}});
    await say(updated?'Интро обновлено. Теперь опиши задачу для поиска партнёра.':'Не нашёл сведений для профиля. Опиши свой проект и чем занимаешься.');return;
  }
  if(text.length<4){await say('Опиши задачу чуть подробнее.');return}
  let query=text;
  if(session.state==='REFINE'&&session.query){
    const route=await classifyCollaborationQuery(managerId,text,ctx.config.features.collaber.communityType,session.query);
    if(route.kind!=='SEARCH'){await say('Уточни, что изменить в задаче «'+session.query+'». /search — начать новый поиск.');return}
    query=route.query;
  }
  const request=await createMatch({managerId,userId,chatId:userId,query,dedupeKey:task.id});await deliverMatch(request.id,managerId);
  if(session.state==='REFINE')await prisma.collaberSession.updateMany({where:{...sessionKey.botId_tgUserId,communityManagerId:managerId,state:'REFINE',query:session.query},data:{state:'SEARCH',query:''}});
}
