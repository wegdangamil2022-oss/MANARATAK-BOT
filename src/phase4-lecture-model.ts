/** 09:14 — reversible lecture quiet period. Nothing in this state changes
 * group protection, moderation, subscription or original auto-reply config.
 */
export interface LectureSession{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 durationMinutes:number;status:'DRAFT'|'ACTIVE'|'ENDED';
 revision:1|2|3;createdAt:number;startedAt?:number;endsAt?:number;closedAt?:number;
}
export interface LectureState{sessions:LectureSession[]}
export const emptyLectureState=():LectureState=>({sessions:[]});
export const lectureId=(x:unknown):x is string=>
 typeof x==='string'&&/^[a-f0-9]{24}$/u.test(x);
export const lectureGroup=(x:unknown):x is string=>
 typeof x==='string'&&/^-[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
export const lectureUser=(x:unknown):x is string=>
 typeof x==='string'&&/^[1-9][0-9]{0,15}$/u.test(x)&&Number.isSafeInteger(Number(x));
export const lectureTime=(x:unknown):x is number=>
 typeof x==='number'&&Number.isSafeInteger(x)&&x>=0&&x<=8_640_000_000_000_000-40*86_400_000;
export const lectureDuration=(x:unknown):x is number=>
 typeof x==='number'&&Number.isSafeInteger(x)&&x>=15&&x<=240;
const obj=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,req:readonly string[],opt:readonly string[]=[]) =>
 req.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>req.includes(k)||opt.includes(k));
export function validLectureSession(v:unknown):v is LectureSession{
 if(!obj(v)||!exact(v,['id','chatId','chatVersion','ownerId',
  'durationMinutes','status','revision','createdAt'],['startedAt','endsAt','closedAt'])||
  !lectureId(v.id)||!lectureGroup(v.chatId)||!lectureUser(v.ownerId)||
  !Number.isSafeInteger(v.chatVersion)||Number(v.chatVersion)<1||
  Number(v.chatVersion)>9_999_999_999||!lectureDuration(v.durationMinutes)||
  !lectureTime(v.createdAt))return false;
 if(v.status==='DRAFT')return v.revision===1&&v.startedAt===undefined&&
  v.endsAt===undefined&&v.closedAt===undefined;
 if(v.status==='ACTIVE')return v.revision===2&&lectureTime(v.startedAt)&&
  v.startedAt>=v.createdAt&&lectureTime(v.endsAt)&&
  v.endsAt===v.startedAt+v.durationMinutes*60_000&&v.closedAt===undefined;
 if(v.status==='ENDED'){
  if(!lectureTime(v.closedAt)||v.closedAt<v.createdAt)return false;
  if(v.revision===2)return v.startedAt===undefined&&v.endsAt===undefined;
  return v.revision===3&&lectureTime(v.startedAt)&&lectureTime(v.endsAt)&&
   v.startedAt>=v.createdAt&&v.closedAt>=v.startedAt&&
   v.endsAt===v.startedAt+v.durationMinutes*60_000;
 }
 return false;
}
export function validLectureState(raw:unknown):raw is LectureState{
 if(!obj(raw)||!exact(raw,['sessions'])||!Array.isArray(raw.sessions)||
  raw.sessions.length>250||raw.sessions.some(x=>!validLectureSession(x)))return false;
 const sessions=raw.sessions as LectureSession[];
 return new Set(sessions.map(x=>x.id)).size===sessions.length&&
  new Set(sessions.filter(x=>x.status==='ACTIVE').map(x=>x.chatId)).size===
   sessions.filter(x=>x.status==='ACTIVE').length&&
  new Set(sessions.filter(x=>x.status==='DRAFT').map(x=>x.chatId)).size===
   sessions.filter(x=>x.status==='DRAFT').length;
}
