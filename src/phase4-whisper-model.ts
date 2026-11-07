/** Phase 4 / 09:06 — private content and at-most-once announcement metadata.
 * A reservation never proves private delivery or a read receipt. An announcement
 * stores no text, user-supplied URL, secret key or outbound retry payload.
 */
export type WhisperKind='FIRST_N'|'DIRECT';
export interface WhisperMessage{
 id:string;chatId:string;chatVersion:number;creatorId:string;
 kind:WhisperKind;seats:number;recipientId?:string;text?:string;
 status:'DRAFT'|'OPEN'|'CLOSED';revision:number;
 createdAt:number;expiresAt:number;approvedAt?:number;closedAt?:number;
}
export interface WhisperReservation{
 id:string;messageId:string;memberId:string;at:number;status:'HELD';
}
export interface WhisperConsent{
 chatId:string;chatVersion:number;memberId:string;enabled:boolean;revision:number;updatedAt:number;
}
/** Member-controlled suppression: only the member may add/remove a block.
 * No public author/blocklist query is provided. */
export interface WhisperBlock{
 chatId:string;chatVersion:number;memberId:string;senderId:string;
 enabled:boolean;revision:number;updatedAt:number;
}
/** A private abuse report. No secret text, files or Telegram provider payload. */
export interface WhisperReport{
 id:string;messageId:string;reporterId:string;reportedAt:number;
 reason:'SPAM'|'HARASSMENT'|'PERSONAL_DATA'|'OTHER';
 status:'OPEN'|'REVIEWED';reviewedAt?:number;reviewedBy?:string;
}
/** Separate public announcement intent: NO whisper content or recipient IDs.
 * A confirmed post is the only evidence that Telegram accepted the teaser.
 */
export interface WhisperAnnouncement{
 id:string;messageId:string;chatId:string;chatVersion:number;ownerId:string;
 createdAt:number;status:'QUEUED'|'SENDING'|'CONFIRMED'|
  'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'SKIPPED';
 attemptId?:string;telegramMessageId?:number;
}
export interface WhisperState{
 messages:WhisperMessage[];reservations:WhisperReservation[];consents:WhisperConsent[];
 blocks?:WhisperBlock[];reports?:WhisperReport[];
 announcements?:WhisperAnnouncement[];
}
export const emptyWhisperState=():WhisperState=>({
 messages:[],reservations:[],consents:[]
});
const record=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(v:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]) =>
 required.every(k=>Object.hasOwn(v,k))&&
 Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const validId=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{24}$/u.test(x);
const validUser=(x:unknown)=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.test(x)&&
 Number.isSafeInteger(Number(x));
const validChat=(x:unknown)=>typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&
 Number.isSafeInteger(Number(x));
const validRevision=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&
 x>=1&&x<=9_999_999_999;
const validTime=(x:unknown)=>typeof x==='number'&&Number.isSafeInteger(x)&&
 x>=0&&x<=8_640_000_000_000_000-600_000;
const validText=(x:unknown)=>typeof x==='string'&&
 x.length>=1&&x.length<=800&&x.trim()===x&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(x);
