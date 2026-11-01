import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {protectionMemberExempt,type GroupProtectionRecord} from './protection-rules.js';
import type {ProtectionEnforcer} from './protection-enforcement.js';
const ROOT='protection:joins:',PREFIX='PROTECTION_JOIN_OBSERVED:';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validTime=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-5000;
function source(s:BotState,record:GroupProtectionRecord):string{return hash([record,s.chats.filter(c=>c.id===record.policy.chatId),s.grants,s.privateFeatures,s.privateSettingsRevision]);}
function observations(s:BotState,chat:string,witness:string,now:number,window:number):Set<string>{
 const members=new Set<string>();
 for(const a of s.audit){if(!a.updateKey.startsWith(ROOT+chat+':')||a.at>now||a.at<=now-window||!a.reason.startsWith(PREFIX))continue;
  try{const v:unknown=JSON.parse(a.reason.slice(PREFIX.length));if(!v||typeof v!=='object'||Array.isArray(v))continue;const r=v as Record<string,unknown>;if(Object.keys(r).sort().join(',')!=='members,source'||r.source!==witness||!Array.isArray(r.members)||r.members.length>100||!r.members.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/u.test(x)))continue;for(const m of r.members)members.add(m as string);}catch{/* malformed observations cannot prove a burst */}
 }
 return members;
}
export async function observeProtectionJoins(store:BotStore,policy:Policy,clock:()=>number,enforcer:ProtectionEnforcer|undefined,chat:string,members:string[],sentAt:number,updateKey:string):Promise<string>{
 if(!/^-[1-9][0-9]{0,15}$/u.test(chat)||!Number.isSafeInteger(Number(chat))||!/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(updateKey)||!Array.isArray(members)||members.length>100||new Set(members).size!==members.length||!members.every(m=>typeof m==='string'&&/^[1-9][0-9]{0,15}$/u.test(m)&&Number.isSafeInteger(Number(m)))||!validTime(sentAt))return 'INVALID';
 const prepared=await store.transaction(s=>{
  const now=clock(),rows=s.protectionPolicies?.filter(r=>r.policy.chatId===chat)??[],record=rows.length===1?rows[0]:undefined,config=record?.policy.joinRaid;
  if(!validTime(now)||!record||!config?.enabled||record.policy.mode==='OFF')return 'DISABLED';
  if(!policy.canUseChat(s,chat,'moderation')||record.chatPolicyVersion!==policy.chatRevision(s,chat)||record.updatedAt>now||sentAt<record.updatedAt||sentAt>now||sentAt<=now-config.windowMs)return 'STALE';
  const key=ROOT+chat+':'+updateKey;if(s.audit.some(a=>a.updateKey===key))return 'DUPLICATE';
  const allowed=(state:BotState)=>policy.has(state,record.updatedBy,'chat.manage',chat,clock())&&(!policy.isOwner(record.updatedBy)||policy.privateFeature(state,'owner.dashboard',record.updatedBy));
  if(record.policy.mode==='ENFORCE'&&(!allowed(s)||!enforcer?.supportsRaid?.()||!enforcer.executeRaid))return 'DENIED';
  const ids=members.filter(m=>!policy.isOwner(m)&&!policy.has(s,m,'chat.manage',chat,now)&&!protectionMemberExempt(record.policy,m,now));if(!ids.length)return 'EXEMPT';
  const witness=source(s,record),digests=ids.map(m=>hash([chat,record.policy.revision,m]));
  s.audit.push({updateKey:key,decision:'NOOP',reason:PREFIX+JSON.stringify({source:witness,members:digests}),policyVersion:record.chatPolicyVersion,at:sentAt});
  const count=observations(s,chat,witness,now,config.windowMs).size;
  if(count<config.minimumMembers)return 'OBSERVED';
  if(record.policy.mode!=='ENFORCE')return 'MONITORED';
  const claim='protection:join-raid:'+chat;if(s.audit.some(a=>a.updateKey===claim&&a.at>now-config.lockSeconds*1000))return 'COOLDOWN';
  s.audit.push({actorId:record.updatedBy,updateKey:claim,decision:'NOOP',reason:'PROTECTION_JOIN_RAID_CLAIM',policyVersion:record.chatPolicyVersion,at:now});return {record:structuredClone(record),witness,at:now};
 });
 if(typeof prepared==='string')return prepared;
 const current=(s:BotState)=>{const now=clock(),rows=s.protectionPolicies?.filter(r=>r.policy.chatId===chat)??[],r=rows[0],c=r?.policy.joinRaid;return validTime(now)&&now>=prepared.at&&now<prepared.at+5000&&rows.length===1&&!!r&&!!c&&r.policy.mode==='ENFORCE'&&c.enabled&&source(s,r)===prepared.witness&&policy.canUseChat(s,chat,'moderation')&&policy.chatRevision(s,chat)===r.chatPolicyVersion&&policy.has(s,r.updatedBy,'chat.manage',chat,now)&&(!policy.isOwner(r.updatedBy)||policy.privateFeature(s,'owner.dashboard',r.updatedBy))&&observations(s,chat,prepared.witness,now,c.windowMs).size>=c.minimumMembers;};
 let status:string;try{status=await enforcer!.executeRaid!(prepared.record.updatedBy,chat,prepared.record.policy.joinRaid!.lockSeconds,current);}catch{status='UNKNOWN_OUTCOME';}
 await store.transaction(s=>{s.audit.push({actorId:prepared.record.updatedBy,updateKey:ROOT+chat+':'+updateKey+':result',decision:status==='CONFIRMED'?'ALLOW':'NOOP',reason:'PROTECTION_JOIN_RAID_'+(['CONFIRMED','DENIED','FAILED_CONFIRMED','UNKNOWN_OUTCOME'].includes(status)?status:'REVIEW_REQUIRED'),policyVersion:prepared.record.chatPolicyVersion,at:clock()});});return 'ENFORCEMENT_'+status;
}
