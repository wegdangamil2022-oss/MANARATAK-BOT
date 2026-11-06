import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1700000000000,NET='abcdef123456',SOURCE='-100123',SUBJECT='432156';
const button=(s:OwnerInlineScreen|null,label:string):string=>{
 assert.ok(s);const row=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));
 assert.ok(row,label+' in '+s.text);assert.ok(Buffer.byteLength(row.callback_data,'utf8')<=64);
 return row.callback_data;
};
for(const engine of ['json','sqlite'] as const){
 const fixture=async()=>{
  const dir=await mkdtemp(join(tmpdir(),'network-watch-ui-'));let now=NOW;
  const store=new BotStore(join(dir,'db.'+engine),{engine}),policy=new Policy(store,OWNER,()=>now);
  const owner=new OwnerNetworkEditor(store,policy,()=>now);
  await policy.approveChat(OWNER,SOURCE,['moderation','navigation']);
  await store.transaction(s=>{s.groupNetworks=[{id:NET,name:'شبكة آمنة',revision:1,
   createdBy:OWNER,updatedAt:now,members:s.chats.filter(c=>c.id===SOURCE)
    .map(c=>({chatId:c.id,version:c.version}))}];});
  return {store,policy,owner,advance:(n:number)=>now+=n,close:()=>rm(dir,{recursive:true,force:true})};
 };
 test(engine+' NETWORK-003 owner creates review-only case through private input and independent approval',async()=>{
  const f=await fixture();try{
   const card=await f.owner.handle(OWNER,'nw:1:d:'+NET);
   const watch=await f.owner.handle(OWNER,button(card,'بلاغات الشبكة'));
   const sources=await f.owner.handle(OWNER,button(watch,'تقديم بلاغ'));
   const categories=await f.owner.handle(OWNER,button(sources,SOURCE));
   const input=await f.owner.handle(OWNER,button(categories,'إزعاج'));
   assert.match(input?.text??'',/معرّف/u);
   assert.equal(await f.owner.previewName('200',SUBJECT),null);
   const preview=await f.owner.previewName(OWNER,SUBJECT);
   assert.match(preview?.text??'',/معاينة/u);
   assert.equal((await f.store.snapshot()).networkWatchCases?.length??0,0);
   const confirm=button(preview,'تأكيد');
   assert.equal(await f.owner.handle('200',confirm),null);
   assert.ok(await f.owner.handle(OWNER,confirm));
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   const s=await f.store.snapshot();
   assert.equal(s.networkWatchCases?.length,1);
   assert.equal(s.networkWatchCases?.[0]?.status,'PENDING');
   assert.equal(s.moderationOperations.length,0);
   assert.equal(s.operations.length,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 decisions require separate previews, stale rejection and one-shot receipts',async()=>{
  const f=await fixture();try{
   const sources=await f.owner.handle(OWNER,'nw:1:u:'+NET+':0');
   const cats=await f.owner.handle(OWNER,button(sources,SOURCE));
   await f.owner.handle(OWNER,button(cats,'إزعاج'));
   const preview=await f.owner.previewName(OWNER,SUBJECT);
   await f.owner.handle(OWNER,button(preview,'تأكيد'));
   const list=await f.owner.handle(OWNER,'nw:1:w:'+NET+':0');
   const detail=await f.owner.handle(OWNER,button(list,SUBJECT));
   const review=await f.owner.handle(OWNER,button(detail,'متابعة'));
   assert.match(review?.text??'',/معاينة/u);
   const confirm=button(review,'تأكيد');
   assert.equal(await f.owner.handle('200',confirm),null);
   assert.ok(await f.owner.handle(OWNER,confirm));
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   assert.equal((await f.store.snapshot()).networkWatchCases?.[0]?.status,'WATCHED');
   const detail2=await f.owner.handle(OWNER,button(await f.owner.handle(OWNER,'nw:1:w:'+NET+':0'),SUBJECT));
   const clear=await f.owner.handle(OWNER,button(detail2,'رفع المتابعة'));
   assert.ok(await f.owner.handle(OWNER,button(clear,'تأكيد')));
   const s=await f.store.snapshot();
   assert.equal(s.networkWatchCases?.[0]?.status,'CLEARED');
   assert.equal(s.moderationOperations.length,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 group revision and dashboard revocation invalidate previews',async()=>{
  const f=await fixture();try{
   const sources=await f.owner.handle(OWNER,'nw:1:u:'+NET+':0');
   const cats=await f.owner.handle(OWNER,button(sources,SOURCE));
   await f.owner.handle(OWNER,button(cats,'إزعاج'));
   const preview=await f.owner.previewName(OWNER,SUBJECT),confirm=button(preview,'تأكيد');
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   assert.equal((await f.store.snapshot()).networkWatchCases?.length??0,0);
   const input2=await f.owner.handle(OWNER,'nw:1:v:'+NET+':'+SOURCE+':S');
   assert.ok(input2);
   const preview2=await f.owner.previewName(OWNER,SUBJECT),confirm2=button(preview2,'تأكيد');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f.owner.handle(OWNER,confirm2),null);
   assert.equal((await f.store.snapshot()).networkWatchCases?.length??0,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 invalid input and navigation cancellation do not leak cases',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:w:'+NET+':0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:v:'+NET+':'+SOURCE+':S'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:w:'+NET+':00'),false);
   const start=await f.owner.handle(OWNER,'nw:1:v:'+NET+':'+SOURCE+':S');
   assert.ok(start);
   await assert.rejects(()=>f.owner.previewName(OWNER,'+967777777777'));
   await assert.rejects(()=>f.owner.previewName(OWNER,'0012'));
   assert.equal((await f.store.snapshot()).networkWatchCases?.length??0,0);
   await f.owner.handle(OWNER,'nw:1:d:'+NET);
   assert.equal(await f.owner.previewName(OWNER,SUBJECT),null);
   assert.equal(await f.owner.handle(OWNER,'nw:1:a:BAD'),null);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 switching from network name input to watchlist cancels old draft',async()=>{
  const f=await fixture();try{
   assert.ok(await f.owner.handle(OWNER,'nw:1:n'));
   assert.ok(await f.owner.handle(OWNER,'nw:1:w:'+NET+':0'));
   assert.equal(await f.owner.previewName(OWNER,'شبكة يجب إلغاؤها'),null);
   assert.equal((await f.store.snapshot()).groupNetworks?.length,1);
  }finally{await f.close();}
 });

}
