import {randomUUID} from 'node:crypto';
import {BotStore,type B6BudgetAttempt} from './store.js';

/** A conservative, source-independent durable attempt reservation boundary.
 * This is OFFLINE model-call admission, not a production Phase 17 billing API,
 * trusted provider receipt or globally distributed money ledger. SQLite uses
 * BotStore's BEGIN IMMEDIATE; JSON is only a single-process simulation.
 * Reservations never contain a user ID, prompt text, model response or token.
 */
export interface B6DurableLimits{
 readonly maxDailyAttempts:number;
 readonly maxDailyReservedTokens:number;
 readonly maxConcurrent:number;
 readonly leaseMs:number;
}
export type B6Reservation=
 |{status:'RESERVED';attemptId:string;leaseUntil:number}
 |{status:'DUPLICATE'|'BUDGET_EXHAUSTED'|'BUSY'|'INVALID_REQUEST'|
   'CLOCK_ROLLBACK'|'UNAVAILABLE'};
export type B6Outcome='COMPLETED'|'UNKNOWN_OUTCOME';
export interface B6DurableSummary{
 readonly durable:true;
 readonly day:string;
 readonly attemptsToday:number;
 readonly reservedTokensToday:number;
 readonly active:number;
 readonly unknownCount:number;
}
const validKey=/^[A-Za-z0-9_-]{8,96}$/u;
const validAttempt=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_LEDGER=2000;
const maxTime=8_640_000_000_000_000;
const safeNow=(n:number):boolean=>Number.isSafeInteger(n)&&n>=0&&n<=maxTime-900_000;
const dayOf=(now:number):string=>new Date(now).toISOString().slice(0,10);

