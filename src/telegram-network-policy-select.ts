import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {validGroupNetwork,type GroupNetwork} from './group-network-model.js';
import {validNetworkInheritanceLinks} from './network-inheritance-model.js';
import {networkEmergencyStopped,validNetworkEmergencyControls} from './network-emergency-stop.js';
import {portableNetworkProtectionRules} from './network-policy-portability.js';
import {prepareNetworkInheritance} from './network-inheritance.js';
import {isValidGroupProtectionRecord,isValidProtectionPolicy,
 type GroupProtectionRecord,type ProtectionPolicy} from './protection-rules.js';

/** NETWORK-002 explicit one-destination follow, leaving every other group
 * untouched. Selection cannot grant rights or activate Telegram actions. */
const TTL=120_000,SIZE=8,PREFIX='network:select-follow:';
const net='([a-f0-9]{12})',group='(-[1-9][0-9]{0,15})',page='(0|[1-9][0-9]{0,2})';
const choose=new RegExp('^nw:1:ps:'+net+':'+group+':'+page+'$','u');
const review=new RegExp('^nw:1:pt:'+net+':'+group+':'+group+'$','u');
const confirm=/^nw:1:pc:([A-Za-z0-9_-]{24})$/u;
const cancel=/^nw:1:px:([A-Za-z0-9_-]{24})$/u;
const grp=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const nowOk=(v:number):boolean=>Number.isSafeInteger(v)&&
 v>=0&&v<=8_640_000_000_000_000-TTL;
const validRev=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
const hash=(v:unknown):string=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;')
 .replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows}});
interface Pending{
 networkId:string;networkRevision:number;
 sourceId:string;sourceRevision:number;targetId:string;targetVersion:number;
 at:number;proof:string;
}
function parse(raw:string):Pending|null{
 let v:unknown;try{v=JSON.parse(raw);}catch{return null;}
 if(!v||typeof v!=='object'||Array.isArray(v))return null;
 const x=v as Record<string,unknown>;
 if(Object.keys(x).sort().join(',')!=='at,networkId,networkRevision,proof,sourceId,sourceRevision,targetId,targetVersion'||
  typeof x.networkId!=='string'||!/^[a-f0-9]{12}$/u.test(x.networkId)||
  !grp(x.sourceId)||!grp(x.targetId)||x.sourceId===x.targetId||
  !validRev(x.networkRevision)||!validRev(x.sourceRevision)||!validRev(x.targetVersion)||
  typeof x.at!=='number'||!nowOk(x.at)||
  typeof x.proof!=='string'||!/^[a-f0-9]{64}$/u.test(x.proof))return null;
 return x as unknown as Pending;
}
const witness=(s:BotState,networkId:string,sourceId:string,targetId:string):string=>
 hash([networkId,sourceId,targetId,s.groupNetworks??[],s.chats,s.grants,
  s.protectionPolicies??[],s.networkInheritance??[],s.networkEmergencyControls??[],
  s.privateFeatures,s.privateSettingsRevision??0]);
