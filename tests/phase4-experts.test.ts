import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4DiscussionService} from '../src/phase4-discussions.js';
import {Phase4ExpertService} from '../src/phase4-experts.js';
import {validExpertState} from '../src/phase4-expert-model.js';
import {expertOwnerScreen} from '../src/phase4-expert-owner.js';
import {expertMemberScreen} from '../src/phase4-expert-member.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',OTHER='-1005678',MEMBER='200',NOW=1_700_000_000_000;
const profile={displayName:'ضيف أكاديمي',specialty:'القبول والمنح الدراسية',
 evidenceUrl:'https://university.example.edu/staff/academic-advisor'};
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-experts-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 let membership:'VERIFIED'|'UNKNOWN'|'NOT_MEMBER'='VERIFIED';
 const discussion=new Phase4DiscussionService(store,policy,()=>now,async()=>membership);
 const experts=new Phase4ExpertService(store,policy,()=>now,async()=>membership);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=>membership,
  ownerMenuMode:'inline',clock:()=>now});
 const message=(update:number,actor:string,chat:string,text:string,forward=false)=>({
  update_id:update,message:{message_id:update,chat:{id:Number(chat),type:chat.startsWith('-')?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text,
   ...(forward?{forward_origin:{type:'user',date:1700000000,sender_user:{id:900,is_bot:false}}}:{})}
 });
 const callback=(update:number,actor:string,data:string)=>({
  update_id:update,callback_query:{id:'cb-'+update,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:10,chat:{id:Number(actor),type:'private'},from:{id:901,is_bot:true}}}
 });
 const seed=async()=>{
  const p=await experts.draftProfile(OWNER,GROUP,profile);
  await experts.reviewProfile(OWNER,p.id,1);
  const q=await discussion.draft(OWNER,GROUP,{title:'أسئلة الضيف الأكاديمي',durationMinutes:60,maxQuestions:20});
  await discussion.open(OWNER,q.id,1);
  return {p,q};
 };
 return {store,policy,experts,discussion,app,message,callback,seed,
  clock:()=>now,advance:(ms:number)=>{now+=ms;},setMembership:(x:typeof membership)=>{membership=x;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('AMA-001 strict state, unknown profiles, cross-references and text safety',()=>{
 assert.equal(validExpertState({profiles:[],sessions:[],decisions:[],summaries:[]}),true);
 for(const bad of [null,{},[],{profiles:[],sessions:[],decisions:[]},
  {profiles:[],sessions:[],decisions:[],summaries:[],unexpected:1},
  {profiles:[{id:'abc'}],sessions:[],decisions:[],summaries:[]}]){
  assert.equal(validExpertState(bad),false);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('AMA-001 '+engine+': owner explicitly reviews source before speaker metadata can be attached to any live session',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.experts.draftProfile(MEMBER,GROUP,profile),/EXPERT_DENIED/);
   await assert.rejects(f.experts.draftProfile(OWNER,GROUP,
    {...profile,evidenceUrl:'http://unsafe.invalid'}),/EXPERT_INVALID/);
   const p=await f.experts.draftProfile(OWNER,GROUP,profile);
   assert.equal(p.status,'DRAFT');
   const q=await f.discussion.draft(OWNER,GROUP,{title:'لقاء مع ضيف أكاديمي',
    durationMinutes:60,maxQuestions:10});
   await f.discussion.open(OWNER,q.id,1);
   await assert.rejects(f.experts.draftSession(OWNER,p.id,q.id),/EXPERT_UNREVIEWED/);
   assert.equal(await f.experts.reviewProfile(MEMBER,p.id,1),false);
   assert.equal(await f.experts.reviewProfile(OWNER,p.id,1),true);
   assert.equal(await f.experts.reviewProfile(OWNER,p.id,1),false);
   const a=await f.experts.draftSession(OWNER,p.id,q.id);
   assert.equal(a.status,'DRAFT');
   assert.equal(await f.experts.openSession(OWNER,a.id,1),true);
   assert.equal(await f.experts.openSession(OWNER,a.id,1),false);
   const info=await f.experts.ownerView(OWNER,a.id);
   assert.equal(info?.profile.displayName,profile.displayName);
   assert.equal(info?.session.status,'OPEN');
   assert.doesNotMatch(JSON.stringify(info),/memberId/);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('AMA-002 '+engine+': same-chat epoch required, no cross-group or revoked expert association',async()=>{
  const f=await fixture(engine);try{
   const p=await f.experts.draftProfile(OWNER,GROUP,profile);
   await f.experts.reviewProfile(OWNER,p.id,1);
   const foreign=await f.discussion.draft(OWNER,OTHER,{title:'أسئلة جهة أخرى',
    durationMinutes:60,maxQuestions:10});
   await f.discussion.open(OWNER,foreign.id,1);
   await assert.rejects(f.experts.draftSession(OWNER,p.id,foreign.id),/EXPERT_SESSION_DENIED/);
   const q=await f.discussion.draft(OWNER,GROUP,{title:'أسئلة المقابلة القادمة',
    durationMinutes:60,maxQuestions:10});
   await f.discussion.open(OWNER,q.id,1);
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   await assert.rejects(f.experts.draftSession(OWNER,p.id,q.id),/EXPERT_SESSION_DENIED/);
  }finally{await f.close();}
 });
 test('AMA-003 '+engine+': pending, approved, deferred and answered counts are private, without student identifiers',async()=>{
  const f=await fixture(engine);try{
   const {p,q}=await f.seed();
   const ama=await f.experts.draftSession(OWNER,p.id,q.id);
   await f.experts.openSession(OWNER,ama.id,1);
   const one=(await f.discussion.ask(MEMBER,q.id,'هل هناك منح ماجستير بدون رسوم؟')).questionId!;
   const two=(await f.discussion.ask('201',q.id,'ما موعد التقديم للطب؟')).questionId!;
   const three=(await f.discussion.ask('202',q.id,'ما المصادر الرسمية للقبول؟')).questionId!;
   assert.equal(await f.discussion.moderate(OWNER,one,'APPROVED',1),true);
   assert.equal(await f.discussion.moderate(OWNER,two,'APPROVED',1),true);
   assert.equal(await f.discussion.moderate(OWNER,three,'APPROVED',1),true);
   assert.equal(await f.experts.deferQuestion(MEMBER,ama.id,two),false);
   assert.equal(await f.experts.deferQuestion(OWNER,ama.id,two),true);
   assert.equal(await f.experts.deferQuestion(OWNER,ama.id,two),false);
   assert.equal(await f.discussion.moderate(OWNER,one,'ANSWERED',2),true);
   const stats=await f.experts.ownerStats(OWNER,ama.id);
   assert.deepEqual(stats,{pending:0,approved:1,deferred:1,answered:1,total:3});
   assert.equal(await f.experts.ownerStats(MEMBER,ama.id),null);
   assert.doesNotMatch(JSON.stringify(stats),/200|201|202|ماجستير/);
  }finally{await f.close();}
 });
 test('AMA-004 '+engine+': owner closure atomically scrubs question text; stale callbacks rejected',async()=>{
  const f=await fixture(engine);try{
   const {p,q}=await f.seed();const ama=await f.experts.draftSession(OWNER,p.id,q.id);
   await f.experts.openSession(OWNER,ama.id,1);
   const secret='بيانات سؤالي العلمي الخاصة';
   const question=await f.discussion.ask(MEMBER,q.id,secret);
   assert.equal(question.status,'RECEIVED');
   assert.equal(await f.experts.closeSession(OWNER,ama.id,1),false);
   assert.equal(await f.experts.closeSession(OWNER,ama.id,2),true);
   assert.equal(await f.experts.closeSession(OWNER,ama.id,2),false);
   const state=await new BotStore(f.store.file,{engine}).snapshot();
   assert.equal(state.phase4Experts?.sessions[0]?.status,'CLOSED');
   assert.equal(state.phase4Discussions?.sessions[0]?.status,'CLOSED');
   assert.equal(state.phase4Discussions?.questions[0]?.text,undefined);
   assert.doesNotMatch(JSON.stringify(state.phase4Discussions),/بيانات سؤالي/);
  }finally{await f.close();}
 });
 test('AMA-005 '+engine+': reviewed summary only; private member lookup fails closed after group revocation',async()=>{
  const f=await fixture(engine);try{
   const {p,q}=await f.seed();const ama=await f.experts.draftSession(OWNER,p.id,q.id);
   await f.experts.openSession(OWNER,ama.id,1);
   assert.equal(await f.experts.closeSession(OWNER,ama.id,2),true);
   assert.equal(await f.experts.memberSummary(MEMBER,ama.id),null);
   const draft=await f.experts.draftSummary(OWNER,ama.id,'مراجعة عامة لشروط الدراسة مع إحالة الطلاب إلى المصادر المنشورة.',
    ['https://university.example.edu/scholarships']);
   assert.equal(draft.status,'DRAFT');
   assert.equal(await f.experts.memberSummary(MEMBER,ama.id),null);
   assert.equal(await f.experts.approveSummary(OWNER,ama.id,1),true);
   assert.equal(await f.experts.approveSummary(OWNER,ama.id,1),false);
   const screen=await expertMemberScreen(f.experts,MEMBER,'/amasummary '+ama.id);
   assert.match(screen?.text??'',/مراجعة عامة/);
   assert.doesNotMatch(screen?.text??'',/ممثل جامعة|موثّق من Telegram/);
   assert.equal((await f.experts.memberSummary('202',ama.id))?.text,draft.text);
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal(await f.experts.memberSummary(MEMBER,ama.id),null);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('AMA-006 '+engine+': Telegram route is strictly owner-private and never auto-publishes questions',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.callback(10,OWNER,'mi:1:i:09:10'));
   assert.equal(home.status,'APPLIED');assert.equal(home.reason,'PHASE4_EXPERT_OWNER');
   const review=await expertOwnerScreen(f.experts,OWNER,
    '/expertnew '+GROUP+' '+profile.evidenceUrl+' | '+profile.displayName+' | '+profile.specialty);
   assert.match(review?.text??'',/مراجعة|المصدر/);
   const saved=(await f.store.snapshot()).phase4Experts?.profiles[0]!;
   const approved=await f.app().handle(f.callback(11,OWNER,'xa:1:r:'+saved.id+':1'));
   assert.equal(approved.status,'APPLIED');
   const wrong=await f.app().handle(f.callback(12,MEMBER,'mi:1:i:09:10'));
   assert.equal(wrong.status,'DENIED');
   const group=await f.app().handle(f.message(13,MEMBER,GROUP,'/amasummary '+saved.id));
   assert.notEqual(group.reason,'PHASE4_EXPERT_MEMBER');
   const forwarded=await f.app().handle(f.message(14,MEMBER,MEMBER,'/amasummary '+saved.id,true));
   assert.equal(forwarded.status,'DENIED');
  }finally{await f.close();}
 });
}
