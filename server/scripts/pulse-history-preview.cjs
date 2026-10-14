// Run on the database host after compiling pulseHistoryPreview.ts. Outputs aggregate JSON only.
// Usage: node pulse-history-preview.cjs /app/dist 'Collaboration' [isolated-preview-module]
const path = require('node:path');
const dist = path.resolve(process.argv[2] || path.join(__dirname,'../dist'));
const { prisma } = require(path.join(dist,'db.js'));
const scoring = require(path.join(dist,'lib/pulseScoring.js'));
const { previewPulseHistory } = require(process.argv[4] ? path.resolve(process.argv[4]) : path.join(dist,'lib/pulseHistoryPreview.js'));
(async()=>{
 const report=await prisma.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const communities=await tx.community.findMany({where:{moderatorChat:{title:{contains:process.argv[3]||'Collaboration',mode:'insensitive'}}},select:{id:true}});
  if(communities.length!==1)throw Error('Select exactly one community');
  const where={communityId:communities[0].id};
  const facts=await tx.communityDailyParticipant.findMany({where,select:{day:true,tgUserId:true,messages:true,replies:true,estimated:true}});
  const stats=await tx.communityDailyStat.findMany({where,select:{day:true,messages:true,activeUsers:true,memberCount:true,joins:true,leaves:true,newSpeakers:true,toxicityWeight:true}});
  const to=scoring.shiftPulseDay(scoring.pulseKey(Date.now()),-1);
  const common={facts,stats};
  return {capturedAt:new Date().toISOString(),firstFactDay:facts.map(f=>f.day).sort()[0]||null,
   windows:[7,30,90,365].map(n=>previewPulseHistory({...common,from:scoring.shiftPulseDay(to,1-n),to})),
   // Display an explicitly shortened historical interval, never silently rebrand it as a quarter/year.
   availableComparableWindow: facts.length ? previewPulseHistory({...common,from:scoring.shiftPulseDay(facts.map(f=>f.day).sort()[0],13),to}):null,
  };
 },{isolationLevel:'RepeatableRead',timeout:30000});
 console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>prisma.$disconnect());
