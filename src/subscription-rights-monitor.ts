import type {BotStore} from './store.js';
import type {Policy} from './policy.js';
import {subscriptionConfigEpoch} from './subscription-config-epoch.js';
import {isCanonicalSubscriptionRule,subscriptionRequirementMode} from './subscription-integrity.js';
import {recordSubscriptionRightsLoss} from './subscription-change-alert.js';
import {recordChannelUnavailability} from './subscription-channel-unavailable.js';

/** Periodic, bounded checks; an unavailable Telegram response is never a loss. */
export class SubscriptionRightsMonitor{
 private readonly nextCheck=new Map<string,number>();
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly gateway:{inspectChannelRights(channel:string):Promise<'ADMIN'|'NOT_ADMIN'|'UNKNOWN'>},
  private readonly clock:()=>number=Date.now,private readonly safety:()=>Promise<boolean>=async()=>true){}
 async tick(limit=5):Promise<void>{
  const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-600000||!await this.safety())return;
  const state=await this.store.snapshot(),epoch=subscriptionConfigEpoch(state),actor=this.policy.ownerId;
  if(!this.policy.privateFeature(state,'owner.dashboard',actor))return;
  const candidates:{key:string;group:string;channel:string;version:number;scope:number}[]=[];
  for(const rule of state.subscriptionRequirements){
   if(!isCanonicalSubscriptionRule(rule)||subscriptionRequirementMode(state,rule.chatId)!=='ACTIVE'||!this.policy.canUseChat(state,rule.chatId,'verification'))continue;
   const scope=this.policy.chatRevision(state,rule.chatId);
   for(const channel of rule.channelIds)if(this.policy.canUseChat(state,channel,'verification'))candidates.push({key:JSON.stringify([rule.chatId,channel,rule.version,scope,this.policy.chatRevision(state,channel)]),group:rule.chatId,channel,version:rule.version,scope});
  }
  const valid=new Set(candidates.map(c=>c.key));for(const key of this.nextCheck.keys())if(!valid.has(key))this.nextCheck.delete(key);
  let count=Number.isSafeInteger(limit)?Math.max(0,Math.min(limit,5)):0;
  for(const c of candidates){
   if(count===0)break;
   if((this.nextCheck.get(c.key)??0)>now)continue;
   if(!await this.safety())return;
   const current=await this.store.snapshot(),checked=this.clock();
   if(!Number.isSafeInteger(checked)||checked<now||checked>=now+120000||subscriptionConfigEpoch(current)!==epoch||!this.policy.privateFeature(current,'owner.dashboard',actor)||!this.policy.canUseChat(current,c.group,'verification')||!this.policy.canUseChat(current,c.channel,'verification')||!await this.safety())return;
   // Another tick can have claimed the candidate while the guards awaited.
   if((this.nextCheck.get(c.key)??0)>now)continue;
   this.nextCheck.set(c.key,now+600000);
   let result:'ADMIN'|'NOT_ADMIN'|'UNKNOWN'='UNKNOWN';try{result=await this.gateway.inspectChannelRights(c.channel);}catch{/* unavailable is unknown */}
   if((result==='NOT_ADMIN'||result==='UNKNOWN')&&await this.safety())await this.store.transaction(s=>{
    const at=this.clock();if(!Number.isSafeInteger(at)||at<now||at>=now+120000||subscriptionConfigEpoch(s)!==epoch||!this.policy.privateFeature(s,'owner.dashboard',actor)||!this.policy.canUseChat(s,c.group,'verification')||!this.policy.canUseChat(s,c.channel,'verification'))return;
    if(result==='NOT_ADMIN')recordSubscriptionRightsLoss(s,actor,c.group,c.channel,c.version,c.scope,at);else recordChannelUnavailability(s,at);
   });
   if(--count<=0)break;
  }
 }
}