export function validWhisperMessage(raw:unknown):raw is WhisperMessage{
 if(!record(raw)||!exact(raw,
  ['id','chatId','chatVersion','creatorId','kind','seats','status',
   'revision','createdAt','expiresAt'],
  ['recipientId','text','approvedAt','closedAt']))return false;
 const x=raw;
 if(!validId(x.id)||!validChat(x.chatId)||!validRevision(x.chatVersion)||
  !validUser(x.creatorId)||!['FIRST_N','DIRECT'].includes(String(x.kind))||
  !Number.isSafeInteger(x.seats)||!(Number(x.seats)>=1&&Number(x.seats)<=20)||
  !validTime(x.createdAt)||!validTime(x.expiresAt)||
  Number(x.expiresAt)<=Number(x.createdAt)||
  Number(x.expiresAt)>Number(x.createdAt)+3_600_000||
  !['DRAFT','OPEN','CLOSED'].includes(String(x.status)))return false;
 if(x.kind==='DIRECT'){
  if(x.seats!==1||!validUser(x.recipientId)||
    x.recipientId===x.creatorId)return false;
 }else if(x.recipientId!==undefined)return false;
 if(x.status==='DRAFT')
  return x.revision===1&&validText(x.text)&&
   x.approvedAt===undefined&&x.closedAt===undefined;
 if(x.status==='OPEN')
  return x.revision===2&&validText(x.text)&&validTime(x.approvedAt)&&
   Number(x.approvedAt)>=Number(x.createdAt)&&
   Number(x.approvedAt)<Number(x.expiresAt)&&x.closedAt===undefined;
 if(x.text!==undefined||!validTime(x.closedAt)||
  Number(x.closedAt)<Number(x.createdAt))return false;
 if(x.approvedAt===undefined)return x.revision===2;
 return x.revision===3&&validTime(x.approvedAt)&&
  Number(x.approvedAt)>=Number(x.createdAt)&&
  Number(x.approvedAt)<Number(x.expiresAt)&&
  Number(x.closedAt)>=Number(x.approvedAt);
}
export function validWhisperState(raw:unknown):raw is WhisperState{
 if(!record(raw)||!exact(raw,['messages','reservations','consents'],['blocks','reports'])||
  !Array.isArray(raw.messages)||raw.messages.length>200||
  !Array.isArray(raw.reservations)||raw.reservations.length>2000||
  !Array.isArray(raw.consents)||raw.consents.length>2000||
  (raw.blocks!==undefined&&(!Array.isArray(raw.blocks)||raw.blocks.length>2000))||
  (raw.reports!==undefined&&(!Array.isArray(raw.reports)||raw.reports.length>500))||
  (raw.announcements!==undefined&&(!Array.isArray(raw.announcements)||
    raw.announcements.length>200)))return false;
 if(raw.messages.some(m=>!validWhisperMessage(m)))return false;
 const messages=raw.messages as WhisperMessage[];
 if(new Set(messages.map(m=>m.id)).size!==messages.length)return false;
 if(raw.reservations.some(c=>!record(c)||!exact(c,['id','messageId','memberId','at','status'])||
  !validId(c.id)||!validId(c.messageId)||!validUser(c.memberId)||
  !validTime(c.at)||c.status!=='HELD'))return false;
 const reservations=raw.reservations as WhisperReservation[];
 if(new Set(reservations.map(c=>c.id)).size!==reservations.length||
  new Set(reservations.map(c=>c.messageId+':'+c.memberId)).size!==reservations.length)return false;
 for(const m of messages){
  const claims=reservations.filter(c=>c.messageId===m.id);
  if(claims.length>m.seats||m.status==='DRAFT'&&claims.length||
   claims.some(c=>m.approvedAt===undefined||c.at<m.approvedAt||c.at>m.expiresAt||
    m.status==='CLOSED'&&m.closedAt!==undefined&&c.at>m.closedAt||
    m.kind==='DIRECT'&&c.memberId!==m.recipientId))return false;
 }
 if(reservations.some(c=>!messages.some(m=>m.id===c.messageId)))return false;
 if(raw.consents.some(c=>!record(c)||!exact(c,
  ['chatId','chatVersion','memberId','enabled','revision','updatedAt'])||
  !validChat(c.chatId)||!validRevision(c.chatVersion)||
  !validUser(c.memberId)||typeof c.enabled!=='boolean'||
  !validRevision(c.revision)||!validTime(c.updatedAt)))return false;
 const consents=raw.consents as WhisperConsent[];
 if(new Set(consents.map(c=>c.chatId+':'+c.memberId)).size!==consents.length)return false;
 const blocks=raw.blocks??[];
 if(blocks.some(x=>!record(x)||!exact(x,
   ['chatId','chatVersion','memberId','senderId','enabled','revision','updatedAt'])||
   !validChat(x.chatId)||!validRevision(x.chatVersion)||!validUser(x.memberId)||
   !validUser(x.senderId)||x.memberId===x.senderId||
   typeof x.enabled!=='boolean'||!validRevision(x.revision)||
   !validTime(x.updatedAt)))return false;
 if(new Set((blocks as WhisperBlock[]).map(x=>
   x.chatId+':'+x.memberId+':'+x.senderId)).size!==blocks.length)return false;
 const announced=raw.announcements??[];
 if(announced.some(a=>!record(a)||!exact(a,
   ['id','messageId','chatId','chatVersion','ownerId','createdAt','status'],
   ['attemptId','telegramMessageId'])||
   !validId(a.id)||!validId(a.messageId)||!validChat(a.chatId)||
   !validRevision(a.chatVersion)||!validUser(a.ownerId)||
   !validTime(a.createdAt)||
   !['QUEUED','SENDING','CONFIRMED','FAILED_CONFIRMED','UNKNOWN_OUTCOME','SKIPPED'].includes(String(a.status))||
   (a.attemptId!==undefined&&!validId(a.attemptId))||
   (a.status==='QUEUED'&&a.attemptId!==undefined)||
   ((a.status==='SENDING'||a.status==='UNKNOWN_OUTCOME'||a.status==='CONFIRMED')&&
    !validId(a.attemptId))||
   (a.telegramMessageId!==undefined&&(!Number.isSafeInteger(a.telegramMessageId)||
     Number(a.telegramMessageId)<1||Number(a.telegramMessageId)>2147483647))||
   (a.status==='CONFIRMED'&&a.telegramMessageId===undefined)||
   (a.status!=='CONFIRMED'&&a.telegramMessageId!==undefined)))return false;
 if(new Set((announced as WhisperAnnouncement[]).map(x=>x.id)).size!==announced.length||
   new Set((announced as WhisperAnnouncement[]).map(x=>x.messageId)).size!==announced.length)
  return false;
 for(const item of announced as WhisperAnnouncement[]){
  const matches=(raw.messages as WhisperMessage[]).filter(x=>x.id===item.messageId);
  if(matches.length!==1||matches[0]!.chatId!==item.chatId||
    matches[0]!.creatorId!==item.ownerId||
    matches[0]!.chatVersion!==item.chatVersion||
    matches[0]!.approvedAt===undefined||
    item.createdAt<matches[0]!.approvedAt)
   return false;
 }
 const reports=raw.reports??[];
 if(reports.some(x=>!record(x)||!exact(x,
  ['id','messageId','reporterId','reportedAt','reason','status'],
  ['reviewedAt','reviewedBy'])||
  !validId(x.id)||!validId(x.messageId)||!validUser(x.reporterId)||
  !validTime(x.reportedAt)||!['SPAM','HARASSMENT','PERSONAL_DATA','OTHER'].includes(String(x.reason))||
  !['OPEN','REVIEWED'].includes(String(x.status))||
  (x.status==='OPEN'&&(x.reviewedAt!==undefined||x.reviewedBy!==undefined))||
  (x.status==='REVIEWED'&&(!validTime(x.reviewedAt)||!validUser(x.reviewedBy)||
     Number(x.reviewedAt)<Number(x.reportedAt)))))return false;
 if(new Set((reports as WhisperReport[]).map(x=>x.id)).size!==reports.length||
   new Set((reports as WhisperReport[]).map(x=>
    x.messageId+':'+x.reporterId)).size!==reports.length)return false;
 for(const report of reports as WhisperReport[]){
  const messages=raw.messages as WhisperMessage[];
  const matching=messages.filter(x=>x.id===report.messageId);
  if(matching.length!==1||!matching[0]||matching[0].creatorId===report.reporterId)
   return false;
  // Report creation requires a HELD seat. A later opt-out or block can
  // release the seat; the previously accepted reason-only report persists
  // without becoming a new authority to view content.
 }
 return true;
}
