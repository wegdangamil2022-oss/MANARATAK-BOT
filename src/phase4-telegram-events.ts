import type {InteractionEvent} from './phase4-welcome-engine.js';
/** Phase 4 Telegram event extraction. No network operations, authorizations or
 * follow-up actions: trust is restricted to Bot API envelope fields validated
 * by the webhook signature handler. The service still rechecks group approval.
 */
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown,min:number,max:number):v is number=>
 typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const user=(v:unknown):v is Record<string,unknown>=>obj(v)&&numeric(v.id,1,Number.MAX_SAFE_INTEGER)&&
 v.is_bot===false;
const group=(v:unknown):v is Record<string,unknown>=>obj(v)&&
 (v.type==='supergroup'||v.type==='group')&&numeric(v.id,-Number.MAX_SAFE_INTEGER,-1);
const MAX_UPD=2_147_483_647;
const firstName=(v:Record<string,unknown>):string=>typeof v.first_name==='string'?
 v.first_name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').slice(0,80):'';
function base(updateId:number,chat:Record<string,unknown>,member:Record<string,unknown>,
 eventKey:string,kind:InteractionEvent['kind'],timestamp:number,topicId:number|undefined,
 extra:Partial<InteractionEvent>):InteractionEvent{
 return {updateKey:'p4:'+String(updateId)+'_'+eventKey,chatId:String(chat.id),actorId:String(member.id),
  kind,at:timestamp,trusted:true,chatApproved:false,
  ...(typeof chat.title==='string'?{groupName:chat.title.slice(0,200)}:{}),
  ...(firstName(member)?{memberName:firstName(member)}:{}),
  ...(topicId!==undefined?{topicId}:{}),...extra};
}
/** Returns only candidate events. Caller must replace chatApproved with current Policy result,
 * must not trust verified from join payload, and must not send via this parser.
 */
export function parsePhase4TelegramEvents(payload:unknown,now:number):readonly InteractionEvent[]{
 if(!obj(payload)||!numeric(payload.update_id,0,MAX_UPD)||!numeric(now,0,8_640_000_000_000_000))
  return [];
 const id=payload.update_id;
 // Edited/forwarded events are deliberately not part of the auto-response feed.
 if(payload.edited_message!==undefined||payload.edited_channel_post!==undefined)return [];
 const msg=payload.message;
 if(!obj(msg)||!group(msg.chat)||!numeric(msg.message_id,1,2_147_483_647))return [];
 const t=msg.message_thread_id;
 if(t!==undefined&&!numeric(t,1,2_147_483_647))return [];
 const topic=t as number|undefined;
 if(!user(msg.from))return [];
 if(msg.forward_origin!==undefined||msg.forward_date!==undefined||msg.is_automatic_forward===true)return [];
 if(msg.new_chat_members!==undefined){
  if(!Array.isArray(msg.new_chat_members)||msg.new_chat_members.length<1||msg.new_chat_members.length>20||
   !msg.new_chat_members.every(user))return [];
  return msg.new_chat_members.map((member:Record<string,unknown>,i:number)=>
   base(id,msg.chat as Record<string,unknown>,member,'join_'+i,'JOIN',now,topic,{verified:false}));
 }
 if(msg.left_chat_member!==undefined){
  if(!user(msg.left_chat_member))return [];
  return [base(id,msg.chat,msg.left_chat_member,'leave','LEAVE',now,topic,{})];
 }
 if(msg.new_chat_title!==undefined||msg.new_chat_photo!==undefined||
  msg.delete_chat_photo===true){
  const changed=msg.new_chat_title!==undefined?'GROUP_TITLE_CHANGED':'GROUP_PHOTO_CHANGED';
  return [base(id,msg.chat,msg.from,'change',changed,now,topic,{})];
 }
 if(typeof msg.text!=='string'||msg.text.length>4000||msg.text.length<1||
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(msg.text))return [];
 const isCommand=/^\/[A-Za-z][A-Za-z0-9_]{0,30}(?:\s|$)/u.test(msg.text);
 return [base(id,msg.chat,msg.from,'message',isCommand?'COMMAND':'KEYWORD',now,topic,{text:msg.text})];
}