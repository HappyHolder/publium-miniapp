import { prisma } from '../../db';
import { env } from '../../env';
import { sendRichMessage, sendBotMessage, type TelegramInlineKeyboard } from '../../lib/telegramBot';
import { blocksToRichHtml, type PostBlock } from '../../lib/richPost';
import { reserveSubscriptionQuota, refundSubscriptionQuota } from '../../lib/subscriptionLimits';
import { communityManagerExecutor } from '../managedBot';
import { isQuietHour } from '../config';
import { collaberContext, refreshCandidates, profileRevision, type Candidate } from './service';
import { contactUrl } from './domain';
import { memberAccess } from './telegram';
import type { CollaberConfig } from './config';

export function matchPresentation(request:{id:string;query:string;candidates:unknown;initiative?:boolean;chatId?:string},config:CollaberConfig,emptyText='Пока не нашёл подходящих людей для этой задачи. Можно уточнить нужную помощь или вернуться к поиску после появления новых интро.'){
  const isGroup=Boolean(request.chatId?.startsWith('-'));
  const allCandidates=Array.isArray(request.candidates)?request.candidates as Candidate[]:[];
  const candidates=isGroup?allCandidates.slice(0,2):allCandidates;
  let paragraphs:string[];
  if(isGroup){
    const short=(value:string,max:number)=>value.length<=max?value:value.slice(0,max-1).replace(/\s+\S*$/u,'')+'…';
    paragraphs=candidates.length?[config.introduction,...candidates.map(c=>`${short(c.name,60)}${c.description.startsWith('Дополнительно:')?' — дополнительно':''}\n«${short(c.evidence.replace(/\s+/gu,' ').trim(),220)}»`)]:[emptyText];
    if(candidates.some(c=>c.reason.includes('Исторические сведения')))paragraphs.push('Актуальность этих сведений стоит уточнить у автора.');
  }else paragraphs=candidates.length?[config.introduction,...candidates.map((c,i)=>`${i+1}. ${c.name}\n${c.description}\n${request.initiative?c.reason.replace('По теме вашего запроса:', 'Возможная точка сотрудничества:'):c.reason}\nИсточник: интро от ${new Date(c.at).toLocaleDateString('ru-RU')}`)]:[emptyText];
  const keyboard:TelegramInlineKeyboard={inline_keyboard:[]};
  candidates.forEach((candidate,index)=>{
    const url=contactUrl(candidate.username,request.initiative?'возможное сотрудничество по твоему интро':request.query);
    if(config.buttons.contact&&url)keyboard.inline_keyboard.push([{text:('Написать '+candidate.name).slice(0,60),url}]);
    if(config.buttons.intro&&candidate.introUrl)keyboard.inline_keyboard.push([{text:('Интро: '+candidate.name).slice(0,60),url:candidate.introUrl}]);
    if(config.buttons.introduce)keyboard.inline_keyboard.push([{text:('Познакомить: '+candidate.name).slice(0,60),callback_data:`cb:n:${request.id}:${index}`}]);
  });
  if(config.buttons.refine)keyboard.inline_keyboard.push([{text:'Уточнить подбор',callback_data:`cb:r:${request.id}:0`},...(candidates.length?[{text:'Не подходит',callback_data:`cb:f:${request.id}:0`}]:[])]);
  if(config.buttons.refine&&candidates.length)keyboard.inline_keyboard.push([{text:'Полезный подбор',callback_data:`cb:good:${request.id}:0`}]);
  const blocks:PostBlock[]=[];
  if(candidates.length&&config.showImage&&config.imageUrl)blocks.push({type:'image',url:config.imageUrl.startsWith('/')?env.PUBLIC_BASE_URL+config.imageUrl:config.imageUrl});
  for(const text of paragraphs.filter(Boolean).flatMap(p=>p.split(/\n+/)))blocks.push({type:'paragraph',runs:[{t:text}]});
  return {text:paragraphs.filter(Boolean).join('\n\n'),html:blocksToRichHtml(blocks),keyboard};
}

export async function emptyMatchText(managerId:string,userId:string,publicOnly:boolean){
  const where={communityManagerId:managerId,tgUserId:{not:userId},searchable:true,forgotten:false,sourceAt:{not:null},membership:{not:'LEFT'}};
  const count=await prisma.collaberProfile.count({where});
  if(!count)return 'В базе этого сообщества пока нет других участников с заполненным интро. Подбор станет доступен, когда они расскажут о себе в группе.';
  if(publicOnly&&!await prisma.collaberProfile.count({where:{...where,publicMentions:true}}))return 'Пока нет профилей, разрешённых для публичного подбора. Можно продолжить поиск в личном диалоге с ботом.';
  return 'Пока не нашёл подходящих людей для этой задачи. Можно уточнить нужную помощь или вернуться к поиску после появления новых интро.';
}

