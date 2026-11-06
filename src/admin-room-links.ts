import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';

/** Local authorization evidence only. This module does not send messages,
 * expose room commands, or verify a Telegram room's privacy setting. */
export type AdminRoomMode='NOTIFICATIONS'|'CONTROL'|'CENTRAL';
export type AdminRoomSide='GROUP'|'ROOM';
type Request={id:string;group:string;room:string;mode:AdminRoomMode;groupVersion:number;roomVersion:number;createdAt:number;expiresAt:number;createdBy:string};
export type AdminRoomVisible={id:string;group:string;room:string;mode:AdminRoomMode;status:'PENDING_GROUP'|'PENDING_ROOM'|'ACTIVE'|'CONFLICT'|'EXPIRED'|'REVOKED';canApproveGroup:boolean;canApproveRoom:boolean;canRevoke:boolean;quiet?:boolean;quietWitness?:string;daily?:boolean;dailyWitness?:string};
export type AdminRoomSummary={group:string;reports:number;warnings:number;actions:number;failures:number;incidents:number;changes:number;since:number;until:number};
const ROOT='admin-room:request:',QUIET='admin-room:quiet:',DAILY='admin-room:daily:',TTL=10*60*1000;
const person=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const chat=(v:unknown):v is string=>typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const idValid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{24}$/u.test(v);
const timeValid=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-TTL;
const modeValid=(v:unknown):v is AdminRoomMode=>v==='NOTIFICATIONS'||v==='CONTROL'||v==='CENTRAL';
function allowed(s:BotState,p:Policy,actor:string,scope:string,now:number):boolean{
 return person(actor)&&p.canUseChat(s,scope,'moderation')&&p.has(s,actor,'chat.manage',scope,now)&&(!p.isOwner(actor)||p.privateFeature(s,'owner.dashboard',actor));
}
function authorityDigest(s:BotState,actor:string,scope:string):string{
 return createHash('sha256').update(JSON.stringify([actor,scope,s.chats.filter(c=>c.id===scope),s.grants.filter(g=>g.actor===actor&&g.capability==='chat.manage'&&g.chatId===scope),s.privateFeatures,s.privateSettingsRevision])).digest('hex');
}
function read(s:BotState,id:string):Request|null{
 const records=s.audit.filter(a=>a.updateKey===ROOT+id),a=records[0];
 if(records.length!==1||!a||a.decision!=='ALLOW'||!person(a.actorId)||!a.reason.startsWith('ADMIN_ROOM_REQUEST:'))return null;
 try{const v:unknown=JSON.parse(a.reason.slice('ADMIN_ROOM_REQUEST:'.length));if(!v||typeof v!=='object'||Array.isArray(v))return null;const x=v as Record<string,unknown>;
  if(Object.keys(x).sort().join(',')!=='createdAt,expiresAt,group,groupVersion,mode,room,roomVersion'||!chat(x.group)||!chat(x.room)||x.group===x.room||!modeValid(x.mode)||!Number.isSafeInteger(x.groupVersion)||Number(x.groupVersion)<1||!Number.isSafeInteger(x.roomVersion)||Number(x.roomVersion)<1||typeof x.createdAt!=='number'||!timeValid(x.createdAt)||x.expiresAt!==x.createdAt+TTL||a.at!==x.createdAt||a.policyVersion!==x.groupVersion)return null;
  return {id,group:x.group,room:x.room,mode:x.mode,groupVersion:Number(x.groupVersion),roomVersion:Number(x.roomVersion),createdAt:x.createdAt,expiresAt:Number(x.expiresAt),createdBy:a.actorId};
 }catch{return null;}
}
function approval(s:BotState,p:Policy,r:Request,side:AdminRoomSide,now:number):boolean{
 const rows=s.audit.filter(a=>a.updateKey===ROOT+r.id+':'+side),a=rows[0],scope=side==='GROUP'?r.group:r.room,version=side==='GROUP'?r.groupVersion:r.roomVersion;
 return rows.length===1&&!!a&&a.decision==='ALLOW'&&person(a.actorId)&&a.reason==='ADMIN_ROOM_APPROVED:'+side+':'+authorityDigest(s,a.actorId,scope)&&a.policyVersion===version&&Number.isSafeInteger(a.at)&&a.at>=r.createdAt&&a.at<r.expiresAt&&a.at<=now&&allowed(s,p,a.actorId,scope,now);
}
function current(s:BotState,p:Policy,r:Request,now:number):boolean{
 return now>=r.createdAt&&p.chatRevision(s,r.group)===r.groupVersion&&p.chatRevision(s,r.room)===r.roomVersion&&p.canUseChat(s,r.group,'moderation')&&p.canUseChat(s,r.room,'moderation');
}
function active(s:BotState,p:Policy,r:Request,now:number):boolean{
 return current(s,p,r,now)&&!s.audit.some(a=>a.updateKey===ROOT+r.id+':revoked')&&approval(s,p,r,'GROUP',now)&&approval(s,p,r,'ROOM',now);
}
/** Exact independent room mode, checked again by every remote action. */
export function adminRoomModeWitness(s:BotState,p:Policy,actor:string,group:string,room:string,mode:AdminRoomMode,now:number):string|null{
 if(!person(actor)||!chat(group)||!chat(room)||!timeValid(now)||!modeValid(mode)||!allowed(s,p,actor,group,now)||!allowed(s,p,actor,room,now))return null;
 const matches=s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).filter((r):r is Request=>!!r&&r.group===group&&r.mode===mode&&active(s,p,r,now));
 if(matches.length!==1||matches[0]!.room!==room)return null;const r=matches[0]!;
 return createHash('sha256').update(JSON.stringify([r,s.audit.filter(a=>a.updateKey===ROOT+r.id||a.updateKey.startsWith(ROOT+r.id+':')),authorityDigest(s,actor,group),authorityDigest(s,actor,room)])).digest('hex');
}
/** Binds both confirmation steps to the same request and current authorities. */
export function adminRoomRevokeWitness(s:BotState,p:Policy,actor:string,id:string,now:number):string|null{
 if(!person(actor)||!idValid(id)||!timeValid(now))return null;const r=read(s,id);
 if(!r||!current(s,p,r,now)||!allowed(s,p,actor,r.group,now)&&!(approval(s,p,r,'GROUP',now)&&allowed(s,p,actor,r.room,now))||s.audit.some(a=>a.updateKey===ROOT+id+':revoked'))return null;
 const evidence=s.audit.filter(a=>a.updateKey===ROOT+id||a.updateKey.startsWith(ROOT+id+':'));
 const actors=[...new Set([actor,...evidence.flatMap(a=>person(a.actorId)?[a.actorId]:[])])].sort();
 return createHash('sha256').update(JSON.stringify([r,evidence,actors.map(a=>[authorityDigest(s,a,r.group),authorityDigest(s,a,r.room)])])).digest('hex');
}
function quietState(s:BotState,r:Request,now:number):{quiet:boolean;witness:string;sequence:number}|null{
 const prefix=QUIET+r.id+':',rows=s.audit.filter(a=>a.updateKey.startsWith(prefix));if(rows.length>1000)return null;
 const ordered=rows.map(a=>({a,part:a.updateKey.slice(prefix.length)}));if(ordered.some(({a,part})=>!/^[1-9][0-9]{0,3}$/u.test(part)||Number(part)>1000||a.decision!=='ALLOW'||!person(a.actorId)||a.policyVersion!==r.groupVersion||!Number.isSafeInteger(a.at)||a.at<r.createdAt||a.at>now||!['ADMIN_ROOM_QUIET_ON','ADMIN_ROOM_QUIET_OFF'].includes(a.reason)))return null;
 ordered.sort((a,b)=>Number(a.part)-Number(b.part));if(ordered.some((v,i)=>Number(v.part)!==i+1||i>0&&v.a.at<ordered[i-1]!.a.at))return null;
 return {quiet:ordered.at(-1)?.a.reason==='ADMIN_ROOM_QUIET_ON',witness:ordered.length?createHash('sha256').update(JSON.stringify(ordered.map(x=>x.a))).digest('hex'):'0',sequence:ordered.length};
}
function dailyState(s:BotState,r:Request,now:number):{enabled:boolean;witness:string;sequence:number;since:number}|null{
 const prefix=DAILY+r.id+':',rows=s.audit.filter(a=>a.updateKey.startsWith(prefix));if(rows.length>1000)return null;const ordered=rows.map(a=>({a,part:a.updateKey.slice(prefix.length)}));
 if(ordered.some(({a,part})=>!/^[1-9][0-9]{0,3}$/u.test(part)||Number(part)>1000||a.decision!=='ALLOW'||!person(a.actorId)||a.policyVersion!==r.groupVersion||!Number.isSafeInteger(a.at)||a.at<r.createdAt||a.at>now||!['ADMIN_ROOM_DAILY_ON','ADMIN_ROOM_DAILY_OFF'].includes(a.reason)))return null;
 ordered.sort((a,b)=>Number(a.part)-Number(b.part));if(ordered.some((v,i)=>Number(v.part)!==i+1||i>0&&v.a.at<ordered[i-1]!.a.at))return null;const last=ordered.at(-1)?.a;
 return {enabled:last?.reason==='ADMIN_ROOM_DAILY_ON',witness:ordered.length?createHash('sha256').update(JSON.stringify(ordered.map(x=>x.a))).digest('hex'):'0',sequence:ordered.length,since:last?.at??0};
}
/** The unique current notifications grant only; other modes never imply it. */
export function adminRoomNotificationTarget(s:BotState,p:Policy,group:string,now:number,includeQuiet=false):{id:string;room:string;setting:string}|null{
 if(!chat(group)||!timeValid(now))return null;
 const matches=s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).filter((r):r is Request=>!!r&&r.group===group&&r.mode==='NOTIFICATIONS'&&active(s,p,r,now));
 if(matches.length!==1)return null;const r=matches[0]!,quiet=quietState(s,r,now);return quiet&&(includeQuiet||!quiet.quiet)?{id:r.id,room:r.room,setting:quiet.witness}:null;
}
function collectSummary(s:BotState,r:Request,since:number,until:number):AdminRoomSummary{
 const seen=new Map<string,number>();for(const a of s.audit)seen.set(a.updateKey,(seen.get(a.updateKey)??0)+1);
 let reports=0;for(const a of s.audit){if(!/^moderation:report:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)||seen.get(a.updateKey)!==1||a.decision!=='ALLOW'||!person(a.actorId)||a.policyVersion!==r.groupVersion||!Number.isSafeInteger(a.at)||a.at<since||a.at>until||!a.reason.startsWith('MODERATION_REPORT:'))continue;
  try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice('MODERATION_REPORT:'.length),'base64url').toString('utf8'));if(v&&typeof v==='object'&&!Array.isArray(v)){const x=v as Record<string,unknown>;if(Object.keys(x).sort().join(',')==='chat,member,message'&&x.chat===r.group&&person(x.member)&&Number.isSafeInteger(x.message)&&Number(x.message)>0)reports++;}}catch{/* ignore malformed records */}
 }
 const keys=new Map<string,number>();for(const w of s.warnings){if(w.chatId!==r.group||!person(w.memberId)||typeof w.reference!=='string')continue;const key=JSON.stringify([w.memberId,w.reference]);keys.set(key,(keys.get(key)??0)+1);}
 const warnings=s.warnings.filter(w=>w.chatId===r.group&&person(w.actorId)&&person(w.memberId)&&typeof w.reference==='string'&&w.reference.length>0&&w.reference.length<=128&&typeof w.active==='boolean'&&Number.isSafeInteger(w.at)&&w.at>=since&&w.at<=until&&keys.get(JSON.stringify([w.memberId,w.reference]))===1).length;
 let actions=0,failures=0,incidents=0,changes=0;
 for(const a of s.audit){if(seen.get(a.updateKey)!==1||a.policyVersion!==r.groupVersion||!Number.isSafeInteger(a.at)||a.at<since||a.at>until)continue;
  if(a.updateKey.startsWith('admin-room:event:')&&a.reason==='ADMIN_ROOM_EVENT:BOT_RIGHTS_UNAVAILABLE:'+r.group&&a.decision==='NOOP')failures++;
  if(a.updateKey.startsWith('moderation-outcome:')){const rows=s.moderationOperations.filter(o=>o.id===a.updateKey.slice('moderation-outcome:'.length)),op=rows[0];if(rows.length!==1||!op||op.chatId!==r.group||op.attemptGateway!=='TELEGRAM_API'||op.policyVersion!==r.groupVersion||a.reason!=='MODERATION_OUTCOME:'+op.status)continue;if(op.status==='CONFIRMED')actions++;if(op.status==='FAILED_CONFIRMED')failures++;if(op.status==='UNKNOWN_OUTCOME')incidents++;}
  if(a.updateKey.startsWith('group-permissions:')){const rows=(s.groupPermissionJobs??[]).filter(j=>j.id===a.updateKey.slice('group-permissions:'.length)),j=rows[0];if(rows.length!==1||!j||j.chatId!==r.group||j.gatewayOrigin!=='TELEGRAM_API'||j.scopeVersion!==r.groupVersion||a.reason!=='GROUP_PERMISSIONS_'+j.status)continue;if(j.status==='CONFIRMED')changes++;if(j.status==='FAILED_CONFIRMED')failures++;if(j.status==='UNKNOWN_OUTCOME')incidents++;}
 }
 return {group:r.group,reports,warnings,actions,failures,incidents,changes,since,until};
}
export type AdminRoomDailyTarget={id:string;group:string;room:string;version:number;setting:string;sequence:number;slot:number;summary:AdminRoomSummary};
/** Current daily window; a skipped day is never replayed. */
export function adminRoomDailyTargets(s:BotState,p:Policy,now:number):AdminRoomDailyTarget[]{
 if(!timeValid(now))return [];const out:AdminRoomDailyTarget[]=[];const requests=s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).filter((r):r is Request=>!!r&&r.mode==='NOTIFICATIONS'&&active(s,p,r,now));
 for(const r of requests){if(requests.filter(x=>x.group===r.group).length!==1)continue;const setting=dailyState(s,r,now);if(!setting||!setting.enabled||!quietState(s,r,now))continue;const slot=Math.floor((now-setting.since)/86400000);if(!Number.isSafeInteger(slot)||slot<1||slot>100000000)continue;const until=setting.since+slot*86400000;
  out.push({id:r.id,group:r.group,room:r.room,version:r.groupVersion,setting:setting.witness,sequence:setting.sequence,slot,summary:collectSummary(s,r,until-86400000,until-1)});
 }return out;
}
export class AdminRoomLinks{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now){}
 async propose(actor:string,group:string,room:string,mode:AdminRoomMode):Promise<string|null>{
  if(!person(actor)||!chat(group)||!chat(room)||group===room||!modeValid(mode))return null;
  return this.store.transaction(s=>{const now=this.clock();if(!timeValid(now)||!allowed(s,this.policy,actor,group,now)||!this.policy.canUseChat(s,room,'moderation'))return null;
   const pending=s.audit.filter(a=>a.updateKey.startsWith(ROOT)&&/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)&&a.at<=now&&a.at>now-TTL);if(pending.length>=100)return null;
   const id=randomBytes(18).toString('base64url'),payload={group,room,mode,groupVersion:this.policy.chatRevision(s,group),roomVersion:this.policy.chatRevision(s,room),createdAt:now,expiresAt:now+TTL};
   s.audit.push({updateKey:ROOT+id,actorId:actor,decision:'ALLOW',reason:'ADMIN_ROOM_REQUEST:'+JSON.stringify(payload),policyVersion:payload.groupVersion,at:now});return id;
  });
 }
 async approve(actor:string,id:string,side:AdminRoomSide):Promise<'PENDING'|'ACTIVE'|null>{
  if(!person(actor)||!idValid(id)||!['GROUP','ROOM'].includes(side))return null;
  return this.store.transaction(s=>{const now=this.clock(),r=read(s,id);if(!timeValid(now)||!r||now<r.createdAt||now>=r.expiresAt||!current(s,this.policy,r,now)||s.audit.some(a=>a.updateKey===ROOT+id+':revoked')||!allowed(s,this.policy,actor,side==='GROUP'?r.group:r.room,now)||s.audit.some(a=>a.updateKey===ROOT+id+':'+side))return null;
   if(side==='ROOM'&&!approval(s,this.policy,r,'GROUP',now))return null;
   // Never replace an existing room for this group and mode implicitly.
   const conflicts=s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).some(x=>x&&x.id!==id&&x.group===r.group&&x.mode===r.mode&&active(s,this.policy,x,now));if(conflicts)return null;
   const scope=side==='GROUP'?r.group:r.room;s.audit.push({updateKey:ROOT+id+':'+side,actorId:actor,decision:'ALLOW',reason:'ADMIN_ROOM_APPROVED:'+side+':'+authorityDigest(s,actor,scope),policyVersion:side==='GROUP'?r.groupVersion:r.roomVersion,at:now});
   return active(s,this.policy,r,now)?'ACTIVE':'PENDING';
  });
 }
 async visible(actor:string):Promise<AdminRoomVisible[]>{
  if(!person(actor))return [];const s=await this.store.snapshot(),now=this.clock();if(!timeValid(now))return [];
  const entries:AdminRoomVisible[]=[];for(const a of s.audit){if(!/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey))continue;const r=read(s,a.updateKey.slice(ROOT.length));if(!r||!current(s,this.policy,r,now))continue;
   const group=allowed(s,this.policy,actor,r.group,now),room=allowed(s,this.policy,actor,r.room,now),groupApproved=approval(s,this.policy,r,'GROUP',now),roomApproved=approval(s,this.policy,r,'ROOM',now),revoked=s.audit.some(x=>x.updateKey===ROOT+r.id+':revoked');
   if(!group&&(!room||!groupApproved||revoked))continue;
   const currentActive=active(s,this.policy,r,now),otherActive=s.audit.filter(x=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(x.updateKey)).map(x=>read(s,x.updateKey.slice(ROOT.length))).some(x=>x&&x.id!==r.id&&x.group===r.group&&x.mode===r.mode&&active(s,this.policy,x,now));
   const groupRecorded=s.audit.some(x=>x.updateKey===ROOT+r.id+':GROUP'),roomRecorded=s.audit.some(x=>x.updateKey===ROOT+r.id+':ROOM'),damaged=groupRecorded&&!groupApproved||roomRecorded&&!roomApproved;
   const status=revoked?'REVOKED':otherActive||damaged?'CONFLICT':currentActive?'ACTIVE':now>=r.expiresAt?'EXPIRED':groupApproved?'PENDING_ROOM':'PENDING_GROUP';
   const quiet=r.mode==='NOTIFICATIONS'&&status==='ACTIVE'?quietState(s,r,now):null,daily=r.mode==='NOTIFICATIONS'&&status==='ACTIVE'?dailyState(s,r,now):null;
   entries.push({id:r.id,group:r.group,room:r.room,mode:r.mode,status:status==='ACTIVE'&&r.mode==='NOTIFICATIONS'&&(!quiet||!daily)?'CONFLICT':status,canApproveGroup:group&&!groupRecorded&&!damaged&&!otherActive&&now<r.expiresAt&&!revoked,canApproveRoom:room&&groupApproved&&!roomRecorded&&!damaged&&!otherActive&&now<r.expiresAt&&!revoked,canRevoke:(group||room&&groupApproved)&&!revoked,...(quiet?{quiet:quiet.quiet,quietWitness:quiet.witness}:{}),...(daily?{daily:daily.enabled,dailyWitness:daily.witness}:{})});
  }return entries.sort((a,b)=>a.id.localeCompare(b.id));
 }
 async setQuiet(actor:string,id:string,expected:string,quiet:boolean):Promise<boolean>{
  if(!person(actor)||!idValid(id)||typeof expected!=='string'||!(/^(?:0|[a-f0-9]{64})$/u.test(expected))||typeof quiet!=='boolean')return false;
  return this.store.transaction(s=>{const now=this.clock(),r=read(s,id);if(!timeValid(now)||!r||r.mode!=='NOTIFICATIONS'||!active(s,this.policy,r,now)||!allowed(s,this.policy,actor,r.group,now)&&!allowed(s,this.policy,actor,r.room,now))return false;
   if(s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).filter(x=>x&&x.group===r.group&&x.mode==='NOTIFICATIONS'&&active(s,this.policy,x,now)).length!==1)return false;
   const state=quietState(s,r,now);if(!state||state.sequence>=1000||state.witness!==expected||state.quiet===quiet)return false;
   s.audit.push({updateKey:QUIET+id+':'+(state.sequence+1),actorId:actor,decision:'ALLOW',reason:quiet?'ADMIN_ROOM_QUIET_ON':'ADMIN_ROOM_QUIET_OFF',policyVersion:r.groupVersion,at:now});return true;});
 }
 async setDaily(actor:string,id:string,expected:string,enabled:boolean):Promise<boolean>{
  if(!person(actor)||!idValid(id)||typeof expected!=='string'||!/^(?:0|[a-f0-9]{64})$/u.test(expected)||typeof enabled!=='boolean')return false;
  return this.store.transaction(s=>{const now=this.clock(),r=read(s,id);if(!timeValid(now)||!r||r.mode!=='NOTIFICATIONS'||!active(s,this.policy,r,now)||!allowed(s,this.policy,actor,r.group,now)&&!allowed(s,this.policy,actor,r.room,now))return false;
   if(s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).filter(x=>x&&x.group===r.group&&x.mode==='NOTIFICATIONS'&&active(s,this.policy,x,now)).length!==1)return false;
   const state=dailyState(s,r,now);if(!state||state.sequence>=1000||state.witness!==expected||state.enabled===enabled||!quietState(s,r,now))return false;
   s.audit.push({updateKey:DAILY+id+':'+(state.sequence+1),actorId:actor,decision:'ALLOW',reason:enabled?'ADMIN_ROOM_DAILY_ON':'ADMIN_ROOM_DAILY_OFF',policyVersion:r.groupVersion,at:now});return true;});
 }
 /** Read-only aggregate of retained records; no names, message text or references. */
 async summary(actor:string,id:string):Promise<AdminRoomSummary|null>{
  if(!person(actor)||!idValid(id))return null;const s=await this.store.snapshot(),now=this.clock(),r=read(s,id);if(!timeValid(now)||!r||r.mode!=='NOTIFICATIONS'||!active(s,this.policy,r,now)||!allowed(s,this.policy,actor,r.group,now)&&!allowed(s,this.policy,actor,r.room,now))return null;
  const matching=s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).filter(x=>x&&x.group===r.group&&x.mode==='NOTIFICATIONS'&&active(s,this.policy,x,now));if(matching.length!==1)return null;
  return collectSummary(s,r,Math.max(0,now-86400000),now);
 }
 async isActive(group:string,room:string,mode:AdminRoomMode):Promise<boolean>{
  if(!chat(group)||!chat(room)||!modeValid(mode))return false;const s=await this.store.snapshot(),now=this.clock();if(!timeValid(now))return false;
  const matches=s.audit.filter(a=>/^admin-room:request:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)).map(a=>read(s,a.updateKey.slice(ROOT.length))).filter((r):r is Request=>!!r&&r.group===group&&r.mode===mode&&active(s,this.policy,r,now));return matches.length===1&&matches[0]!.room===room;
 }
 /** Immediate local revocation by either currently authorized side. */
 async revoke(actor:string,id:string,expected?:{witness:string;createdAt:number;expiresAt:number}):Promise<boolean>{
  if(!person(actor)||!idValid(id)||expected!==undefined&&(!/^[a-f0-9]{64}$/u.test(expected.witness)||!timeValid(expected.createdAt)||expected.expiresAt!==expected.createdAt+120000))return false;return this.store.transaction(s=>{const now=this.clock(),r=read(s,id),witness=adminRoomRevokeWitness(s,this.policy,actor,id,now);if(!r||!witness||expected!==undefined&&(witness!==expected.witness||now<expected.createdAt||now>=expected.expiresAt))return false;
   s.audit.push({updateKey:ROOT+id+':revoked',actorId:actor,decision:'ALLOW',reason:'ADMIN_ROOM_REVOKED',policyVersion:r.groupVersion,at:now});return true;});
 }
}
