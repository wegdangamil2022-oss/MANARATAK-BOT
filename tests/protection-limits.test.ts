import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import {TelegramProtectionEditor} from '../src/telegram-protection-editor.js';
import {evaluateProtectionRules,isValidProtectionPolicy,type ProtectionPolicy} from '../src/protection-rules.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const config=(metric:'MENTIONS'|'HASHTAGS'|'LENGTH'|'QUOTES',maximum:number):ProtectionPolicy=>({chatId:'-100',revision:1,mode:'MONITOR',rules:[{id:'limit',kind:'LIMIT',metric,maximum,enabled:true,action:'WARN'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]});
const evaluate=(metric:'MENTIONS'|'HASHTAGS'|'LENGTH',maximum:number,text:string)=>evaluateProtectionRules(config(metric,maximum),{chatId:'-100',memberId:'300',type:'TEXT',text},100000);
const route=(s:OwnerInlineScreen|null,p:string)=>{const b=s?.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(p));assert.ok(b,p);return b.callback_data;};
test('limits use strict greater-than boundaries, Unicode character length and avoid treating email as a mention',()=>{
 assert.equal(evaluate('MENTIONS',1,'@alpha @bravo').status,'MATCH');assert.equal(evaluate('MENTIONS',1,'@alpha').status,'CLEAR');assert.equal(evaluate('MENTIONS',1,'first@school.edu second@school.edu').status,'CLEAR');
 assert.equal(evaluate('HASHTAGS',1,'#تعليم #منح').status,'MATCH');assert.equal(evaluate('HASHTAGS',1,'#تعليم').status,'CLEAR');
 assert.equal(evaluate('LENGTH',2,'😀ع').status,'CLEAR');assert.equal(evaluate('LENGTH',2,'😀عر').status,'MATCH');
 assert.equal(isValidProtectionPolicy(config('LENGTH',4097)),false);assert.equal(isValidProtectionPolicy(config('MENTIONS',101)),false);assert.equal(isValidProtectionPolicy(config('HASHTAGS',0)),false);
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' validated hidden mentions count once per range, invalid UTF-16 metadata is unavailable, and only counts reach evaluation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'protection-limits-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>100000);await policy.approveChat('100','-100',['moderation']);const service=new GroupProtectionPolicyService(store,policy,()=>100000);await service.save('100',config('MENTIONS',1),1,0);
   const entities=[{type:'text_mention',offset:0,length:3,user:{id:401}},{type:'text_mention',offset:4,length:3,user:{id:402}}];
   await service.observeIncomingText('300','-100','Ali Bob',entities,'b3-webhook:limit:1');let s=await store.snapshot();assert.ok(s.audit.some(a=>a.updateKey==='b3-webhook:limit:1:protection:-100'&&a.reason.includes('action=WARN')));assert.equal(JSON.stringify(s).includes('Ali Bob'),false);assert.equal(JSON.stringify(s).includes('401'),false);
   await service.observeIncomingText('300','-100','Ali Bob',[entities[0],entities[0]],'b3-webhook:limit:2');s=await store.snapshot();assert.equal(s.audit.some(a=>a.updateKey==='b3-webhook:limit:2:protection:-100'),false);
   assert.equal(await service.observeIncomingText('300','-100','😀',[{type:'text_mention',offset:1,length:1}],'b3-webhook:limit:3'),'UNAVAILABLE');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' quote limits count validated formatted ranges once and ignore literal quote characters',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'protection-quotes-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>100000);await policy.approveChat('100','-100',['moderation']);const service=new GroupProtectionPolicyService(store,policy,()=>100000);await service.save('100',config('QUOTES',1),1,0);
   await service.observeIncomingText('300','-100','one two',[{type:'blockquote',offset:0,length:3},{type:'expandable_blockquote',offset:4,length:3}],'b3-webhook:quotes:1');assert.equal((await store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')).length,1);
   await service.observeIncomingText('300','-100','one two',[{type:'blockquote',offset:0,length:3},{type:'expandable_blockquote',offset:0,length:3}],'b3-webhook:quotes:2');await service.observeIncomingText('300','-100','> one > two',[],'b3-webhook:quotes:3');assert.equal((await store.snapshot()).audit.filter(a=>a.reason.startsWith('PROTECTION_MONITOR_MATCH:')).length,1);
   assert.equal(await service.observeIncomingText('300','-100','😀',[{type:'blockquote',offset:1,length:1}],'b3-webhook:quotes:4'),'UNAVAILABLE');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' word matching button persists its choice through editing and rejects stale toggles',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'protection-word-mode-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>100000);await policy.approveChat('100','-100',['moderation']);
   const service=new GroupProtectionPolicyService(store,policy,()=>100000);await service.save('100',{chatId:'-100',revision:1,mode:'OFF',rules:[{id:'word',kind:'WORD',value:'اعلان',enabled:false,action:'REVIEW'}],allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},1,0);
   const ui=new TelegramProtectionEditor(store,policy,()=>100000),home=()=>ui.link('100','-100').then(link=>ui.handle(link!,'100'));
   let g=await home(),list=await ui.handle(route(g,'pr:1:l:'),'100'),detail=await ui.handle(route(list,'pr:1:r:'),'100');const toggle=route(detail,'pr:1:R:');assert.ok(await ui.handle(toggle,'100'));
   let rule=(await store.snapshot()).protectionPolicies![0]!.policy.rules[0]!;assert.equal(rule.kind==='WORD'&&rule.match,'PARTIAL');assert.equal(rule.enabled,false);assert.equal(await ui.handle(toggle,'100'),null);
   g=await home();list=await ui.handle(route(g,'pr:1:l:'),'100');detail=await ui.handle(route(list,'pr:1:r:'),'100');await ui.handle(route(detail,'pr:1:v:'),'100');await ui.handleText('100','منح',false);
   rule=(await store.snapshot()).protectionPolicies![0]!.policy.rules[0]!;assert.equal(rule.kind==='WORD'&&rule.match,'PARTIAL');assert.equal(rule.kind==='WORD'&&rule.value,'منح');
   g=await home();list=await ui.handle(route(g,'pr:1:l:'),'100');detail=await ui.handle(route(list,'pr:1:r:'),'100');await ui.handle(route(detail,'pr:1:R:'),'100');rule=(await store.snapshot()).protectionPolicies![0]!.policy.rules[0]!;assert.equal(Object.hasOwn(rule,'match'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 test(engine+' scoped limit editor validates, starts disabled, preserves back and cancels stale input',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'protection-limit-ui-'));try{
   const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>100000);await policy.approveChat('100','-100',['moderation']);const ui=new TelegramProtectionEditor(store,policy,()=>100000);
   const g=await ui.handle((await ui.link('100','-100'))!,'100'),begin=route(g,'pr:1:Q:');await ui.handle(begin,'100');assert.equal((await ui.handleText('100','mentions 101',false))?.reason,'PROTECTION_EDITOR_INPUT_REJECTED');
   const saved=await ui.handleText('100','mentions 5',false);assert.equal(saved?.status,'APPLIED');const c=(await store.snapshot()).protectionPolicies![0]!.policy;assert.equal(c.mode,'OFF');assert.deepEqual(c.rules.map(r=>r.kind==='LIMIT'?[r.metric,r.maximum,r.enabled,r.action]:[]),[['MENTIONS',5,false,'REVIEW']]);
   assert.equal(await ui.handle(begin,'100'),null);const fresh=await ui.handle((await ui.link('100','-100'))!,'100');await ui.handle(route(fresh,'pr:1:Q:'),'100');await ui.cancelNavigation('100');assert.equal(await ui.handleText('100','length 1000',false),null);const q=await ui.handle((await ui.link('100','-100'))!,'100');await ui.handle(route(q,'pr:1:Q:'),'100');assert.equal((await ui.handleText('100','quotes 2',false))?.status,'APPLIED');assert.ok((await store.snapshot()).protectionPolicies![0]!.policy.rules.some(r=>r.kind==='LIMIT'&&r.metric==='QUOTES'&&!r.enabled));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
