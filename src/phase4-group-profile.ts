import {randomBytes} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {validCommunityConfig,validCommunityProfileTitle,
 type CommunityProfileStatus} from './phase4-community-model.js';

export type GroupProfileMutationResult='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
export interface Phase4GroupProfileGateway{
 canChangeInfo(chatId:string):Promise<boolean>;
 setTitle(chatId:string,title:string):Promise<GroupProfileMutationResult>;
 removePhoto(chatId:string):Promise<GroupProfileMutationResult>;
}
export type GroupProfileDispatchResult=CommunityProfileStatus|'NOT_FOUND'|'PAUSED';
const groupValid=(value:string)=>/^-[1-9]\d{0,15}$/u.test(value)&&Number.isSafeInteger(Number(value));
const idValid=(value:string)=>/^[a-f0-9]{24}$/u.test(value);

/** Bot API mutation is NOT inferred from a local approval. The gateway checks
 * the bot's current administrator status and can_change_info rights first.
 * New photo uploads are intentionally not supported here: setChatPhoto requires
 * multipart InputFile, not the existing Telegram file_id.
 */
export class TelegramBotApiGroupProfileGateway implements Phase4GroupProfileGateway{
 private readonly botUserId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))
   throw Error('PROFILE_TELEGRAM_TOKEN_INVALID');
  this.botUserId=Number(token.split(':',1)[0]);
  if(!Number.isSafeInteger(this.botUserId))throw Error('PROFILE_TELEGRAM_BOT_INVALID');
 }
 private async call(method:'getChatMember'|'setChatTitle'|'deleteChatPhoto',
  body:Record<string,string|number>):Promise<{status:number;ok:boolean;result:unknown}|null>{
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return null;}
  let data:unknown;
  try{
   const raw=await response.text();
   if(raw.length>8192)return null;
   data=JSON.parse(raw);
  }catch{return null;}
  if(!data||typeof data!=='object'||Array.isArray(data))return null;
  const result=data as Record<string,unknown>;
  if(typeof result.ok!=='boolean')return null;
  return {status:response.status,ok:response.ok&&result.ok===true,result:result.result};
 }
 async canChangeInfo(chatId:string):Promise<boolean>{
  if(!groupValid(chatId))return false;
  const data=await this.call('getChatMember',{chat_id:chatId,user_id:this.botUserId});
  if(!data?.ok||!data.result||typeof data.result!=='object'||Array.isArray(data.result))
   return false;
  const member=data.result as Record<string,unknown>;
  return member.status==='creator'||member.status==='administrator'&&
   member.can_change_info===true;
 }
 private classify(result:Awaited<ReturnType<TelegramBotApiGroupProfileGateway['call']>>):GroupProfileMutationResult{
  if(!result)return 'UNKNOWN_OUTCOME';
  if(result.ok&&result.result===true)return 'CONFIRMED';
  // 4xx is definite refusal. Network errors, malformed responses and 5xx are
  // ambiguous: Telegram may have applied the mutation before the failure.
  if(result.status>=400&&result.status<500)return 'FAILED_CONFIRMED';
  return 'UNKNOWN_OUTCOME';
 }
 async setTitle(chatId:string,title:string):Promise<GroupProfileMutationResult>{
  if(!groupValid(chatId)||!validCommunityProfileTitle(title))return 'FAILED_CONFIRMED';
  return this.classify(await this.call('setChatTitle',{chat_id:chatId,title}));
 }
 async removePhoto(chatId:string):Promise<GroupProfileMutationResult>{
  if(!groupValid(chatId))return 'FAILED_CONFIRMED';
  return this.classify(await this.call('deleteChatPhoto',{chat_id:chatId}));
 }
}

/** Claims each approved profile edit at most once across restarts, including
 * JSON and SQLite, with dispatch-time group/policy/Telegram permission fences.
 * A SENDING attempt never reverts to QUEUED on crash or unknown provider result.
 */
