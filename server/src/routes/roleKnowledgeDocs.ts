import { Router } from '../lib/asyncRouter';
import { type Request, type Response } from 'express';
import multer from 'multer';
import { prisma } from '../db';
import { verifyModeratorSession } from '../lib/moderatorSession';
import { classifyDoc, extractDocText } from '../lib/docExtractor';

const router=Router();
const TYPES=['COMMUNITY_MANAGER','MODERATOR','PERSONA'] as const;
type TargetType=(typeof TYPES)[number];
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024,files:1},fileFilter:(_req,file,cb)=>classifyDoc(file.mimetype,file.originalname)?cb(null,true):cb(new Error('Supported formats: PDF, DOCX, Markdown and TXT.'))});

async function owned(req:Request,type:unknown,targetId:unknown){
  if(!TYPES.includes(type as TargetType)||typeof targetId!=='string'||!targetId)return null;
  const session=verifyModeratorSession(req.headers.authorization);
  const user=await prisma.user.findUnique({where:{telegramId:session.tgUserId},select:{id:true}});if(!user)return null;
  let ownerId:string|undefined;
  if(type==='COMMUNITY_MANAGER'){const row=await prisma.communityManager.findUnique({where:{id:targetId},select:{community:{select:{chat:{select:{userId:true}},channel:{select:{userId:true}}}}}});ownerId=row?.community.chat?.userId??row?.community.channel?.userId}
  if(type==='MODERATOR'){const row=await prisma.moderator.findUnique({where:{id:targetId},select:{community:{select:{chat:{select:{userId:true}},channel:{select:{userId:true}}}}}});ownerId=row?.community.chat?.userId??row?.community.channel?.userId}
  if(type==='PERSONA')ownerId=(await prisma.persona.findUnique({where:{id:targetId},select:{ownerUserId:true}}))?.ownerUserId;
  return ownerId===user.id?{userId:user.id,type:type as TargetType,targetId}:null;
}
function denied(res:Response,e?:unknown){res.status(e instanceof Error&&e.message==='SESSION_EXPIRED'?401:403).json({error:'Access to these materials is denied.'})}

router.post('/list',async(req,res)=>{try{const a=await owned(req,req.body?.targetType,req.body?.targetId);if(!a)return denied(res);const docs=await prisma.roleKnowledgeDoc.findMany({where:{targetType:a.type,targetId:a.targetId},select:{id:true,name:true,mime:true,sizeBytes:true,createdAt:true},orderBy:{createdAt:'desc'}});res.json({docs})}catch(e){denied(res,e)}});

router.post('/upload',upload.single('file'),async(req,res)=>{try{
  const a=await owned(req,req.body?.targetType,req.body?.targetId);if(!a)return denied(res);if(!req.file){res.status(400).json({error:'Choose a file.'});return}
  const count=await prisma.roleKnowledgeDoc.count({where:{targetType:a.type,targetId:a.targetId}});if(count>=12){res.status(409).json({error:'Each role can have up to 12 files.'});return}
  const extracted=await extractDocText(req.file.buffer,req.file.mimetype,req.file.originalname);
  const doc=await prisma.roleKnowledgeDoc.create({data:{targetType:a.type,targetId:a.targetId,ownerUserId:a.userId,name:req.file.originalname.slice(0,200),mime:req.file.mimetype,sizeBytes:req.file.size,text:extracted.text},select:{id:true,name:true,mime:true,sizeBytes:true,createdAt:true}});
  res.json({doc:{...doc,truncated:extracted.truncated}});
}catch(e){if(e instanceof Error&&e.message==='SESSION_EXPIRED')return denied(res,e);res.status(422).json({error:e instanceof Error?e.message:'Could not read the file.'})}});

router.post('/delete',async(req,res)=>{try{const a=await owned(req,req.body?.targetType,req.body?.targetId);if(!a)return denied(res);const result=await prisma.roleKnowledgeDoc.deleteMany({where:{id:String(req.body?.docId??''),targetType:a.type,targetId:a.targetId,ownerUserId:a.userId}});if(!result.count){res.status(404).json({error:'File not found.'});return}res.json({ok:true})}catch(e){denied(res,e)}});

export default router;
