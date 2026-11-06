import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4StudyPeersService} from '../src/phase4-study-peers.js';
import {validStudyPeerState} from '../src/phase4-study-peer-model.js';
import {studyPeerOwnerScreen} from '../src/phase4-study-peer-owner.js';
import {studyPeerMemberScreen} from '../src/phase4-study-peer-member.js';
import {startPhase4StudyPeerMaintenance} from '../src/phase4-study-peer-maintenance.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',OTHER='-1005678',STUDENT='200',NOW=1_700_000_000_000;
const draft=(now:number)=>({topic:'رياضيات القبول الجامعي',level:'BEGINNER' as const,
 startsAt:now+3_600_000,durationMinutes:60,capacity:5});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-peers-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const peers=new Phase4StudyPeersService(store,policy,()=>now,async()=>membership);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
  ownerMenuMode:'inline',membership:async()=>membership});
 const message=(n:number,actor:string,chat:string,text:string,forward=false)=>({
  update_id:n,message:{message_id:n,chat:{id:Number(chat),
   type:chat.startsWith('-')?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text,
   ...(forward?{forward_origin:{type:'user',date:1700000000,sender_user:{id:901,is_bot:false}}}:{})}
 });
 const cb=(n:number,actor:string,data:string)=>({
  update_id:n,callback_query:{id:'s'+n,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:20,chat:{id:Number(actor),type:'private'},from:{id:901,is_bot:true}}}
 });
 return {store,policy,peers,app,message,cb,
  advance:(delta:number)=>{now+=delta;},clock:()=>now,
  setMembership:(x:typeof membership)=>{membership=x;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('PEER-001 strict restored state refuses unknown keys and forged member relations',()=>{
 assert.equal(validStudyPeerState({circles:[],members:[],reports:[]}),true);
 for(const invalid of [null,[],{}, {circles:[],members:[]},
  {circles:[],members:[],reports:[],extra:1},
  {circles:[{id:'abc'}],members:[],reports:[]},
  {circles:[],members:[{id:'abc'}],reports:[]}])
  assert.equal(validStudyPeerState(invalid),false);
});
for(const engine of ['json','sqlite'] as const){
 test('PEER-001 '+engine+': owner-only draft preview and explicit open; excludes contact details and stranger matching',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.peers.draft(STUDENT,GROUP,draft(f.clock())),/PEER_DENIED/);
   await assert.rejects(f.peers.draft(OWNER,GROUP,{...draft(f.clock()),
    topic:'https://private.example.edu/contact'}),/PEER_INVALID/);
   await assert.rejects(f.peers.draft(OWNER,GROUP,{...draft(f.clock()),
    topic:'اتصل على 771234567'}),/PEER_INVALID/);
   const circle=await f.peers.draft(OWNER,GROUP,draft(f.clock()));
   assert.equal(circle.status,'DRAFT');assert.equal(circle.revision,1);
   assert.equal((await f.peers.join(STUDENT,circle.id)).status,'CLOSED');
   const preview=await studyPeerOwnerScreen(f.peers,OWNER,'sp:1:v:'+circle.id);
   assert.match(preview?.text??'',/رياضيات/);
   assert.equal(await f.peers.open(OWNER,circle.id,1),true);
   assert.equal(await f.peers.open(OWNER,circle.id,1),false);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('PEER-002 '+engine+': member opt-in capacity enforced atomically and no member list is disclosed',async()=>{
  const f=await fixture(engine);try{
   const circle=await f.peers.draft(OWNER,GROUP,{...draft(f.clock()),capacity:4});
   await f.peers.open(OWNER,circle.id,1);
   const attempts=await Promise.all(Array.from({length:70},(_,i)=>
    f.peers.join(String(200+i%25),circle.id)));
   assert.equal(attempts.filter(x=>x.status==='JOINED').length,4);
   assert.equal((await f.store.snapshot()).phase4StudyPeers?.members.length,4);
   const first=(await f.store.snapshot()).phase4StudyPeers?.members[0]!.memberId!;
   assert.equal((await f.peers.join(first,circle.id)).status,'ALREADY_JOINED');
   const info=await f.peers.memberInfo('300',circle.id);
   assert.equal(info?.joined,4);
   assert.equal(info?.topic,circle.topic);
   assert.equal(Object.hasOwn(info!,'memberId'),false);
   assert.equal(Object.hasOwn(info!,'members'),false);
   assert.equal(Object.hasOwn(info!,'usernames'),false);
   assert.equal(Object.hasOwn(info!,'contacts'),false);
   assert.equal(await f.peers.ownerCounts(OWNER,circle.id),4);
   assert.equal(await f.peers.ownerCounts('300',circle.id),null);
  }finally{await f.close();}
 });
 test('PEER-003 '+engine+': consent withdrawal releases seat even without membership and blocks rejoining',async()=>{
  const f=await fixture(engine);try{
   const c=await f.peers.draft(OWNER,GROUP,draft(f.clock()));await f.peers.open(OWNER,c.id,1);
   assert.equal((await f.peers.join(STUDENT,c.id)).status,'JOINED');
   f.setMembership('UNKNOWN');
   assert.equal(await f.peers.leave(STUDENT,c.id),true);
   assert.equal(await f.peers.leave(STUDENT,c.id),false);
   f.setMembership('VERIFIED');
   assert.equal((await f.peers.join(STUDENT,c.id)).status,'ALREADY_JOINED');
   assert.equal((await f.peers.join('201',c.id)).status,'JOINED');
   const first=(await f.store.snapshot()).phase4StudyPeers?.members.find(x=>x.memberId===STUDENT);
   assert.equal(first?.status,'LEFT');
   assert.equal((await f.peers.memberStatus(STUDENT,c.id))?.status,'LEFT');
  }finally{await f.close();}
 });
 test('PEER-004 '+engine+': private reason-only report and owner count never reveal complainant to other members',async()=>{
  const f=await fixture(engine);try{
   const c=await f.peers.draft(OWNER,GROUP,draft(f.clock()));await f.peers.open(OWNER,c.id,1);
   await f.peers.join(STUDENT,c.id);
   assert.equal((await f.peers.report(STUDENT,c.id,'UNSAFE_MATCH')).status,'REPORTED');
   assert.equal((await f.peers.report(STUDENT,c.id,'CONTACT_REQUEST')).status,'ALREADY_REPORTED');
   assert.equal((await f.peers.report('201',c.id,'OTHER')).status,'INVALID');
   assert.deepEqual(await f.peers.ownerReports(OWNER,c.id),
    {UNSAFE_MATCH:1,CONTACT_REQUEST:0,HARASSMENT:0});
   assert.equal(await f.peers.ownerReports(STUDENT,c.id),null);
   assert.doesNotMatch(JSON.stringify(await f.peers.ownerReports(OWNER,c.id)),/memberId|200/);
  }finally{await f.close();}
 });
 test('PEER-005 '+engine+': changing subscription policy or group approval during verification blocks joining',async()=>{
  const f=await fixture(engine);try{
   const c=await f.peers.draft(OWNER,GROUP,draft(f.clock()));await f.peers.open(OWNER,c.id,1);
   f.setMembership('UNKNOWN');
   assert.equal((await f.peers.join(STUDENT,c.id)).status,'VERIFICATION_REQUIRED');
   f.setMembership('VERIFIED');
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.peers.join(STUDENT,c.id)).status,'STALE');
  }finally{await f.close();}
 });
 test('PEER-006 '+engine+': cancellation scrubs active participants, expiry removes identities after 24h',async()=>{
  const f=await fixture(engine);try{
   const c=await f.peers.draft(OWNER,GROUP,draft(f.clock()));await f.peers.open(OWNER,c.id,1);
   await f.peers.join(STUDENT,c.id);
   assert.equal(await f.peers.cancel(OWNER,c.id,2),true);
   assert.equal(await f.peers.cancel(OWNER,c.id,2),false);
   assert.deepEqual((await f.store.snapshot()).phase4StudyPeers?.members,[]);
   const next=await f.peers.draft(OWNER,GROUP,{...draft(f.clock()),
    topic:'التحضير لاختبار اللغة'});await f.peers.open(OWNER,next.id,1);
   await f.peers.join(STUDENT,next.id);
   f.advance(7_200_001);
   const worker=startPhase4StudyPeerMaintenance(f.peers,()=>()=>{});
   await worker.stop();
   assert.equal((await f.store.snapshot()).phase4StudyPeers?.circles.find(x=>x.id===next.id)?.status,'CLOSED');
   f.advance(86_400_001);await f.peers.expire();
   assert.equal((await f.store.snapshot()).phase4StudyPeers?.members.length,0);
  }finally{await f.close();}
 });
 test('PEER-007 '+engine+': owner and member commands route only in private, no individual pairing',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.cb(1,OWNER,'mi:1:i:09:11'));
   assert.equal(home.status,'APPLIED');assert.equal(home.reason,'PHASE4_STUDY_OWNER');
   const created=await studyPeerOwnerScreen(f.peers,OWNER,
    '/studynew '+GROUP+' '+new Date(f.clock()+3_600_000).toISOString()+
    ' 60 5 BEGINNER | رياضيات القبول الجامعي');
   assert.match(created?.text??'',/رياضيات/);
   const c=(await f.store.snapshot()).phase4StudyPeers?.circles[0]!;
   const open=await f.app().handle(f.cb(2,OWNER,'sp:1:o:'+c.id+':1'));
   assert.equal(open.status,'APPLIED');
   const joined=await f.app().handle(f.message(3,STUDENT,STUDENT,'/studyjoin '+c.id));
   assert.equal(joined.reason,'PHASE4_STUDY_MEMBER');
   const group=await f.app().handle(f.message(4,STUDENT,GROUP,'/studyjoin '+c.id));
   assert.notEqual(group.reason,'PHASE4_STUDY_MEMBER');
   const forwarded=await f.app().handle(f.message(5,STUDENT,STUDENT,'/studyleave '+c.id,true));
   assert.equal(forwarded.status,'DENIED');
   const view=await studyPeerMemberScreen(f.peers,'201','/studyinfo '+c.id);
   assert.doesNotMatch(view?.text??'',/200|@|phone|771234/);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.some(x=>x.plan?.chatId===GROUP)??false,false);
  }finally{await f.close();}
 });
}
