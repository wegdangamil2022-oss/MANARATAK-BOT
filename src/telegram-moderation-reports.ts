import {createHash,randomBytes} from 'node:crypto';
import type {BotStore,BotState} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import {parseReplyModerationCommand} from './telegram-moderation-commands.js';
const ROUTE=/^rp:1:([hr]):(0|[1-9][0-9]{0,2})$|^rp:1:([dxc]):([or]):(0|[1-9][0-9]{0,2}):([1-8]):([a-f0-9]{16})$/u;
export const validModerationReportRoute=(data:string)=>ROUTE.exec(data)?.[0]===data;
const ROOT='moderation:report:',PREFIX='MODERATION_REPORT:';
type Report={id:string;actor:string;chat:string;member:string;message:number;at:number;version:number;closed:boolean};
const b=(text:string,callback_data:string)=>({text,callback_data});
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
function records(s:BotState):Report[]{
 const keyed=new Map<string,typeof s.audit>();for(const a of s.audit){const rows=keyed.get(a.updateKey)??[];rows.push(a);keyed.set(a.updateKey,rows);}
 const rows:Report[]=[];
 for(const a of s.audit){
  if(!/^moderation:report:[A-Za-z0-9_-]{24}$/u.test(a.updateKey)||keyed.get(a.updateKey)?.length!==1||!a.reason.startsWith(PREFIX)||!a.actorId)continue;
  try{const v:unknown=JSON.parse(Buffer.from(a.reason.slice(PREFIX.length),'base64url').toString('utf8'));
   if(!v||typeof v!=='object'||Array.isArray(v))continue;const r=v as Record<string,unknown>;
   if(Object.keys(r).sort().join(',')!=='chat,member,message'||typeof r.chat!=='string'||!/^-[1-9][0-9]{0,15}$/u.test(r.chat)||typeof r.member!=='string'||!/^[1-9][0-9]{0,15}$/u.test(r.member)||!Number.isSafeInteger(r.message)||Number(r.message)<=0||!Number.isSafeInteger(a.at)||a.at<0)continue;
   const decisions=keyed.get(a.updateKey+':closed')??[];if(decisions.length>1)continue;
   rows.push({id:a.updateKey.slice(ROOT.length),actor:a.actorId,chat:r.chat,member:r.member,message:Number(r.message),at:a.at,version:a.policyVersion,closed:decisions.length===1&&decisions[0]!.reason==='MODERATION_REPORT_CLOSED'});
  }catch{/* untrusted journal rows never become reports */}
 }
 return rows.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id));
}
export class TelegramModerationReports{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number){}
 private manager(s:BotState,actor:string,chat:string):boolean{return this.policy.canUseChat(s,chat,'moderation')&&this.policy.has(s,actor,'chat.manage',chat,this.clock())&&(!this.policy.isOwner(actor)||this.policy.privateFeature(s,'owner.dashboard',actor));}
 async submit(actor:string,chat:string,messageId:number|undefined,reply:unknown):Promise<'RECORDED'|'INVALID'|'DENIED'|'DUPLICATE'|'LIMIT'>{
  const parsed=parseReplyModerationCommand('/warn report','ManaratakBot',chat,messageId,reply);
  if(parsed.status!=='COMMAND'||parsed.command.memberId===actor||!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor)))return 'INVALID';
  const message=(reply as {message_id:number}).message_id,member=parsed.command.memberId;
  return this.store.transaction(s=>{
   const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!this.policy.canUseChat(s,chat,'moderation')||!this.policy.privateFeature(s,'support.use',actor))return 'DENIED';
   const all=records(s);if(all.some(r=>r.actor===actor&&r.chat===chat&&r.message===message))return 'DUPLICATE';
   if(all.some(r=>r.actor===actor&&r.at>now)||all.filter(r=>r.actor===actor&&r.at>now-86400000).length>=3||all.filter(r=>r.chat===chat&&!r.closed).length>=200)return 'LIMIT';
   s.audit.push({actorId:actor,updateKey:ROOT+randomBytes(18).toString('base64url'),decision:'ALLOW',reason:PREFIX+Buffer.from(JSON.stringify({chat,member,message})).toString('base64url'),policyVersion:this.policy.chatRevision(s,chat),at:now});return 'RECORDED';
  });
 }
 async handle(actor:string,data:string):Promise<(OwnerInlineScreen&{access?:AdminUIAccess})|null>{
  const route=ROUTE.exec(data);
  if(!route||route[0]!==data||!/^[1-9][0-9]{0,15}$/u.test(actor)||!Number.isSafeInteger(Number(actor)))return null;
  return this.store.transaction(s=>{
   const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!this.policy.privateFeature(s,'support.use',actor))return null;
   const kind=route[1]??route[3]!,review=route[1]==='r'||route[4]==='r',page=Number(route[2]??route[5]),slot=Number(route[6]??1);
   const all=records(s),entries=all.filter(r=>review?this.manager(s,actor,r.chat):r.actor===actor&&this.policy.canUseChat(s,r.chat,'moderation'));
   const epoch=review?protectionUIEpoch(s,this.policy,actor,now):null;if(review&&!epoch)return null;
   const proof=hash([actor,review,entries,s.chats,s.grants,s.privateFeatures,s.privateSettingsRevision]);if(route[7]!==undefined&&route[7]!==proof||page>=Math.max(1,Math.ceil(entries.length/8)))return null;
   const screen=(text:string,rows:{text:string;callback_data:string}[][])=>{const currentEpoch=review?protectionUIEpoch(s,this.policy,actor,now):null;return {text,keyboard:{inline_keyboard:rows},...(currentEpoch?{access:{actorId:actor,epoch:currentEpoch,expiresAt:now+120000}}:{})};};
   const home=b('↩️ البلاغات','rp:1:'+(review?'r':'h')+':0');
   if(kind==='h'||kind==='r'){
    const rows=entries.slice(page*8,page*8+8).map((r,i)=>[b((r.closed?'✅ مغلق':'📨 مفتوح')+' · '+r.chat,'rp:1:d:'+(review?'r':'o')+':'+page+':'+(i+1)+':'+proof)]);
    if(page>0)rows.push([b('⬅️ السابق','rp:1:'+(review?'r':'h')+':'+(page-1))]);if((page+1)*8<entries.length)rows.push([b('➡️ التالي','rp:1:'+(review?'r':'h')+':'+(page+1))]);
    if(!review&&s.chats.some(c=>this.manager(s,actor,c.id)))rows.push([b('🛡 بلاغات المجموعات المخولة','rp:1:r:0')]);
    rows.push([b('🏠 الرئيسية','pn:1:h')]);return screen((review?'بلاغات المجموعات المخولة':'بلاغاتي')+' — صفحة '+(page+1)+'\nللإبلاغ استخدم /report بالرد المباشر على رسالة العضو في المجموعة. لا يُحفظ نص الرسالة ولا ينفذ البلاغ عقوبة. التنبيه الخارجي للفريق غير موصول بعد.',rows);
   }
   const r=entries[page*8+slot-1];if(!r||r.at>now)return null;
   const stem='r:'+page+':'+slot+':'+proof;
   if(kind==='x')return review&&!r.closed?screen('إغلاق البلاغ بعد مراجعته؟ لا حذف ولا تحذير ولا تغيير قيد.',[[b('✅ تأكيد الإغلاق','rp:1:c:'+stem)],[home]]):null;
   if(kind==='c'){
    if(!review||r.closed||!this.manager(s,actor,r.chat))return null;
    s.audit.push({actorId:actor,updateKey:ROOT+r.id+':closed',decision:'ALLOW',reason:'MODERATION_REPORT_CLOSED',policyVersion:r.version,at:now});return screen('أُغلق البلاغ وسُجل القرار دون عقوبة.',[[home]]);
   }
   return screen('بلاغ خاص\nالمجموعة: '+r.chat+'\nرقم الرسالة: '+r.message+'\nالحالة: '+(r.closed?'مغلق':'مفتوح')+(review?'\nالمبلّغ: '+r.actor+'\nصاحب الرسالة: '+r.member:'')+'\nلا يتضمن السجل نص الرسالة أو مرفقاتها. الإغلاق يؤرشف البلاغ فقط بعد التحقق من صلاحيات المراجع الحالية.',[...(review&&!r.closed?[[b('إغلاق بعد المراجعة','rp:1:x:'+stem)]]:[]),[home]]);
  });
 }
}
