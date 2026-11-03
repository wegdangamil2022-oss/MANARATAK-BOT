import type {BotStore} from './store.js';
import {Policy} from './policy.js';
import type {TelegramReplySender} from './telegram-replies.js';
import type {TelegramResult} from './telegram-transport.js';
import {Phase4GreetingService} from './phase4-greeting-service.js';
import {parsePhase4TelegramEvents} from './phase4-telegram-events.js';

/** Optional phase-four handler behind the authenticated primary webhook.
 * NO local update may bypass the main Telegram ingress and STOP guard.
 */
export class Phase4TelegramRuntime {
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly service:Phase4GreetingService,private readonly sender:TelegramReplySender,
  private readonly options:{readonly safetyGate:()=>Promise<boolean>;readonly clock?:()=>number}){}
 async handle(payload:unknown,primary:TelegramResult):Promise<
  {readonly status:'IGNORED'|'PAUSED'|'PROCESSED';readonly queued:number;readonly delivered:number}> {
  // A primary moderation/FAQ reply takes precedence; no duplicate group answer.
  if(!(primary.status==='IGNORED'||primary.status==='DENIED'&&
    primary.reason==='UNSUPPORTED_MESSAGE')||primary.plan)
   return {status:'IGNORED',queued:0,delivered:0};
  const now=this.options.clock?.()??Date.now();
  const candidates=parsePhase4TelegramEvents(payload,now);
  if(!candidates.length)return {status:'IGNORED',queued:0,delivered:0};
  let safe=false;try{safe=await this.options.safetyGate();}catch{/* fail closed */}
  if(!safe)return {status:'PAUSED',queued:0,delivered:0};
  let queued=0,delivered=0;
  for(const candidate of candidates){
   const state=await this.store.snapshot();
   if(!this.policy.canUseChat(state,candidate.chatId,'navigation'))continue;
   // Fresh permission is re-checked by the durable reservation and dispatch.
   const result=await this.service.evaluate({...candidate,chatApproved:true});
   if(result.status!=='QUEUED'||!result.jobId)continue;
   queued++;
   try{safe=await this.options.safetyGate();}catch{safe=false;}
   if(!safe)break;
   const outcome=await this.service.deliver(result.jobId,this.sender);
   if(outcome.status==='SENT')delivered++;
  }
  return {status:'PROCESSED',queued,delivered};
 }
}