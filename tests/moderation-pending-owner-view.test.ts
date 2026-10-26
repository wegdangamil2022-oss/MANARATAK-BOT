import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {parseModerationPendingOwnerRoute} from '../src/moderation-pending-owner-view.js';

const OWNER='100',CHAT='-100123',OTHER='-100456',MEMBER='300',NOW=1_700_000_000_000;
const cb=(n:number,actor:number,data:string,group=false)=>({
 update_id:n,callback_query:{id:'pending_'+n,from:{id:actor,is_bot:false},data,
 message:{message_id:60,chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}}
});
const buttons=(res:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 res.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const pick=(res:Awaited<ReturnType<TelegramUpdateApplication['handle']>>,prefix:string)=>
 buttons(res).find(x=>x.callback_data.startsWith(prefix))?.callback_data;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-pending-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 let now=NOW;
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy),
 admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>now});
 await policy.approveChat(OWNER,CHAT,['navigation','moderation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const version=(await store.snapshot()).chats.find(c=>c.id===CHAT)!.version;
 await store.transaction(s=>{
  s.moderationOperations.push({id:'private-intent',chatId:CHAT,memberId:MEMBER,
   actorId:OWNER,kind:'BAN',reasonFingerprint:'SECRET_CANARY_EVIDENCE',
   policyVersion:version,status:'INTENT',createdAt:now-950000});
  s.moderationOperations.push({id:'private-started',chatId:CHAT,memberId:'301',
   actorId:OWNER,kind:'MUTE',reasonFingerprint:'SECRET_CANARY_EVIDENCE_2',
   policyVersion:version,status:'STARTED',createdAt:now-5000});
  s.moderationOperations.push({id:'private-unknown',chatId:CHAT,memberId:'302',
   actorId:OWNER,kind:'BAN',reasonFingerprint:'SECRET_CANARY_EVIDENCE_3',
   policyVersion:version,status:'UNKNOWN_OUTCOME',createdAt:now-5000});
  s.moderationOperations.push({id:'private-other',chatId:OTHER,memberId:'303',
   actorId:OWNER,kind:'BAN',reasonFingerprint:'SECRET_CANARY_EVIDENCE_4',
   policyVersion:1,status:'STARTED',createdAt:now-950000});
 });
 return {store,policy,app,now:()=>now,advance:(ms:number)=>{now+=ms},
  close:()=>rm(dir,{force:true,recursive:true})};
}
test('strict read-only owner pending route parser rejects malformed or unbounded callback payloads',()=>{
 assert.deepEqual(parseModerationPendingOwnerRoute('mp:1:h'),{kind:'list',page:0});
 assert.deepEqual(parseModerationPendingOwnerRoute('mp:1:p:2'),{kind:'list',page:2});
 assert.deepEqual(parseModerationPendingOwnerRoute('mp:1:d:2:8:abcdef123456'),
  {kind:'details',page:2,slot:8,digest:'abcdef123456'});
 for(const bad of ['mp:2:h','mp:1:p:00','mp:1:p:1000','mp:1:d:0:0:abcdef123456',
  'mp:1:d:0:9:abcdef123456','mp:1:d:0:1:ABCDEF123456',
  'mp:1:d:0:1:abcdef123456\n','mp:1:retry','mp:1:send',
  'mp:1:d:0:1:abcdef123456:'+'x'.repeat(75)])
  assert.equal(parseModerationPendingOwnerRoute(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test(engine+' owner sees pending INTENT/STARTED via unknown-review entry and no private IDs',async()=>{
  const f=await fixture(engine);try{
   const unknown=await f.app().handle(cb(1,100,'mi:1:i:02:01'));
   assert.equal(unknown.status,'APPLIED');
   const link=pick(unknown,'mp:1:');
   assert.equal(link,'mp:1:h');
   const list=await f.app().handle(cb(2,100,link!));
   assert.equal(list.status,'APPLIED');
   assert.match(list.plan?.text??'',/معلقة|معلق|انتظار/);
   assert.equal(buttons(list).filter(x=>x.callback_data.startsWith('mp:1:d:')).length,2);
   const view=await f.app().handle(cb(3,100,pick(list,'mp:1:d:')!));
   assert.equal(view.status,'APPLIED');
   assert.match(view.plan?.text??'',/INTENT|STARTED/);
   for(const secret of [MEMBER,'301','302','303','private-intent','private-started',
    'SECRET_CANARY_EVIDENCE','SECRET_CANARY_EVIDENCE_2']){
    assert.equal((list.plan?.text??'').includes(secret),false);
    assert.equal((view.plan?.text??'').includes(secret),false);
    assert.equal(JSON.stringify(buttons(list)).includes(secret),false);
   }
   assert.equal(buttons(view).some(x=>/حظر|كتم|إرسال|محاولة|تأكيد/.test(x.text)),false);
  }finally{await f.close();}
 });
 test(engine+' pending inspection is owner-private and unavailable inside a group',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app().handle(cb(10,300,'mp:1:h'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(11,100,'mp:1:h',true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(12,100,'mp:1:h'))).status,'APPLIED');
  }finally{await f.close();}
 });
 test(engine+' pending details are stale-safe after status or identity changes',async()=>{
  const f=await fixture(engine);try{
   const list=await f.app().handle(cb(20,100,'mp:1:h'));
   const key=pick(list,'mp:1:d:')!;
   await f.store.transaction(s=>{s.moderationOperations[0]!.status='UNKNOWN_OUTCOME';});
   assert.equal((await f.app().handle(cb(21,100,key))).status,'DENIED');
   const newList=await f.app().handle(cb(22,100,'mp:1:h'));
   const fresh=pick(newList,'mp:1:d:')!;
   await f.store.transaction(s=>{s.moderationOperations[1]!.memberId='389';});
   assert.equal((await f.app().handle(cb(23,100,fresh))).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' pending status screen never edits operations, callbacks, audits or local reasons',async()=>{
  const f=await fixture(engine);try{
   const before=await f.store.snapshot();
   const list=await f.app().handle(cb(30,100,'mp:1:h'));
   const item=await f.app().handle(cb(31,100,pick(list,'mp:1:d:')!));
   assert.equal(item.status,'APPLIED');
   assert.deepEqual((await f.store.snapshot()).moderationOperations,before.moderationOperations);
   assert.deepEqual((await f.store.snapshot()).callbacks,before.callbacks);
   const after=await f.store.snapshot();
   // Transport writes its ordinary RESPONSE_PLANNED_ONLY audit for each
   // incoming callback. Read-only moderation navigation itself must not
   // create any moderation decision, owner review, or mutation audit.
   assert.deepEqual(after.audit.filter(a=>a.reason!=='RESPONSE_PLANNED_ONLY'),
    before.audit.filter(a=>a.reason!=='RESPONSE_PLANNED_ONLY'));
   assert.equal(after.audit.filter(a=>a.reason==='RESPONSE_PLANNED_ONLY').length,
    before.audit.filter(a=>a.reason==='RESPONSE_PLANNED_ONLY').length+2);
   assert.deepEqual((await f.store.snapshot()).moderationReasons,before.moderationReasons);
  }finally{await f.close();}
 });
 test(engine+' approved group revoked during navigation removes pending cases and blocks stale links',async()=>{
  const f=await fixture(engine);try{
   const list=await f.app().handle(cb(40,100,'mp:1:h'));
   const key=pick(list,'mp:1:d:')!;
   await f.policy.revokeChat(OWNER,CHAT);
   assert.equal((await f.app().handle(cb(41,100,key))).status,'DENIED');
   const clear=await f.app().handle(cb(42,100,'mp:1:h'));
   assert.equal(clear.status,'APPLIED');
   assert.equal(buttons(clear).filter(x=>x.callback_data.startsWith('mp:1:d:')).length,0);
  }finally{await f.close();}
 });
 test(engine+' pending paging invalidates old item selection when ordering changes',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    for(let n=0;n<16;n++)s.moderationOperations.push({
     ...s.moderationOperations[1]!,id:'fresh-'+n,
     memberId:String(500+n),createdAt:NOW+n
    });
   });
   const p1=await f.app().handle(cb(50,100,'mp:1:p:1'));
   assert.equal(p1.status,'APPLIED');
   assert.equal(buttons(p1).filter(x=>x.callback_data.startsWith('mp:1:d:')).length,8);
   const p2=await f.app().handle(cb(51,100,'mp:1:p:2'));
   assert.equal(buttons(p2).filter(x=>x.callback_data.startsWith('mp:1:d:')).length,2);
   assert.equal((await f.app().handle(cb(52,100,'mp:1:p:3'))).status,'DENIED');
   const old=pick(p1,'mp:1:d:')!;
   await f.store.transaction(s=>s.moderationOperations.push({
    ...s.moderationOperations[1]!,id:'earliest',memberId:'900',createdAt:1
   }));
   assert.equal((await f.app().handle(cb(53,100,old))).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' old pending cases remain pending after time advances, no conversion or auto-retry',async()=>{
  const f=await fixture(engine);try{
   f.advance(30*24*3600_000);
   const a=await f.app().handle(cb(60,100,'mp:1:h'));
   assert.equal(a.status,'APPLIED');
   assert.match(a.plan?.text??'',/قديمة|عمر|مدة/);
   const s=await f.store.snapshot();
   assert.deepEqual(s.moderationOperations.filter(o=>o.chatId===CHAT&&
    ['INTENT','STARTED'].includes(o.status)).map(o=>o.status),['INTENT','STARTED']);
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test(engine+' pending owner view quarantines duplicate identifiers without modifying ledger',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push({
    ...s.moderationOperations[0]!,memberId:'399',kind:'MUTE'
   }));
   const before=await f.store.snapshot();
   const list=await f.app().handle(cb(200,100,'mp:1:h'));
   assert.equal(list.status,'APPLIED');
   assert.equal(buttons(list).filter(x=>x.callback_data.startsWith('mp:1:d:')).length,1);
   assert.match(list.plan?.text??'',/تعارض|ملتبسة|مكررة/);
   const detail=await f.app().handle(cb(201,100,pick(list,'mp:1:d:')!));
   assert.equal(detail.status,'APPLIED');
   assert.deepEqual((await f.store.snapshot()).moderationOperations,before.moderationOperations);
   assert.deepEqual((await f.store.snapshot()).moderationReasons,before.moderationReasons);
  }finally{await f.close();}
 });
 test(engine+' pending selector expires if a duplicate ID appears in a different group',async()=>{
  const f=await fixture(engine);try{
   const list=await f.app().handle(cb(210,100,'mp:1:h'));
   const key=pick(list,'mp:1:d:')!;
   await f.store.transaction(s=>s.moderationOperations.push({
    ...s.moderationOperations[0]!,chatId:OTHER,memberId:'799'
   }));
   assert.equal((await f.app().handle(cb(211,100,key))).status,'DENIED');
   const refresh=await f.app().handle(cb(212,100,'mp:1:h'));
   assert.equal(buttons(refresh).filter(x=>x.callback_data.startsWith('mp:1:d:')).length,1);
   assert.match(refresh.plan?.text??'',/تعارض|ملتبسة|مكررة/);
  }finally{await f.close();}
 });
 test(engine+' duplicate pending ID colliding with CONFIRMED or UNKNOWN is not reviewable',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>s.moderationOperations.push({
    ...s.moderationOperations[0]!,id:'private-started',status:'CONFIRMED',
    memberId:'887'
   }));
   const list=await f.app().handle(cb(220,100,'mp:1:h'));
   assert.equal(list.status,'APPLIED');
   assert.equal(buttons(list).filter(x=>x.callback_data.startsWith('mp:1:d:')).length,1);
   assert.match(list.plan?.text??'',/تعارض|ملتبسة|مكررة/);
  }finally{await f.close();}
 });
}
