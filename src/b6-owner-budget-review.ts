import {BotStore,type B6BudgetAttempt,type BotState} from './store.js';
import {Policy} from './policy.js';

const maxTime=8_640_000_000_000_000;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const PAGE_SIZE=8;
export type B6ReviewRow={
 attemptId:string;reservedTokens:number;day:string;leaseUntil:number;
 status:'RESERVED'|'COMPLETED'|'UNKNOWN_OUTCOME'|'EXPIRED_UNRESOLVED';
 reviewed:boolean;
};
export type B6ReviewReport=
 |{status:'DENIED'|'INVALID_PAGE'|'UNAVAILABLE'}
 |{status:'REPORT';day:string;page:number;pages:number;total:number;
   attemptsToday:number;reservedTokensToday:number;active:number;unknown:number;
   rows:B6ReviewRow[]};
export type B6ReviewMutation=
 |{status:'DENIED'|'STALE'|'UNAVAILABLE'}
 |{status:'QUARANTINED';count:number}
 |{status:'ACKNOWLEDGED'};

/** Offline operator oversight of persistent conservative fake-call reservations.
 * No student question, account, API secret or opaque request key leaves storage.
 * Acknowledgement records awareness only; UNKNOWN stays UNKNOWN and charged.
 * This is NOT provider reconciliation or permission to replay a model request.
 */
export class B6OwnerBudgetReview {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private validNow():number{
  const now=this.clock();
  if(!Number.isSafeInteger(now)||now<0||now>maxTime-900_000)
   throw Error('B6_INVALID_CLOCK');
  return now;
 }
 private permitted(s:BotState,actor:string):boolean{
  return this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor);
 }
 private effective(row:B6BudgetAttempt,now:number):B6ReviewRow['status']{
  if(row.status==='RESERVED'&&row.leaseUntil<=now)return 'EXPIRED_UNRESOLVED';
  return row.status;
 }
 async report(actor:string,page=0):Promise<B6ReviewReport>{
  if(!this.policy.isOwner(actor))return {status:'DENIED'};
  if(!Number.isSafeInteger(page)||page<0||page>999)return {status:'INVALID_PAGE'};
  try{
   const now=this.validNow(),state=await this.store.snapshot();
   if(!this.permitted(state,actor))return {status:'DENIED'};
   if(state.b6BudgetClock!==undefined&&now<state.b6BudgetClock)
    return {status:'UNAVAILABLE'};
   const ledger=state.b6BudgetAttempts??[];
   const today=new Date(now).toISOString().slice(0,10);
   const current=ledger.filter(r=>r.day===today);
   const sorted=[...ledger].sort((a,b)=>b.reservedAt-a.reservedAt||
     b.attemptId.localeCompare(a.attemptId));
   const pages=Math.ceil(sorted.length/PAGE_SIZE);
   if(page>0&&(page>=pages))return {status:'INVALID_PAGE'};
   const rows=sorted.slice(page*PAGE_SIZE,page*PAGE_SIZE+PAGE_SIZE).map(r=>({
    attemptId:r.attemptId,day:r.day,leaseUntil:r.leaseUntil,
    reservedTokens:r.reservedTokens,status:this.effective(r,now),
    reviewed:r.operatorReview!==undefined
   }));
   return {status:'REPORT',day:today,page,pages,total:ledger.length,
    attemptsToday:current.length,
    reservedTokensToday:current.reduce((n,r)=>n+r.reservedTokens,0),
    active:ledger.filter(r=>r.status==='RESERVED'&&r.leaseUntil>now).length,
    unknown:ledger.filter(r=>r.status==='UNKNOWN_OUTCOME'||
      r.status==='RESERVED'&&r.leaseUntil<=now).length,
    rows};
  }catch{return {status:'UNAVAILABLE'};}
 }
 async quarantineExpired(actor:string):Promise<B6ReviewMutation>{
  if(!this.policy.isOwner(actor))return {status:'DENIED'};
  try{
   const now=this.validNow();
   return await this.store.transaction<B6ReviewMutation>(state=>{
    if(!this.permitted(state,actor))return {status:'DENIED'};
    if(state.b6BudgetClock!==undefined&&now<state.b6BudgetClock)
      return {status:'UNAVAILABLE'};
    let count=0;
    for(const item of state.b6BudgetAttempts??[]){
     if(item.status==='RESERVED'&&item.leaseUntil<=now){
      item.status='UNKNOWN_OUTCOME';count++;
     }
    }
    if(count>0)state.b6BudgetClock=now;
    // IMPORTANT: reservation and units still exist, not refunded or replayable.
    return {status:'QUARANTINED',count};
   });
  }catch{return {status:'UNAVAILABLE'};}
 }
 async acknowledge(actor:string,attemptId:string):Promise<B6ReviewMutation>{
  if(!this.policy.isOwner(actor))return {status:'DENIED'};
  if(typeof attemptId!=='string'||!uuid.test(attemptId))return {status:'STALE'};
  try{
   const now=this.validNow();
   return await this.store.transaction<B6ReviewMutation>(state=>{
    if(!this.permitted(state,actor))return {status:'DENIED'};
    if(state.b6BudgetClock!==undefined&&now<state.b6BudgetClock)
     return {status:'UNAVAILABLE'};
    const row=state.b6BudgetAttempts?.find(x=>x.attemptId===attemptId);
    if(!row||row.status!=='UNKNOWN_OUTCOME'||row.operatorReview)
     return {status:'STALE'};
    row.operatorReview={reviewedBy:actor,reviewedAt:now};
    state.b6BudgetClock=now;
    state.audit.push({actorId:actor,updateKey:'b6-ack:'+attemptId,
     decision:'ALLOW',reason:'B6_UNKNOWN_OUTCOME_ACKNOWLEDGED',
     policyVersion:0,at:now});
    return {status:'ACKNOWLEDGED'};
   });
  }catch{return {status:'UNAVAILABLE'};}
 }
}
