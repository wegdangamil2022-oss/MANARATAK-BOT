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
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {validOwnerNetworkRoute} from '../src/telegram-inline-networks.js';

const OWNER='100',NOW=1_700_000_000_000,NET='abcdef123456',
 SOURCE='-100123',OTHER='-100124',MEMBER='321654';
const cb=(i:number,data:string,user=100,inGroup=false)=>({
 update_id:i,callback_query:{id:'watch-'+i,from:{id:user,is_bot:false},data,
 message:{message_id:42,from:{id:999,is_bot:true},
 chat:{id:inGroup?-100123:user,type:inGroup?'supergroup':'private'}}}
});
const txt=(i:number,text:string,user=100)=>({update_id:i,
 message:{message_id:i,from:{id:user,is_bot:false},chat:{id:user,type:'private'},
 date:1700000000,text}});
type Handled=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
function button(result:Handled,label:string):string {
 assert.equal(result.status,'APPLIED',result.reason);
 assert.equal(isValidTelegramInlineKeyboard(result.plan?.inlineMarkup),true);
 const chosen=result.plan?.inlineMarkup?.inline_keyboard.flat()
  .find(b=>b.text.includes(label));
 assert.ok(chosen,'missing '+label+' in '+result.plan?.text);
 assert.ok(Buffer.byteLength(chosen.callback_data,'utf8')<=64);
 return chosen.callback_data;
}
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'network-watch-ui-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),
  links:new ResourceLinkService(store,policy),
  botId:'watchlist-no-telegram',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=>{throw Error('WATCHLIST_MUST_NOT_CONTACT_TELEGRAM');}});
 for(const id of [SOURCE,OTHER])await policy.approveChat(OWNER,id,['navigation','moderation']);
 await store.transaction(s=>{
  s.groupNetworks=[{id:NET,name:'شبكة الحماية',revision:1,
   createdBy:OWNER,updatedAt:now,members:s.chats.filter(c=>[SOURCE,OTHER].includes(c.id))
    .map(c=>({chatId:c.id,version:c.version}))}];
 });
 return {store,policy,app,advance:(n:number)=>{now+=n;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('NETWORK-003 callback routes are canonical and under Telegram 64-byte limit',()=>{
 const good=['nw:1:u:'+NET+':0','nw:1:o:'+NET+':0',
  'nw:1:cs:'+NET+':'+SOURCE,'nw:1:ca:'+NET+':'+SOURCE+':S',
  'nw:1:iv:111111111111','nw:1:rv:111111111111:A',
  'nw:1:rv:111111111111:D','nw:1:rv:111111111111:C'];
 for(const route of good){assert.equal(validOwnerNetworkRoute(route),true,route);
  assert.ok(Buffer.byteLength(route)<=64);}
 const invalid=['nw:1:u:'+NET+':00','nw:1:o:'+NET+':1000',
  'nw:1:ca:'+NET+':'+SOURCE+':X','nw:1:iv:ABCDEF123456',
  'nw:1:rv:111111111111:B','nw:1:ca:'+NET+':100123:S'];
 for(const route of invalid)assert.equal(validOwnerNetworkRoute(route),false,route);
});
for(const engine of ['json','sqlite'] as const){
 test('NETWORK-003 owner sees organized screens and submits a reviewed watch case ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const card=await f.app().handle(cb(1,'nw:1:d:'+NET));
   const list=await f.app().handle(cb(2,button(card,'بلاغات')));
   assert.match(list.plan?.text??'',/مراجعة بشرية/);
   const origin=await f.app().handle(cb(3,button(list,'تقديم بلاغ')));
   const kind=await f.app().handle(cb(4,button(origin,SOURCE)));
   const input=await f.app().handle(cb(5,button(kind,'إزعاج')));
   assert.match(input.plan?.text??'',/معرّف/);
   const preview=await f.app().handle(txt(6,MEMBER));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/معاينة بلاغ/);
   assert.equal((await f.store.snapshot()).networkWatchCases?.length??0,0);
   const submit=button(preview,'تأكيد تسجيل');
   assert.equal((await f.app().handle(cb(7,submit,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(8,submit,100,true))).status,'DENIED');
   assert.equal((await f.app().handle(cb(9,submit))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(10,submit))).status,'DENIED');
   let s=await f.store.snapshot();
   assert.equal(s.networkWatchCases?.length,1);
   assert.equal(s.networkWatchCases?.[0]?.status,'PENDING');
   assert.equal(s.moderationOperations.length,0);
   const list2=await f.app().handle(cb(11,'nw:1:u:'+NET+':0'));
   const details=await f.app().handle(cb(12,button(list2,MEMBER)));
   const review=await f.app().handle(cb(13,button(details,'اعتماد للمراقبة')));
   assert.equal((await f.app().handle(cb(14,button(review,'تأكيد الاعتماد')))).status,'APPLIED');
   s=await f.store.snapshot();assert.equal(s.networkWatchCases?.[0]?.status,'WATCHED');
   assert.equal(s.moderationOperations.length,0);
   const details2=await f.app().handle(cb(15,'nw:1:iv:'+s.networkWatchCases![0]!.id));
   const clear=await f.app().handle(cb(16,button(details2,'رفع الاشتباه')));
   assert.equal((await f.app().handle(cb(17,button(clear,'تأكيد رفع')))).status,'APPLIED');
   s=await f.store.snapshot();assert.equal(s.networkWatchCases?.[0]?.status,'CLEARED');
  }finally{await f.close();}
 });
 test('NETWORK-003 stale preview cannot publish a watch case and invalid user input cannot create one ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.app().handle(cb(20,'nw:1:ca:'+NET+':'+SOURCE+':S'));
   assert.equal((await f.app().handle(txt(21,'@not-an-id'))).status,'DENIED');
   const preview=await f.app().handle(txt(22,MEMBER));
   assert.equal(preview.status,'APPLIED');
   const token=button(preview,'تأكيد تسجيل');
   await f.store.transaction(s=>{s.groupNetworks![0]!.revision++;});
   assert.equal((await f.app().handle(cb(23,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).networkWatchCases?.length??0,0);
   assert.equal((await f.app().handle(cb(24,'nw:1:ca:'+NET+':'+SOURCE+':X'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('NETWORK-003 cancel input and owner-only review cannot be replayed ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app().handle(cb(30,'nw:1:u:'+NET+':0',200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(31,'nw:1:ca:'+NET+':'+SOURCE+':S',100,true))).status,'DENIED');
   await f.app().handle(cb(32,'nw:1:ca:'+NET+':'+SOURCE+':S'));
   await f.app().handle(cb(33,'nw:1:d:'+NET));
   const stray=await f.app().handle(txt(34,MEMBER));
   assert.notEqual(stray.reason,'NETWORK_TEXT_PREVIEW');
   assert.equal((await f.store.snapshot()).networkWatchCases?.length??0,0);
  }finally{await f.close();}
 });
 test('NETWORK-003 case review locks on changed group approval and cannot trigger Telegram ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const start=await f.app().handle(cb(40,'nw:1:ca:'+NET+':'+SOURCE+':S'));
   assert.equal(start.status,'APPLIED');
   const preview=await f.app().handle(txt(41,MEMBER));
   assert.equal((await f.app().handle(cb(42,button(preview,'تأكيد تسجيل')))).status,'APPLIED');
   const row=(await f.store.snapshot()).networkWatchCases![0]!;
   const pending=await f.app().handle(cb(43,'nw:1:rv:'+row.id+':A'));
   const confirm=button(pending,'تأكيد الاعتماد');
   await f.policy.approveChat(OWNER,SOURCE,['navigation','moderation']);
   assert.equal((await f.app().handle(cb(44,confirm))).status,'DENIED');
   assert.equal((await f.store.snapshot()).networkWatchCases![0]!.status,'PENDING');
  }finally{await f.close();}
 });
}

for(const engine of ['json','sqlite'] as const){
 test('NETWORK-003 target-scoped transfer review requires its own human decisions ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.app().handle(cb(150,'nw:1:ca:'+NET+':'+SOURCE+':S'));
   const draft=await f.app().handle(txt(151,MEMBER));
   assert.equal((await f.app().handle(cb(152,button(draft,'تأكيد تسجيل')))).status,'APPLIED');
   let watched=(await f.store.snapshot()).networkWatchCases![0]!;
   const review=await f.app().handle(cb(153,'nw:1:rv:'+watched.id+':A'));
   assert.equal((await f.app().handle(cb(154,button(review,'تأكيد الاعتماد')))).status,'APPLIED');
   watched=(await f.store.snapshot()).networkWatchCases![0]!;
   const details=await f.app().handle(cb(155,'nw:1:iv:'+watched.id));
   const targets=await f.app().handle(cb(156,button(details,'مراجعة نقل')));
   assert.match(targets.plan?.text??'',/مجموعة مستهدفة/);
   const choose=await f.app().handle(cb(157,button(targets,OTHER)));
   const preview=await f.app().handle(cb(158,button(choose,'كتم')));
   assert.match(preview.plan?.text??'',/لا ينفذ/);
   const token=button(preview,'تأكيد إنشاء');
   assert.equal((await f.app().handle(cb(159,token,200))).status,'DENIED');
   assert.equal((await f.app().handle(cb(160,token))).status,'APPLIED');
   assert.equal((await f.app().handle(cb(161,token))).status,'DENIED');
   let state=await f.store.snapshot();
   assert.equal(state.networkSanctionReviews?.length,1);
   assert.equal(state.networkSanctionReviews?.[0]?.targetChatId,OTHER);
   assert.equal(state.networkSanctionReviews?.[0]?.status,'PENDING');
   assert.equal(state.moderationOperations.length,0);
   assert.equal(state.operations.length,0);
   const transfer=state.networkSanctionReviews![0]!;
   const transferDetails=await f.app().handle(cb(162,'nw:1:ri:'+transfer.id));
   const decision=await f.app().handle(cb(163,button(transferDetails,'مراجعة يدوية فقط')));
   assert.equal((await f.app().handle(cb(164,button(decision,'تأكيد')))).status,'APPLIED');
   state=await f.store.snapshot();
   assert.equal(state.networkSanctionReviews?.[0]?.status,'REVIEWED_ONLY');
   assert.equal(state.moderationOperations.length,0);
   const closeDetails=await f.app().handle(cb(165,'nw:1:ri:'+transfer.id));
   const close=await f.app().handle(cb(166,button(closeDetails,'إغلاق')));
   assert.equal((await f.app().handle(cb(167,button(close,'تأكيد')))).status,'APPLIED');
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.[0]?.status,'CLOSED');
  }finally{await f.close();}
 });
 test('NETWORK-003 target approval drift and withdrawn source watch invalidate old transfer ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.app().handle(cb(180,'nw:1:ca:'+NET+':'+SOURCE+':S'));
   const draft=await f.app().handle(txt(181,MEMBER));
   await f.app().handle(cb(182,button(draft,'تأكيد تسجيل')));
   const watch=(await f.store.snapshot()).networkWatchCases![0]!;
   const approve=await f.app().handle(cb(183,'nw:1:rv:'+watch.id+':A'));
   await f.app().handle(cb(184,button(approve,'تأكيد الاعتماد')));
   const preview=await f.app().handle(cb(185,'nw:1:ra:'+watch.id+':'+OTHER+':B'));
   const token=button(preview,'تأكيد إنشاء');
   await f.policy.approveChat(OWNER,OTHER,['navigation','moderation']);
   assert.equal((await f.app().handle(cb(186,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).networkSanctionReviews?.length??0,0);
   const watch2=(await f.store.snapshot()).networkWatchCases![0]!;
   const clear=await f.app().handle(cb(187,'nw:1:rv:'+watch2.id+':C'));
   await f.app().handle(cb(188,button(clear,'تأكيد')));
   assert.equal((await f.app().handle(cb(189,'nw:1:rt:'+watch2.id+':0'))).status,'DENIED');
   assert.equal((await f.store.snapshot()).moderationOperations.length,0);
  }finally{await f.close();}
 });
}