export class B6DurableBudget{
 constructor(private readonly store:BotStore,private readonly limits:B6DurableLimits,
  private readonly clock:()=>number=Date.now){
  if(!limits||typeof limits!=='object'||Array.isArray(limits)||
    Object.keys(limits).length!==4||
    !Number.isSafeInteger(limits.maxDailyAttempts)||
    limits.maxDailyAttempts<1||limits.maxDailyAttempts>10_000||
    !Number.isSafeInteger(limits.maxDailyReservedTokens)||
    limits.maxDailyReservedTokens<1||limits.maxDailyReservedTokens>10_000_000||
    !Number.isSafeInteger(limits.maxConcurrent)||
    limits.maxConcurrent<1||limits.maxConcurrent>32||
    !Number.isSafeInteger(limits.leaseMs)||
    limits.leaseMs<1000||limits.leaseMs>900_000)
   throw Error('INVALID_B6_BUDGET_LIMITS');
 }
 /** Only transaction code may mutate budget state. An expired unknown model
  * outcome stays permanently counted and may never automatically replay.
  */
 private sweep(rows:B6BudgetAttempt[],now:number):number{
  let changed=0;
  for(const row of rows){
   if(row.status==='RESERVED'&&row.leaseUntil<=now){
    row.status='UNKNOWN_OUTCOME';changed++;
   }
  }
  return changed;
 }
 private clockState(highwater:number|undefined,now:number):boolean{
  return highwater!==undefined&&now<highwater;
 }
 async reserve(requestKey:string,reservedTokens:number):Promise<B6Reservation>{
  if(typeof requestKey!=='string'||!validKey.test(requestKey)||
    typeof reservedTokens!=='number'||!Number.isSafeInteger(reservedTokens)||
    reservedTokens<1||reservedTokens>8192)return {status:'INVALID_REQUEST'};
  let now:number;
  try{now=this.clock();}catch{return {status:'UNAVAILABLE'};}
  if(!safeNow(now))return {status:'UNAVAILABLE'};
  try{
   return await this.store.transaction<B6Reservation>(state=>{
    if(this.clockState(state.b6BudgetClock,now))return {status:'CLOCK_ROLLBACK'};
    const rows=state.b6BudgetAttempts??[];
    // Duplicate must never trigger a new provider attempt, even on another day.
    if(rows.some(row=>row.requestKey===requestKey))return {status:'DUPLICATE'};
    this.sweep(rows,now);
    const today=dayOf(now),used=rows.filter(r=>r.day===today);
    if(used.length>=this.limits.maxDailyAttempts||
      used.reduce((total,r)=>total+r.reservedTokens,0)+reservedTokens>
         this.limits.maxDailyReservedTokens)
     return {status:'BUDGET_EXHAUSTED'};
    if(rows.some(r=>r.status==='RESERVED'&&r.leaseUntil>now)&&
      rows.filter(r=>r.status==='RESERVED'&&r.leaseUntil>now).length>=
        this.limits.maxConcurrent)return {status:'BUSY'};
    // Retention or reconciliation must be an independently reviewed
    // operation: running out of space never silently drops replay evidence.
    if(rows.length>=MAX_LEDGER)return {status:'UNAVAILABLE'};
    const attemptId=randomUUID(),leaseUntil=now+this.limits.leaseMs;
    rows.push({requestKey,attemptId,day:today,reservedTokens,reservedAt:now,
      leaseUntil,status:'RESERVED'});
    state.b6BudgetAttempts=rows;
    state.b6BudgetClock=now;
    return {status:'RESERVED',attemptId,leaseUntil};
   });
  }catch{return {status:'UNAVAILABLE'};}
 }
 /** A provider exception, ambiguous timeout or interrupted worker must settle
  * UNKNOWN, never COMPLETED. Neither status refunds reserved capacity.
  */
 async finish(requestKey:string,attemptId:string,outcome:B6Outcome):Promise<'COMPLETED'|'UNKNOWN_OUTCOME'|'STALE'>{
  if(typeof requestKey!=='string'||!validKey.test(requestKey)||
    typeof attemptId!=='string'||!validAttempt.test(attemptId)||
    (outcome!=='COMPLETED'&&outcome!=='UNKNOWN_OUTCOME'))return 'STALE';
  let now:number;
  try{now=this.clock();}catch{return 'STALE';}
  if(!safeNow(now))return 'STALE';
  try{
   return await this.store.transaction<'COMPLETED'|'UNKNOWN_OUTCOME'|'STALE'>(s=>{
    if(this.clockState(s.b6BudgetClock,now))return 'STALE';
    const rows=s.b6BudgetAttempts??[];
    const attempt=rows.find(r=>r.requestKey===requestKey&&r.attemptId===attemptId);
    if(!attempt||attempt.status!=='RESERVED'||attempt.leaseUntil<=now)
     return 'STALE';
    attempt.status=outcome;
    s.b6BudgetClock=now;
    return outcome;
   });
  }catch{return 'STALE';}
 }
 /** Recovery is a one-way quarantine transition. No outbound model call. */
 async recoverExpired():Promise<number>{
  const now=this.clock();
  if(!safeNow(now))throw Error('B6_INVALID_CLOCK');
  return this.store.transaction(s=>{
   if(this.clockState(s.b6BudgetClock,now))throw Error('B6_CLOCK_ROLLBACK');
   const rows=s.b6BudgetAttempts??[];
   const changed=this.sweep(rows,now);
   if(changed){s.b6BudgetAttempts=rows;s.b6BudgetClock=now;}
   return changed;
  });
 }
 async inspect():Promise<B6DurableSummary>{
  const now=this.clock();
  if(!safeNow(now))throw Error('B6_INVALID_CLOCK');
  const s=await this.store.snapshot();
  if(this.clockState(s.b6BudgetClock,now))throw Error('B6_CLOCK_ROLLBACK');
  const rows=s.b6BudgetAttempts??[],day=dayOf(now);
  const today=rows.filter(r=>r.day===day);
  return {durable:true,day,attemptsToday:today.length,
   reservedTokensToday:today.reduce((total,r)=>total+r.reservedTokens,0),
   active:rows.filter(r=>r.status==='RESERVED'&&r.leaseUntil>now).length,
   unknownCount:rows.filter(r=>r.status==='UNKNOWN_OUTCOME'||
    r.status==='RESERVED'&&r.leaseUntil<=now).length};
 }
}
