import {createHash,randomBytes} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';

type Case={chat:string;member:string;reference:string;kind:'WARNING'|'BAN'|'MUTE';source:string};
type Appeal=Case&{id:string;at:number;version:number;status:'OPEN'|'ACCEPTED'|'REJECTED'};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const names={WARNING:'تحذير',BAN:'حظر',MUTE:'كتم',OPEN:'قيد المراجعة',ACCEPTED:'مراجعة مقبولة',REJECTED:'مرفوض'};
const ROOT='moderation:appeal:',PREFIX='MODERATION_APPEAL_OPEN:';
const route=/^ap:1:([hrj]):(0|[1-9][0-9]{0,2})$|^ap:1:([dpcaxv]):(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$/u;
export const validModerationAppealRoute=(data:string)=>route.exec(data)?.[0]===data&&!data.includes(' ');
const b=(text:string,callback_data:string)=>({text,callback_data});
const escape=(s:string)=>s.replace(/[&<>]/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!));
function ownCases(s:BotState,p:Policy,actor:string):Case[]{
 const values:Case[]=[];
 for(const w of s.warnings)if(w.memberId===actor&&w.active)values.push({chat:w.chatId,member:actor,reference:w.reference,kind:'WARNING',source:hash(w)});
 for(const r of s.moderationReasons)if(r.memberId===actor&&r.active&&r.source==='MANUAL')values.push({chat:r.chatId,member:actor,reference:r.reference,kind:r.kind,source:hash(r)});
 return values.filter(c=>c.reference.length>=1&&c.reference.length<=128&&p.canUseChat(s,c.chat,'moderation')).sort((a,b)=>a.chat.localeCompare(b.chat)||a.reference.localeCompare(b.reference)||a.kind.localeCompare(b.kind));
}
function readAppeals(s:BotState):Appeal[]{
 const result:Appeal[]=[];
 const byKey=new Map<string,typeof s.audit>();for(const a of s.audit){const rows=byKey.get(a.updateKey)??[];rows.push(a);byKey.set(a.updateKey,rows);}
 for(const a of s.audit){
  if(!a.updateKey.startsWith(ROOT)||!a.reason.startsWith(PREFIX)||!a.actorId||byKey.get(a.updateKey)?.length!==1||!Number.isSafeInteger(a.at)||a.at<0||!/^moderation:appeal:[A-Za-z0-9_-]{24}$/u.test(a.updateKey))continue;
  try{
   const c:unknown=JSON.parse(Buffer.from(a.reason.slice(PREFIX.length),'base64url').toString('utf8'));
   if(!c||typeof c!=='object'||Array.isArray(c))continue;const v=c as Record<string,unknown>;
   if(Object.keys(v).sort().join(',')!=='chat,kind,member,reference,source'||typeof v.chat!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(v.chat)||v.member!==a.actorId||typeof v.reference!=='string'||v.reference.length>128||!['WARNING','BAN','MUTE'].includes(String(v.kind))||typeof v.source!=='string'||!/^[a-f0-9]{64}$/u.test(v.source))continue;
   const decisions=byKey.get(a.updateKey+':decision')??[];
   if(decisions.length>1)continue;const status=decisions[0]?.reason==='MODERATION_APPEAL_ACCEPTED'?'ACCEPTED':decisions[0]?.reason==='MODERATION_APPEAL_REJECTED'?'REJECTED':'OPEN';
   result.push({...v as Case,id:a.updateKey.slice(ROOT.length),at:a.at,version:a.policyVersion,status});
  }catch{/* malformed audit entries cannot become an appeal */}
 }
 return result.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
}
export class TelegramModerationAppeals{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){}
 private manager(s:BotState,actor:string,chat:string):boolean{return this.policy.canUseChat(s,chat,'moderation')&&this.policy.has(s,actor,'chat.manage',chat,this.clock())&&(!this.policy.isOwner(actor)||this.policy.privateFeature(s,'owner.dashboard',actor));}
 private digest(s:BotState,actor:string,mode:'own'|'review'):string{return hash([actor,mode,s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision,ownCases(s,this.policy,actor),s.warnings,s.moderationReasons,readAppeals(s)]).slice(0,16);}
 async handle(actor:string,data:string):Promise<(OwnerInlineScreen&{access?:AdminUIAccess})|null>{
  if(!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor))||!validModerationAppealRoute(data))return null;
  return this.store.transaction(s=>{
   const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!this.policy.privateFeature(s,'support.use',actor))return null;
   const m=route.exec(data)!,kind=m[1]??m[3]!,page=Number(m[2]??m[4]),slot=Number(m[5]??1),review=['r','p','a','x'].includes(kind),mode=review?'review' as const:'own' as const;
   const appeals=readAppeals(s),visible=appeals.filter(a=>review?this.manager(s,actor,a.chat):a.member===actor&&this.policy.canUseChat(s,a.chat,'moderation'));
   if(review&&!protectionUIEpoch(s,this.policy,actor,now))return null;
   const journal=kind==='j'||kind==='v',cases=ownCases(s,this.policy,actor),entries=review||journal?visible:cases;
   const proof=this.digest(s,actor,mode);if(m[6]!==undefined&&m[6]!==proof)return null;
   if(page>=Math.max(1,Math.ceil(entries.length/8)))return null;
   const build=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen&{access?:AdminUIAccess}=>{
    const epoch=review?protectionUIEpoch(s,this.policy,actor,now):null;
    return {text,keyboard:{inline_keyboard:rows},...(epoch?{access:{actorId:actor,epoch,expiresAt:now+120000}}:{})};
   };
   const ownHome=()=>b('↩️ حالاتي','ap:1:h:'+page),reviewHome=()=>b('↩️ الاعتراضات','ap:1:r:'+page);
   if(kind==='h'||kind==='r'||kind==='j'){
    if(review&&!this.policy.isOwner(actor)&&!s.chats.some(c=>this.manager(s,actor,c.id)))return null;
    const rows=entries.slice(page*8,page*8+8).map((e,i)=>[b((review||journal?names[(e as Appeal).status]+' · ':'')+e.chat+' · '+names[e.kind],'ap:1:'+(review?'p':journal?'v':'d')+':'+page+':'+(i+1)+':'+proof)]);
    if(page>0)rows.push([b('⬅️ السابق','ap:1:'+kind+':'+(page-1))]);if((page+1)*8<entries.length)rows.push([b('➡️ التالي','ap:1:'+kind+':'+(page+1))]);

    if(!review&&!journal&&visible.length)rows.push([b('📋 سجل طلباتي','ap:1:j:0')]);
    if(journal)rows.push([b('↩️ حالاتي','ap:1:h:0')]);
    rows.push([b('🏠 الرئيسية','pn:1:h')]);
    return build(journal?'سجل طلباتك الخاصة — صفحة '+(page+1):review?'اعتراضات المجموعات المخولة — صفحة '+(page+1)+'\nالقبول يسجل قرار المراجعة فقط؛ لا يرفع عقوبة تلقائيًا.':'حالاتك اليدوية النشطة — صفحة '+(page+1)+'\nاختر حالة لطلب مراجعتها. لن يُحفظ نص حر أو يُرسل بلاغ علني. أسباب الاشتراك تُعالج من التحقق.\nطلباتك: '+visible.map(a=>names[a.kind]+' '+names[a.status]).slice(0,8).join('، '),rows);
   }
   const selected=entries[page*8+slot-1];if(!selected)return null;
   if(journal){const a=selected as Appeal;return build('طلبك الخاص\nالمجموعة: '+a.chat+'\nالنوع: '+names[a.kind]+'\nالمرجع: '+escape(a.reference)+'\nالحالة: '+names[a.status]+'\nالقبول يسجل المراجعة ولا يرفع عقوبة تلقائيًا.',[[b('↩️ سجل طلباتي','ap:1:j:'+page)]]);}
   if(!review){const c=selected as Case;
    if(kind==='d')return build('طلب مراجعة الحالة؟\nالمجموعة: '+c.chat+'\nالنوع: '+names[c.kind]+'\nالمرجع: '+escape(c.reference)+'\nعند التأكيد يُحفظ رقم حسابك ومرجع الحالة وموعد الطلب في سجل خاص للمشرف المخول. لا يرفع الطلب العقوبة ولا يغير أسباب الاشتراك.',[[b('✅ تأكيد طلب المراجعة','ap:1:c:'+page+':'+slot+':'+proof)],[ownHome()]]);
    if(kind!=='c')return null;
    if(appeals.some(a=>a.member===actor&&a.chat===c.chat&&a.source===c.source&&a.version===this.policy.chatRevision(s,c.chat)))return build('يوجد طلب مسجل لهذه النسخة من الحالة؛ راجع حالته من قائمة حالاتك.',[[ownHome()]]);
    if(appeals.filter(a=>a.member===actor&&a.at>now-86400000).length>=3||appeals.filter(a=>a.chat===c.chat&&a.status==='OPEN').length>=200)return build('بلغت حد طلبات المراجعة الحالي. حاول لاحقًا.',[[ownHome()]]);
    const id=randomBytes(18).toString('base64url');s.audit.push({actorId:actor,updateKey:ROOT+id,decision:'ALLOW',reason:PREFIX+Buffer.from(JSON.stringify(c)).toString('base64url'),policyVersion:this.policy.chatRevision(s,c.chat),at:now});
    return build('سُجل طلب المراجعة الخاص. لا تغيير في العقوبة؛ تابع الحالة من /appeals.',[[ownHome()]]);
   }
   const a=selected as Appeal;if(!this.manager(s,actor,a.chat)||a.at>now||a.version!==this.policy.chatRevision(s,a.chat))return null;
   const current=ownCases(s,this.policy,a.member).some(c=>c.chat===a.chat&&c.source===a.source&&c.kind===a.kind&&c.reference===a.reference);
   if(kind==='p')return build('طلب مراجعة خاص\nالمجموعة: '+a.chat+'\nالعضو: '+a.member+'\nالنوع: '+names[a.kind]+'\nالمرجع: '+escape(a.reference)+'\nالحالة: '+names[a.status]+'\n'+(current?'المصدر الحالي مطابق.':'تغير المصدر؛ القرار محجوب.')+'\nقبول المراجعة لا يرفع العقوبة. استخدم مسار الإلغاء الخاص المستقل بعد القرار.',[...(a.status==='OPEN'&&current?[[b('✅ قبول المراجعة','ap:1:a:'+page+':'+slot+':'+proof),b('❌ رفض الطلب','ap:1:x:'+page+':'+slot+':'+proof)]]:[]),[reviewHome()]]);
   if(!['a','x'].includes(kind)||a.status!=='OPEN'||!current)return null;
   s.audit.push({actorId:actor,updateKey:ROOT+a.id+':decision',decision:'ALLOW',reason:kind==='a'?'MODERATION_APPEAL_ACCEPTED':'MODERATION_APPEAL_REJECTED',policyVersion:a.version,at:now});
   return build('سُجل قرار المراجعة. لم يُنفذ رفع قيد أو إلغاء تحذير.',[[reviewHome()],[b('🔍 حالات الإشراف','cs:1:h:'+(a.kind==='WARNING'?'w':'b')+':0')]]);
  });
 }
}
