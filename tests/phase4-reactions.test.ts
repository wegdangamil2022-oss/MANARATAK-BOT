import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4ReactionsService} from '../src/phase4-reactions.js';
import {validReactionState} from '../src/phase4-reaction-model.js';
import {reactionOwnerScreen} from '../src/phase4-reaction-owner.js';
import {reactionMemberScreen,parseReactionMemberCommand} from '../src/phase4-reaction-member.js';
import {startPhase4ReactionMaintenance} from '../src/phase4-reaction-maintenance.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',OTHER='-1005678',STUDENT='200',NOW=1_700_000_000_000;
const post={kind:'BOT_POST' as const,messageId:42,description:'إعلان مصادر القبول الجامعي',durationMinutes:60};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-reactions-'));let now=NOW;
 let proof:'VERIFIED'|'UNKNOWN'|'NOT_MEMBER'='VERIFIED';
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const service=new Phase4ReactionsService(store,policy,()=>now,async()=>proof);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
  ownerMenuMode:'inline',membership:async()=>proof});
 const message=(n:number,actor:string,chat:string,text:string,forward=false)=>({
  update_id:n,message:{message_id:n,chat:{id:Number(chat),
   type:chat.startsWith('-')?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text,
   ...(forward?{forward_origin:{type:'user',date:1700000000,sender_user:{id:901,is_bot:false}}}:{})}
 });
 const cb=(n:number,actor:string,data:string)=>({
  update_id:n,callback_query:{id:'re'+n,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:20,chat:{id:Number(actor),type:'private'},from:{id:901,is_bot:true}}}
 });
 return {store,policy,service,app,message,cb,clock:()=>now,
  setProof:(v:typeof proof)=>{proof=v;},
  advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
test('REACT-001 strict state and command parsing',()=>{
 assert.equal(validReactionState({targets:[],reactions:[]}),true);
 for(const v of [null,{},[],{targets:[]},{targets:[],reactions:[],unknown:1},
  {targets:[{id:'abc'}],reactions:[]},{targets:[],reactions:[{id:'abc'}]}])
  assert.equal(validReactionState(v),false);
 const id='a'.repeat(24);
 assert.deepEqual(parseReactionMemberCommand('/reactlike '+id),{kind:'LIKE',targetId:id});
 assert.deepEqual(parseReactionMemberCommand('/reactunlike '+id),{kind:'UNLIKE',targetId:id});
 assert.deepEqual(parseReactionMemberCommand('/reactstatus '+id),{kind:'STATUS',targetId:id});
 assert.equal(parseReactionMemberCommand('/reactlike '+id+'\n/ban'),null);
});
for(const engine of ['json','sqlite'] as const){
 test('REACT-001 '+engine+': only owner can review target and open reactions, no Telegram bot authorship inference',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service.draft(STUDENT,GROUP,post),/REACTION_DENIED/);
   await assert.rejects(f.service.draft(OWNER,GROUP,{...post,messageId:0}),/REACTION_INVALID/);
   await assert.rejects(f.service.draft(OWNER,GROUP,{...post,description:'@privatepersonal'}),/REACTION_INVALID/);
   const p=await f.service.draft(OWNER,GROUP,post);
   assert.equal(p.status,'DRAFT');assert.equal(p.sourceVerified,false);
   assert.equal((await f.service.like(STUDENT,p.id)).status,'CLOSED');
   assert.equal(await f.service.open(OWNER,p.id,1),true);
   assert.equal(await f.service.open(OWNER,p.id,1),false);
   const screen=await reactionOwnerScreen(f.service,OWNER,'rc:1:v:'+p.id);
   assert.match(screen?.text??'',/غير مثبت|غير موثق|لم يتم التحقق/);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('REACT-002 '+engine+': 80 concurrent hearts from 20 students count once, owner cannot like',async()=>{
  const f=await fixture(engine);try{
   const p=await f.service.draft(OWNER,GROUP,post);await f.service.open(OWNER,p.id,1);
   const result=await Promise.all(Array.from({length:80},(_,i)=>
    f.service.like(String(300+i%20),p.id)));
   assert.equal(result.filter(x=>x.status==='LIKED').length,20);
   assert.equal(result.filter(x=>x.status==='ALREADY_REACTED').length,60);
   assert.equal((await f.service.like(OWNER,p.id)).status,'INVALID');
   assert.equal(await f.service.ownerCount(OWNER,p.id),20);
   const st=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Reactions!;
   assert.equal(st.reactions.length,20);
   assert.equal(st.reactions.filter(x=>x.status==='ACTIVE').length,20);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('REACT-003 '+engine+': withdrawal always allowed without membership, retains anti-spam tombstone',async()=>{
  const f=await fixture(engine);try{
   const p=await f.service.draft(OWNER,GROUP,post);await f.service.open(OWNER,p.id,1);
   assert.equal((await f.service.like(STUDENT,p.id)).status,'LIKED');
   f.setProof('UNKNOWN');
   assert.equal(await f.service.unlike(STUDENT,p.id),true);
   assert.equal(await f.service.unlike(STUDENT,p.id),false);
   f.setProof('VERIFIED');
   assert.equal((await f.service.like(STUDENT,p.id)).status,'ALREADY_REACTED');
   assert.deepEqual(await f.service.myReaction(STUDENT,p.id),{status:'WITHDRAWN'});
   assert.equal(await f.service.ownerCount(OWNER,p.id),0);
  }finally{await f.close();}
 });
 test('REACT-004 '+engine+': closed aggregated count is privacy-suppressed below five, excludes contests',async()=>{
  const f=await fixture(engine);try{
   const p=await f.service.draft(OWNER,GROUP,{...post,kind:'COMMUNITY_QUESTION'});
   await f.service.open(OWNER,p.id,1);
   for(let i=0;i<4;i++)assert.equal((await f.service.like(String(400+i),p.id)).status,'LIKED');
   assert.equal(await f.service.close(OWNER,p.id,2),true);
   assert.equal(await f.service.results(OWNER,p.id),null);
   const next=await f.service.draft(OWNER,GROUP,{...post,kind:'STUDY_EXPERIENCE',messageId:43});
   await f.service.open(OWNER,next.id,1);
   for(let i=0;i<5;i++)await f.service.like(String(500+i),next.id);
   await f.service.close(OWNER,next.id,2);
   assert.deepEqual(await f.service.results(OWNER,next.id),{likes:5});
   assert.equal(await f.service.results(STUDENT,next.id),null);
   assert.doesNotMatch(JSON.stringify(await f.service.results(OWNER,next.id)),/memberId/);
   await assert.rejects(f.service.draft(OWNER,GROUP,{...post,kind:'COMPETITION' as never}),/REACTION_INVALID/);
  }finally{await f.close();}
 });
 test('REACT-005 '+engine+': owner cannot revoke a different group epoch, private client is fail closed',async()=>{
  const f=await fixture(engine);try{
   const target=await f.service.draft(OWNER,GROUP,post);await f.service.open(OWNER,target.id,1);
   await f.service.like(STUDENT,target.id);
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal(await f.service.close(OWNER,target.id,2),false);
   assert.equal((await f.service.like('201',target.id)).status,'STALE');
   assert.equal(await f.service.results(OWNER,target.id),null);
   assert.equal(await f.service.memberInfo(STUDENT,target.id),null);
  }finally{await f.close();}
 });
 test('REACT-006 '+engine+': owner UI and private student commands, never group interaction dispatch',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.cb(1,OWNER,'mi:1:i:09:13'));
   assert.equal(home.reason,'PHASE4_REACTION_OWNER');assert.equal(home.status,'APPLIED');
   const created=await reactionOwnerScreen(f.service,OWNER,
    '/reactnew '+GROUP+' 42 60 BOT_POST | إعلان مصادر القبول الجامعي');
   assert.match(created?.text??'',/القبول/);
   const target=(await f.store.snapshot()).phase4Reactions?.targets[0]!;
   assert.equal((await f.app().handle(f.cb(2,OWNER,'rc:1:o:'+target.id+':1'))).status,'APPLIED');
   assert.equal((await f.app().handle(f.message(3,STUDENT,STUDENT,
    '/reactlike '+target.id))).reason,'PHASE4_REACTION_MEMBER');
   assert.match((await reactionMemberScreen(f.service,STUDENT,'/reactstatus '+target.id))?.text??'',/تفاعلك|إعجابك/);
   const group=await f.app().handle(f.message(4,STUDENT,GROUP,'/reactlike '+target.id));
   assert.notEqual(group.reason,'PHASE4_REACTION_MEMBER');
   const forwarded=await f.app().handle(f.message(5,STUDENT,STUDENT,'/reactunlike '+target.id,true));
   assert.equal(forwarded.status,'DENIED');
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.some(x=>x.plan?.chatId===GROUP)??false,false);
  }finally{await f.close();}
 });
 test('REACT-007 '+engine+': closing and 24-hour retention remove identity-linked reactions',async()=>{
  const f=await fixture(engine);try{
   const target=await f.service.draft(OWNER,GROUP,post);await f.service.open(OWNER,target.id,1);
   await f.service.like(STUDENT,target.id);
   assert.equal(await f.service.close(OWNER,target.id,2),true);
   f.advance(86_400_001);
   const cleanup=startPhase4ReactionMaintenance(f.service,()=>()=>{});
   await cleanup.stop();
   const d=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Reactions!;
   assert.deepEqual(d.reactions,[]);
   assert.equal(JSON.stringify(d).includes('"200"'),false);
   assert.equal(d.targets[0]?.status,'CLOSED');
  }finally{await f.close();}
 });
}
