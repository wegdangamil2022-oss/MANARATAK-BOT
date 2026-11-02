import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {evaluateProtectionRules,isValidProtectionPolicy,type ProtectionPolicy} from '../src/protection-rules.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const base:ProtectionPolicy={chatId:'-100',revision:1,mode:'MONITOR',rules:[{id:'spam',kind:'WORD',value:'spam',enabled:true,action:'WARN'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[],temporaryExemptions:[{memberId:'300',createdAt:100000,expiresAt:160000}]};
const message={chatId:'-100',memberId:'300',type:'TEXT' as const,text:'spam'};
const route=(s:OwnerInlineScreen|null,p:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('temporary exemptions have strict bounded unique records and exact time boundaries',()=>{
 assert.ok(isValidProtectionPolicy(base));
 for(const now of [100000,159999])assert.equal(evaluateProtectionRules(base,message,now).status,'EXEMPT');
 for(const now of [99999,160000])assert.equal(evaluateProtectionRules(base,message,now).status,'MATCH');
 assert.equal(evaluateProtectionRules(base,message,NaN).status,'INVALID_MESSAGE');
 for(const rows of [[{...base.temporaryExemptions![0],expiresAt:159999}],[{...base.temporaryExemptions![0],expiresAt:86500001}],[{...base.temporaryExemptions![0],extra:true}],base.temporaryExemptions!.concat(base.temporaryExemptions!)])assert.equal(isValidProtectionPolicy({...base,temporaryExemptions:rows}),false);
 assert.ok(isValidProtectionPolicy({...base,temporaryExemptions:undefined})===false);
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' exemption editor cancels, rejects copied and stale controls, persists expiry and confirms removal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'temporary-exempt-'));try{
   let now=100000;const path=join(dir,'state.'+engine),store=new BotStore(path,{engine}),policy=new Policy(store,'100',()=>now);
   await policy.approveChat('100','-100',['moderation']);const editor=new TelegramProtectionEditor(store,policy,()=>now);
   const group=async()=>editor.handle((await editor.link('100','-100'))!,'100');
   let g=await group(),add=route(g,'pr:1:E:');assert.equal(await editor.handle(add,'200'),null);
   await editor.handle(add,'100');await editor.cancelNavigation('100');assert.equal(await editor.handleText('100','300 60',false),null);
   assert.equal((await store.snapshot()).protectionPolicies,undefined);
   await editor.handle(add,'100');assert.equal((await editor.handleText('100','300 59',false))!.reason,'PROTECTION_EDITOR_INPUT_REJECTED');
   const saved=await editor.handleText('100','300 60',false);assert.equal(saved?.status,'APPLIED');
   assert.equal(await editor.handle(add,'100'),null);
   let cfg=(await store.snapshot()).protectionPolicies![0]!.policy;
   assert.deepEqual(cfg.temporaryExemptions,[{memberId:'300',createdAt:100000,expiresAt:160000}]);
   assert.deepEqual((await new BotStore(path,{engine}).snapshot()).protectionPolicies![0]!.policy.temporaryExemptions,cfg.temporaryExemptions);
   const service=new GroupProtectionPolicyService(store,policy,()=>now);await service.save('100',{...cfg,revision:2,mode:'MONITOR',rules:base.rules,flood:{enabled:true,limit:1,windowMs:1000,action:'WARN'}},1,1);
   assert.equal(await service.observeIncomingText('300','-100','spam',[],'b3-webhook:test:1'),'EXEMPT');
   assert.equal((await store.snapshot()).protectionFloodWindows,undefined);
   now=160000;assert.equal(await service.observeIncomingText('300','-100','spam',[],'b3-webhook:test:2'),'OBSERVED');
   g=await group();
   // Select the exemptions list explicitly; group also contains domain/phrase lists.
   const listRoute=g!.keyboard.inline_keyboard.flat().find(b=>b.text.includes('الاستثناءات المؤقتة'))!.callback_data;
   const exemptions=await editor.handle(listRoute,'100');assert.match(exemptions!.text,/منتهي/u);
   const confirmation=await editor.handle(route(exemptions,'pr:1:q:'),'100');
   assert.equal((await store.snapshot()).protectionPolicies![0]!.policy.temporaryExemptions!.length,1);
   await editor.handle(route(confirmation,'pr:1:k:'),'100');cfg=(await store.snapshot()).protectionPolicies![0]!.policy;
   assert.deepEqual(cfg.temporaryExemptions,[]);assert.equal(cfg.mode,'MONITOR');assert.equal(cfg.rules.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
