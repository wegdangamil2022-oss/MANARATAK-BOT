import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4EventService} from '../src/phase4-events.js';
import {validEventState} from '../src/phase4-event-model.js';
import {eventMemberScreen,parseEventMemberCommand} from '../src/phase4-event-member.js';
import {eventOwnerScreen} from '../src/phase4-event-owner.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',OTHER='-1005678',USER='200',START=1_700_000_000_000;
const draft=(at:number)=>({title:'جلسة التعريف بالمنح الدراسية',
 startsAt:at+3_600_000,durationMinutes:60,capacity:2,
 link:'https://university.example.edu/event-info'});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-events-'));let now=START;
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const svc=new Phase4EventService(store,policy,()=>now,async()=>membership);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,botId:'bot-main',botUsername:'ManaratakBot',
  clock:()=>now,ownerMenuMode:'inline',membership:async()=>membership});
 const message=(updateId:number,actor:string,chat:string,text:string,forward=false)=>({
  update_id:updateId,message:{message_id:updateId,
   chat:{id:Number(chat),type:chat.startsWith('-')?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text,
   ...(forward?{forward_origin:{type:'user',date:1700000000,sender_user:{id:700,is_bot:false}}}:{})}
 });
 const callback=(id:number,actor:string,data:string)=>({
  update_id:id,callback_query:{id:'E'+id,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:10,chat:{id:Number(actor),type:'private'},from:{id:900,is_bot:true}}}
 });
 return {store,policy,svc,app,message,callback,
  setMember:(v:typeof membership)=>{membership=v;},clock:()=>now,advance:(ms:number)=>{now+=ms;},
  close:()=>rm(dir,{force:true,recursive:true})};
}
test('EVENT-001 strict state and exact private member commands',()=>{
 assert.equal(validEventState({events:[],registrations:[],summaries:[]}),true);
 for(const bad of [null,{},[],{events:[],registrations:[]},
  {events:[],registrations:[],summaries:[],evil:'1'},
  {events:[{id:'fake'}],registrations:[],summaries:[]}])
  assert.equal(validEventState(bad),false);
 const id='0123456789abcdef01234567';
 assert.deepEqual(parseEventMemberCommand('/eventjoin '+id+' yes'),
  {kind:'JOIN',eventId:id,remind:true});
 assert.deepEqual(parseEventMemberCommand('/eventjoin '+id+' no'),
  {kind:'JOIN',eventId:id,remind:false});
 assert.deepEqual(parseEventMemberCommand('/eventleave '+id),
  {kind:'LEAVE',eventId:id});
 assert.deepEqual(parseEventMemberCommand('/eventsummary '+id),
  {kind:'SUMMARY',eventId:id});
 assert.equal(parseEventMemberCommand('/eventjoin '+id+' yes\n/ban 1'),null);
});
for(const engine of ['json','sqlite'] as const){
 test('EVENT-001 '+engine+': owner previews draft then approves locally; no announcement is sent',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.svc.draft(USER,GROUP,draft(f.clock())),/EVENT_DENIED/);
   await assert.rejects(f.svc.draft(OWNER,GROUP,{...draft(f.clock()),link:'http://unsafe.invalid'}),/EVENT_INVALID/);
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));
   assert.equal(e.status,'DRAFT');
   assert.equal((await f.svc.register(USER,e.id,true)).status,'CLOSED');
   assert.equal(await f.svc.open(OWNER,e.id,1),true);
   assert.equal(await f.svc.open(OWNER,e.id,1),false);
   assert.equal(((await f.store.snapshot()).telegramReplyJobs?.some(x=>x.plan?.chatId===GROUP)??false),false);
  }finally{await f.close();}
 });
 test('EVENT-002 '+engine+': optional consent and atomic capacity; repeated registration is idempotent',async()=>{
  const f=await fixture(engine);try{
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));await f.svc.open(OWNER,e.id,1);
   const result=await Promise.all(Array.from({length:30},(_,i)=>
    f.svc.register(String(200+i),e.id,i%2===0)));
   assert.equal(result.filter(x=>x.status==='REGISTERED').length,2);
   assert.equal(result.filter(x=>x.status==='FULL').length,28);
   const st=await new BotStore(f.store.file,{engine}).snapshot();
   const accepted=st.phase4Events?.registrations??[];
   assert.equal((await f.svc.register(accepted[0]!.memberId,e.id,true)).status,'ALREADY_REGISTERED');
   assert.equal(st.phase4Events?.registrations.length,2);
   const expectedReminders=accepted.filter(x=>x.reminderConsent).length;
   assert.equal(await f.svc.reminderCount(OWNER,e.id),expectedReminders);
   assert.equal(await f.svc.reminderCount(USER,e.id),null);
  }finally{await f.close();}
 });
 test('EVENT-002 '+engine+': withdrawn participant releases seat and cannot silently re-register',async()=>{
  const f=await fixture(engine);try{
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));await f.svc.open(OWNER,e.id,1);
   assert.equal((await f.svc.register(USER,e.id,true)).status,'REGISTERED');
   f.setMember('UNKNOWN');
   assert.equal(await f.svc.withdraw(USER,e.id),true);
   assert.equal(await f.svc.withdraw(USER,e.id),false);
   assert.equal((await f.svc.myRegistration(USER,e.id))?.status,'CANCELLED');
   f.setMember('VERIFIED');
   assert.equal((await f.svc.register(USER,e.id,false)).status,'ALREADY_REGISTERED');
   assert.equal((await f.svc.register('201',e.id,false)).status,'REGISTERED');
   const prior=(await f.store.snapshot()).phase4Events?.registrations.find(x=>x.memberId===USER);
   assert.equal(prior?.reminderConsent,false);
  }finally{await f.close();}
 });
 test('EVENT-002 '+engine+': user can turn reminder preference off at any time without Telegram',async()=>{
  const f=await fixture(engine);try{
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));await f.svc.open(OWNER,e.id,1);
   await f.svc.register(USER,e.id,true);
   assert.equal(await f.svc.reminderConsent(USER,e.id,false),true);
   assert.equal(await f.svc.reminderCount(OWNER,e.id),0);
   assert.equal(await f.svc.reminderConsent(USER,e.id,false),false);
   assert.equal(await f.svc.reminderConsent('202',e.id,true),false);
   assert.equal(await f.svc.reminderConsent(USER,e.id,true),true);
   assert.equal(await f.svc.reminderCount(OWNER,e.id),1);
  }finally{await f.close();}
 });
 test('EVENT-003 '+engine+': membership failure and policy reapproval must deny admissions',async()=>{
  const f=await fixture(engine);try{
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));await f.svc.open(OWNER,e.id,1);
   f.setMember('UNKNOWN');
   assert.equal((await f.svc.register(USER,e.id,true)).status,'VERIFICATION_REQUIRED');
   f.setMember('VERIFIED');
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.svc.register(USER,e.id,true)).status,'STALE');
   assert.equal((await f.store.snapshot()).phase4Events?.registrations.length,0);
  }finally{await f.close();}
 });
 test('EVENT-004 '+engine+': cancellation removes private registrations and restores after restart',async()=>{
  const f=await fixture(engine);try{
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));await f.svc.open(OWNER,e.id,1);
   await f.svc.register(USER,e.id,true);
   assert.equal(await f.svc.cancel(OWNER,e.id,2),true);
   assert.equal(await f.svc.cancel(OWNER,e.id,2),false);
   assert.equal((await f.svc.register('201',e.id,false)).status,'CLOSED');
   const st=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Events!;
   assert.equal(st.events[0]?.status,'CANCELLED');
   assert.deepEqual(st.registrations,[]);
  }finally{await f.close();}
 });
 test('EVENT-005 '+engine+': completed event requires reviewed resources before students can read summary',async()=>{
  const f=await fixture(engine);try{
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));await f.svc.open(OWNER,e.id,1);
   assert.equal(await f.svc.summary(USER,e.id),null);
   f.advance(7_200_001);
   assert.equal(await f.svc.expire(),1);
   const overview=await f.svc.view(OWNER,e.id);assert.equal(overview?.status,'FINISHED');
   const summary=await f.svc.draftSummary(OWNER,e.id,
    'هذه خلاصة المحاضرة التعليمية والروابط الرسمية المشار إليها.',
    ['https://university.example.edu/resources']);
   assert.equal(summary.status,'DRAFT');
   assert.equal(await f.svc.summary(USER,e.id),null);
   assert.equal(await f.svc.approveSummary(OWNER,e.id,1),true);
   assert.equal(await f.svc.approveSummary(OWNER,e.id,1),false);
   const published=await f.svc.summary(USER,e.id);
   assert.equal(published?.text,summary.text);
   assert.deepEqual(published?.urls,summary.urls);
   assert.equal(JSON.stringify(published).includes(USER),false);
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal(await f.svc.summary(USER,e.id),null);
  }finally{await f.close();}
 });
 test('EVENT-006 '+engine+': retention purges attendee IDs after 24 hours and event metadata after 30 days',async()=>{
  const f=await fixture(engine);try{
   const e=await f.svc.draft(OWNER,GROUP,draft(f.clock()));await f.svc.open(OWNER,e.id,1);
   await f.svc.register(USER,e.id,true);
   f.advance(7_200_001);await f.svc.expire();
   f.advance(86_400_001);await f.svc.expire();
   const partial=(await f.store.snapshot()).phase4Events!;
   assert.equal(partial.events[0]?.status,'FINISHED');
   assert.deepEqual(partial.registrations,[]);
   f.advance(30*86_400_000+1);await f.svc.expire();
   assert.deepEqual((await f.store.snapshot()).phase4Events,
    {events:[],registrations:[],summaries:[]});
  }finally{await f.close();}
 });
 test('EVENT-007 '+engine+': owner and member Telegram messages route to 09:09 privately',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.callback(1,OWNER,'mi:1:i:09:09'));
   assert.equal(home.status,'APPLIED');
   assert.equal(home.reason,'PHASE4_EVENT_OWNER');
   const preview=await eventOwnerScreen(f.svc,OWNER,
    '/eventnew '+GROUP+' '+new Date(f.clock()+3_600_000).toISOString()+
    ' 60 2 https://university.example.edu/event-info جلسة التعريف بالمنح الدراسية');
   assert.match(preview?.text??'',/مسودة|فتح/);
   const e=(await f.store.snapshot()).phase4Events?.events[0]!;
   const open=await f.app().handle(f.callback(2,OWNER,'ev:1:o:'+e.id+':1'));
   assert.equal(open.status,'APPLIED');
   const receipt=await f.app().handle(f.message(3,USER,USER,'/eventjoin '+e.id+' yes'));
   assert.equal(receipt.status,'APPLIED');
   assert.equal(receipt.reason,'PHASE4_EVENT_MEMBER');
   assert.doesNotMatch(receipt.plan?.text??'',/https:\/\/university/);
   const wrongContext=await f.app().handle(f.message(4,USER,GROUP,'/eventjoin '+e.id+' yes'));
   assert.notEqual(wrongContext.reason,'PHASE4_EVENT_MEMBER');
   const forwarded=await f.app().handle(f.message(5,USER,USER,'/eventleave '+e.id,true));
   assert.equal(forwarded.status,'DENIED');
   assert.equal((await f.store.snapshot()).phase4Events?.registrations.length,1);
  }finally{await f.close();}
 });
}
