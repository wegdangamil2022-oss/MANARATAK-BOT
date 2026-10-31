import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {ownerGroupCardLink} from './telegram-inline-groups.js';
import {evaluateProtectionRules,isValidGroupProtectionRecord,isValidProtectionPolicy,
 type GroupProtectionRecord,type ProtectionPolicy} from './protection-rules.js';

/** Owner-private local group protection templates and copy workflow.
 * Never calls Telegram and never enables ENFORCE. A preview is not authority:
 * the owner, both group epochs, source policy and missing target policy are
 * verified again atomically when consuming a durable one-shot confirmation.
 * Existing target policies are never overwritten.
 */
const group='(-[1-9][0-9]{0,15})',ver='([1-9][0-9]{0,9})';
const page='(0|[1-9][0-9]{0,2})';
const root=/^gt:1:h$/u;
const preset=new RegExp('^gt:1:p:([el]):'+page+'$','u');
const choose=new RegExp('^gt:1:v:([el]):'+group+':'+ver+'$','u');
const sources=new RegExp('^gt:1:s:'+page+'$','u');
const targets=new RegExp('^gt:1:d:'+group+':'+page+'$','u');
const compare=new RegExp('^gt:1:x:'+group+':'+group+'$','u');
const compareOnly=new RegExp('^gt:1:q:'+group+':'+group+'$','u');
const confirm=/^gt:1:c:([A-Za-z0-9_-]{24})$/u;
const bulkRoot=/^gt:1:b:h$/u;
const bulkPage=new RegExp('^gt:1:b:p:([el]):'+page+'$','u');
const bulkPreview=new RegExp('^gt:1:b:v:([el]):'+page+'$','u');
const bulkConfirm=/^gt:1:b:c:([A-Za-z0-9_-]{24})$/u;
const historyHome=/^gt:1:r:h$/u;
const historyPage=new RegExp('^gt:1:r:p:'+page+'$','u');
const historyView=/^gt:1:r:v:([A-Za-z0-9_-]{24})$/u;
const groupHistory=new RegExp('^gt:1:r:g:'+group+':'+page+'$','u');
const revertPreview=/^gt:1:r:x:([A-Za-z0-9_-]{24})$/u;
const revertConfirm=/^gt:1:r:c:([A-Za-z0-9_-]{24})$/u;
const cancelPreview=/^gt:1:k:([A-Za-z0-9_-]{24})$/u;
const TTL=120_000,PREFIX='group-template-confirm:',BULK_PREFIX='group-template-bulk:',
 REVERT_PREFIX='group-template-revert:',REVERT_WINDOW=7*24*60*60*1000;
