import { prisma } from '../../db';
import { extractJsonObject, primaryTextModel, type TerraTextParams } from '../../lib/assistantModel';
import { openAiTextResult } from '../../lib/openaiChat';

/** Reuse the project transport and journal usage without storing archive prompts. */
export async function collaberJson(managerId:string,stage:string,params:TerraTextParams){
  const started=Date.now();
  const result=await openAiTextResult({...params,effort:'low',verbosity:'low'});
  const value=result?extractJsonObject(result.text):null;
  await prisma.communityManagerAction.create({data:{communityManagerId:managerId,decision:'SILENT',intent:'collaber_inference',reason:stage,model:primaryTextModel(),inputTokens:result?.usage.inputTokens??0,outputTokens:result?.usage.outputTokens??0,latencyMs:Date.now()-started,status:value?'COMPLETED':'FAILED',error:value?null:'Модель не вернула корректный JSON'}});
  return value;
}
