import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
const route=/^oc:1:k:([A-Za-z0-9_-]{24})$/u;
const destinations=[
 ['studio.RESTORE:','st:1:l:09:0'],['studio.DELETE_BUTTON:','st:1:l:09:0'],
 ['delegation.confirm:','mi:1:i:03:01'],['category.write:','ec:1:h'],
 ['owner.faq.APPROVED:','of:1:p:0'],['owner.faq.ARCHIVED:','of:1:p:0'],
 ['owner.library.archive:','ol:1:p:0']
] as const;
export function validOwnerPreviewCancelRoute(data:string):boolean{
 return typeof data==='string'&&Buffer.byteLength(data)<=64&&route.exec(data)?.[0]===data;
}
export function ownerPreviewCancelData(ref:string):string{
 if(!/^c_[A-Za-z0-9_-]{24}$/u.test(ref))throw Error('INVALID_OWNER_PREVIEW_REFERENCE');
 return 'oc:1:k:'+ref.slice(2);
}
/** Revoking one owned, pending confirmation cannot grant execution rights.
 * Only the listed preview families are cancellable; input sessions and all
 * other callbacks remain owned by their respective workflows. */
export async function cancelOwnerPreview(store:BotStore,policy:Policy,actor:string,data:string,clock:()=>number):Promise<OwnerInlineScreen|null>{
 if(!validOwnerPreviewCancelRoute(data)||!policy.isOwner(actor))return null;
 return store.transaction(s=>{
  const now=clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000||!policy.privateFeature(s,'owner.dashboard',actor))return null;
  const ref='c_'+route.exec(data)![1],matches=s.callbacks.filter(c=>c.ref===ref),c=matches[0];
  if(matches.length!==1||!c||c.actorId!==actor||c.chatId!=='private'&&!/^-[1-9][0-9]{0,18}$/u.test(c.chatId)||!Number.isSafeInteger(c.policyVersion)||c.policyVersion<0||c.oneShot!==true||c.used!==false||c.revoked!==false||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now||c.expiresAt>now+120000)return null;
  const destination=destinations.find(([prefix])=>c.action.startsWith(prefix));if(!destination)return null;
  c.revoked=true;
  s.audit.push({actorId:actor,updateKey:'owner-preview-cancel:'+ref,decision:'NOOP',reason:'OWNER_PREVIEW_CANCELLED',policyVersion:c.policyVersion,at:now});
  return {text:'<b>أُلغيت المعاينة</b>\nأُبطل تأكيد هذه المعاينة. يمكنك بدء معاينة جديدة من القسم.',keyboard:{inline_keyboard:[[{text:'↩️ العودة إلى القسم',callback_data:destination[1]},{text:'🏠 لوحة المالك',callback_data:'mi:1:h'}]]}};
 });
}
