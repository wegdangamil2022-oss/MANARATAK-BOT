import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {advanceFloodWindow,isValidFloodPolicy,isValidFloodWindow} from '../src/protection-flood.js';
import type {ProtectionPolicy} from '../src/protection-rules.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,CHAT='-100';
const config=():ProtectionPolicy=>({chatId:CHAT,revision:1,mode:'MONITOR',rules:[],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],flood:{enabled:true,limit:10,windowMs:30000,action:'WARN',repeatLimit:2}});
const route=(s:OwnerInlineScreen|null,p:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('repetition fields validate strictly without weakening flood event bounds',()=>{
 assert.equal(isValidFloodPolicy({...config().flood,repeatLimit:11}),false);assert.equal(isValidFloodPolicy({...config().flood,repeatLimit:undefined}),false);
 const base={chatId:CHAT,memberId:'300',policyRevision:1,chatPolicyVersion:1,updatedAt:NOW,events:[{key:'b3-webhook:repeat:1',at:NOW,digest:'a'.repeat(64)}]};assert.equal(isValidFloodWindow(base),true);assert.equal(isValidFloodWindow({...base,events:[{...base.events[0],digest:'bad'}]}),false);assert.equal(isValidFloodWindow({...base,events:[{...base.events[0],extra:true}]}),false);
 assert.equal(advanceFloodWindow(config().flood,[],'b3-webhook:repeat:1',NOW,'bad').status,'INVALID');
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'repetition-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine});let now=NOW;const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation']);return {dir,file,store,policy,now:()=>now,time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};}
 test(engine+' normalized repeated text crosses its separate threshold, survives restart and never persists plaintext',async()=>{
  const f=await fixture();try{
   let service=new GroupProtectionPolicyService(f.store,f.policy,f.now);await service.save('100',config(),1,0);
   await service.observeIncomingText('300',CHAT,'إِعْــلان متكرر',[],'b3-webhook:repeat:1');await service.observeIncomingText('300',CHAT,'اعلان متكرر',[],'b3-webhook:repeat:2');assert.equal((await f.store.snapshot()).audit.some(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')),false);
   service=new GroupProtectionPolicyService(new BotStore(f.file,{engine}),f.policy,f.now);await service.observeIncomingText('300',CHAT,'اعلان متكرر',[],'b3-webhook:repeat:3');const state=await f.store.snapshot();assert.equal(state.audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')).length,1);assert.equal(JSON.stringify(state).includes('اعلان متكرر'),false);assert.ok(state.protectionFloodWindows![0]!.events.every(e=>e.digest?.length===64));
   await service.observeIncomingText('301',CHAT,'اعلان متكرر',[],'b3-webhook:repeat:4');assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')).length,1);
   f.time(NOW+30000);await service.observeIncomingText('300',CHAT,'اعلان متكرر',[],'b3-webhook:repeat:5');assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')).length,1);
  }finally{await f.close();}
 });
 test(engine+' expired evidence cannot authorize delayed enforcement and edits do not advance repetition',async()=>{
  const f=await fixture();try{
   let effects=0,advance=false;const service=new GroupProtectionPolicyService(f.store,f.policy,f.now,{supports:()=>true,execute:async(_a,_c,_m,_action,_key,current)=>{if(advance)f.time(NOW+1000);if(current(await f.store.snapshot()))effects++;return 'REVIEWED';}});
   const c=config();c.mode='ENFORCE';c.flood!.windowMs=1000;await service.save('100',c,1,0);
   await service.observeIncomingText('300',CHAT,'نص متكرر طويل',[],'b3-webhook:repeat:11');await service.observeIncomingText('300',CHAT,'نص متكرر طويل',[],'b3-webhook:repeat:12');await service.observeIncomingText('300',CHAT,'نص متكرر طويل',[],'b3-webhook:repeat:13',false);assert.equal(effects,0);advance=true;
   await service.observeIncomingText('300',CHAT,'نص متكرر طويل',[],'b3-webhook:repeat:14');assert.equal(effects,0);
  }finally{await f.close();}
 });
 test(engine+' editor configures and removes the optional repetition limit while starting disabled',async()=>{
  const f=await fixture();try{
   const ui=new TelegramProtectionEditor(f.store,f.policy,f.now);let g=await ui.handle((await ui.link('100',CHAT))!,'100'),flood=await ui.handle(route(g,'pr:1:S:'),'100');await ui.handle(route(flood,'pr:1:F:'),'100');await ui.handleText('100','10 30 3',false);let c=(await f.store.snapshot()).protectionPolicies![0]!.policy;assert.equal(c.flood!.repeatLimit,3);assert.equal(c.flood!.enabled,false);
   g=await ui.handle((await ui.link('100',CHAT))!,'100');flood=await ui.handle(route(g,'pr:1:S:'),'100');await ui.handle(route(flood,'pr:1:F:'),'100');await ui.handleText('100','10 30',false);c=(await f.store.snapshot()).protectionPolicies![0]!.policy;assert.equal(Object.hasOwn(c.flood!,'repeatLimit'),false);
  }finally{await f.close();}
 });
}
