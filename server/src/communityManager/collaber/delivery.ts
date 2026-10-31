import { prisma } from '../../db';
import { env } from '../../env';
import { sendRichMessage, sendBotMessage, telegramAction, TelegramApiError, type TelegramInlineKeyboard } from '../../lib/telegramBot';
import { blocksToRichHtml, type PostBlock } from '../../lib/richPost';
import { reserveSubscriptionQuota, refundSubscriptionQuota } from '../../lib/subscriptionLimits';
import { communityManagerExecutor } from '../managedBot';
import { isQuietHour } from '../config';
import { collaberContext, type Candidate } from './service';
import { contactUrl } from './domain';
import type { CollaberConfig } from './config';
import { COLLABER_PAGE_SIZE } from './distribution';
import { withCollaberDeliveryLock } from './lock';
import { deliverInitialMatch } from './pages';

export function matchPresentation(request:{id:string;query:string;candidates:unknown;initiative?:boolean;chatId?:string;pageIndex?:number;pageVersion?:number;hasMore?:boolean;hasPrevious?:boolean;privateUrl?:string},config:CollaberConfig,emptyText='Пока не нашёл подходящих людей для этой задачи. Можно уточнить нужную помощь или вернуться к поиску после появления новых интро.'){
  const isGroup=Boolean(request.chatId?.startsWith('-'));
  const allCandidates=Array.isArray(request.candidates)?request.candidates as Candidate[]:[];
  const candidates=allCandidates.slice(0,COLLABER_PAGE_SIZE);
  let paragraphs:string[];
  if(isGroup){
    const short=(value:string,max:number)=>value.length<=max?value:value.slice(0,max-1).replace(/\s+\S*$/u,'')+'…';
    paragraphs=candidates.length?[config.introduction,...candidates.map(c=>`${short(c.name,60)}${c.description.startsWith('Дополнительно:')?' — дополнительно':''}\n«${short(c.evidence.replace(/\s+/gu,' ').trim(),120)}»`)]:[emptyText];
    if(candidates.some(c=>c.reason.includes('Исторические сведения')))paragraphs.push('Актуальность этих сведений стоит уточнить у автора.');
  }else paragraphs=candidates.length?[config.introduction,...candidates.map((c,i)=>`${i+1}. ${c.name}\n${c.description}\n${request.initiative?c.reason.replace('По теме вашего запроса:', 'Возможная точка сотрудничества:'):c.reason}\nИсточник: интро от ${new Date(c.at).toLocaleDateString('ru-RU')}`)]:[emptyText];
  const keyboard:TelegramInlineKeyboard={inline_keyboard:[]};
  candidates.forEach(candidate=>{
    const row:TelegramInlineKeyboard['inline_keyboard'][number]=[];
    const url=contactUrl(candidate.username,request.initiative?'возможное сотрудничество по твоему интро':request.query);
    if(config.buttons.contact&&url)row.push({text:('Написать '+candidate.name).slice(0,60),url});
    if(config.buttons.intro&&candidate.introUrl)row.push({text:row.length?'Интро':('Интро: '+candidate.name).slice(0,60),url:candidate.introUrl});
    if(row.length)keyboard.inline_keyboard.push(row);
  });
  const navigation:TelegramInlineKeyboard['inline_keyboard'][number]=[];
  if(request.hasPrevious)navigation.push({text:'Назад',callback_data:`cb:prev:${request.id}:${request.pageVersion??0}`});
  if(request.hasMore)navigation.push({text:candidates.length?'Показать ещё':'Продолжить поиск',callback_data:`cb:more:${request.id}:${request.pageVersion??0}`});
  if(navigation.length)keyboard.inline_keyboard.push(navigation);
  if(isGroup&&request.hasMore&&request.privateUrl)keyboard.inline_keyboard.push([{text:'Продолжить в личке',url:request.privateUrl}]);
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
  return withCollaberDeliveryLock(managerId,()=>deliverMessageLocked(managerId,chatId,text,keyboard,key,html,replyId,initiative,beforeDispatch));
}
export
async function deliverMessageLocked(managerId:string,chatId:string,text:string,keyboard?:TelegramInlineKeyboard,key?:string,html?:string,replyId?:number,initiative=false,beforeDispatch?:()=>Promise<void>,editMessageId?:number){
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
    action=await prisma.communityManagerAction.create({data:{communityManagerId:managerId,decision:'SENDING',intent:'collaber',reason:'Подбор участников',response:html?text.slice(0,5000):null,metadata:{collaberKey:key??'',addressedToManager:!initiative},status:'SENDING'}});
    const current=await collaberContext(managerId);
    if(!current?.manager.enabled||!current.config.features.collaber.enabled||current.manager.publishedVersion!==ctx.manager.publishedVersion)throw new Error('Настройки изменились, повторите действие');
    await beforeDispatch?.();
    dispatched=true;
    let ref;
    if(editMessageId){
      try{await telegramAction('editMessageText',{chat_id:chatId,message_id:editMessageId,...(html?{rich_message:{html}}:{text}),reply_markup:keyboard??{inline_keyboard:[]}},executor.token)}
      catch(error){if(!(error instanceof TelegramApiError&&error.code===400&&/message is not modified/i.test(error.message)))throw error}
      ref={chatId:Number(chatId),messageId:editMessageId};
    }else ref=html?await sendRichMessage(chatId,html,executor.token,keyboard,replyId):await sendBotMessage(chatId,text,executor.token,keyboard,undefined,replyId);
    if(!ref)throw new Error('Telegram не подтвердил идентификатор сообщения');
    // A confirmed Telegram result must survive a transient receipt-write failure.
    for(let attempt=0;;attempt++)try{await prisma.communityManagerAction.update({where:{id:action.id},data:{decision:'RESPOND',status:'COMPLETED',telegramMessageId:ref.messageId}});break}catch(error){if(attempt>=2)throw error}
    await prisma.communityManager.update({where:{id:managerId},data:{lastActionAt:new Date(),lastHealthyAt:new Date()}}).catch(()=>undefined);
    return ref;
  }catch(error){
    if(editMessageId&&error instanceof TelegramApiError&&error.code)dispatched=false;
    if(!dispatched)await refundSubscriptionQuota(ctx.ownerId,'communityManagerActions');
    if(action)await prisma.communityManagerAction.update({where:{id:action.id},data:{decision:'ERROR',status:dispatched?'UNCERTAIN':'FAILED',error:dispatched?'Проверьте доставку в Telegram перед повтором':'Отправка отменена до обращения к Telegram'}});
    if(error&&typeof error==='object')Object.assign(error,{collaberDispatched:dispatched});
    throw error;
  }
}
export async function deliverMatch(requestId:string,managerId:string,approved=false){
  return deliverInitialMatch(requestId,managerId,approved);
}
