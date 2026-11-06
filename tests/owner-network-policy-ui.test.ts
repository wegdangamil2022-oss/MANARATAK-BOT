import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import {GroupProtectionPolicyService} from '../src/group-protection-policy.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const NOW=1700000000000,OWNER='100',NET='abcdef123456',SOURCE='-100123',A='-100124',B='-100125';
const button=(screen:OwnerInlineScreen|null,title:string)=>{assert.ok(screen);const b=screen.keyboard.inline_keyboard.flat().find(x=>x.text.includes(title));assert.ok(b,title);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'network-policy-ui-')),store=new BotStore(join(dir,'state.'+engine),{engine});
  let now=NOW;const policy=new Policy(store,OWNER,()=>now),owner=new OwnerNetworkEditor(store,policy,()=>now),
   protection=new GroupProtectionPolicyService(store,policy,()=>now);
  for(const chat of [SOURCE,A,B])await policy.approveChat(OWNER,chat,['moderation','navigation']);
  await store.transaction(s=>{s.groupNetworks=[{id:NET,name:'شبكة الطلاب',revision:1,createdBy:OWNER,updatedAt:now,
   members:s.chats.filter(x=>[SOURCE,A,B].includes(x.id)).map(x=>({chatId:x.id,version:x.version}))}];});
  const save=async(chat:string,rev:number,phrase:string)=>{
   const s=await store.snapshot(),v=s.chats.find(x=>x.id===chat)!.version;
   return protection.save(OWNER,{chatId:chat,revision:rev,mode:'MONITOR',
    rules:[{id:'r1',kind:'PHRASE',value:phrase,enabled:true,action:'REVIEW'}],
    allowedDomains:[],allowedPhrases:[],exemptMemberIds:[]},v,rev-1);
  };
  return {store,policy,owner,save,advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' network policy owner button requires private one-shot preview and never copies sanctions',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1,'first policy');
  const card=await f.owner.handle(OWNER,'nw:1:d:'+NET);
  const sources=await f.owner.handle(OWNER,button(card,'سياسات الشبكة'));
  const preview=await f.owner.handle(OWNER,button(sources,SOURCE));
  assert.match(preview?.text??'',/معاينة/u);
  // Telegram renders an actual newline; literal backslash-n is a UI defect.
  assert.ok(sources?.text.includes('\n'));
  assert.ok(preview?.text.includes('\n'));
  assert.equal(sources?.text.includes(String.raw`\n`),false);
  assert.equal(preview?.text.includes(String.raw`\n`),false);
  const yes=button(preview,'تأكيد');
  assert.equal(validOwnerNetworkRoute(yes),true);
  assert.equal((await f.store.snapshot()).networkInheritance,undefined);
  assert.equal(await f.owner.handle('301',yes),null);
  assert.ok(await f.owner.handle(OWNER,yes));
  assert.equal(await f.owner.handle(OWNER,yes),null);
  let s=await f.store.snapshot();
  assert.deepEqual(s.networkInheritance?.map(v=>v.targetChatId).sort(),[A,B].sort());
  assert.ok(s.networkInheritance?.every(v=>v.status==='ACTIVE'&&v.kind==='POLICY'));
  assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===A)?.policy.mode,'MONITOR');
  await f.save(SOURCE,2,'revised source');
  s=await f.store.snapshot();
  assert.equal((s.protectionPolicies?.find(x=>x.policy.chatId===B)?.policy.rules[0] as {value?:string}).value,'revised source');
 }finally{await f.close();}});
 test(engine+' network policy preview fails if group or network version changes during confirmation',async()=>{for(const mode of ['network','target','actor'] as const){
  const f=await fixture();try{
   await f.save(SOURCE,1,'first');
   const sources=await f.owner.handle(OWNER,'nw:1:y:'+NET+':0');
   const preview=await f.owner.handle(OWNER,button(sources,SOURCE));
   const yes=button(preview,'تأكيد');
   if(mode==='network')await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   if(mode==='target')await f.save(A,1,'another local policy');
   assert.equal(await f.owner.handle(mode==='actor'?'301':OWNER,yes),null);
   assert.equal((await f.store.snapshot()).networkInheritance?.length??0,0);
  }finally{await f.close();}
 }});
 test(engine+' owner explicitly pauses one network follow with private, one-shot UI confirmation',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1,'baseline');
  const sources=await f.owner.handle(OWNER,'nw:1:y:'+NET+':0');
  const created=await f.owner.handle(OWNER,button(sources,SOURCE));
  assert.ok(await f.owner.handle(OWNER,button(created,'تأكيد')));
  const card=await f.owner.handle(OWNER,'nw:1:d:'+NET);
  const list=await f.owner.handle(OWNER,button(card,'المتابعة'));
  assert.match(list?.text??'',/المتابعة/u);
  const preview=await f.owner.handle(OWNER,button(list,A));
  const confirm=button(preview,'تأكيد');
  assert.equal(await f.owner.handle('301',confirm),null);
  assert.ok(await f.owner.handle(OWNER,confirm));
  assert.equal(await f.owner.handle(OWNER,confirm),null);
  await f.save(SOURCE,2,'new after pause');
  const s=await f.store.snapshot();
  assert.equal(s.networkInheritance?.find(x=>x.targetChatId===A)?.pausedReason,'OWNER_PAUSED');
  assert.equal(s.networkInheritance?.find(x=>x.targetChatId===B)?.status,'ACTIVE');
  assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===A)?.policy.revision,1);
  assert.equal(s.protectionPolicies?.find(x=>x.policy.chatId===B)?.policy.revision,2);
 }finally{await f.close();}});
 test(engine+' stale owner pause refuses modified network revision and leaves link unchanged',async()=>{const f=await fixture();try{
  await f.save(SOURCE,1,'baseline');
  const source=await f.owner.handle(OWNER,'nw:1:y:'+NET+':0');
  const create=await f.owner.handle(OWNER,button(source,SOURCE));
  await f.owner.handle(OWNER,button(create,'تأكيد'));
  const listing=await f.owner.handle(OWNER,'nw:1:f:'+NET+':0');
  const preview=await f.owner.handle(OWNER,button(listing,B));
  const confirm=button(preview,'تأكيد');
  await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
  assert.equal(await f.owner.handle(OWNER,confirm),null);
  assert.equal((await f.store.snapshot()).networkInheritance?.find(x=>x.targetChatId===B)?.status,'ACTIVE');
 }finally{await f.close();}});
 test(engine+' stale and unsupported network routes cannot create links',async()=>{const f=await fixture();try{
  assert.equal(validOwnerNetworkRoute('nw:1:y:BAD:0'),false);
  assert.equal(validOwnerNetworkRoute('nw:1:z:'+NET+':'+SOURCE+':0'),true);
  assert.equal(await f.owner.handle(OWNER,'nw:1:z:'+NET+':'+SOURCE+':0'),null);
  assert.equal((await f.store.snapshot()).networkInheritance?.length??0,0);
 }finally{await f.close();}});
}