export class Phase4GroupProfileDispatcher{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:Phase4GroupProfileGateway,
  private readonly clock:()=>number=Date.now,
  private readonly safetyGate?:()=>Promise<boolean>){}
 private async safe():Promise<boolean>{
  if(!this.safetyGate)return false; // high-impact writes require explicit gate
  try{return await this.safetyGate()===true;}catch{return false;}
 }
 async dispatch(key:string):Promise<GroupProfileDispatchResult>{
  if(!idValid(key))throw Error('PROFILE_JOB_KEY_INVALID');
  const s=await this.store.snapshot();
  const rows=s.phase4Community?.profileJobs?.filter(x=>x.key===key)??[];
  if(rows.length!==1)return 'NOT_FOUND';
  const job=rows[0]!;
  if(job.status!=='QUEUED')return job.status==='SENDING'?'UNKNOWN_OUTCOME':job.status;
  const now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)return 'PAUSED';
  if(!await this.safe())return 'PAUSED';
  // Permission reads are advisory until the atomic claim verifies current
  // local policy. A revoked group or paused safety switch cannot authorize send.
  let rights=false;
  try{rights=await this.gateway.canChangeInfo(job.chatId);}catch{/* fail closed */}
  const claim=await this.store.transaction(async state=>{
   const found=state.phase4Community?.profileJobs?.filter(x=>x.key===key)??[];
   if(found.length!==1)throw Error('PROFILE_JOB_AMBIGUOUS');
   const current=found[0]!;
   if(current.status!=='QUEUED')return {status:current.status==='SENDING'?
     'UNKNOWN_OUTCOME' as const:current.status};
   if(!await this.safe())return {status:'PAUSED' as const};
   const t=this.clock(),group=state.chats.filter(x=>x.id===current.chatId);
   const configs=state.phase4Community?.configs.filter(x=>x.chatId===current.chatId)??[];
   const config=configs[0];
   const observed=state.phase4Community?.profileRevisions?.find(x=>
     x.chatId===current.chatId)?.revision??0;
   const permitted=Number.isSafeInteger(t)&&t>=current.createdAt&&
    t-current.createdAt<600000&&group.length===1&&group[0]!.approved&&
    group[0]!.present&&group[0]!.version===current.chatVersion&&
    configs.length===1&&config&&validCommunityConfig(config)&&
    config.profileEditingEnabled===true&&config.version===current.policyVersion&&
    observed===current.profileEpoch&&
    this.policy.canUseChat(state,current.chatId,'navigation');
   if(!permitted){
    current.status='SKIPPED';delete current.title;
    return {status:'SKIPPED' as const};
   }
   if(!rights){
    current.status='FAILED_CONFIRMED';delete current.title;
    return {status:'FAILED_CONFIRMED' as const};
   }
   const title=current.title;
   // Store redaction MUST commit BEFORE any network side effect.
   current.status='SENDING';current.attemptId=randomBytes(12).toString('hex');
   delete current.title;
   return {status:'SEND' as const,chatId:current.chatId,kind:current.kind,
    attemptId:current.attemptId,title};
  });
  if(claim.status!=='SEND')return claim.status;
  let outcome:GroupProfileMutationResult='UNKNOWN_OUTCOME';
  try{
   outcome=claim.kind==='TITLE_SET'?
    await this.gateway.setTitle(claim.chatId,claim.title!):
    await this.gateway.removePhoto(claim.chatId);
  }catch{/* crash/network ambiguity must never induce a duplicate attempt */}
  await this.store.transaction(state=>{
   const found=state.phase4Community?.profileJobs?.filter(x=>x.key===key)??[];
   if(found.length!==1||found[0]!.status!=='SENDING'||
     found[0]!.attemptId!==claim.attemptId)
    throw Error('PROFILE_ATTEMPT_FENCED');
   found[0]!.status=outcome;
  });
  return outcome;
 }
 async runDue(limit=4):Promise<GroupProfileDispatchResult[]>{
  if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('PROFILE_DISPATCH_LIMIT');
  const state=await this.store.snapshot(),now=this.clock();
  if(!Number.isSafeInteger(now)||now<0)return [];
  const jobs=(state.phase4Community?.profileJobs??[]).filter(x=>x.status==='QUEUED')
   .sort((a,b)=>a.createdAt-b.createdAt||a.key.localeCompare(b.key)).slice(0,limit);
  const results:GroupProfileDispatchResult[]=[];
  for(const job of jobs)results.push(await this.dispatch(job.key));
  return results;
 }
}
