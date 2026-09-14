import { Router } from '../lib/asyncRouter';
import { Request, Response } from 'express';
import { prisma } from '../db';
import { env } from '../env';
import { verifyModeratorSession } from '../lib/moderatorSession';
import { getBotIdFromToken, getBotIdentity, getChatMember, sendBotMessage, setBotWebhook } from '../lib/telegramBot';
import { DEFAULT_CM_CONFIG, parseCommunityManagerConfig } from '../communityManager/config';
import { acceptCommunityManagerUpdate, buildCommunityManagerPersonality, previewCommunityManagerPersonality, runCommunityActivity, simulateCommunityManager, verifyCommunityManagerWebhookSecret } from '../communityManager/engine';
import { communityManagerExecutor, incomingManagedCommunityBot, managedCommunityBotPublic, updateManagedCommunityBotProfile } from '../communityManager/managedBot';
import { decryptManagedBotToken } from '../moderator/managedBotCrypto';
import { actionPresentation } from '../communityManager/actionPresentation';
import { participantPublic } from '../communityManager/participantMemory';
import { primaryTextModelConfigured } from '../lib/assistantModel';
import { getEffectiveSubscription, hasCustomBotSlot, refundSubscriptionQuota, reserveSubscriptionQuota, TIER_LIMITS } from '../lib/subscriptionLimits';

const router=Router();
async function auth(req:Request){
  const session=verifyModeratorSession(req.headers.authorization);
  const user=await prisma.user.findUnique({where:{telegramId:session.tgUserId},select:{id:true,telegramId:true}});
  if(!user)throw new Error('USER_NOT_FOUND');return{user,tgUserId:session.tgUserId};
}
function fail(res:Response,e:unknown){const m=e instanceof Error?e.message:'';res.status(m==='NOT_FOUND'?404:m==='PLAN_REQUIRED'?403:401).json({error:m==='PLAN_REQUIRED'?'Функция доступна со Starter':m==='SESSION_EXPIRED'?'Сессия истекла. Переоткройте Publium.':'Недействительная авторизация'})}
async function owned(req:Request,id:string){
  const a=await auth(req),manager=await prisma.communityManager.findFirst({where:{id,community:{OR:[{chat:{userId:a.user.id}},{channel:{userId:a.user.id}}]}},include:{community:{include:{moderatorChat:true,chat:true,channel:true,managedCommunityManagerBot:true}}}});
  if(!manager)throw new Error('NOT_FOUND'); const subscription=await getEffectiveSubscription(a.user.id); if(!TIER_LIMITS[subscription.tier].canUseCommunityManager)throw new Error('PLAN_REQUIRED'); return{...a,manager,subscription};
}
const publicManager=(m:any)=>m?{id:m.id,status:m.status,enabled:m.enabled,mode:m.mode,draftVersion:m.draftVersion,publishedVersion:m.publishedVersion,lastActionAt:m.lastActionAt,lastHealthyAt:m.lastHealthyAt,lastError:m.lastError,executorType:m.executorType}:null;

router.get('/channels/:channelId',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}
  const channel=await prisma.channel.findFirst({where:{id:req.params.channelId,userId:a.user.id},include:{community:{include:{moderatorChat:true,communityManager:true,managedCommunityManagerBot:true}}}});
  if(!channel){res.status(404).json({error:'Channel not found'});return}
  const manager=channel.community?.communityManager;
  const [docs,faqs,actions]=manager?await Promise.all([prisma.projectDoc.count({where:{channelId:channel.id}}),prisma.communityManagerFaq.count({where:{communityManagerId:manager.id,enabled:true}}),prisma.communityManagerAction.findMany({where:{communityManagerId:manager.id},orderBy:{createdAt:'desc'},take:10})]):[await prisma.projectDoc.count({where:{channelId:channel.id}}),0,[]];
  const managed=channel.community?.managedCommunityManagerBot??null,custom=manager?.executorType==='CUSTOM'&&managed?.status==='ACTIVE';
  res.json({communityId:channel.community?.id??null,chat:channel.community?.moderatorChat??null,manager:publicManager(manager),botUsername:custom&&managed?.username?managed.username:env.COMMUNITY_MANAGER_BOT_USERNAME,sharedBotUsername:env.COMMUNITY_MANAGER_BOT_USERNAME,managedBot:managedCommunityBotPublic(managed),docsCount:docs,faqCount:faqs,actions:actions.map(action=>({...action,presentation:actionPresentation(action)}))});
});

