import {randomBytes} from 'node:crypto';
import type {BotState,BotStore,Chat,Wizard} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {evaluateProtectionRules,isValidProtectionPolicy,type ProtectionPolicy} from './protection-rules.js';
import {delegationGroupEntry} from './telegram-inline-delegation-edit.js';

const TTL=30*60*1000;
const start=/^gw:1:b:(-[1-9][0-9]{0,15}):([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,2})$/u;
const action=/^gw:1:([A-Za-z0-9_-]{16}):([1-9][0-9]{0,9}):([nbltcsx])$/u;
const flow=/^group-setup:(-[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,2}):([_bl])$/u;
export function validGroupSetupRoute(data:string):boolean {
 if(typeof data!=='string'||Buffer.byteLength(data)>64)return false;
 const m=start.exec(data)??action.exec(data);return Boolean(m&&m[0]===data);
}
const btn=(text:string,callback_data:string)=>({text,callback_data});
const ui=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({text,keyboard:{inline_keyboard:rows}});
const esc=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
/** Persisted, owner-only local setup. Telegram rights are never inferred from local records. */
export class OwnerGroupSetup {
 constructor(private store:BotStore,private policy:Policy,private clock:()=>number=Date.now){}
 private valid(s:BotState,actor:string,id:string,revision:number,now:number):Chat|null{
  if(!this.policy.isOwner(actor)||!this.policy.privateFeature(s,'owner.dashboard',actor)||!Number.isSafeInteger(now)||now<0||now>8640000000000000-TTL||
   !Number.isSafeInteger(Number(id))||!this.policy.canUseChat(s,id,'moderation')||!this.policy.has(s,actor,'chat.manage',id,now))return null;
  const chats=s.chats.filter(c=>c.id===id);return chats.length===1&&chats[0]!.version===revision?chats[0]!:null;
 }
 private config(id:string,template:string):ProtectionPolicy{
  return {chatId:id,revision:1,mode:'MONITOR',rules:template==='l'?[{id:'setup_links',kind:'LINK',hosts:'*',enabled:true,action:'REVIEW'}]:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]};
 }
 private render(s:BotState,w:Wizard,id:string,page:number,template:string,notice=''):OwnerInlineScreen{
  const token=w.key.slice('group-setup:'.length),key=(a:string)=>'gw:1:'+token+':'+w.version+':'+a;
  const back=btn('↩️ بطاقة المجموعة','mi:1:g:d:'+id+':'+w.policyVersion+':'+page);
  const cancel=btn('إلغاء المعالج',key('x'));
  const title='<b>معالج إعداد المجموعة</b>\nالمجموعة: <code>'+esc(id)+'</code>\n'+(notice?esc(notice)+'\n':'');
  if(w.step===0){const delegation=delegationGroupEntry(s,id,w.policyVersion);return ui(title+'١/٤ صلاحية المالك المحلية معتمدة لنطاق الحماية. يمكن إضافة تفويض داخلي للمجموعة.\nحقوق البوت في Telegram: لم تُفحص حيًا. المتابعة تضبط المراقبة المحلية فقط ولا تمنح حقوقًا.',[...(delegation?[[btn('➕ تفويض في هذه المجموعة',delegation)]]:[]),[btn('متابعة الإعداد المحلي',key('n'))],[back,cancel]]);}
  if(w.step===1)return ui(title+'٢/٤ اختر قالب المراقبة. لن تُمس أي سياسة موجودة.',[[btn('قالب فارغ',key('b')),btn('مراجعة الروابط',key('l'))],[btn('↩️ السابق',key('s')),cancel]]);
  if(w.step===2)return ui(title+'٣/٤ القالب: '+(template==='l'?'اقتراح مراجعة الروابط':'فارغ')+'\nاختبره بعينة ثابتة دون إرسال بيانات أو تنفيذ إجراء.',[[btn('🧪 اختبار القالب',key('t'))],[btn('↩️ السابق',key('s')),cancel]]);
  return ui(title+'٤/٤ الاختبار المحلي نجح. القالب: '+(template==='l'?'مراجعة الروابط':'فارغ')+'\nتأكيد الحفظ يشغل وضع المراقبة المحلي فقط؛ لا حذف ولا كتم تلقائي. حقوق Telegram لم تُفحص.',[[btn('✅ تأكيد تشغيل المراقبة',key('c'))],[btn('↩️ السابق',key('s')),cancel]]);
 }
 async handle(actor:string,data:string):Promise<OwnerInlineScreen|null>{
  if(typeof data!=='string'||Buffer.byteLength(data)>64)return null;
  if(!validGroupSetupRoute(data))return null;
  const begin=start.exec(data),a=action.exec(data);if(!begin&&!a)return null;
  try{return await this.store.transaction(s=>{
   const now=this.clock();
   if(begin){
    const id=begin[1]!,revision=Number(begin[2]),page=Number(begin[3]);
    const approved=s.chats.filter(c=>c.approved&&s.chats.filter(x=>x.id===c.id).length===1&&/^-[1-9][0-9]{0,18}$/u.test(c.id)&&Number.isSafeInteger(c.version)&&c.version>=1&&c.version<=9999999999).sort((x,y)=>x.id.localeCompare(y.id));
    if(!this.valid(s,actor,id,revision,now)||!approved.slice(page*8,page*8+8).some(c=>c.id===id)||s.protectionPolicies?.some(r=>r.policy.chatId===id))return null;
    const existing=s.wizards.filter(w=>w.userId===actor&&w.chatId===actor&&w.status==='ACTIVE'&&w.expiresAt>now&&w.flow.startsWith('group-setup:'+id+':'));
    if(existing.length>1)return null;
    let w=existing[0];
    if(w){const match=flow.exec(w.flow);if(!match||w.policyVersion!==revision||Number(match[2])!==page||!/^group-setup:[A-Za-z0-9_-]{16}$/u.test(w.key)||!Number.isSafeInteger(w.version)||w.version<1||w.step<0||w.step>3)return null;return this.render(s,w,id,page,match[3]!,'استُعيد التقدم المحفوظ.');}
    s.wizards=s.wizards.filter(w=>!w.flow.startsWith('group-setup:')||w.status==='ACTIVE'&&w.expiresAt>now);
    if(s.wizards.filter(w=>w.flow.startsWith('group-setup:')).length>=100)return null;
    const token=randomBytes(12).toString('base64url');
    w={key:'group-setup:'+token,userId:actor,chatId:actor,topicId:'',flow:'group-setup:'+id+':'+page+':_',step:0,version:1,expiresAt:now+TTL,policyVersion:revision,status:'ACTIVE'};
    s.wizards.push(w);return this.render(s,w,id,page,'_');
   }
   const rows=s.wizards.filter(w=>w.key==='group-setup:'+a![1]);if(rows.length!==1)return null;
   const w=rows[0]!,m=flow.exec(w.flow);if(!m||w.userId!==actor||w.chatId!==actor||w.topicId!==''||w.status!=='ACTIVE'||w.version!==Number(a![2])||!Number.isSafeInteger(w.version)||w.version>=9999999999||!Number.isSafeInteger(w.expiresAt)||w.expiresAt<=now||w.expiresAt>now+TTL||!Number.isSafeInteger(w.step)||w.step<0||w.step>3)return null;
   const id=m[1]!,page=Number(m[2]),template=m[3]!,op=a![3]!;
   if(!this.valid(s,actor,id,w.policyVersion,now)||s.protectionPolicies?.some(r=>r.policy.chatId===id))return null;
   if(op==='x'){w.status='CANCELLED';w.version++;return ui('أُلغي معالج إعداد المجموعة دون تغيير سياسة الحماية.',[[btn('↩️ بطاقة المجموعة','mi:1:g:d:'+id+':'+w.policyVersion+':'+page)]]);}
   if(op==='s'&&w.step>0){w.step--;if(w.step<2)w.flow='group-setup:'+id+':'+page+':_';}
   else if(op==='n'&&w.step===0)w.step=1;
   else if((op==='b'||op==='l')&&w.step===1){w.flow='group-setup:'+id+':'+page+':'+op;w.step=2;}
   else if(op==='t'&&w.step===2&&(template==='b'||template==='l')){
    const result=evaluateProtectionRules(this.config(id,template),{chatId:id,memberId:'999',type:'TEXT',text:'https://example.org'});
    if(result.authorizedToSend||result.status!==(template==='l'?'MATCH':'CLEAR'))return null;w.step=3;
   }else if(op==='c'&&w.step===3&&(template==='b'||template==='l')){
    const config=this.config(id,template);if(!isValidProtectionPolicy(config))return null;
    s.protectionPolicies??=[];s.protectionPolicies.push({policy:config,chatPolicyVersion:w.policyVersion,updatedBy:actor,updatedAt:now});
    s.audit.push({actorId:actor,updateKey:'group-setup:'+a![1],decision:'ALLOW',reason:'GROUP_SETUP_MONITOR_SAVED',policyVersion:w.policyVersion,at:now});
    w.status='CANCELLED';w.version++;return ui('<b>حُفظ إعداد المراقبة ✅</b>\nالمجموعة: <code>'+esc(id)+'</code>\nالحماية مراقبة محلية فقط. لم تُفحص حقوق Telegram ولم يُفعّل الحذف أو الكتم التلقائي.',[[btn('↩️ بطاقة المجموعة','mi:1:g:d:'+id+':'+w.policyVersion+':'+page)],[btn('🏠 لوحة المالك','mi:1:h')]]);
   }else return null;
   w.version++;const current=flow.exec(w.flow)!;return this.render(s,w,id,page,current[3]!,op==='t'?'نجح اختبار القالب.':'');
  });}catch{return null;}
 }
}