/** All Collaber messages share CM limits, pause checks, subscription accounting and journal. */
export async function deliverMessage(managerId:string,chatId:string,text:string,keyboard?:TelegramInlineKeyboard,key?:string,html?:string,replyId?:number,initiative=false,beforeDispatch?:()=>Promise<void>){
  const lockKey='delivery-lock:'+managerId;
  await prisma.collaberTask.upsert({where:{dedupeKey:lockKey},create:{communityManagerId:managerId,dedupeKey:lockKey,kind:'LOCK',status:'IDLE',payload:{}},update:{}});
  const claim=await prisma.collaberTask.updateMany({where:{dedupeKey:lockKey,OR:[{status:'IDLE'},{leaseUntil:{lt:new Date()}}]},data:{status:'LOCKED',leaseUntil:new Date(Date.now()+5*60000)}});
  if(!claim.count)throw new Error('Другая отправка CM ещё выполняется. Повторите позже.');
  try{return await deliverMessageLocked(managerId,chatId,text,keyboard,key,html,replyId,initiative,beforeDispatch)}
  finally{await prisma.collaberTask.update({where:{dedupeKey:lockKey},data:{status:'IDLE',leaseUntil:null}})}
}
async function deliverMessageLocked(managerId:string,chatId:string,text:string,keyboard?:TelegramInlineKeyboard,key?:string,html?:string,replyId?:number,initiative=false,beforeDispatch?:()=>Promise<void>){
  const ctx=await collaberContext(managerId);if(!ctx?.manager.enabled||!ctx.config.features.collaber.enabled||!ctx.ownerId)throw new Error('Collaber на паузе');
  if(initiative&&isQuietHour(ctx.config))throw new Error('Сейчас тихие часы');
  if(initiative){
    const count=await prisma.communityManagerAction.count({where:{communityManagerId:managerId,intent:'collaber',decision:'RESPOND',metadata:{path:['addressedToManager'],equals:false},createdAt:{gte:new Date(Date.now()-86400000)}}});
    if(count>=ctx.config.features.collaber.maxInitiativesPerDay)throw new Error('Лимит инициатив Collaber достигнут');
  }
  const [hour,day]=await Promise.all([3600000,86400000].map(ms=>prisma.communityManagerAction.count({where:{communityManagerId:managerId,decision:{in:['RESPOND','SENDING']},createdAt:{gte:new Date(Date.now()-ms)}}})));
  if(hour>=ctx.config.limits.maxRepliesPerHour||day>=ctx.config.limits.maxRepliesPerDay)throw new Error('Лимит сообщений CM достигнут');
  const executor=await communityManagerExecutor(ctx.manager.communityId);
  const quota=await reserveSubscriptionQuota(ctx.ownerId,'communityManagerActions');if(!quota.ok)throw new Error('Лимит тарифа достигнут');
  let action:{id:string}|undefined;
  let dispatched=false;
  try{
    action=await prisma.communityManagerAction.create({data:{communityManagerId:managerId,decision:'SENDING',intent:'collaber',reason:'Подбор и знакомства',response:html?text.slice(0,5000):null,metadata:{collaberKey:key??'',addressedToManager:!initiative},status:'SENDING'}});
    const current=await collaberContext(managerId);
    if(!current?.manager.enabled||!current.config.features.collaber.enabled||current.manager.publishedVersion!==ctx.manager.publishedVersion)throw new Error('Настройки изменились, повторите действие');
    await beforeDispatch?.();
    dispatched=true;
    const ref=html?await sendRichMessage(chatId,html,executor.token,keyboard,replyId):await sendBotMessage(chatId,text,executor.token,keyboard,undefined,replyId);
    if(!ref)throw new Error('Telegram не подтвердил идентификатор сообщения');
    await prisma.communityManagerAction.update({where:{id:action.id},data:{decision:'RESPOND',status:'COMPLETED',telegramMessageId:ref.messageId}});
    await prisma.communityManager.update({where:{id:managerId},data:{lastActionAt:new Date(),lastHealthyAt:new Date()}});
    return ref;
  }catch(error){
    if(!dispatched)await refundSubscriptionQuota(ctx.ownerId,'communityManagerActions');
    if(action)await prisma.communityManagerAction.update({where:{id:action.id},data:{decision:'ERROR',status:dispatched?'UNCERTAIN':'FAILED',error:dispatched?'Проверьте доставку в Telegram перед повтором':'Отправка отменена до обращения к Telegram'}});
    if(error&&typeof error==='object')Object.assign(error,{collaberDispatched:dispatched});
    throw error;
  }
}
export async function deliverMatch(requestId:string,managerId:string,approved=false){
  const request=await prisma.collaberRequest.findFirst({where:{id:requestId,communityManagerId:managerId}});
  if(!request||!['READY','DRAFT'].includes(request.status))return;
  const ctx=await collaberContext(managerId);if(!ctx||!ctx.manager.enabled||!ctx.config.features.collaber.enabled)throw new Error('Collaber на паузе');
  const cfg=ctx.config.features.collaber;
  if(request.initiative){
    if(cfg.initiatives==='off'||(!approved&&cfg.initiatives!=='auto'))return;
    const count=await prisma.collaberRequest.count({where:{communityManagerId:managerId,initiative:true,status:{in:['SENDING','SENT','UNCERTAIN']},updatedAt:{gte:new Date(Date.now()-86400000)}}});
    if(count>=cfg.maxInitiativesPerDay||isQuietHour(ctx.config))return;
    const state=await prisma.communityManagerConversationState.findUnique({where:{communityManagerId:managerId}});
    // A reply to an intro belongs to that conversation; only standalone initiatives wait for silence.
    if(!request.sourceMessageId&&state?.lastHumanAt&&state.lastHumanAt>new Date(Date.now()-ctx.config.replies.ambientCooldownMinutes*60000))return;
    if(state?.pendingModeratorAt&&state.pendingModeratorAt>new Date(Date.now()-30*60000))return;
    const activity=await prisma.communityManagerActivity.findFirst({where:{communityManagerId:managerId,status:{in:['PROCESSING','RUNNING','SENDING','ACTIVE']}}});if(activity)return;
  }else if(!cfg.onDemand)return;
  const candidates=(await refreshCandidates(managerId,request.tgUserId,request.candidates,request.chatId.startsWith('-'))).slice(0,request.chatId.startsWith('-')?2:3);
  if(request.initiative&&!candidates.length){await prisma.collaberRequest.updateMany({where:{id:requestId,status:request.status},data:{status:'NO_MATCH',candidates:[]}});return}
  const claim=await prisma.collaberRequest.updateMany({where:{id:requestId,status:request.status},data:{status:'SENDING',candidates:candidates as any}});if(!claim.count)return;
  const presentation=matchPresentation({...request,candidates},cfg,candidates.length?undefined:await emptyMatchText(managerId,request.tgUserId,request.chatId.startsWith('-')));
  try{
    const ref=await deliverMessage(managerId,request.chatId,presentation.text,presentation.keyboard,request.id,presentation.html,request.sourceMessageId??undefined,request.initiative,async()=>{
      await memberAccess(managerId,request.tgUserId);
      const current=await prisma.collaberRequest.findUnique({where:{id:request.id}});
      const eligible=await prisma.collaberProfile.findMany({where:{communityManagerId:managerId,id:{in:candidates.map(c=>c.id)},searchable:true,forgotten:false,...(request.chatId.startsWith('-')?{publicMentions:true}:{})}});
      if(current?.status!=='SENDING'||eligible.length!==candidates.length||candidates.some(c=>!eligible.some(p=>p.id===c.id&&profileRevision(p)===c.profileRevision)))throw new Error('Состав или видимость участников изменились. Повторите подбор.');
      if(request.initiative&&!await prisma.collaberProfile.findFirst({where:{communityManagerId:managerId,tgUserId:request.tgUserId,searchable:true,publicMentions:true,forgotten:false}}))throw new Error('Участник отозвал согласие на рекомендации');
    });
    await prisma.collaberRequest.update({where:{id:requestId},data:{status:'SENT',telegramMessageId:ref.messageId,response:presentation.text}});
    await prisma.collaberProfile.updateMany({where:{id:{in:candidates.map(c=>c.id)},communityManagerId:managerId},data:{lastProposedAt:new Date()}});
  }catch(error){const uncertain=Boolean((error as any)?.collaberDispatched);await prisma.collaberRequest.updateMany({where:{id:requestId,status:'SENDING'},data:{status:uncertain?'UNCERTAIN':request.status,error:uncertain?'Проверьте журнал и чат перед повтором отправки':error instanceof Error?error.message:'Отправка отложена'}});throw error}
}
