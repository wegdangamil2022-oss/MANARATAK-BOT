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
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ApprovedAnswerService as FAQ,ResourceLinkService as Links} from '../src/education-interactions.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {parseModerationOwnerReviewRoute} from '../src/moderation-unknown-review.js';

const OWNER='100', GROUP='-100123', MEMBER='300';
const cb=(i:number,actor:number,data:string,group=false)=>({
 update_id:i,callback_query:{id:'review_'+i,from:{id:actor,is_bot:false},data,
 message:{message_id:60,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:999,is_bot:true}}}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.inlineMarkup?.inline_keyboard.flat()??[];
const select=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>,prefix:string)=>
 buttons(r).find(x=>x.callback_data.startsWith(prefix))!.callback_data;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-unknown-review-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 let now=1700000000000;
 const policy=new Policy(store,OWNER,()=>now);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new FAQ(store,policy),links=new Links(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',clock:()=>now});
 await policy.approveChat(OWNER,GROUP,['navigation','moderation']);
 const version=(await store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
 await store.transaction(s=>{
  s.moderationOperations.push({id:'case-01',chatId:GROUP,memberId:MEMBER,actorId:OWNER,
   kind:'BAN',reasonFingerprint:'secret-target-fingerprint',policyVersion:version,
   status:'UNKNOWN_OUTCOME',createdAt:now});
 });
 return {store,policy,app,advance:(ms:number)=>{now+=ms},now:()=>now,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('owner review callbacks are strict bounded read-only selectors',()=>{
 assert.deepEqual(parseModerationOwnerReviewRoute('mr:1:p:2'),{kind:'list',page:2});
 assert.deepEqual(parseModerationOwnerReviewRoute('mr:1:h'),{kind:'list',page:0});
 assert.deepEqual(parseModerationOwnerReviewRoute('mr:1:d:1:2:abcdef012345'),
  {kind:'details',page:1,slot:2,digest:'abcdef012345'});
 assert.deepEqual(parseModerationOwnerReviewRoute('mr:1:v:1:2:abcdef012345:e'),
  {kind:'preview',page:1,slot:2,digest:'abcdef012345',decision:'ESCALATED'});
 for(const bad of ['mr:1:p:00','mr:1:p:1000','mr:2:h','mr:1:p:0\n',
 'mr:1:d:0:0:abcdef012345','mr:1:d:0:9:abcdef012345',
 'mr:1:d:0:1:ABCDEF012345','mr:1:d:0:1:abcdef012345\n',
 'mr:1:v:0:1:abcdef012345:x','mr:1:v:0:1:abcdef012345:e:confirm'])
 assert.equal(parseModerationOwnerReviewRoute(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('owner review flow is two-stage one-shot; UNKNOWN remains permanently blocked ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(cb(1,100,'mi:1:i:02:01'));
   assert.equal(home.status,'APPLIED');
   assert.match(home.plan?.text??'',/مجهولة|مجهول/);
   const details=await f.app().handle(cb(2,100,select(home,'mr:1:d:')));
   assert.equal(details.status,'APPLIED');
   assert.doesNotMatch(details.plan?.text??'',/300|secret-target-fingerprint|case-01/);
   assert.equal(isValidTelegramInlineKeyboard(details.plan?.inlineMarkup),true);
   const preview=await f.app().handle(cb(3,100,select(details,'mr:1:v:').replace(/:a$/u,':e')));
   assert.equal(preview.status,'APPLIED');
   assert.match(preview.plan?.text??'',/تصعيد/);
   assert.equal((await f.store.snapshot()).moderationOperations[0]?.review,undefined);
   const token=select(preview,'c_');
   assert.equal((await f.app().handle(cb(4,300,token))).status,'DENIED');
   assert.equal((await f.app().handle(cb(5,100,token))).status,'APPLIED');
   const state=await f.store.snapshot();
   assert.equal(state.moderationOperations[0]?.status,'UNKNOWN_OUTCOME');
   assert.equal(state.moderationOperations[0]?.review?.decision,'ESCALATED');
   assert.equal(state.moderationOperations[0]?.review?.reviewedBy,OWNER);
   assert.ok(state.audit.some(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ESCALATED'));
   assert.equal(state.callbacks.find(c=>c.ref===token)?.used,true);
   assert.equal((await f.app().handle(cb(6,100,token))).status,'DENIED');
   const gateway=new FakeModerationGateway();
   const moderation=new ModerationService(f.store,f.policy,gateway,()=>f.now());
   assert.equal((await moderation.reconcile(OWNER,GROUP,MEMBER)).status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
   const latest=await f.app().handle(cb(7,100,'mr:1:h'));
   assert.match(latest.plan?.text??'',/تمت مراجعتها|مراجعة/);
  }finally{await f.close();}
 });
 test('acknowledged review is an annotation only; no operation status mutation ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(cb(10,100,'mr:1:h'));
   const detail=await f.app().handle(cb(11,100,select(home,'mr:1:d:')));
   const preview=await f.app().handle(cb(12,100,select(detail,'mr:1:v:').replace(/:e$/u,':a')));
   const token=select(preview,'c_');
   assert.equal((await f.app().handle(cb(13,100,token))).status,'APPLIED');
   const op=(await f.store.snapshot()).moderationOperations[0]!;
   assert.equal(op.review?.decision,'ACKNOWLEDGED_UNRESOLVED');
   assert.equal(op.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.app().handle(cb(14,100,token))).status,'DENIED');
  }finally{await f.close();}
 });
 test('stale operation state, revoked chat, and expired review tokens do not consume or annotate ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(cb(20,100,'mr:1:h'));
   const detailKey=select(home,'mr:1:d:');
   const detail=await f.app().handle(cb(21,100,detailKey));
   const prev=await f.app().handle(cb(22,100,select(detail,'mr:1:v:')));
   const token=select(prev,'c_');
   await f.store.transaction(s=>{s.moderationOperations[0]!.status='CONFIRMED';});
   assert.equal((await f.app().handle(cb(23,100,detailKey))).status,'DENIED');
   assert.equal((await f.app().handle(cb(24,100,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.find(c=>c.ref===token)?.used,false);
   await f.store.transaction(s=>{s.moderationOperations[0]!.status='UNKNOWN_OUTCOME';});
   const again=await f.app().handle(cb(25,100,'mr:1:h'));
   const freshDetail=await f.app().handle(cb(26,100,select(again,'mr:1:d:')));
   const second=await f.app().handle(cb(27,100,select(freshDetail,'mr:1:v:')));
   const token2=select(second,'c_');
   const version=(await f.store.snapshot()).chats[0]!.version;
   await f.policy.revokeChatAtRevision(OWNER,GROUP,version);
   assert.equal((await f.app().handle(cb(28,100,token2))).status,'DENIED');
   assert.equal((await f.store.snapshot()).moderationOperations[0]?.review,undefined);
  }finally{await f.close();}
 });
 test('expired confirmation token remains unused and nonowner cannot view ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app().handle(cb(30,300,'mr:1:h'))).status,'DENIED');
   assert.equal((await f.app().handle(cb(31,100,'mr:1:h',true))).status,'DENIED');
   const home=await f.app().handle(cb(32,100,'mr:1:h'));
   const detail=await f.app().handle(cb(33,100,select(home,'mr:1:d:')));
   const prev=await f.app().handle(cb(34,100,select(detail,'mr:1:v:')));
   const token=select(prev,'c_');
   f.advance(121000);
   assert.equal((await f.app().handle(cb(35,100,token))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.find(c=>c.ref===token)?.used,false);
  }finally{await f.close();}
 });
 test('competing owner review nonces commit only one annotation and no double consumption ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(cb(40,100,'mr:1:h'));
   const details=await f.app().handle(cb(41,100,select(home,'mr:1:d:')));
   const action=select(details,'mr:1:v:');
   const p1=await f.app().handle(cb(42,100,action)),p2=await f.app().handle(cb(43,100,action));
   const t1=select(p1,'c_'),t2=select(p2,'c_');
   const [a,b]=await Promise.all([f.app().handle(cb(44,100,t1)),f.app().handle(cb(45,100,t2))]);
   assert.deepEqual([a.status,b.status].sort(),['APPLIED','DENIED']);
   const s=await f.store.snapshot();
   assert.equal(s.callbacks.filter(c=>[t1,t2].includes(c.ref)&&c.used).length,1);
   assert.equal(s.audit.filter(x=>x.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED').length,1);
  }finally{await f.close();}
 });
 test('owner review paging and old page membership does not leak another case ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    for(let i=2;i<=19;i++)s.moderationOperations.push({
     ...s.moderationOperations[0]!,id:'case-'+String(i),createdAt:1700000000000+i
    });
   });
   const one=await f.app().handle(cb(50,100,'mr:1:p:1'));
   assert.equal(buttons(one).filter(x=>x.callback_data.startsWith('mr:1:d:')).length,8);
   const two=await f.app().handle(cb(51,100,'mr:1:p:2'));
   assert.equal(buttons(two).filter(x=>x.callback_data.startsWith('mr:1:d:')).length,3);
   assert.equal((await f.app().handle(cb(52,100,'mr:1:p:3'))).status,'DENIED');
   const old=buttons(one).find(x=>x.callback_data.startsWith('mr:1:d:'))!.callback_data;
   await f.store.transaction(s=>s.moderationOperations.push({
    ...s.moderationOperations[0]!,id:'pre-first',createdAt:1
   }));
   assert.equal((await f.app().handle(cb(53,100,old))).status,'DENIED');
  }finally{await f.close();}
 });
}
