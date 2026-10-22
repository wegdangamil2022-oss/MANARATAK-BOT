/** B6 S12-02: extract ONLY one directly replied-to Telegram message.
 * Reply metadata is untrusted payload, never a membership proof, and must
 * never cause fetching older messages or full conversation history.
 */
export type B6OwnerReplyTarget=
 |{status:'QUESTION';question:string}
 |{status:'MISSING_REPLY'|'INVALID'};
const object=(value:unknown):value is Record<string,unknown>=>
 value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>
 typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const controls=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const group=/^-[1-9][0-9]{0,18}$/u;

export function parseB6OwnerReplyTarget(
 reply:unknown,chatId:string,currentMessageId:number|undefined,actorId:string
):B6OwnerReplyTarget{
 if(reply===undefined)return {status:'MISSING_REPLY'};
 if(!object(reply)||!group.test(chatId)||!positive(currentMessageId)||
  typeof actorId!=='string'||!object(reply.chat)||!object(reply.from))
  return {status:'INVALID'};
 const chat=reply.chat,from=reply.from;
 if(!positive(reply.message_id)||reply.message_id>=currentMessageId||
  typeof chat.id!=='number'||!Number.isSafeInteger(chat.id)||
  String(chat.id)!==chatId||!['group','supergroup'].includes(String(chat.type))||
  !positive(from.id)||from.is_bot!==false||String(from.id)===actorId||
  reply.sender_chat!==undefined||reply.via_bot!==undefined||
  reply.forward_origin!==undefined||reply.forward_date!==undefined||
  reply.is_automatic_forward===true||reply.reply_to_message!==undefined||
  reply.caption!==undefined||reply.document!==undefined||
  typeof reply.text!=='string'||reply.text.length<1||reply.text.length>240||
  reply.text!==reply.text.trim()||controls.test(reply.text))
  return {status:'INVALID'};
 return {status:'QUESTION',question:reply.text};
}