router.get('/chats/:chatId',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}
  const chat=await prisma.chat.findFirst({where:{id:req.params.chatId,userId:a.user.id},include:{community:{include:{moderatorChat:true,communityManager:true,managedCommunityManagerBot:true}}}});
  if(!chat){res.status(404).json({error:'Chat not found'});return}
  const manager=chat.community?.communityManager;
  const [faqs,actions]=manager?await Promise.all([prisma.communityManagerFaq.count({where:{communityManagerId:manager.id,enabled:true}}),prisma.communityManagerAction.findMany({where:{communityManagerId:manager.id},orderBy:{createdAt:'desc'},take:10})]):[0,[]];
  const managed=chat.community?.managedCommunityManagerBot??null,custom=manager?.executorType==='CUSTOM'&&managed?.status==='ACTIVE';
  res.json({communityId:chat.community?.id??null,chat:chat.community?.moderatorChat??null,manager:publicManager(manager),botUsername:custom&&managed?.username?managed.username:env.COMMUNITY_MANAGER_BOT_USERNAME,sharedBotUsername:env.COMMUNITY_MANAGER_BOT_USERNAME,managedBot:managedCommunityBotPublic(managed),docsCount:0,faqCount:faqs,actions:actions.map(action=>({...action,presentation:actionPresentation(action)}))});
});

router.post('/channels/:channelId/create',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}
  const subscription=await getEffectiveSubscription(a.user.id); if(!TIER_LIMITS[subscription.tier].canUseCommunityManager){res.status(403).json({error:'Community Manager доступен со Starter'});return}
  const community=await prisma.community.findFirst({where:{channelId:req.params.channelId,channel:{userId:a.user.id}},include:{moderatorChat:true}});
  if(!community){res.status(409).json({error:'Сначала подключите группу в Moderator'});return}
  const manager=await prisma.communityManager.upsert({where:{communityId:community.id},create:{communityId:community.id,mode:'AUTOPILOT',configs:{create:{version:1,config:DEFAULT_CM_CONFIG}}},update:{}});
  res.json({manager:publicManager(manager),chat:community.moderatorChat,botUsername:env.COMMUNITY_MANAGER_BOT_USERNAME});
});

router.post('/chats/:chatId/create',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}
  const subscription=await getEffectiveSubscription(a.user.id);if(!TIER_LIMITS[subscription.tier].canUseCommunityManager){res.status(403).json({error:'Community Manager доступен со Starter'});return}
  const community=await prisma.community.findFirst({where:{chatId:req.params.chatId,chat:{userId:a.user.id}},include:{moderatorChat:true}});
  if(!community){res.status(409).json({error:'Сначала подключите чат через Moderator'});return}
  const manager=await prisma.communityManager.upsert({where:{communityId:community.id},create:{communityId:community.id,mode:'AUTOPILOT',configs:{create:{version:1,config:DEFAULT_CM_CONFIG}}},update:{}});
  res.json({manager:publicManager(manager),chat:community.moderatorChat,botUsername:env.COMMUNITY_MANAGER_BOT_USERNAME});
});

router.get('/:id/draft',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const draft=await prisma.communityManagerConfig.findUnique({where:{communityManagerId_version:{communityManagerId:c.manager.id,version:c.manager.draftVersion}}});
  res.json({manager:publicManager(c.manager),config:parseCommunityManagerConfig(draft?.config??DEFAULT_CM_CONFIG)});
});

router.patch('/:id/draft',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  let config;try{config=parseCommunityManagerConfig(req.body?.config)}catch(e){res.status(400).json({error:e instanceof Error?e.message:'Invalid config'});return}
  const row=await prisma.communityManagerConfig.upsert({where:{communityManagerId_version:{communityManagerId:c.manager.id,version:c.manager.draftVersion}},create:{communityManagerId:c.manager.id,version:c.manager.draftVersion,config},update:{config}});
  await prisma.communityManager.update({where:{id:c.manager.id},data:{mode:'AUTOPILOT'}});
  res.json({config:row.config});
});

