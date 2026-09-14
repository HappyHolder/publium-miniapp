import { hydrateLinkedChannel } from './channelContext';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { env } from '../env';
import { getBotIdFromToken, sendBotMessage, setBotMessageReaction } from '../lib/telegramBot';
import type { ResearchSource } from '../lib/researchEngine';
import { primaryTextModel, primaryTextModelConfigured, terraText } from '../lib/assistantModel';
import { stripDisabledHighlightMarkers } from '../lib/richPost';
import { DEFAULT_CM_CONFIG, isQuietHour, parseCommunityManagerConfig, randomInitiativeDate, type CommunityManagerConfigData } from './config';
import { communityManagerExecutor } from './managedBot';
import { isAddressedToCommunityManager, mentionsTelegramUsername } from './conversationIntelligence';
import { personalityPrompt } from './personality';
import { runActivity } from './activityRuntime';
import type { CommunityActivityType } from './activityDirector';
import { normalizeCommunityManagerPunctuation } from './conversationStyle';
import { canRetryJob, retryDelayMs } from './jobPolicy';
import { recordPulseMessage } from '../lib/communityPulse';
import { markMentionedExperts, rememberCmExchange, rememberParticipant } from './participantMemory';
import { evolvePersonalState } from './personalityState';
import { communityManagerUpdateKey } from './conversationRouting';
import { digestRetentionDate } from './dailyDigest';
import { applyConversationAnalysis, appendCmThesis, appendHumanThesis, conversationStillCurrent, recordEpisode, recordParticipantClaims, resolveConversationLocation } from './conversationCoordinator';
import { automaticChannelMirror, cancelSilentContentRelease, captureAutomaticChannelPost } from './contentRelease';
import { getEffectiveSubscription, refundSubscriptionQuota, reserveSubscriptionQuota, TIER_LIMITS } from '../lib/subscriptionLimits';
import { runCommunityManagerAgent } from './agentRuntime';
import { conversationSessionKey } from './agentSession';