type Mode='e'|'l'|'c';
type Evidence={kind:Mode;sourceId:string;targetId:string;targetVersion:number;proof:string};
type HistoryEvent={
 nonce:string;type:'single'|'copy'|'bulk';audit:BotState['audit'][number];
 receipt:BotState['callbacks'][number];ids:string[];templateKind:'e'|'l'|null;
 page:number|null;digest:string|null
};
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const validTime=(n:number)=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-TTL;
const pageOf=(items:readonly unknown[],page:number):boolean=>page>=0&&page<Math.max(1,Math.ceil(items.length/8));
const key=(kind:Mode,chat:Chat)=>'gt:1:v:'+kind+':'+chat.id+':'+chat.version;
const cardScope=(s:BotState,policy:Policy,actor:string,now:number):Chat[]=>{
 const ids=new Set<string>(),duplicates=new Set<string>();
 for(const c of s.chats){if(ids.has(c.id))duplicates.add(c.id);ids.add(c.id);}
 return s.chats.filter(c=>c.approved&&!duplicates.has(c.id)&&
  /^-[1-9][0-9]{0,15}$/u.test(c.id)&&Number.isSafeInteger(Number(c.id))&&
  Number.isSafeInteger(c.version)&&c.version>=1&&c.version<=9_999_999_999&&
  c.scopes.includes('moderation')&&policy.canUseChat(s,c.id,'moderation')&&
  policy.has(s,actor,'chat.manage',c.id,now)).sort((a,b)=>a.id.localeCompare(b.id));
};
function sourceRecord(s:BotState,chat:Chat,now:number):GroupProtectionRecord|null{
 const rows=(s.protectionPolicies??[]).filter(x=>x.policy.chatId===chat.id);
 if(rows.length!==1||!isValidGroupProtectionRecord(rows[0])||
  rows[0]!.chatPolicyVersion!==chat.version||rows[0]!.updatedAt>now||
  !['OFF','MONITOR'].includes(rows[0]!.policy.mode))return null;
 return rows[0]!;
}
function template(kind:'e'|'l',id:string):ProtectionPolicy{
 return {chatId:id,revision:1,mode:'MONITOR',
  rules:kind==='e'?[]:[{id:'template_links',kind:'LINK',hosts:'*',enabled:true,action:'REVIEW'}],
  allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
}
function copiedPolicy(source:GroupProtectionRecord,id:string):ProtectionPolicy{
 // Explicitly drop group-specific allowlists and protected-member exemptions.
 // Duplicating these could silently weaken the destination group's safety.
 const value:ProtectionPolicy={chatId:id,revision:1,mode:source.policy.mode==='OFF'?'OFF':'MONITOR',
  rules:structuredClone(source.policy.rules),allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
 if(source.policy.flood)value.flood=structuredClone(source.policy.flood);
 return value;
}
function proof(s:BotState,source:Chat|null,target:Chat,record:GroupProtectionRecord|null):string{
 return createHash('sha256').update(JSON.stringify([source??null,record??null,target,
  s.privateSettingsRevision??0,s.privateFeatures['owner.dashboard']])).digest('hex');
}
export function validGroupPolicyStudioRoute(data:unknown):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return false;
 if(root.test(data)||confirm.test(data)||bulkRoot.test(data)||bulkConfirm.test(data)||
  historyHome.test(data)||revertConfirm.test(data)||cancelPreview.test(data)||
  data==='mi:1:i:01:06'||data==='mi:1:i:01:07'||data==='mi:1:i:01:08')return true;
 return [preset,choose,sources,targets,compare,compareOnly,bulkPage,bulkPreview,
  historyPage,historyView,groupHistory,revertPreview].some(re=>re.test(data));
}
export class OwnerGroupPolicyTemplates{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private auth(state:BotState,actor:string,now:number):boolean{
  return validTime(now)&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(state,'owner.dashboard',actor);
 }
 private evidence(s:BotState,actor:string,now:number,kind:Mode,
  sourceId:string,targetId:string):{value:Evidence;policy:ProtectionPolicy}|null{
  if(!this.auth(s,actor,now))return null;
  const groups=cardScope(s,this.policy,actor,now);
  const target=groups.find(c=>c.id===targetId);
  if(!target||(s.protectionPolicies??[]).some(r=>r.policy.chatId===targetId))return null;
  let source:Chat|null=null,record:GroupProtectionRecord|null=null;
  if(kind==='c'){
   if(sourceId===targetId)return null;
   source=groups.find(c=>c.id===sourceId)??null;
   if(!source)return null;
   record=sourceRecord(s,source,now);
   if(!record)return null;
  }else if(sourceId!=='')return null;
  const candidate=kind==='c'?copiedPolicy(record!,targetId):template(kind,targetId);
  if(!isValidProtectionPolicy(candidate)||candidate.mode==='ENFORCE')return null;
  return {value:{kind,sourceId,targetId,targetVersion:target.version,
   proof:proof(s,source,target,record)},policy:candidate};
 }
 private listGroups(title:string,rows:Chat[],p:number,callback:(chat:Chat)=>string,
  back:string,description:string):OwnerInlineScreen|null{
  if(!pageOf(rows,p))return null;
  const list=rows.slice(p*8,p*8+8),buttons=list.map(chat=>[btn('👥 '+chat.id,callback(chat))]);
  const navigation:{text:string;callback_data:string}[]=[];
  // This method is specialized for paged group pickers; callers pass page
  // callbacks via a private sentinel that never appears as a destination ID.
  const pageKey=back.startsWith('gt:1:p:')?back:
   back.startsWith('gt:1:d:')?back:'';
  if(pageKey){
   const prefix=pageKey.slice(0,pageKey.lastIndexOf(':')+1);
   if(p)navigation.push(btn('⬅️ السابق',prefix+(p-1)));
   if((p+1)*8<rows.length)navigation.push(btn('➡️ التالي',prefix+(p+1)));
  }
  if(navigation.length)buttons.push(navigation);
  buttons.push([btn('↩️ رجوع',back.startsWith('gt:1:p:')?'gt:1:h':
   back.startsWith('gt:1:d:')?'gt:1:s:0':back),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>'+title+'</b>\n'+description+'\n'+
   'صفحة '+(p+1)+' من '+Math.max(1,Math.ceil(rows.length/8))+'\n'+
   (rows.length?'حدد المجموعة المعتمدة محليًا.':'لا توجد مجموعات مؤهلة حاليًا.')+'\n'+
   'حقوق Telegram لم تُفحص ولا تُمنح من هذه الشاشة.',buttons);
 }
 private async preview(actor:string,kind:Mode,sourceId:string,targetId:string,
  requestedVersion?:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),e=this.evidence(s,actor,now,kind,sourceId,targetId);
   if(!e||requestedVersion!==undefined&&e.value.targetVersion!==requestedVersion)return null;
   // Older active confirmations stay non-actionable if their state changed.
   // Retain them as audit evidence until expired; cap live previews per owner.
   const pending=s.callbacks.filter(c=>c.action.startsWith(PREFIX)&&
    c.actorId===actor&&!c.used&&!c.revoked&&Number.isSafeInteger(c.expiresAt)&&c.expiresAt>now);
   if(pending.length>=100)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:PREFIX+JSON.stringify([
    e.value.kind,e.value.sourceId,e.value.targetId,e.value.targetVersion,e.value.proof]),
    chatId:'private',actorId:actor,policyVersion:0,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   const sample=evaluateProtectionRules(e.policy,{chatId:targetId,memberId:'999',
    type:'TEXT',text:'https://example.org'});
   if(sample.authorizedToSend||sample.status==='INVALID_MESSAGE'||sample.status==='INVALID_POLICY')return null;
   const sampleText='اختبار عينة ثابتة: '+(sample.status==='MATCH'?'تطابق':sample.status==='OFF'?'متوقفة':'بلا تطابق')+
    ' · دون تنفيذ أي إجراء.\n';
   const count=e.policy.rules.length,kindLabel=kind==='c'?'مقارنة ونسخ قواعد مجموعة':'قالب حماية';
   const returnTo=kind==='c'?'gt:1:d:'+sourceId+':0':'gt:1:p:'+kind+':0';
   const sourceText=kind==='c'?'المصدر: <code>'+esc(sourceId)+'</code>\n':'';
   const note=kind==='c'?
    'الاستثناءات والنطاقات المسموحة وأعضاء الاستثناء لن تُنسخ.':
    kind==='l'?'مراجعة الروابط في وضع المراقبة فقط.':'قالب دراسي فارغ في وضع المراقبة فقط.';
   return ui('<b>معاينة '+kindLabel+'</b>\n'+sourceText+
    'الهدف: <code>'+esc(targetId)+'</code>\n'+
    'قواعد القالب: '+count+'\n'+
    'الحماية: '+(e.policy.mode==='MONITOR'?'مراقبة فقط':'متوقفة')+'\n'+
    sampleText+note+'\n'+
    'لن تُكتب الإعدادات إلا بعد التأكيد لمرة واحدة خلال دقيقتين. '+
    'لا نسخ فوق سياسة موجودة، ولا حظر أو حذف أو كتم عبر Telegram.',
    [[btn(kind==='c'?'✅ تأكيد النسخ المحلي':'✅ تأكيد حفظ القالب','gt:1:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','gt:1:k:'+ref.slice(2)),btn('↩️ رجوع',returnTo)]]);
  });
 }
 private async confirm(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))return null;
   const ref='c_'+nonce,rows=s.callbacks.filter(c=>c.ref===ref),c=rows[0];
   if(rows.length!==1||!c||!c.action.startsWith(PREFIX)||c.actorId!==actor||
    c.chatId!=='private'||c.policyVersion!==0||!c.oneShot||c.used||c.revoked||
    !Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   let v:unknown;
   try{v=JSON.parse(c.action.slice(PREFIX.length));}catch{return null;}
   if(!Array.isArray(v)||v.length!==5||!['e','l','c'].includes(v[0])||
    typeof v[1]!=='string'||typeof v[2]!=='string'||
    !Number.isSafeInteger(v[3])||typeof v[4]!=='string'||!/^[a-f0-9]{64}$/u.test(v[4]))
    return null;
   const kind=v[0] as Mode,sourceId=v[1],targetId=v[2];
   const current=this.evidence(s,actor,now,kind,sourceId,targetId);
   if(!current||current.value.targetVersion!==v[3]||current.value.proof!==v[4]||
    (s.protectionPolicies??[]).length>=500)return null;
   s.protectionPolicies??=[];
   s.protectionPolicies.push({policy:current.policy,chatPolicyVersion:current.value.targetVersion,
    updatedBy:actor,updatedAt:now});
   // Discard any old flood windows belonging to the target. The new policy
   // begins a fresh local monitoring epoch and never imports source events.
   if(s.protectionFloodWindows)
    s.protectionFloodWindows=s.protectionFloodWindows.filter(w=>w.chatId!==targetId);
   c.used=true;
   s.audit.push({actorId:actor,updateKey:'group-template:'+nonce,decision:'ALLOW',
    reason:kind==='c'?'GROUP_TEMPLATE_COPY_MONITOR_SAVED':'GROUP_TEMPLATE_MONITOR_SAVED',
    policyVersion:current.value.targetVersion,at:now});
   return ui('<b>حُفظ '+(kind==='c'?'النسخ':'القالب')+' محليًا ✅</b>\n'+
    'المجموعة: <code>'+esc(targetId)+'</code>\n'+
    'الحالة: '+(current.policy.mode==='MONITOR'?'مراقبة فقط':'متوقفة')+'\n'+
    'تم تسجيل عملية الحفظ في سجل التدقيق. '+
    'لم تُنفذ أوامر Telegram ولم تتغير أي سياسة في المجموعة المصدر.',
    [[btn('📑 قوالب الإعدادات','gt:1:h'),btn('📋 مجموعاتي','mi:1:i:01:01')],
     [btn('🏠 لوحة المالك','mi:1:h')]]);
  });
 }

 /** A bulk operation is deliberately bounded to one *visible* page of eight
  * approved groups. Configured groups stay on the page but are read-only.
  * Retaining page membership in the proof avoids target shifting on confirm. */
 private bulkEvidence(s:BotState,actor:string,now:number,kind:'e'|'l',p:number):{
  all:Chat[];visible:Chat[];eligible:Chat[];pages:number;digest:string
 }|null{
  if(!this.auth(s,actor,now)||!Number.isSafeInteger(p)||p<0||p>999)return null;
  const all=cardScope(s,this.policy,actor,now);
  const pages=Math.max(1,Math.ceil(all.length/8));
  if(p>=pages)return null;
  const visible=all.slice(p*8,p*8+8);
  const eligible=visible.filter(c=>!(s.protectionPolicies??[]).some(row=>row.policy.chatId===c.id));
  const records=visible.map(c=>(s.protectionPolicies??[]).filter(row=>row.policy.chatId===c.id));
  const digest=createHash('sha256').update(JSON.stringify([
   kind,p,all.length,visible,records,
   s.privateSettingsRevision??0,s.privateFeatures['owner.dashboard']
  ])).digest('hex');
  return {all,visible,eligible,pages,digest};
 }
 private bulkPageView(actor:string,s:BotState,kind:'e'|'l',p:number):OwnerInlineScreen|null{
  const evidence=this.bulkEvidence(s,actor,this.clock(),kind,p);
  if(!evidence)return null;
  const rows=evidence.visible.map(chat=>{
   const ready=evidence.eligible.some(c=>c.id===chat.id);
   return [btn((ready?'✅ جاهزة: ':'🔒 مضبوطة مسبقًا: ')+chat.id,
    ownerGroupCardLink(s,chat.id)??'mi:1:i:01:01')];
  });
  const nav:{text:string;callback_data:string}[]=[];
  if(p>0)nav.push(btn('⬅️ السابق','gt:1:b:p:'+kind+':'+(p-1)));
  if(p+1<evidence.pages)nav.push(btn('➡️ التالي','gt:1:b:p:'+kind+':'+(p+1)));
  if(nav.length)rows.push(nav);
  if(evidence.eligible.length)rows.push([btn('🔎 معاينة تطبيق القالب على الصفحة',
   'gt:1:b:v:'+kind+':'+p)]);
  rows.push([btn('↩️ الإجراءات الجماعية','gt:1:b:h'),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>👥 صفحة الإجراءات الجماعية المحلية</b>\n'+
   'القالب: '+(kind==='e'?'القالب الدراسي الفارغ':'مراجعة الروابط')+'\n'+
   'صفحة '+(p+1)+' من '+evidence.pages+'\n'+
   'المستهدفة: '+evidence.eligible.length+' مجموعات من أصل '+evidence.visible.length+' في الصفحة.\n'+
   'المجموعات المضبوطة مسبقًا لن تمس. المعاينة وحدها لا تحفظ إعدادات أو ترسل أوامر Telegram.',
   rows);
 }
 private async previewBulk(actor:string,kind:'e'|'l',p:number):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock(),v=this.bulkEvidence(s,actor,now,kind,p);
   if(!v||!v.eligible.length||(s.protectionPolicies??[]).length+v.eligible.length>500)return null;
   const active=s.callbacks.filter(c=>c.actorId===actor&&c.action.startsWith(BULK_PREFIX)&&
    !c.used&&!c.revoked&&Number.isSafeInteger(c.expiresAt)&&c.expiresAt>now);
   if(active.length>=100)return null;
   for(const c of v.eligible)if(!isValidProtectionPolicy(template(kind,c.id)))return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(x=>x.ref===ref))return null;
   const receipt=[kind,p,v.digest,v.eligible.map(c=>c.id)];
   s.callbacks.push({ref,action:BULK_PREFIX+JSON.stringify(receipt),
    chatId:'private',actorId:actor,policyVersion:0,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   const ids=v.eligible.map(c=>'• <code>'+esc(c.id)+'</code>').join('\n');
   return ui('<b>🔎 معاينة الإجراء الجماعي المحلي</b>\n'+
    'القالب: '+(kind==='e'?'القالب الدراسي الفارغ':'مراجعة الروابط')+'\n'+
    'المجموعات المشمولة: '+v.eligible.length+' فقط (الحد الأقصى 8)\n'+ids+'\n'+
    'لن تمس أي مجموعة لديها سياسة حماية محفوظة.\n'+
    'سيُحفظ وضع MONITOR المحلي فقط، بدون حذف أو كتم أو حظر أو إرسال إلى Telegram.\n'+
    'التأكيد صالح لدقيقتين ولمرة واحدة. إذا تغيرت حالة أي مجموعة تُرفض الدفعة بأكملها.',
    [[btn('✅ تأكيد الحفظ الجماعي','gt:1:b:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','gt:1:k:'+ref.slice(2)),btn('↩️ العودة للصفحة','gt:1:b:p:'+kind+':'+p)]]);
  });
 }
 private async confirmBulk(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))return null;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),c=rows[0];
   if(rows.length!==1||!c||!c.action.startsWith(BULK_PREFIX)||
    c.chatId!=='private'||c.actorId!==actor||c.policyVersion!==0||
    c.oneShot!==true||c.used!==false||c.revoked!==false||
    !Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+TTL)return null;
   let saved:unknown;
   try{saved=JSON.parse(c.action.slice(BULK_PREFIX.length));}catch{return null;}
   if(!Array.isArray(saved)||saved.length!==4||!['e','l'].includes(saved[0])||
    !Number.isSafeInteger(saved[1])||saved[1]<0||saved[1]>999||
    typeof saved[2]!=='string'||!/^[a-f0-9]{64}$/u.test(saved[2])||
    !Array.isArray(saved[3])||saved[3].length<1||saved[3].length>8||
    saved[3].some((id:unknown)=>typeof id!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(id))||
    new Set(saved[3]).size!==saved[3].length)return null;
   const kind=saved[0] as 'e'|'l',p=saved[1] as number;
   const current=this.bulkEvidence(s,actor,now,kind,p);
   if(!current||!current.eligible.length||current.digest!==saved[2]||
    JSON.stringify(current.eligible.map(g=>g.id))!==JSON.stringify(saved[3])||
    (s.protectionPolicies??[]).length+current.eligible.length>500)return null;
   const proposed=current.eligible.map(group=>({
    policy:template(kind,group.id),chatPolicyVersion:group.version,updatedBy:actor,updatedAt:now
   }));
   if(proposed.some(row=>!isValidProtectionPolicy(row.policy)||row.policy.mode!=='MONITOR'))return null;
   s.protectionPolicies??=[];
   s.protectionPolicies.push(...proposed);
   if(s.protectionFloodWindows){
    const targets=new Set(current.eligible.map(g=>g.id));
    s.protectionFloodWindows=s.protectionFloodWindows.filter(w=>!targets.has(w.chatId));
   }
   c.used=true;
   s.audit.push({actorId:actor,updateKey:'group-template-bulk:'+nonce,decision:'ALLOW',
    reason:'GROUP_TEMPLATE_BULK_MONITOR_SAVED',policyVersion:0,at:now});
   return ui('<b>✅ حُفظ القالب الجماعي محليًا</b>\n'+
    'المجموعات التي تم ضبطها: '+proposed.length+'\n'+
    'الحماية: مراقبة محلية فقط (MONITOR).\n'+
    'لم تُعدّل أي سياسة قديمة، ولم يُنفذ أمر حظر أو كتم أو حذف في Telegram.',
    [[btn('↩️ الإجراءات الجماعية','gt:1:b:h'),btn('📋 مجموعاتي','mi:1:i:01:01')],
     [btn('🏠 لوحة المالك','mi:1:h')]]);
  });
 }


 /** The audit + consumed preview receipt are both mandatory evidence for
  * history. A copied/duplicate/restored row is ambiguous and fails closed. */
 private historyEvent(s:BotState,actor:string,nonce:string):HistoryEvent|null{
  if(!/^[A-Za-z0-9_-]{24}$/u.test(nonce))return null;
  const markers=['group-template:'+nonce,'group-template-bulk:'+nonce];
  const matching=s.audit.filter(a=>markers.includes(a.updateKey));
  if(matching.length!==1)return null;
  const audit=matching[0]!,bulk=audit.updateKey===markers[1];
  if(audit.decision!=='ALLOW'||audit.actorId!==actor||
   (bulk?audit.reason!=='GROUP_TEMPLATE_BULK_MONITOR_SAVED'||
    audit.policyVersion!==0:
    !['GROUP_TEMPLATE_MONITOR_SAVED','GROUP_TEMPLATE_COPY_MONITOR_SAVED'].includes(audit.reason))||
   !Number.isSafeInteger(audit.at)||audit.at<0||
   audit.at>8_640_000_000_000_000)return null;
  const rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=rows[0];
  if(rows.length!==1||!receipt||receipt.actorId!==actor||
   receipt.chatId!=='private'||receipt.policyVersion!==0||
   receipt.used!==true||receipt.revoked!==false||receipt.oneShot!==true||
   !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=audit.at||
   receipt.expiresAt>audit.at+TTL)return null;
  const prefix=bulk?BULK_PREFIX:PREFIX;
  if(!receipt.action.startsWith(prefix))return null;
  let values:unknown;
  try{values=JSON.parse(receipt.action.slice(prefix.length));}catch{return null;}
  if(!Array.isArray(values))return null;
  if(bulk){
   if(values.length!==4||!['e','l'].includes(values[0])||
    !Number.isSafeInteger(values[1])||values[1]<0||values[1]>999||
    typeof values[2]!=='string'||!/^[a-f0-9]{64}$/u.test(values[2])||
    !Array.isArray(values[3])||values[3].length<1||values[3].length>8||
    values[3].some((id:unknown)=>typeof id!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(id))||
    new Set(values[3]).size!==values[3].length)return null;
   return {nonce,type:'bulk',audit,receipt,ids:values[3] as string[],
    templateKind:values[0] as 'e'|'l',page:values[1] as number,digest:values[2] as string};
  }
  if(values.length!==5||!['e','l','c'].includes(values[0])||
   typeof values[1]!=='string'||typeof values[2]!=='string'||
   !/^-[1-9][0-9]{0,15}$/u.test(values[2])||
   !Number.isSafeInteger(values[3])||values[3]<1||
   typeof values[4]!=='string'||!/^[a-f0-9]{64}$/u.test(values[4])||
   (values[0]==='c'?!/^-[1-9][0-9]{0,15}$/u.test(values[1]):values[1]!==''))return null;
  if(audit.policyVersion!==values[3]||
   (audit.reason==='GROUP_TEMPLATE_COPY_MONITOR_SAVED')!==(values[0]==='c'))return null;
  return {nonce,type:values[0]==='c'?'copy':'single',audit,receipt,ids:[values[2] as string],
   templateKind:values[0]==='c'?null:values[0] as 'e'|'l',page:null,digest:null};
 }
 private history(s:BotState,actor:string):HistoryEvent[]{
  const candidates=s.audit.filter(a=>
   ['GROUP_TEMPLATE_MONITOR_SAVED','GROUP_TEMPLATE_COPY_MONITOR_SAVED',
    'GROUP_TEMPLATE_BULK_MONITOR_SAVED'].includes(a.reason));
  const entries:HistoryEvent[]=[];
  for(const a of [...candidates].reverse()){
   const match=/^group-template(?:-bulk)?:([A-Za-z0-9_-]{24})$/u.exec(a.updateKey);
   if(!match)continue;
   const found=this.historyEvent(s,actor,match[1]!);
   if(found&&found.audit===a)entries.push(found);
  }
  return entries;
 }
 private alreadyReverted(s:BotState,nonce:string):boolean{
  return s.audit.some(a=>a.updateKey==='group-template-bulk-rollback:'+nonce);
 }
 /** A rollback is allowed only for the exact untouched policies created by
  * the original operation. Reconstruct the PRE-SAVE state and compare the
  * receipt's original digest: any changed group, policy, page or owner epoch
  * makes the whole operation non-reversible. */
 private reversible(s:BotState,actor:string,now:number,event:HistoryEvent):{
  ids:string[];proof:string
 }|null{
  if(event.type!=='bulk'||!event.templateKind||event.page===null||
   !event.digest||this.alreadyReverted(s,event.nonce)||
   now<event.audit.at||now-event.audit.at>REVERT_WINDOW)return null;
  const groupSet=new Set(event.ids),groups=cardScope(s,this.policy,actor,now);
  if(event.ids.some(id=>!groups.some(c=>c.id===id))||
   s.protectionFloodWindows?.some(w=>groupSet.has(w.chatId)))return null;
  const policies:NonNullable<BotState['protectionPolicies']>=[];
  for(const id of event.ids){
   const records=(s.protectionPolicies??[]).filter(row=>row.policy.chatId===id);
   const row=records[0],group=groups.find(g=>g.id===id)!;
   if(records.length!==1||!row||!isValidGroupProtectionRecord(row)||
    row.updatedBy!==actor||row.updatedAt!==event.audit.at||
    row.chatPolicyVersion!==group.version||
    JSON.stringify(row.policy)!==JSON.stringify(template(event.templateKind,id)))
    return null;
   policies.push(row);
  }
  const stateBefore:BotState={...s,
   protectionPolicies:(s.protectionPolicies??[]).filter(row=>!groupSet.has(row.policy.chatId))};
  const before=this.bulkEvidence(stateBefore,actor,now,event.templateKind,event.page);
  if(!before||before.digest!==event.digest||
   JSON.stringify(before.eligible.map(g=>g.id))!==JSON.stringify(event.ids))return null;
  const proof=createHash('sha256').update(JSON.stringify([
   event.audit,event.receipt,event.ids,policies,
   s.privateSettingsRevision??0,s.privateFeatures['owner.dashboard']
  ])).digest('hex');
  return {ids:event.ids,proof};
 }
 private historyList(s:BotState,actor:string,pageNumber:number):OwnerInlineScreen|null{
  const entries=this.history(s,actor);
  if(!pageOf(entries,pageNumber))return null;
  const chosen=entries.slice(pageNumber*8,pageNumber*8+8);
  const rows=chosen.map(e=>[btn(
   (e.type==='bulk'?'👥 ':'📑 ')+e.ids.length+' مجموعة'+
    (this.alreadyReverted(s,e.nonce)?' · مسترجعة':' · محفوظة'),
   'gt:1:r:v:'+e.nonce)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(pageNumber)nav.push(btn('⬅️ السابق','gt:1:r:p:'+(pageNumber-1)));
  if((pageNumber+1)*8<entries.length)nav.push(btn('➡️ التالي','gt:1:r:p:'+(pageNumber+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ قوالب الإعدادات','gt:1:h'),btn('🏠 لوحة المالك','mi:1:h')]);
  const size=entries.length===2?'عمليتان':entries.length===1?'عملية واحدة':entries.length+' عمليات';
  const restored=entries.filter(e=>this.alreadyReverted(s,e.nonce)).length;
  return ui('<b>🕘 سجل تغييرات القوالب المحلية</b>\n'+
   'المحفوظ في تدقيق البوت: '+size+' · المسترجعة: '+restored+'\n'+
   'صفحة '+(pageNumber+1)+' من '+Math.max(1,Math.ceil(entries.length/8))+'\n'+
   (entries.length?'اختر عملية لعرض المجموعة أو المجموعات المستهدفة وحالة الاسترجاع.':
    'لا توجد عمليات حفظ موثقة حاليًا.')+'\n'+
   'السجل لا يثبت تنفيذ أي عقوبات Telegram؛ إنما يعرض حفظ السياسات المحلية.',
   rows);
 }

 /** Show only the template actions that affected the selected *currently*
  * approved group. The action detail still rechecks the original receipt.
  * A stale/revoked group cannot be reached with a copied history callback. */
 private groupHistoryList(s:BotState,actor:string,now:number,id:string,p:number):OwnerInlineScreen|null{
  const group=cardScope(s,this.policy,actor,now).find(c=>c.id===id);
  if(!group)return null;
  const entries=this.history(s,actor).filter(e=>e.ids.includes(id));
  if(!pageOf(entries,p))return null;
  const rows=entries.slice(p*8,p*8+8).map(e=>[btn(
   (e.type==='bulk'?'👥 جماعي · ':'📑 فردي · ')+
    (this.alreadyReverted(s,e.nonce)?'مسترجعة':'محفوظة'),
   'gt:1:r:v:'+e.nonce)]);
  const nav:{text:string;callback_data:string}[]=[];
  if(p)nav.push(btn('⬅️ السابق','gt:1:r:g:'+id+':'+(p-1)));
  if((p+1)*8<entries.length)nav.push(btn('➡️ التالي','gt:1:r:g:'+id+':'+(p+1)));
  if(nav.length)rows.push(nav);
  rows.push([btn('↩️ بطاقة المجموعة',ownerGroupCardLink(s,id)??'mi:1:i:01:01'),
   btn('🕘 سجل القوالب العام','gt:1:r:h')]);
  return ui('<b>🕘 سجل تغييرات هذه المجموعة</b>\n'+
   'المجموعة: <code>'+esc(id)+'</code>\n'+
   'العمليات الموثقة: '+(entries.length===1?'عملية واحدة':entries.length+' عمليات')+'\n'+
   'صفحة '+(p+1)+' من '+Math.max(1,Math.ceil(entries.length/8))+'\n'+
   (entries.length?'اختر عملية لقراءة تفاصيلها؛ لا توجد تغييرات تُنفذ من سجل العرض.':
    'لا توجد قوالب محفوظة موثقة لهذه المجموعة حاليًا.')+'\n'+
   'السجل محلي ولا يدل على أي عقوبات حية في Telegram.',rows);
 }

 private historyDetails(s:BotState,actor:string,now:number,nonce:string):OwnerInlineScreen|null{
  const e=this.historyEvent(s,actor,nonce);
  if(!e)return null;
  const reverted=this.alreadyReverted(s,nonce);
  const reversible=this.reversible(s,actor,now,e);
  const label=e.type==='bulk'?'تطبيق جماعي لقالب مراقبة':
   e.type==='copy'?'نسخ سياسة محلية':'حفظ قالب محلي';
  const rows:{text:string;callback_data:string}[][]=[];
  if(reversible)rows.push([btn('🔎 معاينة الاسترجاع الآمن','gt:1:r:x:'+nonce)]);
  rows.push([btn('↩️ سجل القوالب','gt:1:r:h'),btn('🏠 لوحة المالك','mi:1:h')]);
  return ui('<b>🕘 تفاصيل تغيير إعدادات المجموعات</b>\n'+
   'العملية: '+label+'\n'+
   'المجموعات المستهدفة: '+e.ids.length+'\n'+
   e.ids.map(id=>'• <code>'+esc(id)+'</code>').join('\n')+'\n'+
   'وقت الحفظ (UTC): '+new Date(e.audit.at).toISOString().slice(0,16).replace('T',' ')+'\n'+
   'الاسترجاع: '+(reverted?'مسترجعة':
    reversible?'متاح بعد تأكيد جديد':'غير متاح؛ العملية ليست جماعية أو تغيّرت الأدلة أو انتهت المهلة')+
   '\nلا توجد تغييرات حية في Telegram.',rows);
 }
 private async previewRevert(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))return null;
   const event=this.historyEvent(s,actor,nonce);
   if(!event)return null;
   const evidence=this.reversible(s,actor,now,event);
   if(!evidence)return null;
   const live=s.callbacks.filter(c=>c.action.startsWith(REVERT_PREFIX)&&
    c.actorId===actor&&!c.used&&!c.revoked&&c.expiresAt>now);
   if(live.length>=100)return null;
   const ref='c_'+randomBytes(18).toString('base64url');
   if(s.callbacks.some(c=>c.ref===ref))return null;
   s.callbacks.push({ref,action:REVERT_PREFIX+JSON.stringify([nonce,evidence.proof]),
    chatId:'private',actorId:actor,policyVersion:0,expiresAt:now+TTL,
    oneShot:true,used:false,revoked:false});
   return ui('<b>🔎 معاينة الاسترجاع الجماعي المحلي</b>\n'+
    'سيُسترجع وضع '+evidence.ids.length+' مجموعات بإزالة القوالب التي أضافتها هذه العملية فقط:\n'+
    evidence.ids.map(id=>'• <code>'+esc(id)+'</code>').join('\n')+'\n'+
    'لن تُحذف سياسات المجموعات المعدلة أو التغييرات اللاحقة؛ عند الشك تُرفض الدفعة كاملة.\n'+
    'هذا ليس تراجعًا عن عقوبات Telegram؛ لا تُنفذ أي أوامر Telegram.\n'+
    'التأكيد صالح لدقيقتين ولمرة واحدة.',
    [[btn('✅ تأكيد الاسترجاع المحلي','gt:1:r:c:'+ref.slice(2))],
     [btn('✖ إلغاء المعاينة','gt:1:k:'+ref.slice(2)),btn('↩️ تفاصيل العملية','gt:1:r:v:'+nonce)]]);
  });
 }
 private async confirmRevert(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))return null;
   const records=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=records[0];
   if(records.length!==1||!receipt||receipt.actorId!==actor||
    receipt.chatId!=='private'||receipt.policyVersion!==0||
    !receipt.action.startsWith(REVERT_PREFIX)||receipt.oneShot!==true||
    receipt.used!==false||receipt.revoked!==false||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=now||
    receipt.expiresAt>now+TTL)return null;
   let saved:unknown;
   try{saved=JSON.parse(receipt.action.slice(REVERT_PREFIX.length));}catch{return null;}
   if(!Array.isArray(saved)||saved.length!==2||
    typeof saved[0]!=='string'||!/^[A-Za-z0-9_-]{24}$/u.test(saved[0])||
    typeof saved[1]!=='string'||!/^[a-f0-9]{64}$/u.test(saved[1]))return null;
   const event=this.historyEvent(s,actor,saved[0]);
   if(!event)return null;
   const evidence=this.reversible(s,actor,now,event);
   if(!evidence||evidence.proof!==saved[1])return null;
   const ids=new Set(evidence.ids);
   s.protectionPolicies=(s.protectionPolicies??[]).filter(row=>!ids.has(row.policy.chatId));
   receipt.used=true;
   s.audit.push({actorId:actor,updateKey:'group-template-bulk-rollback:'+event.nonce,
    decision:'ALLOW',reason:'GROUP_TEMPLATE_BULK_MONITOR_REVERTED',
    policyVersion:0,at:now});
   return ui('<b>✅ استرجاع القالب الجماعي محليًا</b>\n'+
    'أزيلت القواعد المحفوظة في '+evidence.ids.length+' مجموعات دون مساس بأي سياسة أخرى.\n'+
    'تم تسجيل العملية في سجل التدقيق؛ لا توجد أوامر Telegram حية.',
    [[btn('🕘 سجل تغييرات القوالب','gt:1:r:h'),btn('📋 مجموعاتي','mi:1:i:01:01')],
     [btn('🏠 لوحة المالك','mi:1:h')]]);
  });
 }


 /** Cancels an existing preview's authority, not merely its navigation. It
  * must not revoke unrelated callbacks or policies. The token is tombstoned
  * atomically and cannot be confirmed even if its old message is replayed. */
 private async cancel(actor:string,nonce:string):Promise<OwnerInlineScreen|null>{
  return this.store.transaction(s=>{
   const now=this.clock();
   if(!this.auth(s,actor,now))return null;
   const rows=s.callbacks.filter(c=>c.ref==='c_'+nonce),receipt=rows[0];
   if(rows.length!==1||!receipt||
    ![PREFIX,BULK_PREFIX,REVERT_PREFIX].some(prefix=>receipt.action.startsWith(prefix))||
    receipt.actorId!==actor||receipt.chatId!=='private'||receipt.policyVersion!==0||
    receipt.oneShot!==true||receipt.used!==false||receipt.revoked!==false||
    !Number.isSafeInteger(receipt.expiresAt)||receipt.expiresAt<=now||
    receipt.expiresAt>now+TTL)return null;
   receipt.revoked=true;
   s.audit.push({actorId:actor,updateKey:'group-template-cancel:'+nonce,
    decision:'NOOP',reason:'GROUP_TEMPLATE_PREVIEW_CANCELLED',
    policyVersion:0,at:now});
   return ui('<b>✖ أُلغيت المعاينة</b>\n'+
    'تم إبطال رمز التأكيد نهائيًا. لا يمكن إعادة استخدام الرسالة القديمة.\n'+
    'لم تتغير أي سياسة حماية أو صلاحية في المجموعة، ولا توجد أوامر Telegram حية.',
    [[btn('📑 قوالب الإعدادات','gt:1:h'),
      btn('🕘 سجل تغييرات القوالب','gt:1:r:h')],
     [btn('🏠 لوحة المالك','mi:1:h')]]);
  });
 }

 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validGroupPolicyStudioRoute(data))return null;
  const cancelled=cancelPreview.exec(data);
  if(cancelled)return this.cancel(actor,cancelled[1]!);
  const undo=revertConfirm.exec(data);
  if(undo)return this.confirmRevert(actor,undo[1]!);
  const bulkConfirmation=bulkConfirm.exec(data);
  if(bulkConfirmation)return this.confirmBulk(actor,bulkConfirmation[1]!);
  const confirmation=confirm.exec(data);
  if(confirmation)return this.confirm(actor,confirmation[1]!);
  const state=await this.store.snapshot(),now=this.clock();
  if(!this.auth(state,actor,now))return null;
  const historyPageMatch=historyPage.exec(data);
  if(historyHome.test(data)||historyPageMatch){
   return this.historyList(state,actor,historyPageMatch?Number(historyPageMatch[1]):0);
  }
  const groupEntry=groupHistory.exec(data);
  if(groupEntry)return this.groupHistoryList(state,actor,now,groupEntry[1]!,Number(groupEntry[2]));
  const viewed=historyView.exec(data);
  if(viewed)return this.historyDetails(state,actor,now,viewed[1]!);
  const undoView=revertPreview.exec(data);
  if(undoView)return this.previewRevert(actor,undoView[1]!);
  const groups=cardScope(state,this.policy,actor,now);
  const targetsForPreset=groups.filter(g=>!(state.protectionPolicies??[]).some(r=>r.policy.chatId===g.id));
  if(data==='gt:1:b:h'||data==='mi:1:i:01:08'){
   return ui('<b>👥 الإجراءات الجماعية — قوالب مراقبة محلية</b>\n'+
    'تطبيق قالب على حتى 8 مجموعات معتمدة في صفحة واحدة، دون الكتابة فوق السياسات القائمة.\n'+
    'المعاينة ثم التأكيد إلزاميان؛ لا عقوبات أو تغييرات Telegram.',
    [[btn('📚 القالب الدراسي الجماعي','gt:1:b:p:e:0')],
     [btn('🔗 مراجعة الروابط جماعيًا','gt:1:b:p:l:0')],
     [btn('🛑 إيقاف خدمات مجموعات جماعيًا','gb:1:h')],
     [btn('🕘 سجل تغييرات القوالب','gt:1:r:h')],
     [btn('↩️ المجموعات والشبكات','mi:1:s:01:0'),btn('🏠 لوحة المالك','mi:1:h')]]);
  }
  const bp=bulkPage.exec(data);
  if(bp)return this.bulkPageView(actor,state,bp[1] as 'e'|'l',Number(bp[2]));
  const bv=bulkPreview.exec(data);
  if(bv)return this.previewBulk(actor,bv[1] as 'e'|'l',Number(bv[2]));
  if(data==='gt:1:h'||data==='mi:1:i:01:06'){
   return ui('<b>📑 قوالب إعدادات المجموعات</b>\n'+
    'قوالب محلية مقيدة بوضع المراقبة، وليست أوامر حماية حية.\n'+
    'الحفظ لمجموعة معتمدة بلا سياسة سابقة، وبعد معاينة وتأكيد.',
    [[btn('📚 القالب الدراسي الفارغ','gt:1:p:e:0')],
     [btn('🔗 مراجعة الروابط','gt:1:p:l:0')],
     [btn('🔄 نسخ ومقارنة مجموعة','gt:1:s:0')],
     [btn('🕘 سجل تغييرات القوالب','gt:1:r:h')],
     [btn('↩️ المجموعات والشبكات','mi:1:s:01:0'),btn('🏠 لوحة المالك','mi:1:h')]]);
  }
  const p=preset.exec(data);
  if(p)return this.listGroups('📑 اختيار مجموعة لتطبيق القالب',targetsForPreset,Number(p[2]),
   chat=>key(p[1] as Mode,chat),'gt:1:p:'+p[1]+':'+p[2],
   'اختيار مجموعة — لا يمكن الكتابة فوق إعدادات حماية موجودة.');
  const v=choose.exec(data);
  if(v)return this.preview(actor,v[1] as Mode,'',v[2]!,Number(v[3]));
  if(data==='mi:1:i:01:07'||sources.test(data)){
   const page= data==='mi:1:i:01:07'?0:Number(sources.exec(data)![1]);
   const rows=groups.filter(chat=>sourceRecord(state,chat,now)!==null);
   if(!pageOf(rows,page))return null;
   const visible=rows.slice(page*8,page*8+8).map(chat=>[btn('👥 '+chat.id,'gt:1:d:'+chat.id+':0')]);
   const navigation:{text:string;callback_data:string}[]=[];
   if(page)navigation.push(btn('⬅️ السابق','gt:1:s:'+(page-1)));
   if((page+1)*8<rows.length)navigation.push(btn('➡️ التالي','gt:1:s:'+(page+1)));
   if(navigation.length)visible.push(navigation);
   visible.push([btn('↩️ قوالب الإعدادات','gt:1:h'),btn('🏠 لوحة المالك','mi:1:h')]);
   return ui('<b>🔄 نسخ ومقارنة إعدادات المجموعات</b>\n'+
    'اختر المجموعة المصدر التي لديها سياسة حفظ محلية سليمة.\n'+
    'سيُنقل تعريف القواعد فقط، دون الاستثناءات أو بيانات الأعضاء أو العقوبات.\n'+
    'المصادر: '+rows.length+' · صفحة '+(page+1)+' من '+Math.max(1,Math.ceil(rows.length/8))+'\n'+
    'لا نسخ فوق سياسة موجودة ولا إرسال إلى Telegram.',visible);
  }
  const d=targets.exec(data);
  if(d){
   const sourceId=d[1]!,source=groups.find(c=>c.id===sourceId);
   if(!source||!sourceRecord(state,source,now))return null;
   const choices=groups.filter(c=>c.id!==sourceId);
   return this.listGroups('🔄 اختيار المجموعة الهدف للنسخ أو المقارنة',choices,Number(d[2]),
    chat=>(state.protectionPolicies??[]).some(r=>r.policy.chatId===chat.id)?
     'gt:1:q:'+sourceId+':'+chat.id:'gt:1:x:'+sourceId+':'+chat.id,
    'gt:1:d:'+sourceId+':'+d[2],
    'المجموعة المصدر: '+esc(sourceId)+'\nالهدف بلا سياسة: معاينة النسخ. الهدف بسياسة قائمة: مقارنة للقراءة فقط، دون استبدال.');
  }
  const q=compareOnly.exec(data);
  if(q){
   const from=groups.find(c=>c.id===q[1]),to=groups.find(c=>c.id===q[2]);
   if(!from||!to||from.id===to.id)return null;
   const source=sourceRecord(state,from,now),target=sourceRecord(state,to,now);
   if(!source||!target)return null;
   const srcCount=source.policy.rules.length,dstCount=target.policy.rules.length;
   const srcActive=source.policy.rules.filter(r=>r.enabled).length;
   const dstActive=target.policy.rules.filter(r=>r.enabled).length;
   return ui('<b>🔍 مقارنة سياسات حماية محلية</b>\n'+
    'المصدر: <code>'+esc(from.id)+'</code>\n'+
    'الهدف: <code>'+esc(to.id)+'</code>\n'+
    'قواعد المصدر: '+srcCount+' · المفعلة: '+srcActive+'\n'+
    'قواعد الهدف: '+dstCount+' · المفعلة: '+dstActive+'\n'+
    'وضع المصدر: '+(source.policy.mode==='MONITOR'?'مراقبة فقط':'متوقفة')+'\n'+
    'وضع الهدف: '+(target.policy.mode==='MONITOR'?'مراقبة فقط':'متوقفة')+'\n'+
    'السماح: '+source.policy.allowedDomains.length+' نطاقًا في المصدر، '+
     target.policy.allowedDomains.length+' في الهدف.\n'+
    'لا يمكن النسخ فوق سياسة موجودة. هذه مقارنة للقراءة فقط؛ لم تُعدّل أي قواعد أو حقوق Telegram.',
    [[btn('↩️ اختيار الهدف','gt:1:d:'+from.id+':0'),
      btn('🏠 لوحة المالك','mi:1:h')]]);
  }
  const x=compare.exec(data);
  if(x)return this.preview(actor,'c',x[1]!,x[2]!);
  return null;
 }
}
