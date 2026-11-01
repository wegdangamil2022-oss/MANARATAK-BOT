import type {BotState,TelegramReplyJob} from './store.js';
import type {Policy} from './policy.js';
import {communityFolderEpoch} from './community-folder-access.js';
export interface CommunityMessageReceipt {chatId:string;messageId:number;epoch:string;expiresAt:number;}
export const COMMUNITY_CLOSED_TEXT='انتهت صلاحية أزرار هذا المجلد أو تغيرت إتاحته. افتح الرئيسية لعرض الخيارات الحالية.';
export function validCommunityMessageReceipt(v:unknown):v is CommunityMessageReceipt{
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const r=v as Record<string,unknown>;
 return Object.keys(r).length===4&&typeof r.chatId==='string'&&/^[1-9][0-9]{0,15}$/u.exec(r.chatId)?.[0]===r.chatId&&Number.isSafeInteger(Number(r.chatId))&&Number.isSafeInteger(r.messageId)&&Number(r.messageId)>0&&typeof r.epoch==='string'&&/^[a-f0-9]{64}$/u.exec(r.epoch)?.[0]===r.epoch&&Number.isSafeInteger(r.expiresAt)&&Number(r.expiresAt)>=0&&Number(r.expiresAt)<=8640000000000000;
}
export function validCommunityMessageMetadata(j:TelegramReplyJob):boolean{
 if(j.communityEditTarget!==undefined){const t=j.communityEditTarget;if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).length!==2||!validCommunityMessageReceipt({...t,epoch:'a'.repeat(64),expiresAt:0})||!['SENDING','UNKNOWN_OUTCOME'].includes(j.status)||j.plan!==undefined||j.communityMessage!==undefined||j.communityClose!==undefined)return false;}
 if(j.communityMessage!==undefined&&(!validCommunityMessageReceipt(j.communityMessage)||j.status!=='SENT'||j.messageId!==j.communityMessage.messageId||j.plan!==undefined||j.communityClose!==undefined))return false;
 if(j.communityClose!==undefined){
  const r=j.communityClose,p=j.plan;
  if(!validCommunityMessageReceipt(r)||j.status!=='QUEUED'||j.privateReplyKind!=='LOCAL'||!p||p.chatId!==r.chatId||p.editMessageId!==r.messageId||p.text!==COMMUNITY_CLOSED_TEXT||p.studioMarkup!==undefined||p.replyMarkup!==undefined||JSON.stringify(p.inlineMarkup)!==JSON.stringify({inline_keyboard:[[{text:'🏠 الرئيسية',callback_data:'pn:1:h'}]]}))return false;
 }
 return true;
}
/** Only one confirmed delivery can establish the identity of a closable message. */
export function staleCommunityMessage(s:BotState,p:Policy,actor:string,messageId:number,now:number):CommunityMessageReceipt|null{
 const rows=(s.telegramReplyJobs??[]).filter(j=>j.communityMessage?.chatId===actor&&j.communityMessage.messageId===messageId);
 if(rows.length!==1||!validCommunityMessageMetadata(rows[0]!))return null;
 const receipt=rows[0]!.communityMessage!;
 if(!Number.isSafeInteger(now)||now<0||now<receipt.expiresAt&&communityFolderEpoch(s,p,actor)===receipt.epoch)return null;
 return structuredClone(receipt);
}
export function matchesCommunityClose(s:BotState,p:Policy,receipt:CommunityMessageReceipt,now:number):boolean{
 const current=staleCommunityMessage(s,p,receipt.chatId,receipt.messageId,now);
 return current!==null&&current.epoch===receipt.epoch&&current.expiresAt===receipt.expiresAt;
}