router.post('/:id/apply',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  if(c.manager.executorType==='SHARED'&&(!env.COMMUNITY_MANAGER_BOT_TOKEN||!env.COMMUNITY_MANAGER_WEBHOOK_SECRET)){res.status(503).json({error:'Community Manager bot не настроен'});return}
  if(!c.manager.community.moderatorChat){res.status(409).json({error:'Группа не подключена'});return}
  const draft=await prisma.communityManagerConfig.findUnique({where:{communityManagerId_version:{communityManagerId:c.manager.id,version:c.manager.draftVersion}}});
  if(!draft){res.status(409).json({error:'Сначала сохраните настройки'});return}
  try{
    const executor=await communityManagerExecutor(c.manager.community.id);
    const [bot,user]=await Promise.all([getChatMember(c.manager.community.moderatorChat.tgChatId,executor.botId,executor.token),getChatMember(c.manager.community.moderatorChat.tgChatId,Number(c.tgUserId),executor.token)]);
    const botAllowed=executor.type==='CUSTOM'?['administrator','creator'].includes(bot.status):['member','administrator','creator'].includes(bot.status);
    if(!botAllowed){res.status(409).json({error:executor.type==='CUSTOM'?'Добавьте персонального CM-бота администратором группы':'Добавьте @'+env.COMMUNITY_MANAGER_BOT_USERNAME+' в группу'});return}
    if(!['administrator','creator'].includes(user.status)){res.status(403).json({error:'Вы больше не администратор группы'});return}
  }catch(e){res.status(502).json({error:e instanceof Error?e.message:'Не удалось проверить бота'});return}
  const next=draft.version+1;
  const result=await prisma.$transaction(async tx=>{
    await tx.communityManagerConfig.updateMany({where:{communityManagerId:c.manager.id,status:'PUBLISHED'},data:{status:'ARCHIVED'}});
    await tx.communityManagerConfig.update({where:{id:draft.id},data:{status:'PUBLISHED',publishedAt:new Date()}});
    await tx.communityManagerConfig.create({data:{communityManagerId:c.manager.id,version:next,config:parseCommunityManagerConfig(draft.config)}});
    return tx.communityManager.update({where:{id:c.manager.id},data:{status:'ACTIVE',enabled:true,mode:'AUTOPILOT',publishedVersion:draft.version,draftVersion:next,lastError:null,lastHealthyAt:new Date()}});
  });
  res.json({manager:publicManager(result)});
});

router.post('/:id/pause',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const enabled=typeof req.body?.enabled==='boolean'?req.body.enabled:!c.manager.enabled;
  const mode='AUTOPILOT';
  if(enabled&&!c.manager.publishedVersion){res.status(409).json({error:'Сначала примените настройки'});return}
  const manager=await prisma.communityManager.update({where:{id:c.manager.id},data:{enabled,mode,status:enabled?'ACTIVE':'PAUSED'}});
  if(!enabled)await prisma.$transaction([prisma.communityManagerJob.updateMany({where:{communityManagerId:manager.id,status:{in:['PENDING','RETRY_WAIT','CLAIMED']}},data:{status:'CANCELLED',leaseUntil:null}}),prisma.communityManagerActivity.updateMany({where:{communityManagerId:manager.id,status:{in:['WAITING','PROCESSING','RUNNING','SENDING','ACTIVE']}},data:{status:'CANCELLED',lastError:'Community Manager paused'}})]);
  res.json({manager:publicManager(manager)});
});

