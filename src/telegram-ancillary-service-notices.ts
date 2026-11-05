/** Strict, content-free decoding for Telegram's ancillary group service notifications.
 * This module never decodes a user message as deletion evidence: the webhook
 * must carry exactly one native Telegram service field, a valid original
 * notification ID/date and no competing human content or another service.
 */
const groupFields=['new_chat_title','new_chat_photo','delete_chat_photo'] as const;
const forumFields=['forum_topic_created','forum_topic_edited','forum_topic_closed',
 'forum_topic_reopened','general_forum_topic_hidden','general_forum_topic_unhidden'] as const;
type GroupField=typeof groupFields[number];
type ForumField=typeof forumFields[number];
export type AncillaryServiceKind='GROUP_TITLE'|'GROUP_PHOTO'|'GROUP_PHOTO_REMOVED'
 |'TOPIC_CREATED'|'TOPIC_EDITED'|'TOPIC_CLOSED'|'TOPIC_REOPENED'
 |'TOPIC_HIDDEN'|'TOPIC_UNHIDDEN';
export type AncillaryServiceScope='GROUP'|'FORUM';
const scopeKind:Readonly<Record<GroupField|ForumField,AncillaryServiceKind>>={
 new_chat_title:'GROUP_TITLE',new_chat_photo:'GROUP_PHOTO',delete_chat_photo:'GROUP_PHOTO_REMOVED',
 forum_topic_created:'TOPIC_CREATED',forum_topic_edited:'TOPIC_EDITED',
 forum_topic_closed:'TOPIC_CLOSED',forum_topic_reopened:'TOPIC_REOPENED',
 general_forum_topic_hidden:'TOPIC_HIDDEN',general_forum_topic_unhidden:'TOPIC_UNHIDDEN'};
const fields=[...groupFields,...forumFields] as const;
const own=(r:Record<string,unknown>,name:string)=>Object.prototype.hasOwnProperty.call(r,name);
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const safeText=(v:unknown,min:number,max:number):v is string=>
 typeof v==='string'&&v.length>=min&&v.length<=max&&v.trim().length>0&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
const safeEmoji=(v:unknown):v is string=>
 typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f\u007f]/u.test(v);
const uint=(v:unknown,maximum:number):v is number=>
 typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=maximum;
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown>=>obj(v)&&Object.keys(v).every(k=>keys.includes(k));
export const ancillaryServiceFieldPresent=(message:Record<string,unknown>):boolean=>
 fields.some(k=>own(message,k));
export const ancillaryServiceScope=(kind:AncillaryServiceKind):AncillaryServiceScope=>
 kind.startsWith('GROUP_')?'GROUP':'FORUM';
function payloadValid(field:GroupField|ForumField,v:unknown):boolean{
 switch(field){
 case 'new_chat_title':return safeText(v,1,255);
 case 'new_chat_photo':
  return Array.isArray(v)&&v.length>0&&v.length<=32&&v.every(p=>
   exact(p,['file_id','file_unique_id','width','height','file_size'])&&
   safeText(p.file_id,8,512)&&safeText(p.file_unique_id,1,512)&&
   uint(p.width,10000)&&uint(p.height,10000)&&
   (p.file_size===undefined||uint(p.file_size,20000000)));
 case 'delete_chat_photo':return v===true;
 case 'forum_topic_created':
  return exact(v,['name','icon_color','icon_custom_emoji_id'])&&
   safeText(v.name,1,128)&&uint(v.icon_color,16777215)&&
   (v.icon_custom_emoji_id===undefined||safeEmoji(v.icon_custom_emoji_id));
 case 'forum_topic_edited':
  return exact(v,['name','icon_custom_emoji_id'])&&
   (v.name!==undefined||v.icon_custom_emoji_id!==undefined)&&
   (v.name===undefined||safeText(v.name,1,128))&&
   (v.icon_custom_emoji_id===undefined||v.icon_custom_emoji_id===''||safeEmoji(v.icon_custom_emoji_id));
 case 'forum_topic_closed':case 'forum_topic_reopened':
 case 'general_forum_topic_hidden':case 'general_forum_topic_unhidden':
  return exact(v,[])&&Object.keys(v).length===0;
 }
}
type Decoded={status:'VALID';kind:AncillaryServiceKind}|{status:'INVALID'|'NONE'};
/** Handles only group property-change and forum-topic service events.
 * Bot-originated *service* notifications are allowed, ordinary bot messages aren't.
 * Validation is conservative; unsupported service variants are never deleted. */
export function decodeAncillaryServiceNotice(message:Record<string,unknown>,chatType:unknown,forwarded:boolean):Decoded{
 const present=fields.filter(k=>own(message,k));
 if(present.length===0)return {status:'NONE'};
 if(present.length!==1||forwarded||!['group','supergroup'].includes(String(chatType))||
    !uint(message.message_id,2147483647)||!uint(message.date,8640000000000))return {status:'INVALID'};
 const field=present[0]!;
 if(forumFields.includes(field as ForumField)&&chatType!=='supergroup')return {status:'INVALID'};
 const content=['text','caption','entities','caption_entities','reply_to_message','document',
  'photo','video','animation','audio','voice','video_note','sticker','poll','contact',
  'location','venue','dice','new_chat_members','left_chat_member','pinned_message',
  'message_auto_delete_timer_changed','migrate_to_chat_id','migrate_from_chat_id',
  'group_chat_created','supergroup_chat_created','channel_chat_created',
  'video_chat_scheduled','video_chat_started','video_chat_ended','video_chat_participants_invited',
  'web_app_data','forum_topic_closed_extra','media_group_id','edit_date'];
 if(content.some(k=>own(message,k))||!payloadValid(field,message[field]))return {status:'INVALID'};
 return {status:'VALID',kind:scopeKind[field]};
}