type TgAuthor={id:number;is_bot?:boolean;username?:string;first_name?:string;last_name?:string};
type TgMessage={message_id:number;date?:number;chat:{id:number};message_thread_id?:number;is_automatic_forward?:boolean;sender_chat?:{id:number};forward_from_message_id?:number;forward_origin?:{type?:string;chat?:{id:number};message_id?:number};from?:TgAuthor;text?:string;caption?:string;reply_to_message?:{message_id:number;date?:number;from?:TgAuthor;text?:string;caption?:string}};
type TgUpdate={update_id:number;message?:TgMessage;edited_message?:TgMessage};
type Ctx={manager:any;config:CommunityManagerConfigData;community:any};
const contextOwnerId=(community:any):string|undefined=>community.chat?.userId??community.channel?.userId;
const contextName=(community:any):string=>community.chat?.title??community.channel?.name??'сообщество';
const jsonObject=(s:string)=>{const m=s.match(/\{[\s\S]*\}/);if(!m)return null;try{return JSON.parse(m[0])}catch{return null}};
const same=(a:string,b:string)=>{if(!a||!b||a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0};
const plainTelegram=(s:string)=>stripDisabledHighlightMarkers(s).replace(/<[^>]+>/g,'').replace(/[*_#>]/g,'').replace(/^[-•]\s*/gm,'• ').replace(/\n{3,}/g,'\n\n').trim();
export const verifyCommunityManagerWebhookSecret=(v:unknown)=>typeof v==='string'&&same(v,env.COMMUNITY_MANAGER_WEBHOOK_SECRET);
async function published(chatId:string,executorType?:'SHARED'|'CUSTOM',communityId?:string):Promise<Ctx|null>{
  const manager=await prisma.communityManager.findFirst({where:{enabled:true,publishedVersion:{not:null},...(executorType?{executorType}:{}),community:{...(communityId?{id:communityId}:{}),moderatorChat:{tgChatId:chatId}}},include:{community:{include:{moderatorChat:true,moderator:true,chat:{include:{style:true}},channel:{include:{brandKit:true}}}}}});
  if(!manager?.publishedVersion)return null;await hydrateLinkedChannel(manager.community);
  const ownerUserId=manager.community.chat?.userId??manager.community.channel?.userId;if(!ownerUserId)return null;const subscription=await getEffectiveSubscription(ownerUserId);
  if(!TIER_LIMITS[subscription.tier].canUseCommunityManager)return null;
  const row=await prisma.communityManagerConfig.findUnique({where:{communityManagerId_version:{communityManagerId:manager.id,version:manager.publishedVersion}}});
  return row?{manager,config:parseCommunityManagerConfig(row.config),community:manager.community}:null;
}

export async function acceptCommunityManagerUpdate(update:TgUpdate,executor:{type:'SHARED'|'CUSTOM';botId:number;communityId?:string}={type:'SHARED',botId:getBotIdFromToken(env.COMMUNITY_MANAGER_BOT_TOKEN)}){
  if(!Number.isInteger(update.update_id))return'ignored';
  const m=update.message??update.edited_message,text=(m?.text??m?.caption??'').trim();
  if(!m)return'ignored';
  const mirror=automaticChannelMirror(m);
  if(mirror){
    const ctx=await published(String(m.chat.id),executor.type,executor.communityId);if(!ctx)return'ignored';
    if(!ctx.community.channelId||!ctx.community.channel)return'ignored';if(ctx.community.channel.tgChatId&&String(mirror.sourceChatId)!==ctx.community.channel.tgChatId)return'ignored';
    const publishedAt=m.date?new Date(m.date*1000):new Date();
    await captureAutomaticChannelPost(ctx.manager.id,{channelId:ctx.community.channelId,channelMessageId:mirror.channelMessageId,discussionChatId:String(m.chat.id),discussionMessageId:mirror.discussionMessageId,text,publishedAt});
    await prisma.communityManagerMessage.upsert({where:{communityManagerId_telegramMessageId:{communityManagerId:ctx.manager.id,telegramMessageId:m.message_id}},create:{communityManagerId:ctx.manager.id,telegramUpdateId:communityManagerUpdateKey(executor.botId,update.update_id)+':channel:'+m.message_id,telegramMessageId:m.message_id,tgChatId:String(m.chat.id),tgUserId:null,replyToMessageId:null,messageThreadId:m.message_thread_id??m.message_id,text:text.slice(0,12000),messageType:'CHANNEL_POST',moderationStatus:'ALLOWED',status:'CONTEXT',createdAt:publishedAt,expiresAt:new Date(Date.now()+8*86400_000)},update:{text:text.slice(0,12000),messageThreadId:m.message_thread_id??m.message_id,expiresAt:new Date(Date.now()+8*86400_000)}}).catch(()=>undefined);
    return'content_forward';
  }
  if(m.is_automatic_forward){
    console.warn('[community-manager/content-forward] Telegram omitted channel origin',{botId:executor.botId,updateId:update.update_id,chatId:m.chat.id,messageId:m.message_id});
    return'unresolved_content_forward';
  }
  if(!text||text.startsWith('/'))return'ignored';
  if(!m.from||m.from.is_bot)return'ignored';
  const ctx=await published(String(m.chat.id),executor.type,executor.communityId);if(!ctx)return'ignored';
  await cancelSilentContentRelease(ctx.manager.id,{replyToMessageId:m.reply_to_message?.message_id,messageThreadId:m.message_thread_id});
  // Pulse analytics: CM sees the chat even when Moderator is off. The recorder
  // claims each message id, so overlapping sources never double-count.
  if(!update.edited_message)void recordPulseMessage({communityId:ctx.community.id,tgUserId:String(m.from.id),telegramMessageId:m.message_id,isReply:Boolean(m.reply_to_message),at:m.date?new Date(m.date*1000):new Date(),identity:{username:m.from.username,firstName:m.from.first_name,lastName:m.from.last_name}}).catch(()=>undefined);
  const reply=m.reply_to_message,replyText=(reply?.text??reply?.caption??'').trim();
  if(reply?.from&&!reply.from.is_bot){
    const tgUserId=String(reply.from.id),username=reply.from.username?.trim().replace(/^@/,'')||null,firstName=reply.from.first_name?.trim()||null,lastName=reply.from.last_name?.trim()||null,displayName=[firstName,lastName].filter(Boolean).join(' ')||username||('Participant '+tgUserId),replyAt=reply.date?new Date(reply.date*1000):new Date();
    await prisma.communityManagerParticipant.upsert({where:{communityManagerId_tgUserId:{communityManagerId:ctx.manager.id,tgUserId}},create:{communityManagerId:ctx.manager.id,tgUserId,username,firstName,lastName,displayName,messageCount:0,roles:[],expertise:[]},update:{...(username?{username}:{}),...(firstName?{firstName}:{}),...(lastName?{lastName}:{}),displayName}}).catch(()=>undefined);
    await prisma.communityManagerMessage.upsert({where:{communityManagerId_telegramMessageId:{communityManagerId:ctx.manager.id,telegramMessageId:reply.message_id}},create:{communityManagerId:ctx.manager.id,telegramUpdateId:communityManagerUpdateKey(executor.botId,update.update_id)+':reply:'+reply.message_id,telegramMessageId:reply.message_id,tgChatId:String(m.chat.id),tgUserId,replyToMessageId:null,messageThreadId:m.message_thread_id,text:replyText.slice(0,12000)||null,messageType:'CONTEXT',moderationStatus:'ALLOWED',status:'CONTEXT',createdAt:replyAt,expiresAt:new Date(Date.now()+30*86400_000)},update:{tgUserId,messageThreadId:m.message_thread_id,...(replyText?{text:replyText.slice(0,12000)}:{}),expiresAt:new Date(Date.now()+30*86400_000)}}).catch(()=>undefined);
  }
  if(update.edited_message){
    const digestCreatedAt=m.date?new Date(m.date*1000):new Date();
    await Promise.all([
      prisma.communityManagerMessage.updateMany({where:{communityManagerId:ctx.manager.id,telegramMessageId:m.message_id},data:{text:text.slice(0,12000),replyToMessageId:m.reply_to_message?.message_id,messageThreadId:m.message_thread_id,messageType:m.text?'TEXT':'CAPTION'}}),
      prisma.communityManagerDigestMessage.upsert({where:{communityManagerId_telegramMessageId:{communityManagerId:ctx.manager.id,telegramMessageId:m.message_id}},create:{communityManagerId:ctx.manager.id,telegramMessageId:m.message_id,replyToMessageId:m.reply_to_message?.message_id,messageThreadId:m.message_thread_id,messageType:m.text?'TEXT':'CAPTION',tgUserId:String(m.from.id),text:text.slice(0,12000),createdAt:digestCreatedAt,expiresAt:digestRetentionDate(digestCreatedAt)},update:{replyToMessageId:m.reply_to_message?.message_id,messageThreadId:m.message_thread_id,messageType:m.text?'TEXT':'CAPTION',tgUserId:String(m.from.id),text:text.slice(0,12000),expiresAt:digestRetentionDate(digestCreatedAt)}}),
    ]);
    return'updated';
  }
  try{
    const row=await prisma.communityManagerMessage.create({data:{communityManagerId:ctx.manager.id,telegramUpdateId:communityManagerUpdateKey(executor.botId,update.update_id),telegramMessageId:m.message_id,tgChatId:String(m.chat.id),tgUserId:String(m.from.id),replyToMessageId:m.reply_to_message?.message_id,messageThreadId:m.message_thread_id,text:text.slice(0,12000),messageType:m.text?'TEXT':'CAPTION',moderationStatus:ctx.community.moderator?.enabled?'PENDING':'ALLOWED',expiresAt:new Date(Date.now()+86400_000)}});
    const digestCreatedAt=m.date?new Date(m.date*1000):row.createdAt;
    await prisma.communityManagerDigestMessage.upsert({where:{communityManagerId_telegramMessageId:{communityManagerId:ctx.manager.id,telegramMessageId:m.message_id}},create:{communityManagerId:ctx.manager.id,telegramMessageId:m.message_id,replyToMessageId:m.reply_to_message?.message_id,messageThreadId:m.message_thread_id,messageType:m.text?'TEXT':'CAPTION',tgUserId:String(m.from.id),text:text.slice(0,12000),createdAt:digestCreatedAt,expiresAt:digestRetentionDate(digestCreatedAt)},update:{replyToMessageId:m.reply_to_message?.message_id,messageThreadId:m.message_thread_id,messageType:m.text?'TEXT':'CAPTION',tgUserId:String(m.from.id),text:text.slice(0,12000),createdAt:digestCreatedAt,expiresAt:digestRetentionDate(digestCreatedAt)}}).catch(()=>undefined);
    await rememberParticipant(ctx.manager.id,m.from,text,ctx.config.personality.relationshipStyle).catch(()=>undefined);
    await prisma.$transaction([
      prisma.communityManagerJob.create({data:{communityManagerId:ctx.manager.id,messageId:row.id,runAfter:new Date(Date.now()+6000+(ctx.community.moderator?.enabled?1800:0))}}),
      prisma.communityManagerConversationState.upsert({where:{communityManagerId:ctx.manager.id},create:{communityManagerId:ctx.manager.id,lastHumanAt:new Date(),nextInitiativeAt:randomInitiativeDate(ctx.config),messagesSinceAnalysis:1},update:{lastHumanAt:new Date(),messagesSinceAnalysis:{increment:1}}}),
    ]);
    void processCommunityManagerJobs().catch(error=>console.error('[community-manager] worker failed',error.message));return'queued';
  }catch(e){if(e instanceof Prisma.PrismaClientKnownRequestError&&e.code==='P2002')return'duplicate';throw e}
}

type ParticipantIdentity={tgUserId:string;displayName:string;username:string|null};
const participantLabel=(person:ParticipantIdentity|null|undefined)=>person?(person.displayName+(person.username?' (@'+person.username+')':'')):'Unknown participant';
async function ai(system:string,user:string){
  if(!primaryTextModelConfigured())throw new Error('CM_AI_NOT_CONFIGURED');
  const raw=await terraText({system,prompt:user,maxTokens:1200,timeoutMs:45000,effort:'low',verbosity:'low'});
  if(!raw)throw new Error('CM_AI_EMPTY');
  return{text:raw.trim(),input:0,output:0};
}

async function moderationDisposition(ctx:Ctx,m:any):Promise<'ALLOWED'|'BLOCKED'|'IGNORED'|'PENDING'>{
  if(!ctx.community.moderator?.enabled)return 'ALLOWED';
  const row=await prisma.moderationEvent.findFirst({where:{communityId:ctx.community.id,telegramMessageId:m.telegramMessageId,eventType:'MESSAGE_DISPOSITION'},orderBy:{createdAt:'desc'},select:{action:true}});
  return row?.action==='BLOCK'?'BLOCKED':row?.action==='IGNORE'?'IGNORED':row?.action==='ALLOW'?'ALLOWED':'PENDING';
}

async function persistMemoryUpdates(managerId:string,updates:Array<{kind:'ROLE'|'EXPERTISE'|'PREFERENCE'|'FACT';value:string;confidence:number;evidenceMessageId:string}>){
  const telegramIds=[...new Set(updates.map(item=>/^msg:(\d+)$/.exec(item.evidenceMessageId)?.[1]).filter((id):id is string=>Boolean(id)).map(Number))];
  if(!telegramIds.length)return;
  const messages=await prisma.communityManagerMessage.findMany({where:{communityManagerId:managerId,telegramMessageId:{in:telegramIds},tgUserId:{not:null}},select:{id:true,telegramMessageId:true,tgUserId:true,text:true}});
  const participantIds=[...new Set(messages.map(message=>message.tgUserId).filter((id):id is string=>Boolean(id)))];
  const participants=participantIds.length?await prisma.communityManagerParticipant.findMany({where:{communityManagerId:managerId,tgUserId:{in:participantIds}},select:{id:true,tgUserId:true}}):[];
  const participantByUser=new Map(participants.map(participant=>[participant.tgUserId,participant.id]));
  for(const update of updates){
    const match=/^msg:(\d+)$/.exec(update.evidenceMessageId),message=match?messages.find(item=>item.telegramMessageId===Number(match[1])):undefined,participantId=message?.tgUserId?participantByUser.get(message.tgUserId):undefined;
    if(!message||!participantId)continue;
    await recordParticipantClaims(managerId,participantId,message.id,message.text??'',[{kind:update.kind,value:update.value,confidence:update.confidence}]);
  }
}
async function withinQuota(ctx:Ctx,m:any,enforceUserCooldown=true){
  if(enforceUserCooldown&&m.tgUserId&&ctx.config.replies.userCooldownSeconds>0){const userMessages=await prisma.communityManagerMessage.findMany({where:{communityManagerId:ctx.manager.id,tgUserId:m.tgUserId,createdAt:{gte:new Date(Date.now()-86400_000)}},orderBy:{createdAt:'desc'},take:100,select:{id:true}});if(userMessages.length&&await prisma.communityManagerAction.count({where:{communityManagerId:ctx.manager.id,decision:'RESPOND',messageId:{in:userMessages.map(x=>x.id)},createdAt:{gte:new Date(Date.now()-ctx.config.replies.userCooldownSeconds*1000)}}}))return false}
  const h=new Date(Date.now()-3600_000),d=new Date(Date.now()-86400_000);
  const [hour,day]=await Promise.all([prisma.communityManagerAction.count({where:{communityManagerId:ctx.manager.id,decision:'RESPOND',createdAt:{gte:h}}}),prisma.communityManagerAction.count({where:{communityManagerId:ctx.manager.id,decision:'RESPOND',createdAt:{gte:d}}})]);
  return hour<ctx.config.limits.maxRepliesPerHour&&day<ctx.config.limits.maxRepliesPerDay;
}

async function log(ctx:Ctx,m:any,decision:string,intent:string,confidence:number,reason:string,start:number,response?:string,sources:ResearchSource[]=[],usage={input:0,output:0},error?:unknown,telegramMessageId?:number,metadata?:Prisma.InputJsonValue){
  const meta=metadata&&typeof metadata==='object'?metadata as Record<string,unknown>:undefined;
  await prisma.communityManagerAction.create({data:{communityManagerId:ctx.manager.id,messageId:m?.id,threadId:typeof meta?.threadId==='string'?meta.threadId:m?.threadId,segmentId:typeof meta?.segmentId==='string'?meta.segmentId:m?.segmentId,decision,intent,confidence,reason:reason.slice(0,500),response:response?.slice(0,5000),sources:sources as any,metadata,model:primaryTextModel(),promptVersion:'community-agent-v1',inputTokens:usage.input,outputTokens:usage.output,latencyMs:Date.now()-start,telegramMessageId,status:error?'FAILED':'COMPLETED',error:error instanceof Error?error.message.slice(0,500):undefined}});
}
async function done(id:string,status:string,error?:string,runAfter?:Date){await prisma.communityManagerJob.update({where:{id},data:{status:runAfter?'RETRY_WAIT':status,lastError:error,runAfter,leaseUntil:null}})}

async function processJob(job:any){
  const start=Date.now(),m=job.message,ctx=await published(m.tgChatId);
  if(!ctx||ctx.manager.id!==job.communityManagerId){await done(job.id,'SKIPPED','inactive');return}
  const delivered=await prisma.communityManagerAction.findFirst({where:{communityManagerId:ctx.manager.id,messageId:m.id,telegramMessageId:{not:null},status:'COMPLETED'},select:{id:true}});
  if(delivered){await done(job.id,'COMPLETED','Already delivered');return}
  const disposition=await moderationDisposition(ctx,m);
  if(disposition==='PENDING'){
    if(job.attempts<30){await done(job.id,'RETRY_WAIT','Waiting for Moderator',new Date(Date.now()+2000));return}
    await log(ctx,m,'SILENT','moderation_timeout',1,'Moderator timeout',start);await done(job.id,'SKIPPED');return;
  }
  if(disposition==='IGNORED'||disposition==='BLOCKED'){
    await prisma.communityManagerMessage.update({where:{id:m.id},data:{moderationStatus:disposition,status:'SKIPPED'}});
    await log(ctx,m,'SILENT',disposition==='BLOCKED'?'unsafe':'moderator_trigger',1,disposition==='BLOCKED'?'Blocked by Moderator':'Handled by Moderator',start);
    await done(job.id,'SKIPPED');return;
  }
  await prisma.communityManagerMessage.update({where:{id:m.id},data:{moderationStatus:'ALLOWED'}});
  const location=await resolveConversationLocation(ctx.manager.id,m),executor=await communityManagerExecutor(ctx.community.id);
  const burst=m.tgUserId?await prisma.communityManagerMessage.findMany({where:{communityManagerId:ctx.manager.id,tgUserId:m.tgUserId,replyToMessageId:m.replyToMessageId??null,createdAt:{gte:new Date(m.createdAt.getTime()-20000),lte:m.createdAt}},orderBy:{createdAt:'asc'},take:6,select:{text:true}}):[];
  const text=(burst.map((row:any)=>row.text).filter(Boolean).join('\n')||m.text||'').slice(0,12000),mention=mentionsTelegramUsername(text,executor.username);
  const repliedAction=m.replyToMessageId?await prisma.communityManagerAction.findFirst({where:{communityManagerId:ctx.manager.id,telegramMessageId:m.replyToMessageId},orderBy:{createdAt:'desc'},select:{response:true}}):null;
  const repliedHuman=m.replyToMessageId&&!repliedAction?await prisma.communityManagerMessage.findFirst({where:{communityManagerId:ctx.manager.id,telegramMessageId:m.replyToMessageId},select:{tgUserId:true,text:true}}):null;
  const participant=m.tgUserId?await prisma.communityManagerParticipant.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:ctx.manager.id,tgUserId:m.tgUserId}}}):null;
  const targetPerson=repliedHuman?.tgUserId?await prisma.communityManagerParticipant.findUnique({where:{communityManagerId_tgUserId:{communityManagerId:ctx.manager.id,tgUserId:repliedHuman.tgUserId}},select:{displayName:true,username:true,tgUserId:true}}):null;
  const addressedToOtherHuman=Boolean(repliedHuman?.tgUserId&&repliedHuman.tgUserId!==m.tgUserId),socialAddress=isAddressedToCommunityManager(text,ctx.config,!addressedToOtherHuman),addressedToManager=Boolean(mention||repliedAction||socialAddress);
  const replyTarget=repliedAction?(ctx.config.identity.displayName||'КМ'):targetPerson?participantLabel(targetPerson):null;
  const blockedPath=(repliedAction&&!ctx.config.replies.replyToDirectReply)?'direct replies disabled':(mention&&!ctx.config.replies.replyToMention)?'mentions disabled':(!addressedToManager&&!ctx.config.replies.ambientConversation)?'ambient participation disabled':(addressedToOtherHuman&&!ctx.config.replies.thematicConversation)?'thematic participation disabled':null;
  if(blockedPath){await prisma.communityManagerMessage.update({where:{id:m.id},data:{status:'SKIPPED'}});await log(ctx,m,'SILENT','configured_reply_policy',1,blockedPath,start,undefined,[],{input:0,output:0},undefined,undefined,{threadId:location.threadId,segmentId:location.segmentId});await done(job.id,'SKIPPED');return}
  if(!addressedToManager&&ctx.config.replies.ambientCooldownMinutes>0){const recentAmbient=await prisma.communityManagerAction.findFirst({where:{communityManagerId:ctx.manager.id,decision:'RESPOND',createdAt:{gte:new Date(Date.now()-ctx.config.replies.ambientCooldownMinutes*60_000)},metadata:{path:['addressedToManager'],equals:false}},select:{id:true}});if(recentAmbient){await prisma.communityManagerMessage.update({where:{id:m.id},data:{status:'SKIPPED'}});await log(ctx,m,'SILENT','ambient_cooldown',1,'Ambient cooldown is active',start,undefined,[],{input:0,output:0},undefined,undefined,{threadId:location.threadId,segmentId:location.segmentId});await done(job.id,'SKIPPED');return}}
  const priorState=await prisma.communityManagerConversationState.findUnique({where:{communityManagerId:ctx.manager.id},select:{internalState:true}});
  const personal=evolvePersonalState(priorState?.internalState,ctx.config,{direct:addressedToManager,question:/[?？]\s*$/.test(text),conflict:/(?:дурак|идиот|тупой|заткнись|fuck|stupid)/iu.test(text)});
  await prisma.communityManagerConversationState.update({where:{communityManagerId:ctx.manager.id},data:{internalState:{personal} as any,lastAnalyzedAt:new Date(),messagesSinceAnalysis:0}});
  try{
    const result=await runCommunityManagerAgent({managerId:ctx.manager.id,communityId:ctx.community.id,channelId:ctx.community.channelId,channelName:contextName(ctx.community),chatId:m.tgChatId,config:ctx.config,sessionKey:conversationSessionKey(location.threadId,location.segmentId),threadId:location.threadId,segmentId:location.segmentId,event:{kind:'HUMAN_MESSAGE',dedupeKey:'human:'+ctx.manager.id+':'+m.id,sourceMessageId:m.id,currentText:text,currentTelegramMessageId:m.telegramMessageId,currentAuthorId:m.tgUserId??undefined,currentAuthor:participantLabel(participant),replyTarget:replyTarget??undefined,replyTargetMessageId:m.replyToMessageId??undefined,addressedToManager,addressedToOtherHuman}});
    const decision=result.decision,humanQuestion=/[?？]\s*$/.test(text),unansweredQuestion=decision.action==='no_action'&&humanQuestion,nextLocation=await applyConversationAnalysis(ctx.manager.id,m.id,location,{topicKey:decision.topicKey||'conversation',sameSegment:decision.sameConversation,expectsReply:unansweredQuestion,conversationComplete:unansweredQuestion?false:decision.conversationComplete,newContribution:text,speechAct:humanQuestion?'question':'other',possibleClaims:decision.memoryUpdates.map(item=>({kind:item.kind,value:item.value,confidence:item.confidence}))},m.createdAt);
    await appendHumanThesis(nextLocation,participantLabel(participant),text);
    if(ctx.config.replies.conversationMemory&&decision.episode)await recordEpisode({managerId:ctx.manager.id,participantId:participant?.id,location:nextLocation,kind:decision.episode.kind,summary:decision.episode.summary,outcome:decision.episode.outcome});
    if(ctx.config.replies.conversationMemory&&decision.memoryUpdates.length)await persistMemoryUpdates(ctx.manager.id,decision.memoryUpdates);
    const metadata={agentEventId:result.eventId,threadId:nextLocation.threadId,segmentId:nextLocation.segmentId,topicKey:decision.topicKey,action:decision.action,references:decision.references,addressedToManager,addressedToOtherHuman,replyTarget},usage={input:result.inputTokens,output:result.outputTokens};
    if(decision.action==='no_action'||decision.action==='poll'||(!decision.message&&decision.action!=='react')){await prisma.communityManagerMessage.update({where:{id:m.id},data:{status:'SKIPPED'}});await log(ctx,m,'SILENT',decision.intent,.9,decision.reason,start,undefined,result.sources,usage,undefined,undefined,metadata);await done(job.id,'SKIPPED');return}
    if(decision.action==='react'){
      const supported=new Set(['👍','🔥','❤','❤️','👏','🤔','👀','😁','🤯']),emoji=supported.has(decision.reaction??'')?decision.reaction!:'👍';
      if(ctx.manager.mode==='AUTOPILOT')await setBotMessageReaction(m.tgChatId,m.telegramMessageId,emoji,executor.token);
      await log(ctx,m,ctx.manager.mode==='AUTOPILOT'?'REACT':'DRAFT',decision.intent,.9,decision.reason,start,emoji,result.sources,usage,undefined,ctx.manager.mode==='AUTOPILOT'?m.telegramMessageId:undefined,{...metadata,reaction:emoji});
      await prisma.communityManagerMessage.update({where:{id:m.id},data:{status:'PROCESSED'}});await done(job.id,'COMPLETED');return;
    }
    const response=plainTelegram(decision.message??'').slice(0,1200);if(!response){await done(job.id,'SKIPPED','Empty agent message');return}
    if(ctx.manager.mode!=='AUTOPILOT'){await log(ctx,m,ctx.manager.mode==='DRAFTS'?'DRAFT':'SILENT',decision.intent,.9,decision.reason,start,response,result.sources,usage,undefined,undefined,metadata);await prisma.communityManagerMessage.update({where:{id:m.id},data:{status:'PROCESSED'}});await done(job.id,'COMPLETED');return}
    if((isQuietHour(ctx.config)&&!addressedToManager)||!await withinQuota(ctx,m,!addressedToManager)){await log(ctx,m,'SILENT','delivery_policy',1,'Configured delivery policy',start,undefined,result.sources,usage,undefined,undefined,metadata);await done(job.id,'SKIPPED');return}
    const stillEnabled=await prisma.communityManager.findFirst({where:{id:ctx.manager.id,enabled:true,publishedVersion:ctx.manager.publishedVersion},select:{id:true}});if(!stillEnabled||!await conversationStillCurrent(nextLocation)){await done(job.id,'CANCELLED','Conversation changed before send');return}
    const ownerUserId=contextOwnerId(ctx.community);if(!ownerUserId){await done(job.id,'FAILED','Community owner not found');return}const quota=await reserveSubscriptionQuota(ownerUserId,'communityManagerActions');if(!quota.ok){await done(job.id,'SKIPPED');return}
    let sent=false;
    try{
      const target=decision.targetMessageId??m.telegramMessageId,ref=await sendBotMessage(m.tgChatId,response,executor.token,undefined,undefined,target);sent=true;
      await log(ctx,m,'RESPOND',decision.intent,.9,decision.reason,start,response,result.sources,usage,undefined,ref?.messageId,{...metadata,targetMessageId:target});
      await prisma.$transaction([prisma.communityManager.update({where:{id:ctx.manager.id},data:{lastActionAt:new Date(),lastHealthyAt:new Date(),lastError:null}}),prisma.communityManagerMessage.update({where:{id:m.id},data:{status:'PROCESSED'}}),prisma.communityManagerThread.update({where:{id:nextLocation.threadId},data:{lastCmAt:new Date(),version:{increment:1}}})]);
      await appendCmThesis(nextLocation,response);await markMentionedExperts(ctx.manager.id,response);if(participant)await rememberCmExchange(ctx.manager.id,m.tgUserId,ctx.config.personality.relationshipStyle,{positive:decision.intent==='acknowledgement'||decision.intent==='feedback'});await done(job.id,'COMPLETED');
    }catch(error){const ownerUserId=contextOwnerId(ctx.community);if(!sent&&ownerUserId)await refundSubscriptionQuota(ownerUserId,'communityManagerActions');await log(ctx,m,'ERROR',decision.intent,.9,'Telegram send failed',start,response,result.sources,usage,error,undefined,metadata);const retry=canRetryJob(job.attempts);await done(job.id,retry?'RETRY_WAIT':'FAILED',error instanceof Error?error.message:'send failed',retry?new Date(Date.now()+retryDelayMs(job.attempts)):undefined)}
  }catch(error){await log(ctx,m,'ERROR','agent_runtime',0,'Unified agent failed',start,undefined,[],{input:0,output:0},error);const retry=canRetryJob(job.attempts);await done(job.id,retry?'RETRY_WAIT':'FAILED',error instanceof Error?error.message:'agent failed',retry?new Date(Date.now()+retryDelayMs(job.attempts)):undefined)}
}
let working=false;
export async function processCommunityManagerJobs(){
  if(working)return;working=true;
  try { await prisma.communityManagerJob.updateMany({where:{status:'CLAIMED',leaseUntil:{lt:new Date()}},data:{status:'RETRY_WAIT',runAfter:new Date(),leaseUntil:null}});
  for(let n=0;n<10;n++){const c=await prisma.communityManagerJob.findFirst({where:{status:{in:['PENDING','RETRY_WAIT']},runAfter:{lte:new Date()},OR:[{leaseUntil:null},{leaseUntil:{lt:new Date()}}]},orderBy:{runAfter:'asc'},include:{message:true}});if(!c)break;const claim=await prisma.communityManagerJob.updateMany({where:{id:c.id,status:c.status},data:{status:'CLAIMED',leaseUntil:new Date(Date.now()+10*60_000),attempts:{increment:1}}});if(claim.count)await processJob({...c,attempts:c.attempts+1})}}
  finally{working=false}
}