router.get('/:id/health',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  let botStatus='missing',executorType=c.manager.executorType;try{if(c.manager.community.moderatorChat){const executor=await communityManagerExecutor(c.manager.community.id);executorType=executor.type;botStatus=(await getChatMember(c.manager.community.moderatorChat.tgChatId,executor.botId,executor.token)).status}}catch{botStatus='error'}
  const [pending,retrying,failed24h,oldest]=await Promise.all([prisma.communityManagerJob.count({where:{communityManagerId:c.manager.id,status:{in:['PENDING','RETRY_WAIT','CLAIMED']}}}),prisma.communityManagerJob.count({where:{communityManagerId:c.manager.id,status:'RETRY_WAIT'}}),prisma.communityManagerJob.count({where:{communityManagerId:c.manager.id,status:'FAILED',updatedAt:{gte:new Date(Date.now()-86400_000)}}}),prisma.communityManagerJob.findFirst({where:{communityManagerId:c.manager.id,status:{in:['PENDING','RETRY_WAIT','CLAIMED']}},orderBy:{createdAt:'asc'},select:{createdAt:true}})]);
  res.json({executor:botStatus,executorType,webhook:executorType==='CUSTOM'?Boolean(c.manager.community.managedCommunityManagerBot?.webhookSecret):Boolean(env.COMMUNITY_MANAGER_WEBHOOK_SECRET),published:Boolean(c.manager.publishedVersion),enabled:c.manager.enabled,ai:primaryTextModelConfigured(),research:Boolean(env.ANTHROPIC_API_KEY||env.TAVILY_API_KEY||process.env.SERPER_API_KEY),pending,retrying,failed24h,oldestPendingAt:oldest?.createdAt??null,lastHealthyAt:c.manager.lastHealthyAt,lastError:c.manager.lastError});
});

router.post('/:id/simulate',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const text=typeof req.body?.text==='string'?req.body.text.trim():'';
  if(text.length<3){res.status(400).json({error:'Добавьте сообщение'});return}
  try{res.json(await simulateCommunityManager(c.manager.id,text,req.body?.config))}catch(e){res.status(502).json({error:e instanceof Error?e.message:'Simulation failed'})}
});


router.post('/:id/personality-preview',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  try{res.json(await previewCommunityManagerPersonality(c.manager.id,req.body?.config))}catch(e){res.status(502).json({error:e instanceof Error?e.message:'Preview failed'})}
});
router.post('/:id/personality-build',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  try{res.json(await buildCommunityManagerPersonality(c.manager.id,req.body?.config))}catch(e){res.status(502).json({error:e instanceof Error?e.message:'Personality build failed'})}
});
router.get('/:id/actions',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const take=Math.min(100,Math.max(1,Number(req.query.take)||30));
  const actions=await prisma.communityManagerAction.findMany({where:{communityManagerId:c.manager.id},orderBy:{createdAt:'desc'},take});
  res.json({actions:actions.map(action=>({...action,presentation:actionPresentation(action)}))});
});
router.get('/:id/participants',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const participants=await prisma.communityManagerParticipant.findMany({where:{communityManagerId:c.manager.id},include:{claims:{where:{OR:[{status:'CONFIRMED'},{confidence:{gte:.9}}]},orderBy:{updatedAt:'desc'},take:20}},orderBy:[{expertConfirmed:'desc'},{lastSeenAt:'desc'}],take:200});
  res.json({participants:participants.map(participantPublic)});
});

router.patch('/:id/participants/:participantId',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const current=await prisma.communityManagerParticipant.findFirst({where:{id:req.params.participantId,communityManagerId:c.manager.id}});
  if(!current){res.status(404).json({error:'Участник не найден'});return}
  const list=(value:unknown,max:number)=>Array.isArray(value)?[...new Set(value.flatMap(item=>typeof item==='string'&&item.trim()?[item.trim().slice(0,80)]:[]))].slice(0,max):undefined;
  const requestedRelationship=['NEW','ACTIVE','REGULAR','FRIEND'].includes(String(req.body?.relationship))?String(req.body.relationship):undefined;
  const expertConfirmed=typeof req.body?.expertConfirmed==='boolean'?req.body.expertConfirmed:undefined;
  const roles=list(req.body?.roles,8),expertise=list(req.body?.expertise,12);
  const relationshipOverride=requestedRelationship==='FRIEND'?'FRIEND':requestedRelationship?null:current.relationshipOverride;
  const nextExpert=expertConfirmed??current.expertConfirmed;
  const nextRelationship=nextExpert?'EXPERT':relationshipOverride??current.autoRelationship;
  const participant=await prisma.communityManagerParticipant.update({where:{id:current.id},data:{
    relationship:nextRelationship,relationshipOverride,
    ...(expertConfirmed!==undefined?{expertConfirmed}:{}),
    ...(typeof req.body?.mentionEnabled==='boolean'?{mentionEnabled:req.body.mentionEnabled}:{}),
    ...(roles?{roles}:{}),...(expertise?{expertise}:{}),
  }});
  res.json({participant:participantPublic(participant)});
});