export function validOwnerNetworkSelectedFollowRoute(data:unknown):boolean{
 return typeof data==='string'&&Buffer.byteLength(data,'utf8')<=64&&
  [choose,review,confirm,cancel].some(re=>re.test(data));
}
export class OwnerNetworkSelectedPolicyFollow {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private eligible(s:BotState,actor:string,now:number,netId:string,sourceId:string):
 {network:GroupNetwork;source:Chat;record:GroupProtectionRecord;targets:Chat[]}|null{
  if(!nowOk(now)||!this.policy.isOwner(actor)||
    !this.policy.privateFeature(s,'owner.dashboard',actor)||
    !validNetworkEmergencyControls(s.networkEmergencyControls??[])||
    !validNetworkInheritanceLinks(s.networkInheritance??[])||
    networkEmergencyStopped(s,netId))return null;
  const networks=(s.groupNetworks??[]).filter(n=>n.id===netId),network=networks[0];
  if(networks.length!==1||!network||!validGroupNetwork(network)||
    network.updatedAt>now)return null;
  const sourceMembership=network.members.filter(m=>m.chatId===sourceId),
   sourceRows=s.chats.filter(c=>c.id===sourceId),source=sourceRows[0];
  if(sourceMembership.length!==1||sourceRows.length!==1||!source||!source.approved||
    source.version!==sourceMembership[0]!.version||
    !source.scopes.includes('moderation')||
    !this.policy.canUseChat(s,sourceId,'moderation')||
    !this.policy.has(s,actor,'chat.manage',sourceId,now))return null;
  const sourcePolicies=(s.protectionPolicies??[]).filter(p=>p.policy.chatId===sourceId),
   record=sourcePolicies[0];
  if(sourcePolicies.length!==1||!record||!isValidGroupProtectionRecord(record)||
    record.chatPolicyVersion!==source.version||record.updatedAt>now||
    record.policy.mode==='ENFORCE'||!portableNetworkProtectionRules(record.policy))return null;
  const targets:Chat[]=[];
  for(const membership of network.members){
   if(membership.chatId===sourceId)continue;
   const rows=s.chats.filter(c=>c.id===membership.chatId),chat=rows[0];
   if(rows.length!==1||!chat||!chat.approved||
    chat.version!==membership.version||!chat.scopes.includes('moderation')||
    !this.policy.canUseChat(s,chat.id,'moderation')||
    !this.policy.has(s,actor,'chat.manage',chat.id,now)||
    (s.protectionPolicies??[]).some(p=>p.policy.chatId===chat.id)||
    (s.networkInheritance??[]).some(x=>x.kind==='POLICY'&&x.targetChatId===chat.id))
    continue;
   targets.push(chat);
  }
  targets.sort((a,b)=>a.id.localeCompare(b.id));
  return {network,source,record,targets};
 }
 private list(s:BotState,actor:string,now:number,netId:string,
  sourceId:string,p:number):OwnerInlineScreen|null{
  const found=this.eligible(s,actor,now,netId,sourceId);if(!found)return null;
  const pages=Math.max(1,Math.ceil(found.targets.length/SIZE));
  if(p>=pages)return null;
  const rows:{text:string;callback_data:string}[][]=found.targets
   .slice(p*SIZE,(p+1)*SIZE).map(c=>[
    btn('🎯 متابعة للمجموعة '+c.id,'nw:1:pt:'+netId+':'+sourceId+':'+c.id)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','nw:1:ps:'+netId+':'+sourceId+':'+(p-1)));
  if(p+1<pages)nav.push(btn('➡️ التالي','nw:1:ps:'+netId+':'+sourceId+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ المصادر','nw:1:y:'+netId+':0'),
   btn('🌐 الشبكة','nw:1:d:'+netId)]);
  return ui('<b>🎯 متابعة سياسة لمجموعة مختارة</b>\n'+
   'الشبكة: '+esc(found.network.name)+'\n'+
   'المصدر: <code>'+sourceId+'</code> · إصدار سياسة '+found.record.policy.revision+'\n'+
   'عدد المجموعات المؤهلة بلا سياسة: '+found.targets.length+
   ' · صفحة '+(p+1)+'/'+pages+'\n'+
   'اختر وجهة واحدة. تبقى جميع المجموعات الأخرى مستثناة، '+
   'ويمكنك ربط مجموعة أخرى بعد إتمام المراجعة.\n'+
   'هذه متابعة محلية OFF/MONITOR فقط، دون صلاحيات أو عقوبات Telegram.',rows);
 }
 private async preview(actor:string,netId:string,sourceId:string,targetId:string):
 Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),found=this.eligible(s,actor,now,netId,sourceId);
   if(!found||!found.targets.some(x=>x.id===targetId))return null;
   const target=found.targets.find(x=>x.id===targetId)!;
   const candidate:ProtectionPolicy={chatId:targetId,revision:1,
    mode:found.record.policy.mode,rules:structuredClone(found.record.policy.rules),
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],
    ...(found.record.policy.flood?{flood:structuredClone(found.record.policy.flood)}:{})};
   if(!isValidProtectionPolicy(candidate)||candidate.mode==='ENFORCE')return null;
   const nowRef='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===nowRef))return null;
   const pending:Pending={networkId:netId,networkRevision:found.network.revision,
    sourceId,sourceRevision:found.record.policy.revision,targetId,
    targetVersion:target.version,at:now,proof:witness(s,netId,sourceId,targetId)};
   const open=s.callbacks.filter(c=>c.actorId===actor&&c.action.startsWith(PREFIX)&&
    !c.used&&!c.revoked&&c.expiresAt>now);
   if(open.length>=100)return null;
   for(const old of open)old.revoked=true;
   s.callbacks.push({ref:nowRef,action:PREFIX+JSON.stringify(pending),
    actorId:actor,chatId:'private',policyVersion:0,
    oneShot:true,used:false,revoked:false,expiresAt:now+TTL});
   const token=nowRef.slice(2);
   return ui('<b>🔎 معاينة متابعة مجموعة واحدة</b>\n'+
    'الشبكة: '+esc(found.network.name)+'\n'+
    'المصدر: <code>'+sourceId+'</code> · إصدار '+pending.sourceRevision+'\n'+
    'الوجهة: <code>'+targetId+'</code> · اعتماد '+pending.targetVersion+'\n'+
    'الوضع المبدئي: '+candidate.mode+'\n'+
    'عدد القواعد المحمولة: '+candidate.rules.length+'\n'+
    'لا تنسخ المعاينة استثناءات الأعضاء أو قوائم السماح أو '+
    'قواعد الهوية أو معلومات الدفع أو أي سر.\n'+
    'الموافقة تخص هذه المجموعة فقط. يُلغى الطلب إذا تغير أي تفويض أو سياسة.\n'+
    'تأكيد المالك صالح لدقيقتين ولمرة واحدة، ولا يُنفذ Telegram.',
    [[btn('✅ تأكيد متابعة هذه المجموعة','nw:1:pc:'+token)],
     [btn('✖ إلغاء المعاينة','nw:1:px:'+token)],
     [btn('↩️ اختيار مجموعة أخرى','nw:1:ps:'+netId+':'+sourceId+':0')]]);
  });
 }
 private async decide(actor:string,nonce:string,apply:boolean):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!nowOk(now)||!this.policy.isOwner(actor)||
    !this.policy.privateFeature(s,'owner.dashboard',actor))return null;
   const receipts=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=receipts[0];
   if(receipts.length!==1||!receipt||!receipt.action.startsWith(PREFIX)||
    receipt.actorId!==actor||receipt.chatId!=='private'||
    receipt.policyVersion!==0||!receipt.oneShot||receipt.used||receipt.revoked||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=now||
    receipt.expiresAt>now+TTL)return null;
   const pending=parse(receipt.action.slice(PREFIX.length));
   if(!pending||receipt.expiresAt!==pending.at+TTL||now<pending.at)return null;
   if(!apply){receipt.revoked=true;return ui('أُلغي طلب متابعة السياسة. لم تتغير المجموعات.',
    [[btn('↩️ الشبكات','nw:1:h')]]);}
   const found=this.eligible(s,actor,now,pending.networkId,pending.sourceId);
   if(!found||found.network.revision!==pending.networkRevision||
    found.record.policy.revision!==pending.sourceRevision||
    !found.targets.some(c=>c.id===pending.targetId&&c.version===pending.targetVersion)||
    witness(s,pending.networkId,pending.sourceId,pending.targetId)!==pending.proof)return null;
   const source=found.record.policy;
   const draft:ProtectionPolicy={chatId:pending.targetId,revision:1,
    mode:source.mode,rules:structuredClone(source.rules),
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],
    ...(source.flood?{flood:structuredClone(source.flood)}:{})};
   if(!isValidProtectionPolicy(draft)||draft.mode==='ENFORCE')return null;
   // Stage the new local policy before preparing the inheritance link,
   // because prepareNetworkInheritance validates the destination's revision.
   const proposal=structuredClone(s);
   proposal.protectionPolicies??=[];
   if(proposal.protectionPolicies.length>=500)return null;
   proposal.protectionPolicies.push({policy:draft,chatPolicyVersion:pending.targetVersion,
    updatedBy:actor,updatedAt:now});
   const link=prepareNetworkInheritance(proposal,this.policy,actor,now,'POLICY',
    found.network,pending.sourceId,pending.targetId,pending.sourceRevision,draft);
   if(!link||!validNetworkInheritanceLinks([...(proposal.networkInheritance??[]),link]))return null;
   proposal.networkInheritance??=[];
   proposal.networkInheritance.push(link);
   s.protectionPolicies=proposal.protectionPolicies;
   s.networkInheritance=proposal.networkInheritance;
   receipt.used=true;
   s.audit.push({actorId:actor,updateKey:'network:select-follow:'+nonce,
    decision:'ALLOW',reason:'OWNER_NETWORK_POLICY_FOLLOW_SELECTED',
    policyVersion:found.network.revision,at:now});
   return ui('<b>✅ تمت متابعة السياسة لهذه المجموعة فقط</b>\n'+
    'المصدر: <code>'+pending.sourceId+'</code>\n'+
    'الوجهة: <code>'+pending.targetId+'</code>\n'+
    'حالة السياسة: '+draft.mode+'\n'+
    'المجموعات الأخرى لم تتغير. التعديل المحلي على الوجهة '+
    'أو تغيير صلاحياتها يوقف التوريث مستقبلًا.\n'+
    'لا توجد عقوبات أو رسائل Telegram في هذه العملية.',
    [[btn('🎯 اختيار وجهة ثانية','nw:1:ps:'+pending.networkId+':'+pending.sourceId+':0')],
     [btn('🌐 بطاقة الشبكة','nw:1:d:'+pending.networkId)]]);
  });
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validOwnerNetworkSelectedFollowRoute(data))return null;
  const c=confirm.exec(data);if(c)return this.decide(actor,c[1]!,true);
  const x=cancel.exec(data);if(x)return this.decide(actor,x[1]!,false);
  const t=review.exec(data);if(t)return this.preview(actor,t[1]!,t[2]!,t[3]!);
  const m=choose.exec(data);
  if(!m)return null;
  const state=await this.store.snapshot();
  return this.list(state,actor,this.clock(),m[1]!,m[2]!,Number(m[3]));
 }
}
