import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { prisma } from '../../db';
import { hash, parseArchive } from './domain';
import { collaberContext, createMatch, ingestIntro, profilePreference } from './service';
import { communityManagerExecutor } from '../managedBot';
import { entryPayload } from './telegram';
import { deliverMatch, emptyMatchText, matchPresentation } from './delivery';

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:2}}).single('file');
export function registerCollaberRoutes(parent:Router,owned:(req:Request,id:string)=>Promise<any>,fail:(res:Response,e:unknown)=>void){
  const router=Router({mergeParams:true});
  router.use((req:Request,res:Response,next:NextFunction)=>{void owned(req,req.params.id).then(c=>{res.locals.owner=c;next()}).catch(e=>fail(res,e))});
  const route=(fn:(req:Request,res:Response,id:string)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res,res.locals.owner.manager.id).catch(e=>{if(!res.headersSent)res.status(400).json({error:e instanceof Error?e.message:'Ошибка Collaber'})})};
  router.get('/',route(async(req,res,id)=>{
    const page=Math.max(0,Math.min(10000,Number(req.query.page)||0)),q=typeof req.query.q==='string'?req.query.q.trim().slice(0,100):'';
    const where={communityManagerId:id,...(q?{participant:{displayName:{contains:q,mode:'insensitive' as const}}}:{})};
    const [profiles,total,requests,drafts,imports]=await Promise.all([
      prisma.collaberProfile.findMany({where,include:{participant:{select:{displayName:true,username:true}}},orderBy:{updatedAt:'desc'},skip:page*25,take:25}),
      prisma.collaberProfile.count({where}),
      prisma.collaberRequest.findMany({where:{communityManagerId:id,status:{notIn:['DRAFT','PREVIEW']}},orderBy:{createdAt:'desc'},take:30}),
      prisma.collaberRequest.findMany({where:{communityManagerId:id,status:'DRAFT'},orderBy:{createdAt:'desc'},take:30}),
      prisma.collaberImport.findMany({where:{communityManagerId:id},select:{id:true,filename:true,status:true,total:true,skipped:true,processed:true,profiles:true,error:true,createdAt:true},orderBy:{createdAt:'desc'},take:10}),
    ]);
    const ctx=await collaberContext(id,true),executor=ctx?await communityManagerExecutor(ctx.manager.communityId).catch(()=>null):null;
    const [searchable,publicProfiles,sent,matched,useful,introduced]=await Promise.all([
      prisma.collaberProfile.count({where:{communityManagerId:id,searchable:true,forgotten:false,sourceAt:{not:null}}}),
      prisma.collaberProfile.count({where:{communityManagerId:id,searchable:true,forgotten:false,publicMentions:true}}),
      prisma.collaberRequest.count({where:{communityManagerId:id,status:'SENT'}}),
      prisma.collaberRequest.count({where:{communityManagerId:id,status:'SENT',NOT:{candidates:{equals:[]}}}}),
      prisma.collaberRequest.count({where:{communityManagerId:id,feedback:'USEFUL'}}),
      prisma.collaberInvite.count({where:{communityManagerId:id,status:'INTRODUCED'}}),
    ]);
    res.json({profiles,total,page,requests,drafts,imports,stats:{searchable,publicProfiles,sent,matched,useful,introduced},entryUrl:executor?.username?'https://t.me/'+executor.username+'?start='+entryPayload(id):null});
  }));
  router.post('/imports',(req,res,next)=>upload(req,res,e=>{if(e)res.status(400).json({error:'Не удалось загрузить JSON. Максимальный размер — 10 МБ.'});else next()}),route(async(req,res,id)=>{
    if(!req.file)throw new Error('Выберите JSON-файл истории');
    const ctx=await collaberContext(id,true);if(!ctx)throw new Error('Сначала создайте CM');
    let raw;try{raw=JSON.parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/,''))}catch{throw new Error('Файл не является корректным JSON')}
    const parsed=parseArchive(raw,ctx.chatId),checksum=hash(req.file.buffer.toString('utf8'));
    const active=await prisma.collaberImport.count({where:{communityManagerId:id,status:{in:['PREVIEW','PENDING','PROCESSING']}}});if(active>=3)throw new Error('Завершите или отмените предыдущие импорты');
    const existing=await prisma.collaberImport.findUnique({where:{communityManagerId_checksum:{communityManagerId:id,checksum}}});
    if(existing&&['CANCELLED','EXPIRED'].includes(existing.status))await prisma.collaberImport.updateMany({where:{id:existing.id,status:{in:['CANCELLED','EXPIRED']}},data:{status:'PREVIEW',messages:parsed.messages as any,total:parsed.messages.length,skipped:parsed.skipped,processed:0,profiles:0,attempts:0,error:null,createdAt:new Date()}});
    const row=await prisma.collaberImport.upsert({where:{communityManagerId_checksum:{communityManagerId:id,checksum}},create:{communityManagerId:id,checksum,filename:req.file.originalname.slice(0,160),messages:parsed.messages as any,total:parsed.messages.length,skipped:parsed.skipped},update:{}});
    res.json({id:row.id,status:row.status,total:row.total,skipped:row.skipped,sample:parsed.messages.slice(0,3).map(m=>({name:m.name,text:m.text.slice(0,300)}))});
  }));
  router.post('/imports/:importId/:action',route(async(req,res,id)=>{
    const row=await prisma.collaberImport.findFirst({where:{id:req.params.importId,communityManagerId:id}});if(!row)throw new Error('Импорт не найден');
    if(req.params.action==='cancel')await prisma.collaberImport.update({where:{id:row.id},data:{status:'CANCELLED',messages:[],leaseUntil:null}});
    else if(req.params.action==='start'&&['PREVIEW','FAILED'].includes(row.status))await prisma.collaberImport.update({where:{id:row.id},data:{status:'PENDING',attempts:0,error:null}});
    else throw new Error('Это действие недоступно для текущего состояния импорта');
    res.json({ok:true});
  }));
  router.patch('/profiles/:profileId',route(async(req,res,id)=>{
    const row=await prisma.collaberProfile.findFirst({where:{id:req.params.profileId,communityManagerId:id},include:{participant:true}});if(!row)throw new Error('Профиль не найден');
    if(req.body?.forget===true){await profilePreference(id,row.tgUserId,'forget');res.json({ok:true});return}
    if(typeof req.body?.sourceText==='string'){
      const text=req.body.sourceText.trim();if(text.length<25||text.length>12000)throw new Error('Интро должно содержать от 25 до 12 000 символов');
      const ctx=await collaberContext(id,true);if(!ctx)throw new Error('Настройки не найдены');
      if(!await ingestIntro(id,{id:'0',userId:row.tgUserId,name:row.participant.displayName,username:row.participant.username,text,at:new Date().toISOString()},ctx.config.features.collaber,true))throw new Error('Не удалось извлечь факты либо участник запретил сохранение профиля');
    }
    // Owner can hide profiles, but cannot override a participant's opt-out.
    if(req.body?.searchable===false)await profilePreference(id,row.tgUserId,'hide');
    if(typeof req.body?.publicMentions==='boolean')await prisma.collaberProfile.update({where:{id:row.id},data:{publicMentions:req.body.publicMentions&&!row.forgotten}});
    res.json({ok:true});
  }));
  router.post('/preview',route(async(req,res,id)=>{
    const query=typeof req.body?.query==='string'?req.body.query.trim().slice(0,500):'';if(query.length<4)throw new Error('Опишите задачу для подбора');
    const request=await createMatch({managerId:id,userId:res.locals.owner.tgUserId,chatId:res.locals.owner.tgUserId,query,dedupeKey:'preview:'+id+':'+Date.now(),preview:true});
    const ctx=await collaberContext(id,true);res.json({request,presentation:matchPresentation(request,ctx!.config.features.collaber,await emptyMatchText(id,res.locals.owner.tgUserId,false))});
  }));
  router.post('/requests/:requestId/:action',route(async(req,res,id)=>{
    const request=await prisma.collaberRequest.findFirst({where:{id:req.params.requestId,communityManagerId:id,status:'DRAFT'}});if(!request)throw new Error('Черновик не найден');
    if(req.params.action==='send')await deliverMatch(request.id,id,true);
    else if(req.params.action==='dismiss')await prisma.collaberRequest.update({where:{id:request.id},data:{status:'DECLINED'}});
    else throw new Error('Неизвестное действие');
    res.json({request:await prisma.collaberRequest.findUnique({where:{id:request.id}})});
  }));
  parent.use('/:id/collaber',router);
}
