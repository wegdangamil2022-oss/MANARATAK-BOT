import type {BotStore,Chat,SubscriptionRequirement} from './store.js';
import type {Policy} from './policy.js';
import {CallbackActionCodec} from './callback.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
import {renderOwnerInlineGroups} from './telegram-inline-groups.js';

/** Security boundaries:
 * 1. Telegram private verified owner context is checked in transport.
 * 2. Preview checks current authorized group + exact revision/page.
 * 3. Nonce is random, owner-bound, scoped, expiring and one-shot in durable DB.
 * 4. Confirmation atomically consumes the nonce then applies Policy's revision
 *    fenced LOCAL restriction; no live moderation gateway is touched.
 * A failed/crashed confirmation may consume an intent without a mutation;
 * it is intentionally NOT retried automatically.
 */
type Operation='aiOff'|'restrictAssistant'|'restrictPublishing'|'pauseSubscription'|'revokeChat';
type Review={chatId:string;version:number;page:number;operation:Operation};
const grammar=/^mi:1:g:v:(-[1-9][0-9]{0,18}):([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,2}):([xapsr])$/u;
export function parseOwnerInlineControlPreview(input:string):Review|null{
 if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>64)return null;
 const m=grammar.exec(input);
 if(!m||m[0]!==input)return null;
 const operation=m[4]==='x'?'aiOff':m[4]==='a'?'restrictAssistant':
  m[4]==='p'?'restrictPublishing':m[4]==='s'?'pauseSubscription':'revokeChat';
 return {chatId:m[1]!,version:Number(m[2]),page:Number(m[3]),operation};
}
type Action='owner.chat.ai_off'|'owner.chat.restrict.assistant'|'owner.chat.restrict.publishing'|
 'owner.chat.revoke'|'owner.subscription.pause';
const actionName=(op:Operation):Action=>op==='aiOff'?'owner.chat.ai_off':
 op==='restrictAssistant'?'owner.chat.restrict.assistant':
 op==='restrictPublishing'?'owner.chat.restrict.publishing':
 op==='pauseSubscription'?'owner.subscription.pause':'owner.chat.revoke';
const actionLabels:Readonly<Record<Action,string>>={
 'owner.chat.ai_off':'إيقاف وضع المساعد الذكي',
 'owner.chat.restrict.assistant':'تقييد نطاق المساعد',
 'owner.chat.restrict.publishing':'تقييد نطاق النشر',
 'owner.subscription.pause':'تعليق الاشتراك الإجباري محليًا',
 'owner.chat.revoke':'إلغاء تصريح المجموعة محليًا'
};
const permitted=(chat:Chat,action:Action,rule?:SubscriptionRequirement):boolean=>chat.approved&&
 (action==='owner.chat.ai_off'?chat.groupAI!=='OFF':
 action==='owner.chat.restrict.assistant'?chat.scopes.includes('assistant'):
 action==='owner.chat.restrict.publishing'?chat.scopes.includes('publishing'):
 action==='owner.subscription.pause'?chat.scopes.includes('verification')&&
  Boolean(rule?.channelIds.length):true);
const ui=(text:string,rows:readonly (readonly {text:string;callback_data:string}[])[]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard});
const button=(text:string,callback_data:string)=>({text,callback_data});
const escaped=(v:string)=>v.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
const previewPrefix='mi:1:g:v:';
const tokenRe=/^c_[A-Za-z0-9_-]{24}$/u;
export class OwnerInlineGroupControls {
 private readonly codec:CallbackActionCodec;
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){
  this.codec=new CallbackActionCodec(store,clock);
 }
 async handle(input:string,actorId:string):Promise<OwnerInlineScreen|null>{
  if(!this.policy.isOwner(actorId))return null;
  if(input.startsWith(previewPrefix))return this.preview(input,actorId);
  if(tokenRe.test(input))return this.confirm(input,actorId);
  return null;
 }
 private async preview(input:string,actorId:string):Promise<OwnerInlineScreen|null>{
  const selected=parseOwnerInlineControlPreview(input);
  if(!selected)return null;
  // Require the selected group to remain an actual member of this *current*
  // owner-visible page and version, not merely a plausible signed-looking ID.
  const selector='mi:1:g:d:'+selected.chatId+':'+selected.version+':'+selected.page;
  if(!await renderOwnerInlineGroups(this.store,this.policy,actorId,selector))return null;
  const before=await this.store.snapshot();
  const chat=before.chats.find(c=>c.id===selected.chatId);
  const action=actionName(selected.operation);
  const rules=before.subscriptionRequirements.filter(r=>r.chatId===selected.chatId);
  if(rules.length>1)return null;
  const requirement=rules[0];
  if(!chat||chat.version!==selected.version||!permitted(chat,action,requirement))return null;
  const at=this.clock();
  if(!Number.isSafeInteger(at)||at<0||at>8_640_000_000_000_000-120_000)return null;
  // Token grants nothing by itself; consumption later rechecks owner and
  // actual chat authorization/target revision under the durable store lock.
  const token=await this.codec.issue({
   action,chatId:selected.chatId,actorId,policyVersion:selected.version,
   ...(action==='owner.subscription.pause'?{requirementVersion:requirement!.version}:{}),
   expiresAt:at+120_000,oneShot:true
  });
  return ui('<b>معاينة إجراء محلي 🔐</b>\n'
   +'المجموعة: <code>'+escaped(selected.chatId)+'</code>\n'
   +'الإجراء: '+actionLabels[action]+'\n'
   +'إصدار السياسة: '+selected.version+'\n'
   +'لا يحدث تعديل في المعاينة. التأكيد صالح لدقيقتين وضغطة واحدة، '
   +'ومرتبط بهذا المالك وهذه النسخة من سياسة المجموعة.\n'
   +'سيُغيّر السياسة المحلية فقط؛ لا إرسال إلى Telegram ولا عقوبات أو رفع صلاحيات.',
   [[button('✅ تأكيد الإجراء المحلي',token)],
    [button('↩️ إلغاء والعودة',selector),button('🏠 لوحة المالك','mi:1:h')]]);
 }
 private async confirm(token:string,actorId:string):Promise<OwnerInlineScreen|null>{
  // The nonce and local policy update commit in ONE durable transaction. A
  // crash cannot consume approval without applying the local restriction.
  const applied=await this.policy.applyOwnerInlineConfirmation(actorId,token);
  if(!applied)return null;
  const label=actionLabels[applied.action];
  return ui('<b>تم تنفيذ الإجراء المحلي ✅</b>\n'
   +'المجموعة: <code>'+escaped(applied.chatId)+'</code>\n'
   +'الإجراء: '+label+'\n'
   +'حُفظ تغيير السياسة محليًا وسُجل في سجل التدقيق.\n'
   +'لا يعني ذلك تعديل حقوق Telegram أو تنفيذ حظر أو كتم أو إرسال منشور.',
   [[button('👥 مجموعاتي','mi:1:i:01:01'),button('🏠 لوحة المالك','mi:1:h')]]);
 }
}
