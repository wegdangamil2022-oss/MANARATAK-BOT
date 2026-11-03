import {createHash,randomBytes,randomInt} from 'node:crypto';
import type {BotState,BotStore,Wizard} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import type {MembershipPort} from './education-interactions.js';
const ROOT='captcha:policy:',MEMBER='captcha-member:';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const user=(v:string)=>/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const group=(v:string)=>/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const time=(v:number)=>Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000-1000000;
export type CaptchaSettings={enabled:boolean;timeout:60|120|300;attempts:1|3|5};
type Settings=CaptchaSettings&{revision:number};
const validSettings=(v:unknown):v is CaptchaSettings=>{if(!v||typeof v!=='object'||Array.isArray(v))return false;const a=v as CaptchaSettings;return Object.keys(a).sort().join(',')==='attempts,enabled,timeout'&&typeof a.enabled==='boolean'&&[60,120,300].includes(a.timeout)&&[1,3,5].includes(a.attempts);};
export const captchaSource=(s:BotState)=>hash([s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision??null,s.audit.filter(a=>a.updateKey.startsWith(ROOT))]);
type Session={nonce:string;group:string;revision:number;issued:number;deadline:number;retryAt:number;round:number;tries:number;lastAttempt:number;phase:'WAITING'|'FAILED'|'PASSED';problem:[number,number,number]};
const key=(chat:string,actor:string)=>MEMBER+chat+':'+actor;
export const validCaptchaRoute=(data:string)=>/^cp:1:l:(0|[1-9][0-9]{0,2})$/u.exec(data)?.[0]===data||/^cp:1:[bro]:[A-Za-z0-9_-]{24}$/u.exec(data)?.[0]===data||/^cp:1:a:[A-Za-z0-9_-]{24}:[012]$/u.exec(data)?.[0]===data;
/** Durable challenge only. This module never changes Telegram restrictions.
 * Enforcement must be explicitly composed with independent reason receipts. */
