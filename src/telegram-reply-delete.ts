import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import {purgeReviewDigest,type ModerationPurgeService} from './moderation-purge.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
type Result={status:'APPLIED'|'DENIED'|'UNKNOWN';reason:string;screen?:OwnerInlineScreen};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const route=new RegExp('^pd:1:([cx]):('+uuid+'):([a-f0-9]{16})$','u');
const deny=(reason:string):Result=>({status:'DENIED',reason});
export function isReplyDeleteCommand(text:string,username:string):boolean{
 const match=/^\/delete(?:@([A-Za-z][A-Za-z0-9_]{4,31}))?(?=\s|$)/u.exec(text);
 return Boolean(match&&(!match[1]||match[1].toLowerCase()===username.toLowerCase()));
}
export async function previewReplyDelete(store:BotStore,policy:Policy,purge:ModerationPurgeService,
 actor:string,chat:string,messageId:number|undefined,text:string,reply:unknown,now:number):Promise<Result>{
 // Never index arbitrary reply content or guess protection flags. This path
 // operates only on metadata already observed by the trusted purge service.
 if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||!/^\/delete(?:@[A-Za-z][A-Za-z0-9_]{4,31})?$/u.test(text)||!positive(messageId)||
  !object(reply)||!positive(reply.message_id)||reply.message_id>=messageId||
  !object(reply.chat)||!Number.isSafeInteger(reply.chat.id)||String(reply.chat.id)!==chat||
  !['group','supergroup'].includes(String(reply.chat.type))||!object(reply.from)||
  !positive(reply.from.id)||reply.from.is_bot!==false||!positive(reply.date)||
  reply.sender_chat!==undefined||reply.forward_origin!==undefined||reply.forward_date!==undefined||
  reply.via_bot!==undefined||reply.is_automatic_forward===true)return deny('DELETE_REPLY_INVALID');
 try{
  const state=await store.snapshot();
  if(!policy.canUseChat(state,chat,'moderation')||!policy.has(state,actor,'chat.manage',chat,now)||
   String(reply.from.id)===policy.ownerId||policy.has(state,String(reply.from.id),'chat.manage',chat,now))return deny('DELETE_NOT_AUTHORIZED');
  const matches=state.rollingMessageMeta.filter(m=>m.chatId===chat&&m.messageId===reply.message_id);
  if(matches.length!==1)return deny('DELETE_MESSAGE_NOT_OBSERVED');
  const meta=matches[0]!;
  if(meta.senderKind!=='USER'||meta.senderId!==String(reply.from.id)||meta.sentAt!==reply.date*1000||
   meta.pinned||meta.linkedChannel||meta.adminLog||meta.approvedAnnouncement)return deny('DELETE_MESSAGE_PROTECTED_OR_STALE');
  const preview=await purge.preview(actor,chat,{limit:1,senderId:meta.senderId,beforeMessageId:meta.messageId+1});
  if(preview.items.length!==1||preview.items[0]!.messageId!==meta.messageId){
   await purge.cancel(actor,preview.id);return deny('DELETE_PREVIEW_CHANGED');
  }
  return {status:'APPLIED',reason:'DELETE_PREVIEW_ONLY',screen:{text:'<b>معاينة حذف رسالة واحدة</b>\n'
   +'اختيرت الرسالة المردود عليها من الفهرس الملاحظ. لم يرسل طلب حذف بعد.\n'
   +'التأكيد مرتبط بحسابك وصلاحيات المجموعة وبالرسالة المعاينة، وينتهي تلقائيًا.\n'
   +'إذا أُغلق الخاص فلن يصلك هذا التأكيد ولن يُنفّذ الحذف.',keyboard:{inline_keyboard:[[
    {text:'✅ تأكيد حذف الرسالة',callback_data:'pd:1:c:'+preview.id+':'+purgeReviewDigest(preview)},
    {text:'↩️ إلغاء الحذف',callback_data:'pd:1:x:'+preview.id+':'+purgeReviewDigest(preview)}
   ]]}}};
 }catch{return deny('DELETE_PREVIEW_UNAVAILABLE');}
}
export async function handleReplyDeleteCallback(store:BotStore,policy:Policy,purge:ModerationPurgeService,
 actor:string,data:string,now:number):Promise<Result>{
 const parsed=route.exec(data);if(!parsed||parsed[0]!==data)return deny('DELETE_CALLBACK_INVALID');
 try{
  const state=await store.snapshot(),jobs=state.purgeJobs.filter(j=>j.id===parsed[2]);
  if(jobs.length!==1)return deny('DELETE_CALLBACK_STALE');
  const job=jobs[0]!;
  if(!Number.isSafeInteger(job.createdAt)||!Number.isSafeInteger(job.expiresAt)||
   job.createdAt<0||job.expiresAt<=job.createdAt||job.expiresAt-job.createdAt>600000||
   purgeReviewDigest(job)!==parsed[3]||job.actorId!==actor||job.status!=='PREVIEW'||job.items.length!==1||
   !Number.isSafeInteger(now)||now<job.createdAt||now>job.expiresAt||
   !policy.canUseChat(state,job.chatId,'moderation')||!policy.has(state,actor,'chat.manage',job.chatId,now))return deny('DELETE_CALLBACK_STALE');
  if(parsed[1]==='x'){
   await purge.cancel(actor,job.id);
   return {status:'APPLIED',reason:'DELETE_CANCELLED',screen:resultScreen(policy,actor,'أُلغي طلب الحذف قبل إرساله.')};
  }
  await purge.confirm(actor,job.id,parsed[3]);
 }catch{return deny('DELETE_CONFIRMATION_REJECTED');}
 try{
  const result=await purge.dispatchNext(parsed[2]!);
  if(result.status==='ACKNOWLEDGED')return {status:'APPLIED',reason:'DELETE_REQUEST_ACKNOWLEDGED',
   screen:resultScreen(policy,actor,'قبلت بوابة الحذف الطلب. هذا إقرار بالطلب وليس إثباتًا مستقلًا للحذف المادي.')};
  if(result.status==='UNKNOWN_OUTCOME')return {status:'UNKNOWN',reason:'DELETE_OUTCOME_UNKNOWN',
   screen:resultScreen(policy,actor,'نتيجة الحذف غير مؤكدة؛ حُجبت إعادة الإرسال وتلزم مراجعة مستقلة.')};
  return {status:'DENIED',reason:'DELETE_'+result.status,screen:resultScreen(policy,actor,'لم يُعتمد نجاح الحذف. راجع حالة العملية قبل أي إجراء جديد.')};
 }catch{return {status:'UNKNOWN',reason:'DELETE_REVIEW_REQUIRED'};}
}
function resultScreen(policy:Policy,actor:string,text:string):OwnerInlineScreen{
 return {text,keyboard:{inline_keyboard:[[{text:policy.isOwner(actor)?'🏠 لوحة المالك':'🏠 مجموعاتي الإشرافية',callback_data:policy.isOwner(actor)?'mi:1:h':'ms:1:h'}]]}};
}
