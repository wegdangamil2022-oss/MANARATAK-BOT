import {randomBytes} from 'node:crypto';
import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {validNetworkWatchCase,type NetworkWatchCase,
 type NetworkWatchCategory,type NetworkWatchDecision} from './network-watchlist-model.js';

const id=/^[a-f0-9]{12}$/u;
const member=/^[1-9][0-9]{0,15}$/u;
const group=/^-[1-9][0-9]{0,15}$/u;
const nowValid=(now:number)=>Number.isSafeInteger(now)&&now>=0&&
 now<=8_640_000_000_000_000-600000;
const cleanMember=(value:string)=>member.test(value)&&Number.isSafeInteger(Number(value));
/** Explicit per-group source authorization; network membership is never a grant.
 * Owner dashboard, current group approval revision and moderation scope are
 * mandatory on each read/write. Stale or ambiguous restored records fail shut. */
function sourceContext(s:BotState,policy:Policy,actor:string,now:number,
 networkId:string,sourceId:string,expectedRevision?:number):
 {networkRevision:number;sourceVersion:number}|null{
 if(!nowValid(now)||!policy.isOwner(actor)||
  !policy.privateFeature(s,'owner.dashboard',actor)||
  !id.test(networkId)||!group.test(sourceId)||
  !Number.isSafeInteger(Number(sourceId)))return null;
 const networks=(s.groupNetworks??[]).filter(n=>n.id===networkId),net=networks[0];
 if(networks.length!==1||!net||
  (expectedRevision!==undefined&&net.revision!==expectedRevision)||
  net.updatedAt>now)return null;
 const chats=s.chats.filter(c=>c.id===sourceId),chat=chats[0];
 const links=net.members.filter(m=>m.chatId===sourceId);
 if(chats.length!==1||!chat?.approved||chat.version<1||
  links.length!==1||links[0]!.version!==chat.version||
  !chat.scopes.includes('moderation')||
  !policy.canUseChat(s,sourceId,'moderation')||
  !policy.has(s,actor,'chat.manage',sourceId,now))return null;
 return {networkRevision:net.revision,sourceVersion:chat.version};
}
export function networkWatchCaseAccessible(
 s:BotState,policy:Policy,actor:string,now:number,caseId:string
):NetworkWatchCase|null {
 if(!id.test(caseId))return null;
 const matches=(s.networkWatchCases??[]).filter(c=>c.id===caseId),row=matches[0];
 if(matches.length!==1||!row||!validNetworkWatchCase(row))return null;
 const context=sourceContext(s,policy,actor,now,row.networkId,row.sourceChatId,row.networkRevision);
 return context?.sourceVersion===row.sourceChatVersion?row:null;
}
/** Creates only a PENDING local allegation. Never calls moderation, Telegram,
 * distribution or rule-enforcement code. Subsequent review is always separate. */
export function prepareNetworkWatchCase(
 s:BotState,policy:Policy,actor:string,now:number,networkId:string,
 sourceChatId:string,subjectId:string,category:NetworkWatchCategory
):NetworkWatchCase|null {
 if(!cleanMember(subjectId)||!['SPAM','FLOOD','IMPERSONATION','OTHER'].includes(category)||
  (s.networkWatchCases??[]).length>=400)return null;
 const context=sourceContext(s,policy,actor,now,networkId,sourceChatId);
 if(!context||(s.networkWatchCases??[]).some(c=>c.networkId===networkId&&
  c.subjectId===subjectId&&(c.status==='PENDING'||c.status==='WATCHED')))return null;
 const caseId=randomBytes(6).toString('hex');
 if((s.networkWatchCases??[]).some(c=>c.id===caseId))return null;
 const row:NetworkWatchCase={
  id:caseId,networkId,networkRevision:context.networkRevision,
  sourceChatId,sourceChatVersion:context.sourceVersion,subjectId,category,
  revision:1,status:'PENDING',submittedBy:actor,submittedAt:now
 };
 return validNetworkWatchCase(row)?row:null;
}
/** Human decision with optimistic version; no side effects outside this row.
 * Even an accepted WATCHED case is a read-only advisory, NOT a ban request. */
export function reviewNetworkWatchCase(
 s:BotState,policy:Policy,actor:string,now:number,caseId:string,
 version:number,decision:NetworkWatchDecision
):boolean {
 if(!Number.isSafeInteger(version)||version<1||!nowValid(now))return false;
 const row=networkWatchCaseAccessible(s,policy,actor,now,caseId);
 if(!row||row.revision!==version||now<row.submittedAt)return false;
 if(row.status==='PENDING'){
  if(decision!=='WATCHED'&&decision!=='DISMISSED')return false;
  row.status=decision;row.revision=2;row.reviewedBy=actor;row.reviewedAt=now;
 }else if(row.status==='WATCHED'&&decision==='CLEARED'&&row.reviewedAt!==undefined&&
  now>=row.reviewedAt){
  row.status='CLEARED';row.revision=3;row.clearedBy=actor;row.clearedAt=now;
 }else return false;
 return validNetworkWatchCase(row);
}