export class CaptchaService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly membership:MembershipPort,private readonly clock:()=>number=Date.now){}
 settings(s:BotState,chat:string):Settings|null{
  const defaults:Settings={enabled:false,timeout:120,attempts:3,revision:0},rows=s.audit.filter(a=>a.updateKey===ROOT+chat),a=rows[0],now=this.clock();if(!rows.length)return defaults;
  if(rows.length!==1||!a||a.actorId!==this.policy.ownerId||a.decision!=='ALLOW'||!time(a.at)||a.at>now)return null;
  let v:unknown;try{v=JSON.parse(a.reason);}catch{return null;}
  if(!v||typeof v!=='object'||Array.isArray(v))return null;const r=v as Settings,{revision,...settings}=r;if(!validSettings(settings)||!Number.isSafeInteger(revision)||revision<1)return null;
  return a.policyVersion===this.policy.chatRevision(s,chat)?r:{...defaults,revision};
 }
 async configure(actor:string,chat:string,settings:CaptchaSettings,expected:string,confirmationRef?:string):Promise<boolean>{
  if(!validSettings(settings)||!group(chat))return false;
  return this.store.transaction(s=>{const now=this.clock(),old=this.settings(s,chat),confirmations=confirmationRef===undefined?[]:s.callbacks.filter(c=>c.ref===confirmationRef),confirmation=confirmations[0];if(confirmationRef!==undefined&&(confirmations.length!==1||!confirmation||confirmation.actorId!==actor||confirmation.chatId!=='private'||confirmation.policyVersion!==0||!confirmation.used||confirmation.revoked||!confirmation.oneShot||now>=confirmation.expiresAt||confirmation.expiresAt>now+120000))return false;if(!time(now)||!old||old.revision>=Number.MAX_SAFE_INTEGER||!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor)||!this.policy.canUseChat(s,chat,'moderation')||s.chats.filter(c=>c.id===chat).length!==1||captchaSource(s)!==expected)return false;
   const record={actorId:actor,updateKey:ROOT+chat,decision:'ALLOW' as const,reason:JSON.stringify({...settings,revision:old.revision+1}),policyVersion:this.policy.chatRevision(s,chat),at:now},existing=s.audit.find(a=>a.updateKey===record.updateKey);if(existing)Object.assign(existing,record);else s.audit.push(record);s.audit.push({actorId:actor,updateKey:'captcha:policy-change:'+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:'CAPTCHA_CHALLENGE_SETTINGS:'+hash(record),policyVersion:record.policyVersion,at:now});return true;});
 }
 #read(s:BotState,w:Wizard,actor:string,allowStale=false):Session|null{
  if(!user(actor)||w.userId!==actor||w.chatId!==actor||w.topicId!==''||w.step!==0||w.version!==1||typeof w.flow!=='string'||!w.flow.startsWith(MEMBER))return null;
  try{const d=JSON.parse(w.flow.slice(MEMBER.length)) as Session;if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).sort().join(',')!=='deadline,group,issued,lastAttempt,nonce,phase,problem,retryAt,revision,round,tries'||typeof d.nonce!=='string'||/^[A-Za-z0-9_-]{24}$/u.exec(d.nonce)?.[0]!==d.nonce||!group(d.group)||w.key!==key(d.group,actor)||s.wizards.filter(x=>x.key===w.key).length!==1||!time(d.issued)||!time(this.clock())||this.clock()<d.issued||!Number.isSafeInteger(d.deadline)||!Number.isSafeInteger(d.retryAt)||!Number.isSafeInteger(d.round)||d.round<1||d.round>3||!Number.isSafeInteger(d.tries)||d.tries<0||!Number.isSafeInteger(d.lastAttempt)||d.lastAttempt< -1||d.lastAttempt>this.clock()||d.lastAttempt>=0&&d.lastAttempt<d.issued||!['WAITING','FAILED','PASSED'].includes(d.phase)||!Array.isArray(d.problem)||d.problem.length!==3||!d.problem.every(n=>Number.isSafeInteger(n))||d.problem[0]<1||d.problem[0]>9||d.problem[1]<1||d.problem[1]>9||d.problem[2]<0||d.problem[2]>2)return null;
   const settings=this.settings(s,d.group);if(!settings?.enabled||!Number.isSafeInteger(d.revision)||d.revision<1||d.revision>settings.revision||!allowStale&&settings.revision!==d.revision||!this.policy.canUseChat(s,d.group,'moderation')||!Number.isSafeInteger(w.policyVersion)||w.policyVersion<1||w.policyVersion>this.policy.chatRevision(s,d.group)||!allowStale&&w.policyVersion!==this.policy.chatRevision(s,d.group)||w.expiresAt!==d.deadline||![60000,120000,300000].includes(d.deadline-d.issued)||!allowStale&&d.deadline!==d.issued+settings.timeout*1000||d.tries>5||!allowStale&&d.tries>settings.attempts||d.retryAt!==d.deadline+d.round*60000||d.tries===0&&d.lastAttempt!==-1||d.tries>0&&d.lastAttempt<d.issued||d.phase==='PASSED'&&(d.tries<1||w.status!=='CANCELLED')||d.phase!=='PASSED'&&w.status!=='ACTIVE'||this.policy.has(s,actor,'chat.manage',d.group,this.clock()))return null;return d;
  }catch{return null;}
 }
 #fresh(chat:string,settings:Settings,round:number):Session{const now=this.clock();return {nonce:randomBytes(18).toString('base64url'),group:chat,revision:settings.revision,issued:now,deadline:now+settings.timeout*1000,retryAt:now+settings.timeout*1000+round*60000,round,tries:0,lastAttempt:-1,phase:'WAITING',problem:[randomInt(1,10),randomInt(1,10),randomInt(0,3)]};}
 /** Retire completed challenge payloads only; audit and moderation evidence remain intact. */
 #cleanup(s:BotState):number{
  const now=this.clock();if(!time(now))return 0;
  const removable=new Set<Wizard>();
  for(const w of s.wizards){
   if(removable.size>=100)break;
   if(w.status!=='CANCELLED'||typeof w.flow!=='string'||!w.flow.startsWith(MEMBER))continue;
   const d=this.#read(s,w,w.userId,true);
   if(!d||d.phase!=='PASSED'||now<d.issued+86400000)continue;
   const receipts=s.audit.filter(a=>a.updateKey==='captcha:passed:'+d.nonce),receipt=receipts[0];
   if(receipts.length!==1||!receipt||receipt.actorId!==w.userId||receipt.decision!=='ALLOW'||receipt.policyVersion!==w.policyVersion||receipt.at!==d.lastAttempt||receipt.at>=d.deadline||receipt.reason!=='CAPTCHA_CHALLENGE_PASSED:'+hash([d.group,w.userId,d.revision]))continue;
   // A future enforcement path must own its evidence lifecycle separately.
   if(s.moderationReasons.some(r=>r.chatId===d.group&&r.memberId===w.userId)||s.moderationOperations.some(o=>o.chatId===d.group&&o.memberId===w.userId))continue;
   removable.add(w);
  }
  s.wizards=s.wizards.filter(w=>!removable.has(w));return removable.size;
 }
 reviewCases(s:BotState,actor:string):{nonce:string;group:string;actor:string;deadline:number;tries:number;round:number;phase:'FAILED'|'EXPIRED'}[]{
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor))return [];
  return s.wizards.flatMap(w=>{const d=this.#read(s,w,w.userId);return d&&!s.audit.some(a=>a.updateKey==='captcha:review:'+d.nonce)&&d.round===3&&d.phase!=='PASSED'&&(d.phase==='FAILED'||this.clock()>=d.deadline)?[{nonce:d.nonce,group:d.group,actor:w.userId,deadline:d.deadline,tries:d.tries,round:d.round,phase:(d.phase==='FAILED'?'FAILED':'EXPIRED') as 'FAILED'|'EXPIRED'}]:[];}).sort((a,b)=>a.deadline-b.deadline||a.nonce.localeCompare(b.nonce));
 }
 /** Local CAPTCHA evidence only; callers must separately verify membership and other gates. */
 status(s:BotState,chat:string,actor:string):'NOT_REQUIRED'|'PENDING'|'PASSED'|'REJECTED'|'UNAVAILABLE'{
  if(!group(chat)||!user(actor)||!this.policy.canUseChat(s,chat,'moderation'))return 'UNAVAILABLE';
  const settings=this.settings(s,chat);if(!settings)return 'UNAVAILABLE';if(!settings.enabled||this.policy.has(s,actor,'chat.manage',chat,this.clock()))return 'NOT_REQUIRED';
  const rows=s.wizards.filter(w=>w.key===key(chat,actor)),w=rows[0];
  if(rows.length===0){
   const reason='CAPTCHA_CHALLENGE_PASSED:'+hash([chat,actor,settings.revision]),proofs=s.audit.filter(a=>a.actorId===actor&&a.reason===reason&&a.policyVersion===this.policy.chatRevision(s,chat));
   return proofs.length>0&&proofs.every(a=>a.decision==='ALLOW'&&/^captcha:passed:[A-Za-z0-9_-]{24}$/u.exec(a.updateKey)?.[0]===a.updateKey&&time(a.at)&&a.at<=this.clock()&&s.audit.filter(other=>other.updateKey===a.updateKey).length===1)?'PASSED':'UNAVAILABLE';
  }
  if(rows.length!==1||!w)return 'UNAVAILABLE';const d=this.#read(s,w,actor);if(!d)return 'UNAVAILABLE';
  const human=this.#humanDecision(s,w,d);if(human)return human==='APPROVED'?'PASSED':'REJECTED';if(s.audit.some(a=>a.updateKey==='captcha:review:'+d.nonce))return 'UNAVAILABLE';
  if(d.phase!=='PASSED')return 'PENDING';
  const receipts=s.audit.filter(a=>a.updateKey==='captcha:passed:'+d.nonce),a=receipts[0];return receipts.length===1&&a?.actorId===actor&&a.decision==='ALLOW'&&a.policyVersion===w.policyVersion&&a.at===d.lastAttempt&&a.at<d.deadline&&a.reason==='CAPTCHA_CHALLENGE_PASSED:'+hash([d.group,actor,d.revision])?'PASSED':'UNAVAILABLE';
 }
 /** Stable per group/member/settings approval, including challenge retries. */
 challenge(s:BotState,chat:string,actor:string):{reference:string;epoch:string;issued:number;nonce:string}|null{
  const rows=s.wizards.filter(w=>w.key===key(chat,actor)),w=rows[0];if(rows.length!==1||!w)return null;const d=this.#read(s,w,actor);return d?{reference:'captcha_'+hash([chat,actor,d.revision,w.policyVersion]).slice(0,24),epoch:hash(w),issued:d.issued,nonce:d.nonce}:null;
 }
 /** Human review concerns the CAPTCHA step only, never a Telegram release. */
 caseEvidence(s:BotState,actor:string,nonce:string):string|null{
  const cases=this.reviewCases(s,actor).filter(c=>c.nonce===nonce),c=cases[0];if(cases.length!==1||!c)return null;
  const w=s.wizards.find(w=>w.key===key(c.group,c.actor));return w?hash([captchaSource(s),w,s.moderationReasons.filter(r=>r.chatId===c.group&&r.memberId===c.actor),s.moderationOperations.filter(o=>o.chatId===c.group&&o.memberId===c.actor)]):null;
 }
 #humanDecision(s:BotState,w:Wizard,d:Session):'APPROVED'|'REJECTED'|null{
  const rows=s.audit.filter(a=>a.updateKey==='captcha:review:'+d.nonce),a=rows[0];
  if(rows.length!==1||!a||a.actorId!==this.policy.ownerId||a.decision!=='ALLOW'||a.policyVersion!==w.policyVersion||!time(a.at)||a.at<d.issued||a.at>this.clock())return null;
  try{const v=JSON.parse(a.reason) as {decision:string;session:string};return Object.keys(v).sort().join(',')==='decision,session'&&v.session===hash(w)&&(v.decision==='APPROVED'||v.decision==='REJECTED')?v.decision:null;}catch{return null;}
 }
 async reviewCase(actor:string,nonce:string,decision:'APPROVED'|'REJECTED',expected:string,confirmationRef:string):Promise<boolean>{
  if(!['APPROVED','REJECTED'].includes(decision)||/^captcha-owner:[A-Za-z0-9_-]{24}$/u.exec(confirmationRef)?.[0]!==confirmationRef||/^[a-f0-9]{64}$/u.exec(expected)?.[0]!==expected)return false;
  return this.store.transaction(s=>{const now=this.clock(),rows=s.callbacks.filter(c=>c.ref===confirmationRef),c=rows[0];
   if(!time(now)||rows.length!==1||!c||c.actorId!==actor||c.chatId!=='private'||c.policyVersion!==0||!c.used||c.revoked||!c.oneShot||!Number.isSafeInteger(c.expiresAt)||now>=c.expiresAt||c.expiresAt>now+120000||this.caseEvidence(s,actor,nonce)!==expected)return false;
   try{const a=JSON.parse(c.action);if(!Array.isArray(a)||a.length!==3||a[2]!==expected||a[1]!==captchaSource(s)||a[0]?.group!==nonce||a[0]?.kind!==(decision==='APPROVED'?'accept-confirm':'reject-confirm'))return false;}catch{return false;}
   const target=this.reviewCases(s,actor).find(c=>c.nonce===nonce);if(!target)return false;const w=s.wizards.find(w=>w.key===key(target.group,target.actor));if(!w||s.audit.some(a=>a.updateKey==='captcha:review:'+nonce))return false;
   s.audit.push({actorId:actor,updateKey:'captcha:review:'+nonce,decision:'ALLOW',reason:JSON.stringify({decision,session:hash(w)}),policyVersion:w.policyVersion,at:now});return true;
  });
 }
 async cleanup():Promise<number>{return this.store.transaction(s=>this.#cleanup(s));}
 async observe(chat:string,members:string[],updateKey:string,sentAt:number):Promise<number>{
  if(!group(chat)||!Array.isArray(members)||members.length>100||new Set(members).size!==members.length||!members.every(user)||!/^b3-webhook:[A-Za-z0-9_-]{1,80}:[0-9]{1,16}$/u.test(updateKey)||!time(sentAt))return 0;
  return this.store.transaction(s=>{const now=this.clock(),settings=this.settings(s,chat);if(!time(now)||now<sentAt||now-sentAt>30000||!settings?.enabled||!this.policy.canUseChat(s,chat,'moderation'))return 0;this.#cleanup(s);let issued=0;
   for(const actor of members){if(this.policy.has(s,actor,'chat.manage',chat,now)||this.status(s,chat,actor)==='PASSED')continue;const rows=s.wizards.filter(w=>w.key===key(chat,actor)),w=rows[0];if(rows.length>1)continue;if(w){const d=this.#read(s,w,actor,true);if(!d||d.revision===settings.revision&&w.policyVersion===this.policy.chatRevision(s,chat)&&(now<d.issued+86400000||d.round===3||s.audit.some(a=>a.updateKey==='captcha:review:'+d.nonce)||s.moderationReasons.some(r=>r.chatId===chat&&r.memberId===actor)||s.moderationOperations.some(o=>o.chatId===chat&&o.memberId===actor)))continue;}
    if(s.wizards.filter(w=>typeof w.flow==='string'&&w.flow.startsWith(MEMBER)&&w.key!==key(chat,actor)).length>=1000)continue;const d=this.#fresh(chat,settings,1);s.audit.push({actorId:actor,updateKey:'captcha:join-issued:'+d.nonce,decision:'ALLOW',reason:'CAPTCHA_JOIN_OBSERVED:'+hash([chat,actor,d.nonce,updateKey,sentAt,s.audit.filter(a=>a.updateKey==='captcha:enforcement:'+chat)]),policyVersion:this.policy.chatRevision(s,chat),at:now});s.wizards=s.wizards.filter(w=>w.key!==key(chat,actor));s.wizards.push({key:key(chat,actor),userId:actor,chatId:actor,topicId:'',flow:MEMBER+JSON.stringify(d),step:0,version:1,policyVersion:this.policy.chatRevision(s,chat),expiresAt:d.deadline,status:'ACTIVE'});issued++;
   }return issued;});
 }
 async view(actor:string,data?:string):Promise<OwnerInlineScreen|null>{
  if(!user(actor)||data!==undefined&&!validCaptchaRoute(data))return null;
  const before=await this.store.snapshot(),now=this.clock(),page=data?.startsWith('cp:1:l:')?Number(data.split(':')[3]):null,nonce=page===null?data?.split(':')[3]:undefined,candidates=before.wizards.filter(w=>w.userId===actor&&w.status==='ACTIVE'&&typeof w.flow==='string'&&w.flow.startsWith(MEMBER)).flatMap(w=>{const current=this.#read(before,w,actor),d=current??(data===undefined?this.#read(before,w,actor,true):null);return d&&(!nonce||d.nonce===nonce)?[{w,d,refresh:current===null}]:[];}),selected=data===undefined?(candidates.find(c=>c.refresh)??candidates[0]):candidates[0];
  if(!selected||nonce&&candidates.length!==1)return null;
  if(!selected.refresh&&(data===undefined||page!==null)&&candidates.length>1){const index=page??0;if(index>=Math.ceil(candidates.length/8))return null;const rows=candidates.slice(index*8,index*8+8).map(c=>[{text:c.d.group,callback_data:'cp:1:o:'+c.d.nonce}]);if(index>0)rows.push([{text:'السابق',callback_data:'cp:1:l:'+(index-1)}]);if((index+1)*8<candidates.length)rows.push([{text:'التالي',callback_data:'cp:1:l:'+(index+1)}]);rows.push([{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]);return {text:'اختر مجموعة اختبار الانضمام.',keyboard:{inline_keyboard:rows}};}if(page!==null){if(page!==0)return null;data=undefined;}
  const action=data?.split(':')[2],prior=selected.d;
  if((action==='a'||action==='b')&&(prior.phase!=='WAITING'||now>=prior.deadline||prior.lastAttempt>=0&&now-prior.lastAttempt<2000))return null;
  if(action==='r'&&(prior.phase==='PASSED'||prior.round>=3||now<prior.retryAt))return null;
  let member=false;try{member=await this.membership(selected.d.group,actor)==='VERIFIED';}catch{/* unknown is not membership */}if(!member)return null;
  return this.store.transaction(s=>{const at=this.clock(),w=s.wizards.find(w=>w.key===selected.w.key);if(!w||w.status!=='ACTIVE'||at<now||at>=now+120000||captchaSource(s)!==captchaSource(before)||w.flow!==selected.w.flow)return null;let d=this.#read(s,w,actor);if(!d&&selected.refresh&&data===undefined){const previous=this.#read(s,w,actor,true),current=previous?this.settings(s,previous.group):null;if(!previous||!current)return null;d=this.#fresh(previous.group,current,1);w.policyVersion=this.policy.chatRevision(s,previous.group);w.flow=MEMBER+JSON.stringify(d);w.expiresAt=d.deadline;}const settings=d?this.settings(s,d.group):null;if(!d||!settings)return null;
   const human=this.#humanDecision(s,w,d);
   if(human)return {text:(human==='APPROVED'?'✅ قُبل التحقق بمراجعة بشرية.':'رُفض التحقق بعد مراجعة بشرية.')+'\nهذا القرار يخص CAPTCHA فقط، ولا يرفع عقوبة أو قيد اشتراك مستقلًا.',keyboard:{inline_keyboard:[[{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]]}};
   if(s.audit.some(a=>a.updateKey==='captcha:review:'+d.nonce))return null;
   if(data){const action=data.split(':')[2];if(action==='r'){if(d.phase==='PASSED'||at<d.retryAt||d.round>=3)return null;Object.assign(d,this.#fresh(d.group,settings,d.round+1));}
    else if(action!=='o'){if(at>=d.deadline||d.phase!=='WAITING'||d.lastAttempt>=0&&at-d.lastAttempt<2000)return null;d.lastAttempt=at;d.tries++;if(action==='b'||Number(data.split(':')[4])===d.problem[2]){if(s.audit.some(a=>a.updateKey==='captcha:passed:'+d.nonce))return null;d.phase='PASSED';w.status='CANCELLED';s.audit.push({actorId:actor,updateKey:'captcha:passed:'+d.nonce,decision:'ALLOW',reason:'CAPTCHA_CHALLENGE_PASSED:'+hash([d.group,actor,d.revision]),policyVersion:w.policyVersion,at});}else if(d.tries>=settings.attempts)d.phase='FAILED';}
   }
   w.flow=MEMBER+JSON.stringify(d);w.expiresAt=d.deadline;
   const b=(text:string,callback_data:string)=>({text,callback_data}),back=[b('🏠 الرئيسية','pn:1:h')];
   if(d.phase==='PASSED')return {text:'✅ اكتمل اختبار التحقق. هذا النجاح لا يفك عقوبة أو قيد اشتراك مستقل.\nفحص الزر أو السؤال لا يضمن إيقاف جميع الحسابات الآلية.',keyboard:{inline_keyboard:[back]}};
   if(d.phase==='FAILED'||at>=d.deadline)return {text:(d.phase==='FAILED'?'استُنفدت محاولات الاختبار.':'انتهت مهلة الاختبار.')+'\n'+(d.round>=3?'راجع مشرفًا لإكمال المراجعة البشرية.':'يمكن إعادة المحاولة بعد '+Math.max(0,Math.ceil((d.retryAt-at)/1000))+' ثانية، دون تغيير أي قيد مستقل.'),keyboard:{inline_keyboard:[...(d.round<3?[[b('🔄 إعادة المحاولة','cp:1:r:'+d.nonce)]]:[]),back]}};
   const sum=d.problem[0]+d.problem[1],answers=[0,1,2].map(i=>sum+(i-d.problem[2]+3)%3);
   return {text:'<b>الاختبار: تحقق الانضمام</b>\nالمجموعة: '+d.group+'\nما ناتج '+d.problem[0]+' + '+d.problem[1]+'؟\nالوقت المتبقي: '+Math.max(0,Math.ceil((d.deadline-at)/1000))+' ثانية\nالمتبقي: '+(settings.attempts-d.tries)+' محاولات.\nيمكن استخدام زر التحقق البديل دون سؤال.\nإنفاذ قيد CAPTCHA يتطلب اعتمادًا مستقلًا من المالك. القيود المستقلة لا يلغيها نجاح الاختبار.',keyboard:{inline_keyboard:[answers.map((v,i)=>b(String(v),'cp:1:a:'+d.nonce+':'+i)),[b('✅ تحقق بديل متاح','cp:1:b:'+d.nonce)],back]}};
  });
 }
}