router.delete('/:id/participants/:participantId',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const deleted=await prisma.communityManagerParticipant.deleteMany({where:{id:req.params.participantId,communityManagerId:c.manager.id}});
  if(!deleted.count){res.status(404).json({error:'Участник не найден'});return}
  res.json({ok:true});
});



router.post('/:id/actions/:actionId/send',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const action=await prisma.communityManagerAction.findFirst({where:{id:req.params.actionId,communityManagerId:c.manager.id,decision:'DRAFT'}});
  if(!action?.response||!c.manager.community.moderatorChat){res.status(404).json({error:'Черновик не найден'});return}
  const quota=await reserveSubscriptionQuota(c.user.id,'communityManagerActions');
  if(!quota.ok){res.status(429).json({error:'Лимит действий Community Manager исчерпан',limit:quota.limit,used:quota.used});return}
  const claim=await prisma.communityManagerAction.updateMany({where:{id:action.id,communityManagerId:c.manager.id,decision:'DRAFT'},data:{decision:'SENDING'}});
  if(claim.count!==1){await refundSubscriptionQuota(c.user.id,'communityManagerActions');res.status(409).json({error:'Черновик уже отправляется или был отправлен'});return}
  try{const executor=await communityManagerExecutor(c.manager.community.id);const ref=await sendBotMessage(c.manager.community.moderatorChat.tgChatId,action.response,executor.token);await prisma.communityManagerAction.update({where:{id:action.id},data:{decision:'RESPOND',telegramMessageId:ref?.messageId}});res.json({ok:true})}catch(e){await refundSubscriptionQuota(c.user.id,'communityManagerActions');await prisma.communityManagerAction.updateMany({where:{id:action.id,decision:'SENDING'},data:{decision:'DRAFT',error:e instanceof Error?e.message.slice(0,500):'Send failed'}});res.status(502).json({error:e instanceof Error?e.message:'Send failed'})}
});

router.get('/:id/faq',async(req,res)=>{let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}res.json({faqs:await prisma.communityManagerFaq.findMany({where:{communityManagerId:c.manager.id},orderBy:[{priority:'desc'},{createdAt:'desc'}]})})});
router.post('/:id/faq',async(req,res)=>{let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}const q=String(req.body?.question??'').trim().slice(0,1000),a=String(req.body?.answer??'').trim().slice(0,5000);if(!q||!a){res.status(400).json({error:'Нужны вопрос и ответ'});return}res.json({faq:await prisma.communityManagerFaq.create({data:{communityManagerId:c.manager.id,question:q,answer:a}})})});
router.delete('/:id/faq/:faqId',async(req,res)=>{let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}const x=await prisma.communityManagerFaq.deleteMany({where:{id:req.params.faqId,communityManagerId:c.manager.id}});res.status(x.count?200:404).json(x.count?{ok:true}:{error:'FAQ not found'})});

router.post('/:id/activities/run',async(req,res)=>{
  let c;try{c=await owned(req,req.params.id)}catch(e){fail(res,e);return}
  const allowed=['DISCUSSION','POLL','QUIZ','LIGHT','HOT_NEWS','DIGEST','PREDICTION','CHALLENGE','CONTEST'] as const;
  if(!allowed.includes(req.body?.type)){res.status(400).json({error:'Неизвестный тип активности'});return}
  const type=req.body.type as typeof allowed[number],topic=typeof req.body?.topic==='string'?req.body.topic.trim().slice(0,500):undefined;
  try{res.json(await runCommunityActivity(c.manager.id,type,topic))}catch(e){const message=e instanceof Error?e.message:'Activity failed';res.status(/disabled|unavailable|requires|Quiet hours|limit reached|not active|not applied/i.test(message)?409:502).json({error:message})}
});