export async function runCommunityActivity(managerId:string,type:CommunityActivityType,topic?:string,meta:{automatic?:boolean;reason?:string;postId?:string;phase?:string}={}){return runActivity(managerId,type,topic,meta)}

let timer:NodeJS.Timeout|undefined;
export function startCommunityManagerWorker(){if(timer)return;timer=setInterval(()=>{void processCommunityManagerJobs().catch(error=>console.error('[community-manager] worker failed',error.message));void Promise.all([prisma.communityManagerMessage.deleteMany({where:{expiresAt:{lt:new Date()}}}),prisma.communityManagerDigestMessage.deleteMany({where:{expiresAt:{lt:new Date()}}})]).catch(error=>console.error('[community-manager] cleanup failed',error.message))},5000);timer.unref();void processCommunityManagerJobs().catch(error=>console.error('[community-manager] worker failed',error.message))}

export async function simulateCommunityManager(managerId:string,text:string,raw?:unknown){
  const manager=await prisma.communityManager.findUnique({where:{id:managerId},include:{community:{include:{chat:true,channel:true,moderatorChat:true}}}});if(!manager?.community.moderatorChat)throw new Error('CM not found');await hydrateLinkedChannel(manager.community);
  const config=raw?parseCommunityManagerConfig(raw):DEFAULT_CM_CONFIG,result=await runCommunityManagerAgent({managerId:manager.id,communityId:manager.community.id,channelId:manager.community.channelId,channelName:manager.community.chat?.title??manager.community.channel?.name??'сообщество',chatId:manager.community.moderatorChat.tgChatId,config,sessionKey:'simulation:'+Date.now(),event:{kind:'HUMAN_MESSAGE',dedupeKey:'simulation:'+manager.id+':'+Date.now()+':'+Math.random(),currentText:text,currentAuthor:'Тестовый участник',addressedToManager:true}});
  return{decision:result.decision,agentEventId:result.eventId};
}
export async function buildCommunityManagerPersonality(managerId:string,raw:unknown){
  const manager=await prisma.communityManager.findUnique({where:{id:managerId},select:{id:true}});if(!manager)throw new Error('CM not found');
  const config=parseCommunityManagerConfig(raw);
  const schema='{"psychology":{"openness":"cautious|flexible|experimental","discipline":"spontaneous|organized|meticulous","extraversion":"reserved|social|outgoing","conflict":"avoidant|assertive|argumentative","emotionalReactivity":"calm|expressive|hot","impulsivity":"deliberate|balanced|immediate","directness":"diplomatic|direct|blunt","dominance":"non_dominant|confident|leading"},"reactions":{"criticism":"accepts|examines|sensitive","uncertainty":"cautious|investigates|risks","rudeness":"ignore|firm|humor","mistakes":"admits|verifies|defensive","selfDisclosure":"private|gradual|open","authority":"hierarchy|merit|skeptical"},"relationshipStyle":{"bonding":"slow|normal|fast","trust":"guarded|balanced|trusting","repair":"remembers|gradual|quick","regulars":"distance|warmer|friends"},"core":{"goals":["..."],"strengths":["..."],"weaknesses":["..."],"boundaries":["..."],"triggers":["..."],"contradictions":["..."]}}';
  const system='Build a coherent behavioral personality profile for a human community manager. Return ONLY JSON matching this schema exactly: '+schema+'. Infer cautiously from the supplied biography, roles, traits, speech and owner instructions. Do not invent biographical facts. Use 1-4 concise Russian phrases in each core array. Include realistic weaknesses and one or two productive contradictions; do not create a perfect person. Hard safety boundaries are handled separately.';
  const out=await ai(system,JSON.stringify({identity:config.identity,current:config.personality}).slice(0,14000)),parsed=jsonObject(out.text);
  if(!parsed)throw new Error('Invalid personality profile');
  const personality=parseCommunityManagerConfig({...config,personality:parsed}).personality;
  return{personality};
}

