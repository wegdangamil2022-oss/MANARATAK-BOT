import type {BotStore,BotState,Chat} from './store.js';
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
type Operation='aiOff'|'restrictAssistant'|'restrictPublishing';
type Review={chatId:string;version:number;page:number;operation:Operation};
const grammar=/^mi:1:g:v:(-[1-9][0-9]{0,18}):([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,2}):([xap])$/u;
export function parseOwnerInlineControlPreview(input:string):Review|null{
 if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>64)return null;
 const m=grammar.exec(input);
 if(!m||m[0]!==input)return null;
 const operation=m[4]==='x'?'aiOff':m[4]==='a'?'restrictAssistant':'restrictPublishing';
 return {chatId:m[1]!,version:Number(m[2]),page:Number(m[3]),operation};
}
type Action='owner.chat.ai_off'|'owner.chat.restrict.assistant'|'owner.chat.restrict.publishing';
const actionName=(op:Operation):Action=>op==='aiOff'?'owner.chat.ai_off':
 op==='restrictAssistant'?'owner.chat.restrict.assistant':'owner.chat.restrict.publishing';
const actionLabels:Readonly<Record<Action,string>>={
 'owner.chat.ai_off':'إيقاف وضع المساعد الذكي',
 'owner.chat.restrict.assistant':'تقييد نطاق المساعد',
 'owner.chat.restrict.publishing':'تقييد نطاق النشر'
};
const isAction=(input:string):input is Action=>Object.hasOwn(actionLabels,input);
const permitted=(chat:Chat,action:Action):boolean=>chat.approved&&
 (action==='owner.chat.ai_off'?chat.groupAI!=='OFF':
 action==='owner.chat.restrict.assistant'?chat.scopes.includes('assistant'):
 chat.scopes.includes('publishing'));
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
  if(!chat||chat.version!==selected.version||!permitted(chat,action))return null;
  const at=this.clock();
  if(!Number.isSafeInteger(at)||at<0||at>8_640_000_000_000_000-120_000)return null;
  // Token grants nothing by itself; consumption later rechecks owner and
  // actual chat authorization/target revision under the durable store lock.
  const token=await this.codec.issue({
   action,chatId:selected.chatId,actorId,policyVersion:selected.version,
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
  const current=await this.store.snapshot();
  const saved=current.callbacks.find(c=>c.ref===token);
  if(!saved||!isAction(saved.action)||saved.actorId!==actorId||
   !this.policy.isOwner(actorId)||!saved.oneShot||
   saved.expiresAt<=this.clock()||!saved.chatId.startsWith('-'))return null;
  const action=saved.action;
  const chat=current.chats.find(c=>c.id===saved.chatId);
  if(!chat||chat.version!==saved.policyVersion||!permitted(chat,action))return null;
  const consumed=await this.codec.consume(token,actorId,saved.chatId,saved.policyVersion,
   (actual: string,state:BotState)=>{
    const c=state.chats.find(x=>x.id===saved.chatId);
    return this.policy.isOwner(actorId)&&actual===action&&
     !!c&&c.version===saved.policyVersion&&permitted(c,action);
   });
  if(!consumed.ok||consumed.action!==action)return null;
  // Atomic Policy CAS cannot replay a stale/revoked action even if a second
  // token was issued concurrently. Fail-closed if the CAS rejects.
  try {
   if(action==='owner.chat.ai_off')
    await this.policy.disableGroupAIAtRevision(actorId,saved.chatId,saved.policyVersion);
   else await this.policy.restrictChatScopeAtRevision(actorId,saved.chatId,
    action==='owner.chat.restrict.assistant'?'assistant':'publishing',saved.policyVersion);
  }catch{return null;}
  return ui('<b>تم تنفيذ التقييد المحلي ✅</b>\n'
   +'المجموعة: <code>'+escaped(saved.chatId)+'</code>\n'
   +'الإجراء: '+actionLabels[action]+'\n'
   +'حُفظ تغيير السياسة محليًا وسُجل في سجل التدقيق.\n'
   +'لا يعني ذلك تعديل حقوق Telegram أو تنفيذ حظر أو كتم أو إرسال منشور.',
   [[button('👥 مجموعاتي','mi:1:i:01:01'),button('🏠 لوحة المالك','mi:1:h')]]);
 }
}
