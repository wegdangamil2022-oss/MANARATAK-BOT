import type {BotState} from './store.js';
import {BotStore} from './store.js';
import {Policy} from './policy.js';
import {ApprovedAnswerService,type FAQResult} from './education-interactions.js';

/** B6 contract stage 1: a lookup is a HINT, not authorization.
 * No user identifier, conversation history, platform session token or other
 * message content is passed to a knowledge adapter. An untrusted provider
 * cannot make an answer public: B3's reviewed FAQ is the final authority.
 * No external AI model or Phase 17 credential is connected in this slice.
 */
export interface KnowledgeSourcePort {
 lookup(query:Readonly<{scope:string;question:string}>):Promise<unknown>;
}
export interface B6AnswerRequest {
 readonly actor:string;
 readonly scope:string;
 readonly question:string;
 readonly optedIn?:boolean;
 readonly explicitMention?:boolean;
}
export type B6AnswerPlan=
 |{status:'APPROVED_ANSWER';answer:string;sourceId:string}
 |{status:'DENIED'|'NO_APPROVED_SOURCE'|'AMBIGUOUS'|'UNAVAILABLE'|'STALE'};

const numeric=/^[1-9][0-9]{0,19}$/u;
const group=/^-[1-9][0-9]{0,18}$/u;
const controls=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const resourceId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const questionKey=(v:string):string=>
 v.normalize('NFKC').toLocaleLowerCase('en-US')
  .replace(/[!?؟.,،؛:;\s]+/gu,' ').trim();
const isRecord=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);
function parseHint(value:unknown):FAQResult|null{
 if(!isRecord(value)||typeof value.status!=='string')return null;
 if(value.status==='ANSWER'){
  if(Object.keys(value).length!==3||
    typeof value.answer!=='string'||value.answer.length<1||value.answer.length>1200||
    controls.test(value.answer)||value.answer!==value.answer.trim()||
    typeof value.sourceId!=='string'||!resourceId.test(value.sourceId))
   return null;
  return {status:'ANSWER',answer:value.answer,sourceId:value.sourceId};
 }
 if(['DISABLED','NO_MATCH','AMBIGUOUS'].includes(value.status)&&
    Object.keys(value).length===1)
  return {status:value.status as 'DISABLED'|'NO_MATCH'|'AMBIGUOUS'};
 return null;
}

/** A deliberately bounded local-only adapter. It may collect matching
 * approved FAQ candidate text within ONE scope, but publication status,
 * reviewer/source validity, and actor ACLs are checked later by the trusted
 * ApprovedAnswerService. No account data is written or cached.
 */
export class LocalFAQKnowledgeSource implements KnowledgeSourcePort {
 constructor(private readonly store:BotStore){}
 async lookup(query:Readonly<{scope:string;question:string}>):Promise<unknown>{
  const s=await this.store.snapshot();
  const key=questionKey(query.question);
  if(!key||key.length>240)return {status:'NO_MATCH'};
  const candidates=s.faqEntries.filter(q=>
   q.scope===query.scope&&q.status==='APPROVED'&&
   [q.question,...q.aliases].some(alias=>questionKey(alias)===key));
  if(candidates.length===0)return {status:'NO_MATCH'};
  if(candidates.length!==1)return {status:'AMBIGUOUS'};
  const chosen=candidates[0]!;
  return {status:'ANSWER',answer:chosen.answer,sourceId:chosen.sourceResourceId};
 }
}

/** Prepare a deterministic, source-backed answer only. There is intentionally
 * NO generative fallback, no live AI adapter, and no Telegram send here.
 * Revalidate the current user/chat policy AND the exact local published
 * answer after awaiting the knowledge hint (revocation wins).
 */
export class B6AnswerPreflight {
 constructor(private readonly store:BotStore,
  private readonly policy:Policy,
  private readonly approved:ApprovedAnswerService,
  private readonly source:KnowledgeSourcePort){}
 private isAllowed(s:BotState,input:B6AnswerRequest):boolean {
  return input.scope==='private'
   ?this.policy.mayAskPrivate(s,input.actor,input.optedIn===true)
   :this.policy.mayAskGroup(s,input.scope,input.actor,input.explicitMention===true);
 }
 private chatVersion(s:BotState,scope:string):number{
  return scope==='private'?0:this.policy.chatRevision(s,scope);
 }
 async prepare(input:B6AnswerRequest):Promise<B6AnswerPlan>{
  if(!isRecord(input)||Object.keys(input).some(k=>
    !['actor','scope','question','optedIn','explicitMention'].includes(k))||
    typeof input.actor!=='string'||!numeric.test(input.actor)||
    typeof input.scope!=='string'||
    (input.scope!=='private'&&!group.test(input.scope))||
    typeof input.question!=='string'||input.question.length>240||
    !input.question.trim()||input.question!==input.question.trim()||
    controls.test(input.question)||!questionKey(input.question)||
    (input.optedIn!==undefined&&typeof input.optedIn!=='boolean')||
    (input.explicitMention!==undefined&&typeof input.explicitMention!=='boolean'))
   return {status:'DENIED'};
  let before:BotState;
  try{before=await this.store.snapshot();}catch{return {status:'UNAVAILABLE'};}
  if(!this.isAllowed(before,input))return {status:'DENIED'};
  const epoch=this.chatVersion(before,input.scope);
  let hint:FAQResult|null=null;
  try{hint=parseHint(await this.source.lookup({scope:input.scope,question:input.question}));}
  catch{return {status:'UNAVAILABLE'};}
  if(!hint)return {status:'UNAVAILABLE'};
  let after:BotState;
  try{after=await this.store.snapshot();}catch{return {status:'UNAVAILABLE'};}
  if(!this.isAllowed(after,input))return {status:'DENIED'};
  if(this.chatVersion(after,input.scope)!==epoch)return {status:'STALE'};
  let trusted:FAQResult;
  try{
   trusted=input.scope==='private'
    ?await this.approved.answerPrivate(input.actor,input.question,input.optedIn===true)
    :await this.approved.answerGroup(input.actor,input.scope,input.question,input.explicitMention===true);
  }catch{return {status:'UNAVAILABLE'};}
  if(trusted.status==='DISABLED')return {status:'DENIED'};
  if(hint.status!==trusted.status)return {status:'STALE'};
  if(trusted.status==='NO_MATCH')return {status:'NO_APPROVED_SOURCE'};
  if(trusted.status==='AMBIGUOUS')return {status:'AMBIGUOUS'};
  if(trusted.status!=='ANSWER'||hint.status!=='ANSWER')return {status:'STALE'};
  if(hint.answer!==trusted.answer||hint.sourceId!==trusted.sourceId)
   return {status:'STALE'};
  return {status:'APPROVED_ANSWER',answer:trusted.answer,sourceId:trusted.sourceId};
 }
}