router.post('/communities/:communityId/managed-bot/request',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}
  const community=await prisma.community.findFirst({where:{id:req.params.communityId,OR:[{chat:{userId:a.user.id}},{channel:{userId:a.user.id}}]},include:{managedCommunityManagerBot:true}});if(!community){res.status(404).json({error:'Community not found'});return}
  const slot=await hasCustomBotSlot(a.user.id,community.id);if(!slot.ok){res.status(403).json({error:'Лимит персональных ботов исчерпан',limit:slot.limit,used:slot.used});return}
  const name=typeof req.body?.displayName==='string'?req.body.displayName.trim().slice(0,64):'',username=typeof req.body?.username==='string'?req.body.username.trim().replace(/^@/,''):'';
  if(name.length<2){res.status(400).json({error:'Название должно содержать минимум 2 символа'});return}if(!/^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/.test(username)){res.status(400).json({error:'Username: 5–32 символа, латиница/цифры/_ и окончание bot'});return}
  if(community.managedCommunityManagerBot&&['READY','ACTIVE'].includes(community.managedCommunityManagerBot.status)){res.status(409).json({error:'Персональный CM-бот уже создан — измените его оформление'});return}
  const manager=await getBotIdentity(env.TELEGRAM_BOT_TOKEN).catch(()=>null);if(!manager?.username||manager.can_manage_bots!==true){res.status(409).json({error:'Включите Bot Management Mode у @Publiumbot в BotFather и повторите'});return}
  const expires=new Date(Date.now()+30*60_000);await Promise.all([prisma.managedCommunityManagerBot.updateMany({where:{ownerUserId:a.user.id,status:'REQUESTED',communityId:{not:community.id}},data:{status:'CANCELLED',lastError:'Создан новый запрос для другого сообщества'}}),prisma.managedModeratorBot.updateMany({where:{ownerUserId:a.user.id,status:'REQUESTED'},data:{status:'CANCELLED',lastError:'Создан запрос персонального Community Manager'}})]);
  const bot=await prisma.managedCommunityManagerBot.upsert({where:{communityId:community.id},create:{communityId:community.id,ownerUserId:a.user.id,displayName:name,expectedUsername:username.toLowerCase(),avatarUrl:typeof req.body?.avatarUrl==='string'?req.body.avatarUrl:null,status:'REQUESTED',requestExpiresAt:expires},update:{ownerUserId:a.user.id,tgBotId:null,username:null,expectedUsername:username.toLowerCase(),displayName:name,avatarUrl:typeof req.body?.avatarUrl==='string'?req.body.avatarUrl:null,tokenCipher:null,tokenIv:null,tokenTag:null,webhookSecret:null,status:'REQUESTED',lastError:null,requestExpiresAt:expires}});
  res.json({managedBot:managedCommunityBotPublic(bot),createUrl:'https://t.me/newbot/'+manager.username+'/'+username+'?name='+encodeURIComponent(name)});
});

router.patch('/communities/:communityId/managed-bot/profile',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}const community=await prisma.community.findFirst({where:{id:req.params.communityId,OR:[{chat:{userId:a.user.id}},{channel:{userId:a.user.id}}]},include:{managedCommunityManagerBot:true}});if(!community?.managedCommunityManagerBot){res.status(404).json({error:'Персональный CM-бот не найден'});return}
  const name=typeof req.body?.displayName==='string'?req.body.displayName.trim().slice(0,64):'';if(name.length<2){res.status(400).json({error:'Название должно содержать минимум 2 символа'});return}
  try{const warning=await updateManagedCommunityBotProfile(community.managedCommunityManagerBot.id,name,typeof req.body?.avatarUrl==='string'?req.body.avatarUrl:community.managedCommunityManagerBot.avatarUrl);const updated=await prisma.managedCommunityManagerBot.findUnique({where:{id:community.managedCommunityManagerBot.id}});res.json({managedBot:managedCommunityBotPublic(updated),warning})}catch(e){res.status(502).json({error:e instanceof Error?e.message:'Не удалось обновить бота'})}
});

