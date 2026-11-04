import {randomBytes} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {validCommunityConfig,validCommunityProfileTitle,
 validCommunityPhotoId,
 type CommunityProfileStatus} from './phase4-community-model.js';

export type GroupProfileMutationResult='CONFIRMED'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME';
export interface Phase4GroupProfileGateway{
 canChangeInfo(chatId:string):Promise<boolean>;
 setTitle(chatId:string,title:string):Promise<GroupProfileMutationResult>;
 removePhoto(chatId:string):Promise<GroupProfileMutationResult>;
 /** Optional for compatibility with old simulated gateways. Live implements this. */
 setPhoto?(chatId:string,photoFileId:string):Promise<GroupProfileMutationResult>;
}
export type GroupProfileDispatchResult=CommunityProfileStatus|'NOT_FOUND'|'PAUSED';
const groupValid=(value:string)=>/^-[1-9]\d{0,15}$/u.test(value)&&Number.isSafeInteger(Number(value));
const idValid=(value:string)=>/^[a-f0-9]{24}$/u.test(value);

/** Bot API mutation is NOT inferred from a local approval. The gateway checks
 * the bot's current administrator status and can_change_info rights first.
 * For setChatPhoto a Telegram file_id is only a download reference: a verified
 * JPEG is fetched from Telegram servers, then uploaded as a fresh InputFile.
 */
export class TelegramBotApiGroupProfileGateway implements Phase4GroupProfileGateway{
 private readonly botUserId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(token))
   throw Error('PROFILE_TELEGRAM_TOKEN_INVALID');
  this.botUserId=Number(token.split(':',1)[0]);
  if(!Number.isSafeInteger(this.botUserId))throw Error('PROFILE_TELEGRAM_BOT_INVALID');
 }
 private async call(method:'getChatMember'|'setChatTitle'|'deleteChatPhoto'|'getFile',
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
  const user=member.user;
  if(!user||typeof user!=='object'||Array.isArray(user)||
    (user as Record<string,unknown>).id!==this.botUserId||
    (user as Record<string,unknown>).is_bot!==true)return false;
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
 /** Get a strictly bounded JPEG from the official Telegram file API.
  * No user-provided URLs, file paths, IP hosts, redirects or raw disk writes.
  * The entire photo is memory-bounded even if content-length is missing.
  */
 private async downloadTelegramPhoto(fileId:string):Promise<Uint8Array|null>{
  if(!validCommunityPhotoId(fileId))return null;
  const data=await this.call('getFile',{file_id:fileId});
  if(!data?.ok||!data.result||typeof data.result!=='object'||Array.isArray(data.result))return null;
  const metadata=data.result as Record<string,unknown>;
  if(metadata.file_id!==undefined&&metadata.file_id!==fileId)return null;
  const path=metadata.file_path;
  if(typeof path!=='string'||!/^photos\/(?:[A-Za-z0-9_-]{1,64}\/){0,2}[A-Za-z0-9_-]{1,100}\.jpe?g$/u.test(path))return null;
  const MAX=10*1024*1024;
  if(metadata.file_size!==undefined&&(!Number.isSafeInteger(metadata.file_size)||
    (metadata.file_size as number)<6||(metadata.file_size as number)>MAX))return null;
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/file/bot'+this.token+'/'+path,{
    method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)
   });
  }catch{return null;}
  if(!response.ok||!response.body)return null;
  const mime=response.headers.get('content-type');
  if(mime!==null&&!['image/jpeg','application/octet-stream'].includes(mime.split(';',1)[0]!.trim()))return null;
  const reported=response.headers.get('content-length');
  if(reported!==null&&(!/^\d{1,9}$/u.test(reported)||Number(reported)>MAX))return null;
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0,oversized=false;
  try{
   while(true){
    const part=await reader.read();
    if(part.done)break;
    if(!(part.value instanceof Uint8Array)||size+part.value.byteLength>MAX){oversized=true;break;}
    size+=part.value.byteLength;
    chunks.push(part.value);
   }
   if(oversized){await reader.cancel();return null;}
  }catch{return null;
  }finally{reader.releaseLock();}
  if(size<6||(metadata.file_size!==undefined&&size!==metadata.file_size))return null;
  const photo=Buffer.concat(chunks,size);
  if(photo[0]!==0xff||photo[1]!==0xd8||photo[2]!==0xff||
    photo[size-2]!==0xff||photo[size-1]!==0xd9)return null;
  return Uint8Array.from(photo);
 }
 async setPhoto(chatId:string,photoFileId:string):Promise<GroupProfileMutationResult>{
  if(!groupValid(chatId)||!validCommunityPhotoId(photoFileId))return 'FAILED_CONFIRMED';
  const photo=await this.downloadTelegramPhoto(photoFileId);
  if(photo===null)return 'FAILED_CONFIRMED'; // No mutation attempted yet.
  const form=new FormData();
  form.set('chat_id',chatId);
  form.set('photo',new Blob([photo],{type:'image/jpeg'}),'manaratak-chat-photo.jpg');
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+'/setChatPhoto',{
    method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(15000)
   });
  }catch{return 'UNKNOWN_OUTCOME';} // Upload might have reached Telegram.
  let result:unknown;
  try{
   const raw=await response.text();
   if(raw.length>8192)return 'UNKNOWN_OUTCOME';
   result=JSON.parse(raw);
  }catch{return 'UNKNOWN_OUTCOME';}
  if(!result||typeof result!=='object'||Array.isArray(result)||
    typeof (result as Record<string,unknown>).ok!=='boolean')return 'UNKNOWN_OUTCOME';
  return this.classify({status:response.status,
   ok:response.ok&&(result as Record<string,unknown>).ok===true,
   result:(result as Record<string,unknown>).result});
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
    current.status='SKIPPED';delete current.title;delete current.photoFileId;
    return {status:'SKIPPED' as const};
   }
   if(!rights){
    current.status='FAILED_CONFIRMED';delete current.title;delete current.photoFileId;
    return {status:'FAILED_CONFIRMED' as const};
   }
   if(current.kind==='PHOTO_SET'&&typeof this.gateway.setPhoto!=='function'){
    current.status='FAILED_CONFIRMED';delete current.photoFileId;
    return {status:'FAILED_CONFIRMED' as const};
   }
   const title=current.title,photoFileId=current.photoFileId;
   // Store redaction MUST commit BEFORE any network side effect.
   current.status='SENDING';current.attemptId=randomBytes(12).toString('hex');
   delete current.title;delete current.photoFileId;
   return {status:'SEND' as const,chatId:current.chatId,kind:current.kind,
    attemptId:current.attemptId,title,photoFileId};
  });
  if(claim.status!=='SEND')return claim.status;
  let outcome:GroupProfileMutationResult='UNKNOWN_OUTCOME';
  try{
   outcome=claim.kind==='TITLE_SET'?
    await this.gateway.setTitle(claim.chatId,claim.title!):
    claim.kind==='PHOTO_SET'?await this.gateway.setPhoto!(claim.chatId,claim.photoFileId!):
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
