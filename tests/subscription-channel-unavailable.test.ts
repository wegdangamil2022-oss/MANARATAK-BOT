import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {FakeMembershipGateway,SubscriptionGate} from '../src/subscription.js';
import {FakeModerationGateway,ModerationService} from '../src/moderation.js';
import {SubscriptionRightsMonitor} from '../src/subscription-rights-monitor.js';
import {recordChannelUnavailability,summarizeChannelUnavailability} from '../src/subscription-channel-unavailable.js';
const NOW=1700000000000,G='-100100',C='-100200';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'channel-unavailable-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,run=true;const clock=()=>now,policy=new Policy(store,'100',clock);for(const id of [G,C])await policy.approveChat('100',id,['verification']);const gate=new SubscriptionGate(store,policy,new FakeMembershipGateway(),new ModerationService(store,policy,new FakeModerationGateway()),clock);await gate.configure('100',G,[C],'ALL');return {store,policy,gate,clock,time:(n:number)=>now=n,safety:async()=>run,stop:()=>run=false,close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' unavailable rights reads are aggregated without identities and expire in bounded buckets',async()=>{const f=await fixture();try{
  const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=> 'UNKNOWN'},f.clock,f.safety);await m.tick();await m.tick();let s=await f.store.snapshot(),r=summarizeChannelUnavailability(s,f.clock());assert.equal(r.count,1);assert.equal(r.available,true);assert.doesNotMatch(JSON.stringify(s.subscriptionChannelHealth),/100100|100200|300/u);
  f.time(NOW+86400000+300000);r=summarizeChannelUnavailability(s,f.clock());assert.equal(r.count,0);await m.tick();s=await f.store.snapshot();assert.equal(summarizeChannelUnavailability(s,f.clock()).count,1);assert.ok((s.subscriptionChannelHealth as unknown[]).length<=289);
 }finally{await f.close();}});
 test(engine+' stopped, stale and corrupt telemetry never become a confirmed loss or block protection',async()=>{for(const variant of ['stop','changed','corrupt'] as const){const f=await fixture();try{
  if(variant==='corrupt')await f.store.transaction(s=>{s.subscriptionChannelHealth={invalid:true};});
  const m=new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=>{if(variant==='stop')f.stop();if(variant==='changed')await f.gate.configure('100',G,[],'ALL');return 'UNKNOWN';}},f.clock,f.safety);await m.tick();const s=await f.store.snapshot(),r=summarizeChannelUnavailability(s,f.clock());assert.equal(r.count,0);assert.equal(r.available,variant!=='corrupt');assert.ok(!s.audit.some(a=>a.reason.startsWith('SUBSCRIPTION_RIGHTS_ALERT:')));
  if(variant==='corrupt'){await new SubscriptionRightsMonitor(f.store,f.policy,{inspectChannelRights:async()=> 'NOT_ADMIN'},f.clock,f.safety).tick();assert.ok((await f.store.snapshot()).audit.some(a=>a.reason.startsWith('SUBSCRIPTION_RIGHTS_ALERT:')));}
 }finally{await f.close();}}});
 test(engine+' telemetry is bounded on clock rollback, duplicate buckets and saturation',async()=>{const f=await fixture();try{
  const slot=Math.floor(NOW/300000);await f.store.transaction(s=>{s.subscriptionChannelHealth=[{slot,count:1000000000}];assert.equal(recordChannelUnavailability(s,NOW),true);});let state=await f.store.snapshot(),summary=summarizeChannelUnavailability(state,NOW);assert.equal(summary.saturated,true);assert.equal(summary.count,1000000000);
  assert.equal(summarizeChannelUnavailability(state,NOW-300000).available,false);assert.equal(recordChannelUnavailability(state,NOW-300000),false);
  state.subscriptionChannelHealth=[{slot,count:1},{slot,count:1}];assert.equal(summarizeChannelUnavailability(state,NOW).available,false);assert.equal(recordChannelUnavailability(state,NOW),false);
 }finally{await f.close();}});
}
