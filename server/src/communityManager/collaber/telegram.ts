import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '../../db';
import { env } from '../../env';
import { answerBotCallback, getChatMember } from '../../lib/telegramBot';
import { communityManagerExecutor } from '../managedBot';
import { membershipReaderToken } from '../membership';
import { collaberContext, createMatch, enqueueCollaber, ingestIntro, profilePreference, type Candidate } from './service';
import { deliverMatch, deliverMessage } from './delivery';
import { canAct, contactUrl, preferenceCommand, safeUsername, type IntroMessage } from './domain';

const signature=(text:string)=>createHmac('sha256',env.COMMUNITY_MANAGER_WEBHOOK_SECRET||env.TELEGRAM_BOT_TOKEN).update(text).digest('base64url').slice(0,16);
export function entryPayload(managerId:string,now?:number){const data=managerId+'_'+(now===undefined?'0':Math.floor(now/1000).toString(36));return'co_'+data+'_'+signature(data)}
export function parseEntry(payload:string,now=Date.now()){
  const m=/^co_([a-z0-9]+)_([a-z0-9]+)_([A-Za-z0-9_-]{16})$/.exec(payload);if(!m)return null;
  const at=parseInt(m[2],36)*1000;if(!Number.isFinite(at)||(at!==0&&(at>now+60000||now-at>30*86400000)))return null;
  return timingSafeEqual(Buffer.from(m[3]),Buffer.from(signature(m[1]+'_'+m[2])))?m[1]:null;
}
export async function acceptCollaberUpdate(update:any,executor:{type:'SHARED'|'CUSTOM';botId:number;communityId?:string}){
  const callback=update.callback_query,m=update.message, userId=String(callback?.from?.id??m?.from?.id??'');
  if(!Number.isInteger(update.update_id)||!/^\d+$/.test(userId)||callback?.from?.is_bot||m?.from?.is_bot)return false;
  let managerId:string|undefined;
  if(callback?.data?.startsWith('cb:')){
    const parts=String(callback.data).split(':');
    const row=['yes','no'].includes(parts[1])?await prisma.collaberInvite.findUnique({where:{id:parts[2]}}):await prisma.collaberRequest.findUnique({where:{id:parts[2]}});
    managerId=row?.communityManagerId;
  }else if(m?.chat?.type==='private'){
    const payload=/^\/start(?:@\w+)?\s+(\S+)/.exec(m.text??'')?.[1];
    managerId=payload?parseEntry(payload)??undefined:(await prisma.collaberSession.findUnique({where:{botId_tgUserId:{botId:String(executor.botId),tgUserId:userId}}}))?.communityManagerId;
  }else return false;
  if(!managerId)return Boolean(callback?.data?.startsWith('cb:')||m?.text?.startsWith('/start co_'));
  const ctx=await collaberContext(managerId);if(!ctx||ctx.manager.executorType!==executor.type||executor.communityId&&ctx.manager.communityId!==executor.communityId)return true;
  const currentExecutor=await communityManagerExecutor(ctx.manager.communityId);if(currentExecutor.botId!==executor.botId)return true;
  if(callback)await answerBotCallback(callback.id,'Проверяю…',currentExecutor.token).catch(()=>undefined);
  await enqueueCollaber(managerId,'TELEGRAM','telegram:'+executor.botId+':'+update.update_id,{userId,botId:String(executor.botId),text:String(m?.text??'').slice(0,12000),name:[m?.from?.first_name,m?.from?.last_name].filter(Boolean).join(' '),username:m?.from?.username??null,messageId:m?.message_id??null,callback:callback?{data:String(callback.data),chatId:String(callback.message?.chat?.id??'')}:null});
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
  return{...ctx,executor};
}
export async function processTelegramTask(task:{id:string;communityManagerId:string;payload:unknown}){
  const p=task.payload as any, managerId=task.communityManagerId,userId=String(p.userId),privacyCommand=preferenceCommand(String(p.text??'')),ctx=await memberAccess(managerId,userId,Boolean(privacyCommand));
  if(String(ctx.executor.botId)!==p.botId)throw new Error('Исполнитель изменился');
  const say=(text:string,keyboard?:any)=>deliverMessage(managerId,userId,text,keyboard,task.id);
  const sessionKey={botId_tgUserId:{botId:p.botId,tgUserId:userId}};
  if(p.callback){
    const [,kind,id,index]=String(p.callback.data).split(':');
    if(kind==='yes'||kind==='no'){
      const invite=await prisma.collaberInvite.findFirst({where:{id,communityManagerId:managerId,candidateId:userId,status:'WAITING',expiresAt:{gt:new Date()}}});if(!invite)return;
      const claim=await prisma.collaberInvite.updateMany({where:{id:invite.id,status:'WAITING'},data:{status:kind==='no'?'DECLINED':'ACCEPTED'}});if(!claim.count)return;
      if(kind==='no'){await say('Приглашение отклонено.');return}
      await memberAccess(managerId,invite.requesterId);
      const profiles=await prisma.collaberProfile.findMany({where:{communityManagerId:managerId,tgUserId:{in:[userId,invite.requesterId]},searchable:true,forgotten:false},include:{participant:true}});
      if(profiles.length!==2){await prisma.collaberInvite.update({where:{id},data:{status:'CANCELLED'}});return}
      const request=await prisma.collaberRequest.findFirst({where:{id:invite.requestId,communityManagerId:managerId}});if(!request)return;
      for(const recipient of [userId,invite.requesterId]){
        const other=profiles.find(x=>x.tgUserId!==recipient)!,url=contactUrl(other.participant.username,request.query);
        await deliverMessage(managerId,recipient,`Вы оба согласились познакомиться по теме: ${request.query}\nВаш собеседник — ${other.participant.displayName}.${url?'':' У собеседника нет публичного username; договоритесь о контакте в общем чате.'}`,url?{inline_keyboard:[[{text:'Написать',url}]]}:undefined,task.id);
      }
      await prisma.collaberInvite.update({where:{id},data:{status:'INTRODUCED'}});return;
    }
    const request=await prisma.collaberRequest.findFirst({where:{id,communityManagerId:managerId,status:'SENT',createdAt:{gt:new Date(Date.now()-7*86400000)}}});
    if(!request||!canAct(request.tgUserId,userId))return;
    const replyChat=request.chatId; // Never assume a group user has started a private conversation.
    const respond=(text:string,keyboard?:any)=>deliverMessage(managerId,replyChat,text,keyboard,task.id,undefined,request.telegramMessageId??undefined);
    if(kind==='f'||kind==='good'){await prisma.collaberRequest.update({where:{id},data:{feedback:kind==='good'?'USEFUL':'NOT_USEFUL'}});await respond(kind==='good'?'Спасибо, отметил полезный подбор. Это ещё не означает, что знакомство состоялось.':'Отметил: подбор не подошёл. Уточни задачу, чтобы я изменил поиск.');return}
    if(kind==='r'){await respond('Напиши, что изменить: нужные навыки, тематику или формат сотрудничества. Можно продолжить в личном диалоге.',{inline_keyboard:[[{text:'Уточнить в личном диалоге',url:'https://t.me/'+ctx.executor.username+'?start='+entryPayload(managerId)}]]});return}
    const candidate=(request.candidates as unknown as Candidate[])[Number(index)];if(!candidate)return;
    const profile=await prisma.collaberProfile.findFirst({where:{id:candidate.id,communityManagerId:managerId,searchable:true,forgotten:false,...(replyChat.startsWith('-')?{publicMentions:true}:{})},include:{participant:true}});if(!profile)return;
    await memberAccess(managerId,profile.tgUserId);
    if(kind==='i'){await respond(`${profile.participant.displayName}\nИнтро от ${profile.sourceAt?.toLocaleDateString('ru-RU')??'неизвестной даты'}:\n${profile.sourceText.slice(0,3000)}`);return}
    if(kind==='n'){
      const sessions=await prisma.collaberSession.findMany({where:{communityManagerId:managerId,botId:p.botId,tgUserId:{in:[userId,profile.tgUserId]},expiresAt:{gt:new Date()}}});
      if(!sessions.some(s=>s.tgUserId===userId)){await respond('Для знакомства сначала открой личный диалог с ботом, затем нажми «Познакомить» ещё раз.',{inline_keyboard:[[{text:'Открыть бота',url:'https://t.me/'+ctx.executor.username+'?start='+entryPayload(managerId)}]]});return}
      if(!sessions.some(s=>s.tgUserId===profile.tgUserId)){await respond('Участник пока не подключил личные приглашения. Можно воспользоваться его публичным контактом, если он указан.');return}
      const pairKey=[userId,profile.tgUserId].sort().join(':');
      const previous=await prisma.collaberInvite.findUnique({where:{communityManagerId_pairKey:{communityManagerId:managerId,pairKey}}});
      if(previous&&previous.updatedAt>new Date(Date.now()-30*86400000)){await respond('Эту пару уже предлагали недавно. Повторное приглашение не отправлено.');return}
      const invite=await prisma.collaberInvite.upsert({where:{communityManagerId_pairKey:{communityManagerId:managerId,pairKey}},create:{communityManagerId:managerId,pairKey,requesterId:userId,candidateId:profile.tgUserId,requestId:id,expiresAt:new Date(Date.now()+7*86400000)},update:{requesterId:userId,candidateId:profile.tgUserId,requestId:id,status:'WAITING',expiresAt:new Date(Date.now()+7*86400000)}});
      const author=await prisma.communityManagerParticipant.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}}});
      await deliverMessage(managerId,profile.tgUserId,`${author?.displayName??'Участник сообщества'} хочет познакомиться по теме: ${request.query}`,{inline_keyboard:[[{text:'Согласен',callback_data:'cb:yes:'+invite.id+':0'},{text:'Не сейчас',callback_data:'cb:no:'+invite.id+':0'}]]},task.id);
      await respond('Приглашение отправлено. Знакомство состоится после согласия второй стороны.');return;
    }
    return;
  }
  const text=String(p.text).trim();
  const command=preferenceCommand(text);
  if(command){await profilePreference(managerId,userId,command);if(ctx.manager.enabled&&ctx.config.features.collaber.enabled)await say(command==='forget'?'Данные Collaber удалены. Повторный импорт не восстановит профиль.':'Настройки участия обновлены.');return}
  if(text.startsWith('/start')){
    const participant=await prisma.communityManagerParticipant.upsert({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}},create:{communityManagerId:managerId,tgUserId:userId,displayName:p.name||'Участник',username:p.username},update:{}});
    await prisma.collaberProfile.upsert({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}},create:{communityManagerId:managerId,participantId:participant.id,tgUserId:userId,membership:'MEMBER'},update:{membership:'MEMBER'}});
    await prisma.collaberSession.upsert({where:sessionKey,create:{communityManagerId:managerId,tgUserId:userId,botId:p.botId,expiresAt:new Date(Date.now()+30*86400000)},update:{communityManagerId:managerId,state:'SEARCH',expiresAt:new Date(Date.now()+30*86400000)}});
    await say('Для какой задачи ищешь человека? Опиши нужную помощь и что можешь предложить.\n\n/profile — мой профиль\n/edit — исправить интро\n/public — разрешить рекомендации обо мне в группе\n/hide — не предлагать меня\n/show — участвовать в подборе\n/forget — удалить данные Collaber');return;
  }
  const session=await prisma.collaberSession.findUnique({where:sessionKey});if(!session||session.communityManagerId!==managerId||session.expiresAt<new Date())return;
  if(text==='/profile'){
    const profile=await prisma.collaberProfile.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:managerId,tgUserId:userId}}});
    await say(`Твой профиль: ${profile?.searchable?'участвует в поиске':'скрыт'}. Публичные рекомендации: ${profile?.publicMentions?'разрешены':'выключены'}.\n${profile?.sourceText.slice(0,2500)||'Интро пока нет.'}\n\n/edit — изменить интро\n/public — разрешить публичные рекомендации\n/private — запретить публичные рекомендации`);return;
  }
  if(text==='/public'||text==='/private'){await prisma.collaberProfile.updateMany({where:{communityManagerId:managerId,tgUserId:userId},data:{publicMentions:text==='/public'}});await say('Видимость публичных рекомендаций обновлена.');return}
  if(text==='/edit'){await prisma.collaberSession.update({where:sessionKey,data:{state:'EDIT'}});await say('Пришли новое интро: проекты, навыки, чем можешь помочь и кого ищешь. Оно заменит сохранённое описание.');return}
  if(session.state==='EDIT'){
    const message:IntroMessage={id:String(p.messageId),userId,name:p.name||'Участник',username:p.username,text,at:new Date().toISOString()};
    const updated=await ingestIntro(managerId,message,ctx.config.features.collaber,true,true);
    if(updated)await prisma.collaberSession.update({where:sessionKey,data:{state:'SEARCH'}});
    await say(updated?'Интро обновлено. Теперь опиши задачу для поиска партнёра.':'Не нашёл сведений для профиля. Опиши свой проект и чем занимаешься.');return;
  }
  if(text.length<4){await say('Опиши задачу чуть подробнее.');return}
  const request=await createMatch({managerId,userId,chatId:userId,query:text,dedupeKey:task.id});await deliverMatch(request.id,managerId);
}
