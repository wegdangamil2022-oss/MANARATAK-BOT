import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {evaluateProtectionRules,isValidProtectionPolicy,protectionRuleFingerprint,type ProtectionPolicy} from '../src/protection-rules.js';
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
test('rule-specific exemption skips only its selected rule and respects expiry',()=>{
 const config:ProtectionPolicy={...base,temporaryExemptions:[],rules:[...base.rules,{id:'second',kind:'PHRASE',value:'danger',enabled:true,action:'MUTE'}],ruleExemptions:[{memberId:'300',ruleId:'spam',ruleDigest:protectionRuleFingerprint(base.rules[0]!),createdAt:100000,expiresAt:160000,grantedBy:'100'}]};
 assert.equal(isValidProtectionPolicy(config),true);assert.deepEqual(evaluateProtectionRules(config,{...message,text:'spam danger'},100000).matchedRuleIds,['second']);assert.equal(evaluateProtectionRules(config,message,100000).status,'CLEAR');assert.equal(evaluateProtectionRules(config,message,160000).status,'MATCH');assert.equal(evaluateProtectionRules(config,{...message,memberId:'301'},100000).status,'MATCH');
 assert.equal(isValidProtectionPolicy({...config,ruleExemptions:[...config.ruleExemptions!,config.ruleExemptions![0]!]}),false);assert.equal(isValidProtectionPolicy({...config,ruleExemptions:[{...config.ruleExemptions![0]!,ruleId:'missing'}]}),false);
 const edited={...config,rules:[{...config.rules[0]!,value:'other'},config.rules[1]!]};assert.equal(evaluateProtectionRules(edited,{...message,text:'other'},100000).status,'MATCH');
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' rule-specific exemptions have actionable preview and removal without suppressing flood',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-specific-exempt-'));try{
   const now=100000,path=join(dir,'state.'+engine),store=new BotStore(path,{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const service=new GroupProtectionPolicyService(store,policy,()=>now);
   const initial={...base,temporaryExemptions:[],flood:{enabled:true,limit:1,windowMs:1000,action:'WARN' as const}};assert.equal((await service.save('100',initial,1,0)).status,'SAVED');const editor=new TelegramProtectionEditor(store,policy,()=>now),g=await editor.handle((await editor.link('100','-100'))!,'100'),list=await editor.handle(route(g,'pr:1:l:'),'100'),details=await editor.handle(route(list,'pr:1:r:'),'100');
   const add=route(details,'pr:1:G:');assert.ok(await editor.handle(add,'100'));assert.equal((await editor.handleText('100','300 59',false))!.reason,'PROTECTION_EDITOR_INPUT_REJECTED');assert.equal((await editor.handleText('100','300 60',false))!.status,'APPLIED');
   const saved=(await store.snapshot()).protectionPolicies![0]!.policy;assert.deepEqual(saved.ruleExemptions,[{memberId:'300',ruleId:'spam',ruleDigest:protectionRuleFingerprint(base.rules[0]!),createdAt:now,expiresAt:now+60000,grantedBy:'100'}]);assert.deepEqual((await new BotStore(path,{engine}).snapshot()).protectionPolicies![0]!.policy.ruleExemptions,saved.ruleExemptions);
   const forged={...saved,revision:saved.revision+1,ruleExemptions:[...saved.ruleExemptions!,{...saved.ruleExemptions![0]!,memberId:'301',grantedBy:'999'}]};assert.equal((await service.save('100',forged,1,saved.revision)).status,'INVALID');
   await service.observeIncomingText('300','-100','spam',[],'b3-webhook:test:11');await service.observeIncomingText('300','-100','spam',[],'b3-webhook:test:12');assert.ok((await store.snapshot()).audit.some(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')));
   const fresh=await editor.handle((await editor.link('100','-100'))!,'100'),picker=fresh!.keyboard.inline_keyboard.flat().find(b=>b.text.includes('استثناءات القواعد'))!;assert.ok(picker);const entries=await editor.handle(picker.callback_data,'100'),preview=await editor.handle(route(entries,'pr:1:q:'),'100');assert.equal((await store.snapshot()).protectionPolicies![0]!.policy.ruleExemptions!.length,1);assert.ok(await editor.handle(route(preview,'pr:1:k:'),'100'));assert.deepEqual((await store.snapshot()).protectionPolicies![0]!.policy.ruleExemptions,[]);
   const again=await editor.handle((await editor.link('100','-100'))!,'100'),rules=await editor.handle(route(again,'pr:1:l:'),'100'),item=await editor.handle(route(rules,'pr:1:r:'),'100');await editor.handle(route(item,'pr:1:G:'),'100');assert.equal((await editor.handleText('100','300 60',false))!.status,'APPLIED');
   const withExemption=await editor.handle((await editor.link('100','-100'))!,'100'),ruleList=await editor.handle(route(withExemption,'pr:1:l:'),'100'),ruleDetails=await editor.handle(route(ruleList,'pr:1:r:'),'100'),removeRule=await editor.handle(route(ruleDetails,'pr:1:d:'),'100');assert.match(removeRule!.text,/واستثناءاتها/u);assert.ok(await editor.handle(route(removeRule,'pr:1:x:'),'100'));const after=(await store.snapshot()).protectionPolicies![0]!.policy;assert.deepEqual(after.rules,[]);assert.deepEqual(after.ruleExemptions,[]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' changing a rule permanently invalidates its earlier exemptions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-change-'));try{const now=100000,store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const service=new GroupProtectionPolicyService(store,policy,()=>now),rule=base.rules[0]!;
   const initial:ProtectionPolicy={...base,temporaryExemptions:[],ruleExemptions:[{memberId:'300',ruleId:rule.id,ruleDigest:protectionRuleFingerprint(rule),createdAt:now,expiresAt:now+60000,grantedBy:'100'}]};assert.equal((await service.save('100',initial,1,0)).status,'SAVED');
   const changed={...initial,revision:2,rules:[{id:'spam',kind:'WORD' as const,value:'other',enabled:true,action:'WARN' as const}]};assert.equal((await service.save('100',changed,1,1)).status,'SAVED');const after=(await store.snapshot()).protectionPolicies![0]!.policy;assert.deepEqual(after.ruleExemptions,[]);
   assert.equal((await service.save('100',{...after,revision:3,rules:[rule]},1,2)).status,'SAVED');const restored=(await store.snapshot()).protectionPolicies![0]!.policy;assert.equal(evaluateProtectionRules(restored,message,now).status,'MATCH');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' editor explains when a rule edit ends its scoped exceptions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-explain-'));try{const now=100000,store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const service=new GroupProtectionPolicyService(store,policy,()=>now),rule=base.rules[0]!;
   const initial:ProtectionPolicy={...base,temporaryExemptions:[],ruleExemptions:[{memberId:'300',ruleId:rule.id,ruleDigest:protectionRuleFingerprint(rule),createdAt:now,expiresAt:now+60000,grantedBy:'100'}]};assert.equal((await service.save('100',initial,1,0)).status,'SAVED');const editor=new TelegramProtectionEditor(store,policy,()=>now),group=await editor.handle((await editor.link('100','-100'))!,'100'),list=await editor.handle(route(group,'pr:1:l:'),'100'),details=await editor.handle(route(list,'pr:1:r:'),'100');await editor.handle(route(details,'pr:1:v:'),'100');const saved=await editor.handleText('100','other',false);assert.match(saved!.screen.text,/أُنهِيت استثناءات القاعدة/u);assert.deepEqual((await store.snapshot()).protectionPolicies![0]!.policy.ruleExemptions,[]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' changing word matching ends old exceptions and reports the effect',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rule-exempt-match-'));try{const now=100000,store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);const service=new GroupProtectionPolicyService(store,policy,()=>now),rule=base.rules[0]!;
   const initial:ProtectionPolicy={...base,temporaryExemptions:[],ruleExemptions:[{memberId:'300',ruleId:rule.id,ruleDigest:protectionRuleFingerprint(rule),createdAt:now,expiresAt:now+60000,grantedBy:'100'}]};assert.equal((await service.save('100',initial,1,0)).status,'SAVED');const editor=new TelegramProtectionEditor(store,policy,()=>now),group=await editor.handle((await editor.link('100','-100'))!,'100'),list=await editor.handle(route(group,'pr:1:l:'),'100'),details=await editor.handle(route(list,'pr:1:r:'),'100'),saved=await editor.handle(route(details,'pr:1:R:'),'100');assert.match(saved!.text,/أُنهِيت استثناءات القاعدة/u);assert.deepEqual((await store.snapshot()).protectionPolicies![0]!.policy.ruleExemptions,[]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
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