router.post('/communities/:communityId/managed-bot/activate',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}const community=await prisma.community.findFirst({where:{id:req.params.communityId,OR:[{chat:{userId:a.user.id}},{channel:{userId:a.user.id}}]},include:{moderatorChat:true,communityManager:true,managedCommunityManagerBot:true}});const bot=community?.managedCommunityManagerBot;
  if(!community?.moderatorChat||!community.communityManager||!bot?.tgBotId||!bot.webhookSecret){res.status(409).json({error:'Сначала создайте персонального CM-бота'});return}
  try{const token=decryptManagedBotToken(bot);const[botRole,userRole]=await Promise.all([getChatMember(community.moderatorChat.tgChatId,Number(bot.tgBotId),token),getChatMember(community.moderatorChat.tgChatId,Number(a.tgUserId),token)]);if(!['administrator','creator'].includes(botRole.status)||!['administrator','creator'].includes(userRole.status)){res.status(403).json({error:'Добавьте персонального CM-бота администратором группы'});return}await setBotWebhook(token,env.PUBLIC_BASE_URL+'/api/community-manager/webhook/'+bot.tgBotId,bot.webhookSecret);const[,updated]=await prisma.$transaction([prisma.communityManager.update({where:{id:community.communityManager.id},data:{executorType:'CUSTOM',mode:'AUTOPILOT'}}),prisma.managedCommunityManagerBot.update({where:{id:bot.id},data:{status:'ACTIVE',lastError:null}})]);res.json({executorType:'CUSTOM',managedBot:managedCommunityBotPublic(updated)})}catch(e){res.status(502).json({error:e instanceof Error?e.message:'Не удалось подключить персонального бота'})}
});

router.post('/communities/:communityId/executor/shared',async(req,res)=>{
  let a;try{a=await auth(req)}catch(e){fail(res,e);return}const community=await prisma.community.findFirst({where:{id:req.params.communityId,OR:[{chat:{userId:a.user.id}},{channel:{userId:a.user.id}}]},include:{moderatorChat:true,communityManager:true,managedCommunityManagerBot:true}});if(!community?.moderatorChat||!community.communityManager){res.status(404).json({error:'Community not found'});return}
  try{const[botRole,userRole]=await Promise.all([getChatMember(community.moderatorChat.tgChatId,getBotIdFromToken(env.COMMUNITY_MANAGER_BOT_TOKEN),env.COMMUNITY_MANAGER_BOT_TOKEN),getChatMember(community.moderatorChat.tgChatId,Number(a.tgUserId),env.COMMUNITY_MANAGER_BOT_TOKEN)]);if(!['member','administrator','creator'].includes(botRole.status)||!['administrator','creator'].includes(userRole.status)){res.status(403).json({error:'Добавьте @'+env.COMMUNITY_MANAGER_BOT_USERNAME+' в группу'});return}await prisma.$transaction([prisma.communityManager.update({where:{id:community.communityManager.id},data:{executorType:'SHARED',mode:'AUTOPILOT'}}),...(community.managedCommunityManagerBot?[prisma.managedCommunityManagerBot.update({where:{id:community.managedCommunityManagerBot.id},data:{status:'READY'}})]:[])]);res.json({executorType:'SHARED'})}catch(e){res.status(502).json({error:e instanceof Error?e.message:'Не удалось проверить общего бота'})}
});

router.post('/webhook/:botId',async(req,res)=>{
  const runtime=await incomingManagedCommunityBot(req.params.botId,typeof req.headers['x-telegram-bot-api-secret-token']==='string'?req.headers['x-telegram-bot-api-secret-token']:undefined);if(!runtime){res.status(401).json({error:'Unauthorized'});return}
  try{const status=await acceptCommunityManagerUpdate(req.body,{type:'CUSTOM',botId:runtime.numericBotId,communityId:runtime.communityId});res.json({ok:true,status})}catch(e){console.error('[community-manager/custom-webhook]',e instanceof Error?e.message:e);res.status(200).json({ok:true,status:'failed'})}
});
router.post('/webhook',async(req,res)=>{
  const secret=req.headers['x-telegram-bot-api-secret-token'];
  if(!verifyCommunityManagerWebhookSecret(secret)){res.status(401).json({error:'Unauthorized'});return}
  try{const status=await acceptCommunityManagerUpdate(req.body);res.json({ok:true,status})}catch(e){console.error('[community-manager/webhook]',e instanceof Error?e.message:e);res.status(200).json({ok:true,status:'failed'})}
});

export default router;
