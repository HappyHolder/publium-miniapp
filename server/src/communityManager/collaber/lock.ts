import { prisma } from '../../db';
import { randomUUID } from 'crypto';

export class CollaberDeliveryBusy extends Error {
 constructor(public readonly owner?:string){super('Другая отправка CM ещё выполняется. Повторите позже.')}
}

/** Shared by sends, page edits and profile suppression so they cannot race each other. */
export async function withCollaberDeliveryLock<T>(managerId:string,run:()=>Promise<T>,owner?:string):Promise<T>{
 const dedupeKey='delivery-lock:'+managerId;
 const leaseId=randomUUID();
 await prisma.collaberTask.upsert({where:{dedupeKey},create:{communityManagerId:managerId,dedupeKey,kind:'LOCK',status:'IDLE',payload:{}},update:{}});
 const claim=await prisma.collaberTask.updateMany({where:{dedupeKey,OR:[{status:'IDLE'},{leaseUntil:{lt:new Date()}}]},data:{status:'LOCKED',payload:{leaseId,...(owner?{owner}:{})},leaseUntil:new Date(Date.now()+5*60000)}});
 if(!claim.count){const lock=await prisma.collaberTask.findUnique({where:{dedupeKey},select:{payload:true}});throw new CollaberDeliveryBusy((lock?.payload as {owner?:string}|null)?.owner)}
 try{return await run()}finally{await prisma.collaberTask.updateMany({where:{dedupeKey,status:'LOCKED',payload:{path:['leaseId'],equals:leaseId}},data:{status:'IDLE',payload:{},leaseUntil:null}})}
}
