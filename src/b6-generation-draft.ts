import type {B6AnswerRequest} from './b6-approved-answer-preflight.js';
import {B6AnswerPreflight} from './b6-approved-answer-preflight.js';

/** B6 Phase-17-facing PROPOSED contract, fake-only in this release.
 * The port receives no Telegram actor ID, previous chat history, session
 * credentials, group membership lists, or platform account identifier.
 * Source text is still untrusted as model context; output is never sent to
 * Telegram or published without a separately designed owner review.
 */
export interface AnswerGenerationPort {
 generate(request:Readonly<{
  schema:'b6-reviewed-draft-v1';
  scope:string;
  question:string;
  approvedAnswer:string;
  sourceId:string;
  maxOutputChars:number;
 }>):Promise<unknown>;
}
export interface B6DraftConfig {
 readonly enabled?:boolean;
 readonly maxOutputChars?:number;
}
export interface B6AttemptLimits {
 readonly maxCallsPerUtcDay:number;
 readonly maxConcurrent:number;
}
export type B6DraftResult=
 |{status:'DISABLED'|'DENIED'|'STALE'|'NO_APPROVED_SOURCE'|'AMBIGUOUS'|
   'UNAVAILABLE'|'BUSY'|'BUDGET_EXHAUSTED'|'INVALID_OUTPUT'}
 |{status:'DRAFT';draftText:string;safeHtml:string;sourceId:string;
   reviewState:'OWNER_REVIEW_REQUIRED';
   usage:{inputTokens:number;outputTokens:number}};

/** Strictly local, in-process OFFLINE attempt gate. This is NOT billing,
 * provider token accounting, distributed rate-limiting or durable budget
 * enforcement. No paid/real AI endpoint may depend on this as its guard.
 * Every call that begins consumes one attempt, including unknown outcomes.
 */
export class B6EphemeralCallBudget {
 private active=0;
 private day='';
 private count=0;
 constructor(private readonly limits:B6AttemptLimits,
  private readonly clock:()=>number=Date.now){
  if(!limits||typeof limits!=='object'||Array.isArray(limits)||
    Object.keys(limits).length!==2||
    !Number.isSafeInteger(limits.maxCallsPerUtcDay)||
    limits.maxCallsPerUtcDay<1||limits.maxCallsPerUtcDay>10_000||
    !Number.isSafeInteger(limits.maxConcurrent)||
    limits.maxConcurrent<1||limits.maxConcurrent>32)
   throw Error('INVALID_B6_OFFLINE_LIMITS');
 }
 private syncDay():void{
  const now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)
   throw Error('INVALID_B6_CLOCK');
  const current=new Date(now).toISOString().slice(0,10);
  if(current!==this.day){this.day=current;this.count=0;}
 }
 summary():{durable:false;attemptsToday:number;active:number}{
  this.syncDay();
  return {durable:false,attemptsToday:this.count,active:this.active};
 }
 begin():{status:'ADMITTED';finish:()=>void}|{status:'BUSY'|'BUDGET_EXHAUSTED'}{
  this.syncDay();
  if(this.active>=this.limits.maxConcurrent)return {status:'BUSY'};
  if(this.count>=this.limits.maxCallsPerUtcDay)return {status:'BUDGET_EXHAUSTED'};
  this.count++;this.active++;
  let finished=false;
  return {status:'ADMITTED',finish:()=>{
   if(finished)return;
   finished=true;this.active--;
  }};
 }
}

const controls=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const resourceId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const obj=(v:unknown):v is Record<string,unknown>=>
 Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:readonly string[]):boolean=>
 Object.keys(v).length===names.length&&names.every(n=>Object.prototype.hasOwnProperty.call(v,n));
const safeText=(v:unknown,max:number):v is string=>
 typeof v==='string'&&v.length>=1&&v.length<=max&&
 v.trim()===v&&!controls.test(v);
const tokenAmount=(n:unknown,max:number):n is number=>
 typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=max;
/** Render ONLY as escaped HTML in a future owner review UI, never raw HTML
 * directly in Telegram. A valid DRAFT does not establish factual correctness.
 */
const escapeHtml=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
function reviewDraft(raw:unknown,sourceId:string,maxOutputChars:number):
 Extract<B6DraftResult,{status:'DRAFT'}>|null {
 if(!obj(raw)||!keys(raw,['schema','sourceId','text','usage'])||
   raw.schema!=='b6-reviewed-draft-v1'||
   raw.sourceId!==sourceId||!resourceId.test(sourceId)||
   !safeText(raw.text,maxOutputChars)||!obj(raw.usage)||
   !keys(raw.usage,['inputTokens','outputTokens'])||
   !tokenAmount(raw.usage.inputTokens,4096)||
   !tokenAmount(raw.usage.outputTokens,256))return null;
 return {status:'DRAFT',sourceId,draftText:raw.text,safeHtml:escapeHtml(raw.text),
  reviewState:'OWNER_REVIEW_REQUIRED',
  usage:{inputTokens:raw.usage.inputTokens,outputTokens:raw.usage.outputTokens}};
}

/** No autonomous generation: explicitly injected fake, disabled by default.
 * All generated text is quarantined as an unapproved OWNER-REVIEW DRAFT.
 * The independently trusted FAQ preflight is repeated AFTER the awaited port
 * call. A source edit, FAQ archival, scope revocation or permission change
 * wins over the generated text. Never automatically retry uncertain calls.
 */
export class B6GenerationDraftService {
 private readonly enabled:boolean;
 private readonly maxOutputChars:number;
 constructor(
  private readonly preflight:B6AnswerPreflight,
  private readonly port:AnswerGenerationPort,
  private readonly budget:B6EphemeralCallBudget,
  config:B6DraftConfig={}){
  if(!obj(config)||Object.keys(config).some(k=>k!=='enabled'&&k!=='maxOutputChars')||
    (config.enabled!==undefined&&typeof config.enabled!=='boolean')||
    (config.maxOutputChars!==undefined&&
     (!Number.isSafeInteger(config.maxOutputChars)||
      config.maxOutputChars<1||config.maxOutputChars>800)))
   throw Error('INVALID_B6_DRAFT_CONFIG');
  this.enabled=config.enabled===true;
  this.maxOutputChars=config.maxOutputChars??400;
 }
 async prepareDraft(input:B6AnswerRequest):Promise<B6DraftResult>{
  if(!this.enabled)return {status:'DISABLED'};
  const initial=await this.preflight.prepare(input);
  if(initial.status!=='APPROVED_ANSWER')return {status:initial.status};
  const admission=this.budget.begin();
  if(admission.status==='BUSY')return {status:'BUSY'};
  if(admission.status==='BUDGET_EXHAUSTED')return {status:'BUDGET_EXHAUSTED'};
  let returned:unknown;
  try{
   returned=await this.port.generate({
    schema:'b6-reviewed-draft-v1',
    scope:input.scope,question:input.question,
    approvedAnswer:initial.answer,sourceId:initial.sourceId,
    maxOutputChars:this.maxOutputChars
   });
  }catch{return {status:'UNAVAILABLE'};}
  finally{admission.finish();}
  const reviewed=reviewDraft(returned,initial.sourceId,this.maxOutputChars);
  if(!reviewed)return {status:'INVALID_OUTPUT'};
  const current=await this.preflight.prepare(input);
  if(current.status==='DENIED')return {status:'DENIED'};
  if(current.status!=='APPROVED_ANSWER')return {status:'STALE'};
  if(current.answer!==initial.answer||current.sourceId!==initial.sourceId)
   return {status:'STALE'};
  return reviewed;
 }
}
