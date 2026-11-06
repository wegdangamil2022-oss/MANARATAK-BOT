import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {summarizeNetworkSettings,compareNetworkGroupSettings} from '../src/network-policy-diff.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const OWNER='100',NOW=1_700_000_000_000,N='abcdef123456',OTHER='bbbbbb123456';
const A='-100124',B='-100125',C='-100126',D='-100127',E='-100128',OUT='-100199';
function click(screen:OwnerInlineScreen|null,needle:string):string{
 assert.ok(screen,'expected UI: '+needle);
 const b=screen.keyboard.inline_keyboard.flat().find(x=>x.text.includes(needle));
 assert.ok(b,'expected button '+needle+' on '+screen.text);
 assert.ok(Buffer.byteLength(b.callback_data,'utf8')<=64,'Telegram callback >64 bytes');
 return b.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'phase3-network-policy-diff-'));
  const filename=join(dir,'state.'+engine),store=new BotStore(filename,{engine});
  let now=NOW;
  const policy=new Policy(store,OWNER,()=>now);
  for(const id of [A,B,C,D,E,OUT])
   await policy.approveChat(OWNER,id,['moderation','assistant','navigation']);
  const baseRule={id:'r1',kind:'WORD' as const,value:'secretpatternalpha',
   enabled:true,action:'WARN' as const};
  const cfg=(chatId:string)=>({policy:{
   chatId,revision:1,mode:'MONITOR' as const,rules:[{...baseRule}],
   allowedDomains:['private-example.com'],allowedPhrases:['restricted-example'],
   exemptMemberIds:['200']},chatPolicyVersion:1,updatedBy:OWNER,updatedAt:now-100});
  await store.transaction(s=>{
   s.groupNetworks=[
    {id:N,name:'شبكة المقارنة',revision:1,createdBy:OWNER,updatedAt:now,
     members:[A,B,C,D,E].map((id,i)=>({chatId:id,version:i===4?2:1}))},
    {id:OTHER,name:'شبكة خارجية',revision:1,createdBy:OWNER,updatedAt:now,
     members:[{chatId:OUT,version:1}]}];
   for(const chat of s.chats)chat.groupAI='ALL_MENTION';
   const second=cfg(B);second.policy.revision=5;
   const third=cfg(C);
   third.policy.rules=[{...baseRule,value:'secretpatternbeta'}];
   third.policy.allowedDomains=['sensitive-changed.com'];
   s.protectionPolicies=[cfg(A),second,third];
   s.chats.find(c=>c.id===C)!.groupAI='OFF';
  });
  return {store,policy,editor:new OwnerNetworkEditor(store,policy,()=>now),
   newEditor:()=>new OwnerNetworkEditor(new BotStore(filename,{engine}),policy,()=>now),
   advance:(ms:number)=>now+=ms,close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' NETWORK-005 current-member overview shows approved, stale and missing policy status without mutation',async()=>{
  const f=await fixture();try{
   const before=await f.store.snapshot();
   const card=await f.editor.handle(OWNER,'nw:1:d:'+N);
   const home=await f.editor.handle(OWNER,click(card,'مقارنة إعدادات'));
   assert.match(home?.text??'',/المقارنة/u);
   assert.match(home?.text??'',/5/u);
   const page=await f.editor.handle(OWNER,click(home,'اختيار مجموعة مرجعية'));
   assert.match(page?.text??'',/مجموعة مرجعية/u);
   assert.match(page?.text??'',/ارتباطات قديمة/u);
   assert.ok(click(page,A));
   const after=await f.store.snapshot();
   assert.deepEqual(after,before,'read-only workflows must not create approvals, audit, receipts, or policy changes');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 equality ignores group identity, policy revision and metadata',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot(),d=compareNetworkGroupSettings(s,f.policy,OWNER,NOW,N,A,B);
   assert.ok(d);assert.equal(d.comparable,true);assert.equal(d.equivalent,true);
   assert.deepEqual(d.differences,[]);
   const sources=await f.editor.handle(OWNER,'nw:1:cp:'+N+':0');
   const targets=await f.editor.handle(OWNER,click(sources,A));
   const report=await f.editor.handle(OWNER,click(targets,B));
   assert.match(report?.text??'',/متطابقة/u);
   assert.match(report?.text??'',/القراءة فقط/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 detects same-count rule and domain changes without leaking literal text',async()=>{
  const f=await fixture();try{
   const d=compareNetworkGroupSettings(await f.store.snapshot(),f.policy,OWNER,NOW,N,A,C);
   assert.ok(d);assert.equal(d.comparable,true);assert.equal(d.equivalent,false);
   assert.ok(d.differences.some(x=>x.field==='rules'));
   assert.ok(d.differences.some(x=>x.field==='allowedDomains'));
   assert.ok(d.differences.some(x=>x.field==='groupAI'));
   const screen=await f.editor.handle(OWNER,'nw:1:ct:'+N+':'+A+':'+C);
   assert.match(screen?.text??'',/قواعد/u);
   assert.match(screen?.text??'',/النطاقات/u);
   assert.doesNotMatch(screen?.text??'',/secretpattern(?:alpha|beta)/u);
   assert.doesNotMatch(screen?.text??'',/private-example\.com|sensitive-changed\.com/u);
   assert.doesNotMatch(screen?.text??'',/restricted-example/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 missing policy is explicit and cannot be mistaken for equivalent',async()=>{
  const f=await fixture();try{
   const d=compareNetworkGroupSettings(await f.store.snapshot(),f.policy,OWNER,NOW,N,A,D);
   assert.ok(d);assert.equal(d.comparable,false);assert.equal(d.equivalent,false);
   assert.equal(d.target.policyStatus,'MISSING');
   assert.ok(d.differences.some(x=>x.field==='policyStatus'));
   const screen=await f.editor.handle(OWNER,'nw:1:ct:'+N+':'+A+':'+D);
   assert.match(screen?.text??'',/لا توجد سياسة/u);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 stale and revoked network membership cannot become comparison authority',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   const overview=summarizeNetworkSettings(s,f.policy,OWNER,NOW,N);
   assert.equal(overview?.members.find(x=>x.chatId===E)?.status,'STALE');
   assert.equal(compareNetworkGroupSettings(s,f.policy,OWNER,NOW,N,A,E),null);
   assert.equal(compareNetworkGroupSettings(s,f.policy,OWNER,NOW,N,A,OUT),null);
   const screen=await f.editor.handle(OWNER,'nw:1:ct:'+N+':'+A+':'+E);
   assert.equal(screen,null);
   await f.store.transaction(x=>{x.chats.find(c=>c.id===B)!.approved=false;});
   assert.equal(await f.editor.handle(OWNER,'nw:1:ct:'+N+':'+A+':'+B),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 corrupt or duplicated policy records are quarantined from content comparisons',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   s.protectionPolicies!.push(structuredClone(s.protectionPolicies![0]!));
   assert.equal(summarizeNetworkSettings(s,f.policy,OWNER,NOW,N)?.members.find(x=>x.chatId===A)?.policyStatus,'DUPLICATE');
   assert.equal(compareNetworkGroupSettings(s,f.policy,OWNER,NOW,N,A,B),null);
   s.protectionPolicies!.pop();
   s.protectionPolicies![0]!.chatPolicyVersion=99;
   assert.equal(summarizeNetworkSettings(s,f.policy,OWNER,NOW,N)?.members.find(x=>x.chatId===A)?.policyStatus,'STALE');
   assert.equal(compareNetworkGroupSettings(s,f.policy,OWNER,NOW,N,A,B)?.comparable,false);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 private owner only, malformed callbacks and outside network are denied',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:cp:'+N+':0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:cs:'+N+':'+A+':0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:ct:'+N+':'+A+':'+B),true);
   assert.equal(validOwnerNetworkRoute('nw:1:ct:'+N+':'+A+':'+OUT),true);
   assert.equal(validOwnerNetworkRoute('nw:1:ct:'+N+':BAD:'+B),false);
   assert.equal(validOwnerNetworkRoute('nw:1:ct:'+N+':'+A+':'+B+':999'),false);
   assert.equal(await f.editor.handle('200','nw:1:ct:'+N+':'+A+':'+B),null);
   assert.equal(await f.editor.handle(OWNER,'nw:1:ct:'+OTHER+':'+A+':'+B),null);
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.editor.handle(OWNER,'nw:1:cp:'+N+':0'),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 read-only comparisons remain available during emergency STOP',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{
    s.networkEmergencyControls=[{networkId:N,revision:1,status:'STOPPED',changedAt:NOW,changedBy:OWNER}];
   });
   const detail=await f.editor.handle(OWNER,'nw:1:ct:'+N+':'+A+':'+C);
   assert.match(detail?.text??'',/طوارئ/u);
   const s=await f.store.snapshot();
   assert.equal(s.chats.find(x=>x.id===C)?.groupAI,'OFF');
   assert.equal(s.networkEmergencyControls?.[0]?.status,'STOPPED');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 paginates more than eight groups without changing the selected network',async()=>{
  const f=await fixture();try{
   const extras=Array.from({length:10},(_,i)=>'-100'+String(140+i));
   for(const id of extras)
    await f.policy.approveChat(OWNER,id,['moderation','assistant','navigation']);
   await f.store.transaction(s=>{
    const n=s.groupNetworks!.find(x=>x.id===N)!;
    n.members.push(...extras.map(chatId=>({chatId,version:1})));
   });
   const p0=await f.editor.handle(OWNER,'nw:1:cp:'+N+':0');
   assert.match(p0?.text??'',/صفحة 1\/2/u);
   const p1=await f.editor.handle(OWNER,click(p0,'التالي'));
   assert.match(p1?.text??'',/صفحة 2\/2/u);
   const src=await f.editor.handle(OWNER,click(p1,extras[9]!));
   assert.match(src?.text??'',/اختر مجموعة/u);
   const target=await f.editor.handle(OWNER,click(src,B));
   assert.match(target?.text??'',/لا توجد سياسة/u);
   assert.equal((await f.store.snapshot()).callbacks.length,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 group service scopes differences remain private and flagged',async()=>{
  const f=await fixture();try{
   const s=await f.store.snapshot();
   s.chats.find(x=>x.id===B)!.scopes=['moderation','navigation','alternate'];
   const d=compareNetworkGroupSettings(s,f.policy,OWNER,NOW,N,A,B);
   assert.ok(d);
   assert.equal(d.equivalent,false);
   assert.ok(d.differences.some(x=>x.field==='scopes'));
   assert.equal(d.differences.some(x=>x.field==='rules'),false);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-005 comparison rechecks live versions and survives editor restart without storing selections',async()=>{
  const f=await fixture();try{
   const p=await f.editor.handle(OWNER,'nw:1:cp:'+N+':0');
   const first=await f.editor.handle(OWNER,click(p,A));
   const detail=await f.newEditor().handle(OWNER,click(first,B));
   assert.match(detail?.text??'',/متطابقة/u);
   await f.store.transaction(s=>{s.chats.find(x=>x.id===A)!.version++;});
   assert.equal(await f.editor.handle(OWNER,click(first,B)),null);
   const record=await f.store.snapshot();
   assert.equal(record.callbacks.length,0);
   assert.equal(record.audit.length>0,false);
  }finally{await f.close();}
 });
}
