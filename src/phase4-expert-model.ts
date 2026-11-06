import {validEventURL,validEventSummaryInput} from './phase4-event-model.js';

/** 09:10 — human-reviewed speaker metadata, NOT Telegram-certified
 * qualifications. Question texts stay in MOD-09:07's private inbox.
 */
export interface ExpertProfile{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 displayName:string;specialty:string;evidenceUrl:string;
 status:'DRAFT'|'REVIEWED'|'REVOKED';revision:number;
 createdAt:number;reviewedAt?:number;revokedAt?:number;
}
export interface ExpertSession{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 profileId:string;questionSessionId:string;
 status:'DRAFT'|'OPEN'|'CLOSED';revision:number;
 createdAt:number;expiresAt:number;openedAt?:number;closedAt?:number;
}
export interface ExpertDecision{
 id:string;sessionId:string;questionId:string;status:'DEFERRED';
 createdAt:number;revision:number;
}
export interface ExpertSummary{
 sessionId:string;text:string;urls:string[];
 status:'DRAFT'|'APPROVED';revision:number;createdAt:number;approvedAt?:number;
}
export interface ExpertVote{
 id:string;sessionId:string;questionId:string;memberId:string;
 status:'CAST'|'WITHDRAWN';revision:1|2;createdAt:number;withdrawnAt?:number;
}
export type ExpertReportReason='CONTACT_DETAILS'|'UNLICENSED_ADVICE'|'HARASSMENT';
export interface ExpertReport{
 id:string;sessionId:string;questionId:string;reporterId:string;
 reason:ExpertReportReason;createdAt:number;
}
export interface ExpertState{
 profiles:ExpertProfile[];sessions:ExpertSession[];
 decisions:ExpertDecision[];summaries:ExpertSummary[];
 /** Optional for backward compatibility with already-persisted 09:10 state. */
 votes?:ExpertVote[];reports?:ExpertReport[];
}
export const emptyExpertState=():ExpertState=>({
 profiles:[],sessions:[],decisions:[],summaries:[]
});
const obj=(v:unknown):v is Record<string,unknown>=>
 typeof v==='object'&&v!==null&&!Array.isArray(v);
const exact=(x:Record<string,unknown>,req:readonly string[],optional:readonly string[]=[]) =>
 req.every(y=>Object.hasOwn(x,y))&&Object.keys(x).every(y=>req.includes(y)||optional.includes(y));
export const expertHex=(v:unknown):v is string=>
 typeof v==='string'&&/^[a-f0-9]{24}$/u.test(v);
const user=(v:unknown):v is string=>typeof v==='string'&&
 /^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const group=(v:unknown):v is string=>typeof v==='string'&&
 /^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const version=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
const time=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-60*86_400_000;
export const expertName=(v:unknown):v is string=>typeof v==='string'&&
 v===v.trim()&&v.length>=3&&v.length<=80&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
export const expertSpecialty=(v:unknown):v is string=>typeof v==='string'&&
 v===v.trim()&&v.length>=5&&v.length<=120&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v);