export async function previewCommunityManagerPersonality(managerId:string,raw:unknown){
  const manager=await prisma.communityManager.findUnique({where:{id:managerId},include:{community:{include:{chat:true,channel:true}}}});if(!manager)throw new Error('CM not found');await hydrateLinkedChannel(manager.community);
  const config=parseCommunityManagerConfig(raw),system=personalityPrompt(config)+'\nReturn ONLY JSON with five short natural Russian Telegram replies: {"answer":"reply to a beginner asking what prediction markets are","disagreement":"disagree with a regular member without becoming generic","criticism":"respond when a participant criticizes your previous answer","familiar":"reply to a familiar regular after a successful earlier exchange","conflict":"follow a moderator after two people continued insulting each other"}. Show the selected personality, reaction policy and relationship style while keeping hard safety boundaries. No greetings, self-introduction, support filler, headings or source links.';
  const out=await ai(system,'Community: '+(manager.community.chat?.title??manager.community.channel?.name??'сообщество'));
  const j=jsonObject(out.text);if(!j)throw new Error('Invalid personality preview');
  return{examples:{answer:normalizeCommunityManagerPunctuation(String(j.answer||'')).slice(0,700),disagreement:normalizeCommunityManagerPunctuation(String(j.disagreement||'')).slice(0,700),criticism:normalizeCommunityManagerPunctuation(String(j.criticism||'')).slice(0,700),familiar:normalizeCommunityManagerPunctuation(String(j.familiar||'')).slice(0,700),conflict:normalizeCommunityManagerPunctuation(String(j.conflict||'')).slice(0,700)}};
}
