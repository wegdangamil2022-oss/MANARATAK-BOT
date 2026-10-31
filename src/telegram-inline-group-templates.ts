import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore,Chat} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {isValidGroupProtectionRecord,isValidProtectionPolicy,
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
const confirm=/^gt:1:c:([A-Za-z0-9_-]{24})$/u;
const TTL=120_000,PREFIX='group-template-confirm:';
type Mode='e'|'l'|'c';
type Evidence={kind:Mode;sourceId:string;targetId:string;targetVersion:number;proof:string};
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
 return createHash('sha256').update(JSON.stringify([source??null,record??null,target])).digest('hex');
}
export function validGroupPolicyStudioRoute(data:unknown):boolean{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return false;
 if(root.test(data)||confirm.test(data))return true;
 return [preset,choose,sources,targets,compare].some(re=>re.test(data));
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
   const count=e.policy.rules.length,kindLabel=kind==='c'?'نسخ قواعد مجموعة':'قالب حماية';
   const returnTo=kind==='c'?'gt:1:d:'+sourceId+':0':'gt:1:p:'+kind+':0';
   const sourceText=kind==='c'?'المصدر: <code>'+esc(sourceId)+'</code>\n':'';
   const note=kind==='c'?
    'الاستثناءات والنطاقات المسموحة وأعضاء الاستثناء لن تُنسخ.':
    kind==='l'?'مراجعة الروابط في وضع المراقبة فقط.':'قالب دراسي فارغ في وضع المراقبة فقط.';
   return ui('<b>معاينة '+kindLabel+'</b>\n'+sourceText+
    'الهدف: <code>'+esc(targetId)+'</code>\n'+
    'قواعد القالب: '+count+'\n'+
    'الحماية: '+(e.policy.mode==='MONITOR'?'مراقبة فقط':'متوقفة')+'\n'+
    note+'\n'+
    'لن تُكتب الإعدادات إلا بعد التأكيد لمرة واحدة خلال دقيقتين. '+
    'لا نسخ فوق سياسة موجودة، ولا حظر أو حذف أو كتم عبر Telegram.',
    [[btn(kind==='c'?'✅ تأكيد النسخ المحلي':'✅ تأكيد حفظ القالب','gt:1:c:'+ref.slice(2))],
     [btn('↩️ إلغاء والعودة',returnTo),btn('🏠 لوحة المالك','mi:1:h')]]);
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
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actor)||!validGroupPolicyStudioRoute(data))return null;
  const confirmation=confirm.exec(data);
  if(confirmation)return this.confirm(actor,confirmation[1]!);
  const state=await this.store.snapshot(),now=this.clock();
  if(!this.auth(state,actor,now))return null;
  const groups=cardScope(state,this.policy,actor,now);
  const targetsForPreset=groups.filter(g=>!(state.protectionPolicies??[]).some(r=>r.policy.chatId===g.id));
  if(data==='gt:1:h'||data==='mi:1:i:01:06'){
   return ui('<b>📑 قوالب إعدادات المجموعات</b>\n'+
    'قوالب محلية مقيدة بوضع المراقبة، وليست أوامر حماية حية.\n'+
    'الحفظ لمجموعة معتمدة بلا سياسة سابقة، وبعد معاينة وتأكيد.',
    [[btn('📚 القالب الدراسي الفارغ','gt:1:p:e:0')],
     [btn('🔗 مراجعة الروابط','gt:1:p:l:0')],
     [btn('🔄 نسخ ومقارنة مجموعة','gt:1:s:0')],
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
   const choices=targetsForPreset.filter(c=>c.id!==sourceId);
   return this.listGroups('🔄 اختيار المجموعة الهدف للنسخ',choices,Number(d[2]),
    chat=>'gt:1:x:'+sourceId+':'+chat.id,
    'gt:1:d:'+sourceId+':'+d[2],
    'المجموعة المصدر: '+esc(sourceId)+'\nاختر المجموعة الهدف التي ليس لها سياسة حماية محفوظة.');
  }
  const x=compare.exec(data);
  if(x)return this.preview(actor,'c',x[1]!,x[2]!);
  return null;
 }
}
