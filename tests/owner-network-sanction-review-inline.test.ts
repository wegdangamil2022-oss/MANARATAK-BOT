import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {OwnerNetworkEditor,validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';
import type {OwnerInlineScreen} from '../src/telegram-inline-owner.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',
 SOURCE='-100123',TARGET='-100124',OTHER='-100125',CASE='222222222222',SUBJECT='321654';
function button(s:OwnerInlineScreen|null,label:string):string {
 assert.ok(s,'expected screen for '+label);
 const found=s.keyboard.inline_keyboard.flat().find(x=>x.text.includes(label));
 assert.ok(found,label+' in '+s.text);
 assert.ok(Buffer.byteLength(found.callback_data,'utf8')<=64);
 return found.callback_data;
}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'network-sanction-inline-'));
  let now=NOW;
  const store=new BotStore(join(dir,'state.'+engine),{engine});
  const policy=new Policy(store,OWNER,()=>now);
  const owner=new OwnerNetworkEditor(store,policy,()=>now);
  for(const id of [SOURCE,TARGET,OTHER])
   await policy.approveChat(OWNER,id,['moderation','navigation']);
  await store.transaction(s=>{
   s.groupNetworks=[{id:NET,name:'شبكة مراجعات',revision:1,createdBy:OWNER,
    updatedAt:now,members:s.chats.map(c=>({chatId:c.id,version:c.version}))}];
   s.networkWatchCases=[{id:CASE,networkId:NET,networkRevision:1,
    sourceChatId:SOURCE,sourceChatVersion:1,subjectId:SUBJECT,category:'SPAM',
    revision:2,status:'WATCHED',submittedBy:OWNER,submittedAt:now-100,
    reviewedBy:OWNER,reviewedAt:now-50}];
  });
  return {store,policy,owner,
   advance:(n:number)=>{now+=n;},
   close:()=>rm(dir,{recursive:true,force:true})};
 }
 async function propose(f:Awaited<ReturnType<typeof fixture>>,target=TARGET,kind='كتم'){
  const caseScreen=await f.owner.handle(OWNER,'nw:1:a:'+CASE);
  const reviewList=await f.owner.handle(OWNER,button(caseScreen,'اقتراحات العقوبات'));
  const targets=await f.owner.handle(OWNER,button(reviewList,'اقتراح لمجموعة'));
  const choices=await f.owner.handle(OWNER,button(targets,target));
  return f.owner.handle(OWNER,button(choices,kind));
 }
 test(engine+' NETWORK-003 exposes per-target recommendations only after human WATCHED case',async()=>{
  const f=await fixture();try{
   assert.equal(validOwnerNetworkRoute('nw:1:sl:'+CASE+':0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:st:'+CASE+':0'),true);
   assert.equal(validOwnerNetworkRoute('nw:1:sl:'+CASE+':00'),false);
   assert.equal(validOwnerNetworkRoute('nw:1:sd:INVALID'),false);
   const caseScreen=await f.owner.handle(OWNER,'nw:1:a:'+CASE);
   const reviews=await f.owner.handle(OWNER,button(caseScreen,'اقتراحات العقوبات'));
   assert.match(reviews?.text??'',/معلوماتي/u);
   const targets=await f.owner.handle(OWNER,button(reviews,'اقتراح لمجموعة'));
   assert.equal(targets?.keyboard.inline_keyboard.flat().some(x=>x.text.includes(SOURCE)),false);
   assert.ok(button(targets,TARGET));
   assert.ok(button(targets,OTHER));
   assert.equal(await f.owner.handle('200','nw:1:st:'+CASE+':0'),null);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length??0,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 requires owner preview and one-shot confirmation; no moderation side effects',async()=>{
  const f=await fixture();try{
   const preview=await propose(f);
   assert.match(preview?.text??'',/معاينة/u);
   assert.match(preview?.text??'',/لا.*عقوبة/u);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length??0,0);
   const confirm=button(preview,'تأكيد');
   assert.equal(await f.owner.handle('200',confirm),null);
   const success=await f.owner.handle(OWNER,confirm);
   assert.match(success?.text??'',/حُفظ|تم/u);
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   const s=await f.store.snapshot();
   assert.equal(s.networkSanctionReviews?.length,1);
   assert.equal(s.networkSanctionReviews?.[0]?.status,'PENDING');
   assert.equal(s.networkSanctionReviews?.[0]?.targetChatId,TARGET);
   assert.equal(s.networkSanctionReviews?.[0]?.kind,'MUTE');
   assert.equal(s.moderationOperations.length,0);
   assert.equal(s.operations.length,0);
   assert.equal(s.telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 independently reviews and closes a single target then displays local-only check',async()=>{
  const f=await fixture();try{
   const preview=await propose(f);
   const created=await f.owner.handle(OWNER,button(preview,'تأكيد'));
   const card=await f.owner.handle(OWNER,button(created,'التفاصيل'));
   const decision=await f.owner.handle(OWNER,button(card,'تثبيت المراجعة'));
   assert.match(decision?.text??'',/معاينة/u);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.[0]?.status,'PENDING');
   const approved=await f.owner.handle(OWNER,button(decision,'تأكيد'));
   assert.match(approved?.text??'',/معلوماتية/u);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.[0]?.status,'REVIEWED_ONLY');
   const inspected=await f.owner.handle(OWNER,button(
    await f.owner.handle(OWNER,button(approved,'التفاصيل')),'فحص الجاهزية'));
   assert.match(inspected?.text??'',/الجاهزية المحلية/u);
   assert.match(inspected?.text??'',/لا.*Telegram/u);
   const close=await f.owner.handle(OWNER,button(
    await f.owner.handle(OWNER,'nw:1:sd:'+
     (await f.store.snapshot()).networkSanctionReviews![0]!.id),'إغلاق المراجعة'));
   assert.ok(await f.owner.handle(OWNER,button(close,'تأكيد')));
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.[0]?.status,'CLOSED');
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 rejection allows new independent review; parallel targets remain isolated',async()=>{
  const f=await fixture();try{
   const first=await propose(f);
   const created=await f.owner.handle(OWNER,button(first,'تأكيد'));
   const detail=await f.owner.handle(OWNER,button(created,'التفاصيل'));
   const reject=await f.owner.handle(OWNER,button(detail,'رفض المراجعة'));
   assert.ok(await f.owner.handle(OWNER,button(reject,'تأكيد')));
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.[0]?.status,'REJECTED');
   assert.ok(await f.owner.handle(OWNER,button(await propose(f,TARGET,'حظر'),'تأكيد')));
   assert.ok(await f.owner.handle(OWNER,button(await propose(f,OTHER,'كتم'),'تأكيد')));
   const s=await f.store.snapshot();
   assert.equal(s.networkSanctionReviews?.length,3);
   assert.equal(s.networkSanctionReviews?.filter(x=>x.status==='PENDING').length,2);
   assert.equal(s.networkSanctionReviews?.find(x=>x.targetChatId===OTHER)?.kind,'MUTE');
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 existing unresolved target is not overwritten by a second proposal',async()=>{
  const f=await fixture();try{
   assert.ok(await f.owner.handle(OWNER,button(await propose(f),'تأكيد')));
   const duplicate=await propose(f);
   assert.equal(duplicate,null);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length,1);
  }finally{await f.close();}
 });
 test(engine+' NETWORK-003 stale group versions, withdrawn evidence and revoked dashboard reject receipts',async()=>{
  const f=await fixture();try{
   const preview=await propose(f);
   const confirm=button(preview,'تأكيد');
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision+=1;});
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length??0,0);
  }finally{await f.close();}
  const f2=await fixture();try{
   const preview=await propose(f2);
   const confirm=button(preview,'تأكيد');
   await f2.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal(await f2.owner.handle(OWNER,confirm),null);
   assert.equal((await f2.store.snapshot()).networkSanctionReviews?.length??0,0);
  }finally{await f2.close();}
  const f3=await fixture();try{
   const preview=await propose(f3);
   const confirm=button(preview,'تأكيد');
   await f3.store.transaction(s=>{
    const c=s.networkWatchCases![0]!;
    c.status='CLEARED';c.revision=3;c.clearedAt=NOW;c.clearedBy=OWNER;
   });
   assert.equal(await f3.owner.handle(OWNER,confirm),null);
   assert.equal((await f3.store.snapshot()).networkSanctionReviews?.length??0,0);
  }finally{await f3.close();}
 });
 test(engine+' NETWORK-003 expired confirmation never records a proposal',async()=>{
  const f=await fixture();try{
   const preview=await propose(f);
   const confirm=button(preview,'تأكيد');
   f.advance(121_000);
   assert.equal(await f.owner.handle(OWNER,confirm),null);
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length??0,0);
  }finally{await f.close();}
 });
}