export function validExpertProfile(v:unknown):v is ExpertProfile{
 if(!obj(v)||!exact(v,['id','chatId','chatVersion','ownerId','displayName',
  'specialty','evidenceUrl','status','revision','createdAt'],
  ['reviewedAt','revokedAt']))return false;
 if(!expertHex(v.id)||!group(v.chatId)||!version(v.chatVersion)||
  !user(v.ownerId)||!expertName(v.displayName)||!expertSpecialty(v.specialty)||
  !validEventURL(v.evidenceUrl)||!time(v.createdAt))return false;
 if(v.status==='DRAFT')return v.revision===1&&
  v.reviewedAt===undefined&&v.revokedAt===undefined;
 if(v.status==='REVIEWED')return v.revision===2&&
  time(v.reviewedAt)&&Number(v.reviewedAt)>=v.createdAt&&v.revokedAt===undefined;
 if(v.status==='REVOKED')return (v.revision===2||v.revision===3)&&
  time(v.revokedAt)&&Number(v.revokedAt)>=v.createdAt&&
  (v.reviewedAt===undefined||time(v.reviewedAt)&&
   Number(v.revokedAt)>=v.reviewedAt);
 return false;
}
export function validExpertSession(v:unknown):v is ExpertSession{
 if(!obj(v)||!exact(v,['id','chatId','chatVersion','ownerId','profileId',
  'questionSessionId','status','revision','createdAt','expiresAt'],
  ['openedAt','closedAt']))return false;
 if(!expertHex(v.id)||!group(v.chatId)||!version(v.chatVersion)||
  !user(v.ownerId)||!expertHex(v.profileId)||!expertHex(v.questionSessionId)||
  !time(v.createdAt)||!time(v.expiresAt)||Number(v.expiresAt)<=v.createdAt)return false;
 if(v.status==='DRAFT')return v.revision===1&&
  v.openedAt===undefined&&v.closedAt===undefined;
 if(v.status==='OPEN')return v.revision===2&&
  time(v.openedAt)&&Number(v.openedAt)>=v.createdAt&&
  Number(v.openedAt)<v.expiresAt&&v.closedAt===undefined;
 if(v.status==='CLOSED')return v.revision===3&&time(v.closedAt)&&
  Number(v.closedAt)>=v.createdAt&&
  time(v.openedAt)&&Number(v.openedAt)>=v.createdAt&&
  Number(v.closedAt)>=v.openedAt;
 return false;
}
function validDecision(v:unknown):v is ExpertDecision{
 return obj(v)&&exact(v,['id','sessionId','questionId','status','createdAt','revision'])&&
  expertHex(v.id)&&expertHex(v.sessionId)&&expertHex(v.questionId)&&
  v.status==='DEFERRED'&&v.revision===1&&time(v.createdAt);
}
function validVote(v:unknown):v is ExpertVote{
 if(!obj(v)||!exact(v,['id','sessionId','questionId','memberId','status',
  'revision','createdAt'],['withdrawnAt'])||!expertHex(v.id)||
  !expertHex(v.sessionId)||!expertHex(v.questionId)||!user(v.memberId)||
  !time(v.createdAt))return false;
 if(v.status==='CAST')return v.revision===1&&v.withdrawnAt===undefined;
 return v.status==='WITHDRAWN'&&v.revision===2&&time(v.withdrawnAt)&&
  Number(v.withdrawnAt)>=v.createdAt;
}
function validReport(v:unknown):v is ExpertReport{
 return obj(v)&&exact(v,['id','sessionId','questionId','reporterId','reason','createdAt'])&&
  expertHex(v.id)&&expertHex(v.sessionId)&&expertHex(v.questionId)&&
  user(v.reporterId)&&time(v.createdAt)&&
  ['CONTACT_DETAILS','UNLICENSED_ADVICE','HARASSMENT'].includes(String(v.reason));
}
function validSummary(v:unknown):v is ExpertSummary{
 if(!obj(v)||!exact(v,['sessionId','text','urls','status','revision','createdAt'],
  ['approvedAt'])||!expertHex(v.sessionId)||
  !validEventSummaryInput(v.text,v.urls)||!time(v.createdAt))return false;
 if(v.status==='DRAFT')return v.revision===1&&v.approvedAt===undefined;
 return v.status==='APPROVED'&&v.revision===2&&time(v.approvedAt)&&
  Number(v.approvedAt)>=v.createdAt;
}
export function validExpertState(v:unknown):v is ExpertState{
 if(!obj(v)||!exact(v,['profiles','sessions','decisions','summaries'],['votes','reports'])||
  !Array.isArray(v.profiles)||v.profiles.length>100||
  !Array.isArray(v.sessions)||v.sessions.length>100||
  !Array.isArray(v.decisions)||v.decisions.length>2000||
  !Array.isArray(v.summaries)||v.summaries.length>100||
  (v.votes!==undefined&&(!Array.isArray(v.votes)||v.votes.length>5000))||
  (v.reports!==undefined&&(!Array.isArray(v.reports)||v.reports.length>1000))||
  v.profiles.some(x=>!validExpertProfile(x))||
  v.sessions.some(x=>!validExpertSession(x))||
  v.decisions.some(x=>!validDecision(x))||
  v.summaries.some(x=>!validSummary(x))||
  ((v.votes??[]) as unknown[]).some(x=>!validVote(x))||
  ((v.reports??[]) as unknown[]).some(x=>!validReport(x)))return false;
 const profiles=v.profiles as ExpertProfile[],sessions=v.sessions as ExpertSession[];
 const decisions=v.decisions as ExpertDecision[],summaries=v.summaries as ExpertSummary[];
 const votes=(v.votes??[]) as ExpertVote[],reports=(v.reports??[]) as ExpertReport[];
 if(new Set(profiles.map(x=>x.id)).size!==profiles.length||
  new Set(sessions.map(x=>x.id)).size!==sessions.length||
  new Set(sessions.map(x=>x.questionSessionId)).size!==sessions.length||
  new Set(decisions.map(x=>x.id)).size!==decisions.length||
  new Set(decisions.map(x=>x.sessionId+':'+x.questionId)).size!==decisions.length||
  new Set(summaries.map(x=>x.sessionId)).size!==summaries.length||
  new Set(votes.map(x=>x.id)).size!==votes.length||
  new Set(votes.map(x=>x.sessionId+':'+x.questionId+':'+x.memberId)).size!==votes.length||
  new Set(reports.map(x=>x.id)).size!==reports.length||
  new Set(reports.map(x=>x.sessionId+':'+x.questionId+':'+x.reporterId)).size!==reports.length)return false;
 const profilesById=new Map(profiles.map(x=>[x.id,x]));
 const sessionsById=new Map(sessions.map(x=>[x.id,x]));
 for(const x of sessions){
  const p=profilesById.get(x.profileId);
  if(!p||p.chatId!==x.chatId||p.chatVersion!==x.chatVersion||
   p.ownerId!==x.ownerId||p.createdAt>x.createdAt||
   (p.status==='DRAFT')||(p.reviewedAt!==undefined&&p.reviewedAt>x.createdAt))
   return false;
 }
 for(const x of decisions){
  const session=sessionsById.get(x.sessionId);
  if(!session||session.status==='DRAFT'||x.createdAt<(session.openedAt??0)||
   x.createdAt>session.expiresAt||session.closedAt!==undefined&&
   x.createdAt>session.closedAt)return false;
 }
 for(const x of [...votes,...reports]){
  const session=sessionsById.get(x.sessionId);
  if(!session||session.status==='DRAFT'||x.createdAt<(session.openedAt??0)||
   x.createdAt>=session.expiresAt||session.closedAt!==undefined&&
   x.createdAt>session.closedAt)return false;
 }
 for(const x of summaries){
  const session=sessionsById.get(x.sessionId);
  if(!session||session.status!=='CLOSED'||x.createdAt<(session.closedAt??0))return false;
 }
 return true;
}
