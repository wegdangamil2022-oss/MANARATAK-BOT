import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationPurgeService,FakePurgeGateway,purgeReviewDigest} from '../src/moderation-purge.js';
import {TelegramPurgeEditor} from '../src/telegram-purge-editor.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
const CHAT='-100123',NOW=1700000000000;
function find(view:OwnerInlineScreen|null,label:string):string{assert.ok(view);assert.ok(isValidTelegramInlineKeyboard(view.keyboard));const b=view.keyboard.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(b,'missing '+label);return b.callback_data;}
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'purge-editor-'));let now=NOW;
  const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now),gateway=new FakePurgeGateway(),purge=new ModerationPurgeService(store,policy,gateway,()=>now);
  await policy.approveChat('100',CHAT,['moderation']);
  const ui=()=>new TelegramPurgeEditor(store,policy,purge,()=>now);
  const observe=(id:number,extra:Partial<Parameters<typeof purge.observe>[0]>={})=>purge.observe({chatId:CHAT,messageId:id,senderKind:'USER',senderId:'300',sentAt:now-1000,observedAt:now,contentType:'TEXT',hasLinks:false,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false,...extra});
  const edit=async()=>ui().handle('100',find(await ui().handle('100','pc:1:h'),CHAT));
  const preview=async()=>ui().handle('100',find(await edit(),'معاينة العدد'));
  return {store,policy,purge,gateway,ui,observe,edit,preview,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' filtered purge previews, confirms and dispatches one reviewed ID per press across restart',async()=>{
  const f=await fixture();try{
   await f.observe(1);await f.observe(2);await f.observe(3,{pinned:true});await f.observe(4,{linkedChannel:true});
   const preview=await f.preview();assert.ok(preview);assert.match(preview.text,/المحددة: 2/u);assert.match(preview.text,/المحمية المستبعدة: 2/u);assert.equal(f.gateway.calls.length,0);
   const confirm=find(preview,'اعتماد الخطة');assert.equal(await f.ui().handle('200',confirm),null);
   const approved=await f.ui().handle('100',confirm);assert.ok(approved);assert.equal(f.gateway.calls.length,0);assert.equal(await f.ui().handle('100',confirm),null);
   const next=find(approved,'تنفيذ الرسالة التالية'),first=await f.ui().handle('100',next);assert.ok(first);assert.equal(f.gateway.calls.length,1);assert.equal(f.gateway.calls[0]!.messageId,2);
   assert.equal(await f.ui().handle('100',next),null);await f.ui().cancel('100');
   const job=(await f.store.snapshot()).purgeJobs[0]!;
   const reopened=await f.ui().handle('100','pc:1:j:'+job.id+':'+purgeReviewDigest(job));assert.ok(reopened);
   const last=await f.ui().handle('100',find(reopened,'تنفيذ الرسالة التالية'));assert.ok(last);assert.match(last.text,/طلبات مقبولة: 2/u);assert.equal(f.gateway.calls.length,2);
   assert.equal(last.keyboard.inline_keyboard.flat().some(b=>b.text.includes('تنفيذ الرسالة التالية')),false);
  }finally{await f.close();}
 });
 test(engine+' sender, content, age and count filters compose without storing message bodies',async()=>{
  const f=await fixture();try{
   await f.observe(1,{contentType:'MEDIA',hasLinks:true});await f.observe(2,{contentType:'MEDIA',senderId:'301'});await f.observe(3,{contentType:'MEDIA',sentAt:NOW-7200000});await f.observe(4);
   let view=await f.edit();view=await f.ui().handle('100',find(view,'وسائط'));view=await f.ui().handle('100',find(view,'ساعة واحدة'));view=await f.ui().handle('100',find(view,'حد 1 '));
   view=await f.ui().handle('100',find(view,'اختيار مرسل'));view=await f.ui().handle('100',find(view,'300'));view=await f.ui().handle('100',find(view,'معاينة العدد'));assert.ok(view);
   const job=(await f.store.snapshot()).purgeJobs[0]!;assert.deepEqual(job.items.map(i=>i.messageId),[1]);assert.equal(job.filter.senderId,'300');assert.equal(job.filter.mediaOnly,true);assert.equal(job.filter.limit,1);assert.equal(job.filter.sentAfter,NOW-3600000);assert.equal(job.filter.sentBefore,NOW+1);
   assert.equal(f.gateway.calls.length,0);view=await f.ui().handle('100',find(view,'إلغاء الخطة'));assert.ok(view);assert.equal((await f.store.snapshot()).purgeJobs[0]!.status,'CANCELLED');
  }finally{await f.close();}
 });
 test(engine+' navigation, expiry, closed dashboard and changed chat epochs invalidate controls',async()=>{
  const f=await fixture();try{
   await f.observe(1);let view=await f.preview(),confirm=find(view,'اعتماد الخطة');await f.ui().cancel('100');assert.equal(await f.ui().handle('100',confirm),null);
   view=await f.preview();confirm=find(view,'اعتماد الخطة');f.time(NOW+120001);assert.equal(await f.ui().handle('100',confirm),null);f.time(NOW);
   view=await f.preview();confirm=find(view,'اعتماد الخطة');await f.policy.revokeChat('100',CHAT);await f.policy.approveChat('100',CHAT,['moderation']);assert.equal(await f.ui().handle('100',confirm),null);
   view=await f.preview();confirm=find(view,'اعتماد الخطة');await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});assert.equal(await f.ui().handle('100',confirm),null);assert.equal(await f.ui().handle('100','pc:1:h'),null);assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' returning during a delayed approval prevents it from authorizing the plan',async()=>{
  const f=await fixture();try{
   await f.observe(1);const confirm=find(await f.preview(),'اعتماد الخطة');
   const original=f.purge.confirm.bind(f.purge);f.purge.confirm=async(...args)=>{await f.ui().cancel('100');return original(...args);};
   assert.equal(await f.ui().handle('100',confirm),null);assert.equal((await f.store.snapshot()).purgeJobs[0]!.status,'PREVIEW');assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' unknown outcomes and altered plans cannot be replayed',async()=>{
  const f=await fixture();try{
   await f.observe(1);let view=await f.ui().handle('100',find(await f.preview(),'اعتماد الخطة'));const send=find(view,'تنفيذ الرسالة التالية');f.gateway.outcome='UNKNOWN_OUTCOME';view=await f.ui().handle('100',send);assert.ok(view);assert.equal(view.status,'UNKNOWN');assert.equal(view.reason,'PURGE_UNKNOWN_OUTCOME');assert.match(view.text,/غير مؤكدة/u);assert.equal(f.gateway.calls.length,1);assert.equal(view.keyboard.inline_keyboard.flat().some(b=>b.text.includes('تنفيذ الرسالة التالية')),false);assert.equal(await f.ui().handle('100',send),null);
   await f.observe(2);view=await f.preview();const confirm=find(view,'اعتماد الخطة');await f.store.transaction(s=>{s.purgeJobs.at(-1)!.filter.limit=1;});assert.equal(await f.ui().handle('100',confirm),null);assert.equal(f.gateway.calls.length,1);
  }finally{await f.close();}
 });
 test(engine+' navigation during awaited rights checks blocks the outbound request',async()=>{
  const f=await fixture();try{
   await f.observe(1);const view=await f.ui().handle('100',find(await f.preview(),'اعتماد الخطة'));
   f.gateway.canDelete=async()=>{await f.ui().cancel('100');return true;};
   assert.equal(await f.ui().handle('100',find(view,'تنفيذ الرسالة التالية')),null);assert.equal(f.gateway.calls.length,0);assert.equal((await f.store.snapshot()).purgeJobs[0]!.status,'PAUSED');
  }finally{await f.close();}
 });
 for(const [label,type] of [['روابط','TEXT'],['أوامر','COMMAND']] as const)test(engine+' '+label+' filter and empty selection return to working controls',async()=>{
  const f=await fixture();try{
   await f.observe(1,{contentType:type,hasLinks:label==='روابط'});await f.observe(2);
   let view=await f.ui().handle('100',find(await f.edit(),label));view=await f.ui().handle('100',find(view,'معاينة العدد'));assert.ok(view);assert.deepEqual((await f.store.snapshot()).purgeJobs[0]!.items.map(i=>i.messageId),[1]);
   await f.ui().handle('100',find(view,'إلغاء الخطة'));await f.store.transaction(s=>{s.rollingMessageMeta=[];});view=await f.preview();assert.ok(view);assert.match(view.text,/لا توجد رسائل/u);assert.ok(find(view,'معاينة العدد'));assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' selector pagination and unavailable configuration remain safe',async()=>{
  const f=await fixture();try{
   for(let i=0;i<9;i++){await f.policy.approveChat('100','-200'+i,['moderation']);await f.observe(i+1,{senderId:String(300+i)});}
   const groups=await f.ui().handle('100','pc:1:h');assert.ok(await f.ui().handle('100',find(groups,'التالي')));
   let view=await f.edit();view=await f.ui().handle('100',find(view,'اختيار مرسل'));assert.ok(await f.ui().handle('100',find(view,'التالي')));
   assert.equal(await f.ui().handle('100','pc:1:bad'),null);assert.equal(await f.ui().handle('100','pc:1:h\n'),null);
   const absent=await new TelegramPurgeEditor(f.store,f.policy,undefined,()=>NOW).handle('100','pc:1:h');assert.ok(absent);assert.match(absent.text,/غير مهيأ/u);assert.equal(absent.keyboard.inline_keyboard.flat().some(b=>b.text.includes(CHAT)),false);
  }finally{await f.close();}
 });
 test(engine+' malformed saved filters cannot render HTML or authorize a restored plan',async()=>{
  const f=await fixture();try{
   await f.observe(1);await f.preview();await f.store.transaction(s=>{s.purgeJobs[0]!.filter.senderId='<b>UNTRUSTED</b>';});
   const job=(await f.store.snapshot()).purgeJobs[0]!;assert.equal(await f.ui().handle('100','pc:1:j:'+job.id+':'+purgeReviewDigest(job)),null);await assert.rejects(f.purge.confirm('100',job.id),/PREVIEW_STALE/);assert.equal(f.gateway.calls.length,0);
  }finally{await f.close();}
 });
}
