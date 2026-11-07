import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4EngagementReportsService,REPORT_WINDOWS} from '../src/phase4-engagement-reports.js';
import {engagementOwnerScreen,parseEngagementOwnerCommand,validEngagementOwnerRoute} from '../src/phase4-engagement-owner.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4ReactionsService} from '../src/phase4-reactions.js';
import {Phase4LectureService} from '../src/phase4-lectures.js';
import {Phase4PollService} from '../src/phase4-polls.js';
import {Phase4StudyPeersService} from '../src/phase4-study-peers.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',MEMBER='200',OTHER='201',GROUP='-1001234',GROUP_B='-1005678';
const NOW=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-engagement-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,GROUP_B,['navigation']);
 const reports=new Phase4EngagementReportsService(store,policy,()=>now);
 const community=new Phase4CommunityService(store,policy,()=>now);
 const reactions=new Phase4ReactionsService(store,policy,()=>now,async()=> 'VERIFIED');
 const lecture=new Phase4LectureService(store,policy,()=>now);
 const poll=new Phase4PollService(store,policy,()=>now,async()=> 'VERIFIED');
 const study=new Phase4StudyPeersService(store,policy,()=>now,async()=> 'VERIFIED');
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>now,
  membership:async()=> 'VERIFIED',ownerMenuMode:'inline',community});
 const cb=(n:number,actor:string,data:string)=>({
  update_id:n,callback_query:{id:'eng'+n,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:20,chat:{id:Number(actor),type:'private'},from:{id:900,is_bot:true}}}
 });
 const msg=(n:number,actor:string,chat:string,text:string,forward=false)=>({
  update_id:n,message:{message_id:n,chat:{id:Number(chat),
   type:chat.startsWith('-')?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'طالب'},text,
   ...(forward?{forward_origin:{type:'user',date:1700000000,sender_user:{id:901,is_bot:false}}}:{})}
 });
 return {dir,store,policy,reports,community,reactions,lecture,poll,study,
  cb,msg,app,advance:(v:number)=>{now+=v;},now:()=>now,
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('REPORT-001: strict period and owner-menu parser, no untrusted callback payloads',()=>{
 assert.deepEqual(REPORT_WINDOWS,{DAY:86_400_000,WEEK:604_800_000,MONTH:2_592_000_000});
 assert.deepEqual(parseEngagementOwnerCommand('/engagement'),{kind:'HOME'});
 assert.deepEqual(parseEngagementOwnerCommand('/engagement '+GROUP+' WEEK'),
  {kind:'VIEW',chatId:GROUP,period:'WEEK'});
 assert.equal(parseEngagementOwnerCommand('/engagement '+GROUP+' ALL'),null);
 assert.equal(validEngagementOwnerRoute('er:1:g:'+GROUP+':DAY'),true);
 for(const bad of ['er:1:g:1:DAY','er:1:g:'+GROUP+':ALL',
  'er:1:g:'+GROUP+':DAY\n','er:1:p:-1','er:1:v:invalid'])
  assert.equal(validEngagementOwnerRoute(bad),false,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('REPORT-001 '+engine+': private scoped owner view returns local zero evidence without inventing deliveries or views',async()=>{
  const f=await fixture(engine);try{
   const original=JSON.stringify(await f.store.snapshot());
   const report=await f.reports.report(OWNER,GROUP,'WEEK');
   assert.ok(report);
   assert.equal(report.chatId,GROUP);
   assert.equal(report.window,'WEEK');
   assert.equal(report.to,NOW);
   assert.equal(report.from,NOW-7*86_400_000);
   assert.ok(report.metrics.length>=12);
   assert.equal(report.metrics.every(x=>x.count===0),true);
   assert.ok(report.notes.some(x=>/Telegram|التسليم|المشاهدة/.test(x)));
   assert.equal(JSON.stringify(await f.store.snapshot()),original);
   assert.equal(await f.reports.report(MEMBER,GROUP,'WEEK'),null);
   assert.equal(await f.reports.report(OWNER,'-1009999','WEEK'),null);
   assert.equal(await f.reports.report(OWNER,GROUP,'ALL' as never),null);
   assert.deepEqual((await f.reports.groups(OWNER)).map(x=>x.chatId),[GROUP,GROUP_B]);
   await assert.rejects(f.reports.groups(MEMBER),/REPORT_DENIED/);
  }finally{await f.close();}
 });
 test('REPORT-002 '+engine+': group-scoped metrics count only real stored records, no member list or Telegram delivery claim',async()=>{
  const f=await fixture(engine);try{
   await f.community.approve(OWNER,
    (await f.community.pending(OWNER,{kind:'REPLIES_ON'},GROUP)).id);
   await f.community.approve(OWNER,
    (await f.community.pending(OWNER,{kind:'REPLY_ADD',match:'WORD',trigger:'مصادر',text:'الروابط الرسمية'},GROUP)).id);
   const proposed=await f.community.propose({kind:'TEXT',chatId:GROUP,actorId:MEMBER,
    memberName:'طالب',groupName:'منارتك',messageText:'مصادر'},
    'b3-webhook:bot-main:900');
   assert.ok(proposed);
   const target=await f.reactions.draft(OWNER,GROUP,{
    kind:'STUDY_EXPERIENCE',messageId:45,
    description:'تجربة المذاكرة قبل القبول الجامعي',durationMinutes:60});
   assert.equal(await f.reactions.open(OWNER,target.id,1),true);
   assert.equal((await f.reactions.like(MEMBER,target.id)).status,'LIKED');
   const other=await f.reactions.draft(OWNER,GROUP_B,{
    kind:'COMMUNITY_QUESTION',messageId:45,
    description:'سؤال في المجموعة الثانية مختلف',durationMinutes:60});
   await f.reactions.open(OWNER,other.id,1);
   await f.reactions.like(MEMBER,other.id);
   const lecture=await f.lecture.draft(OWNER,GROUP,30);
   await f.lecture.start(OWNER,lecture.id,1);
   const result=await f.reports.report(OWNER,GROUP,'DAY');
   assert.ok(result);
   const get=(key:string)=>result.metrics.find(x=>x.key===key)?.count;
   assert.equal(get('automaticReplyReservations'),1);
   assert.equal(get('postLikesActive'),1);
   assert.equal(get('lectureStarts'),1);
   assert.equal(get('pollBallotsActive'),0);
   assert.equal(get('postViews'),undefined);
   assert.equal(JSON.stringify(result).includes(MEMBER),false);
   assert.equal(JSON.stringify(result).includes('memberId'),false);
   assert.equal(JSON.stringify(result).includes('messageText'),false);
   assert.equal((await f.reports.report(OWNER,GROUP_B,'DAY'))?.metrics.find(x=>x.key==='postLikesActive')?.count,1);
   const restored=new BotStore(f.store.file,{engine});
   assert.deepEqual(await new Phase4EngagementReportsService(restored,f.policy,()=>f.now()).report(OWNER,GROUP,'DAY'),result);
  }finally{await f.close();}
 });
 test('REPORT-003 '+engine+': no report outside current approval epoch and no cross-group metric leakage',async()=>{
  const f=await fixture(engine);try{
   const target=await f.reactions.draft(OWNER,GROUP,{
    kind:'BOT_POST',messageId:49,description:'الروابط التعليمية للمرحلة الجديدة',
    durationMinutes:60});
   await f.reactions.open(OWNER,target.id,1);
   await f.reactions.like(MEMBER,target.id);
   assert.equal((await f.reports.report(OWNER,GROUP,'DAY'))?.metrics.find(x=>x.key==='postLikesActive')?.count,1);
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal(await f.reports.report(OWNER,GROUP,'DAY'),null);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.reports.report(OWNER,GROUP,'DAY'))?.metrics.find(x=>x.key==='postLikesActive')?.count,0);
  }finally{await f.close();}
 });
 test('REPORT-004 '+engine+': windows filter exclusively by actual creation/approval timestamp and never forecast',async()=>{
  const f=await fixture(engine);try{
   const before=await f.reactions.draft(OWNER,GROUP,{
    kind:'BOT_POST',messageId:41,description:'المادة التعليمية قبل بداية النافذة',
    durationMinutes:60});
   await f.reactions.open(OWNER,before.id,1);
   f.advance(2*86_400_000);
   const after=await f.reactions.draft(OWNER,GROUP,{
    kind:'STUDY_EXPERIENCE',messageId:42,description:'المادة التعليمية داخل النافذة الحالية',
    durationMinutes:60});
   await f.reactions.open(OWNER,after.id,1);
   await f.reactions.like(MEMBER,after.id);
   assert.equal((await f.reports.report(OWNER,GROUP,'DAY'))?.metrics.find(x=>x.key==='postLikesActive')?.count,1);
   assert.equal((await f.reports.report(OWNER,GROUP,'WEEK'))?.metrics.find(x=>x.key==='reactionTargetsOpened')?.count,2);
   assert.equal((await f.reports.report(OWNER,GROUP,'DAY'))?.metrics.find(x=>x.key==='reactionTargetsOpened')?.count,1);
   assert.equal((await f.reports.report(OWNER,GROUP,'MONTH'))?.metrics.find(x=>x.key==='reactionTargetsOpened')?.count,2);
  }finally{await f.close();}
 });
 test('REPORT-005 '+engine+': private owner page, bounded group choice and suppressed low-count private metrics',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.cb(1,OWNER,'mi:1:i:09:15'));
   assert.equal(home.status,'APPLIED');assert.equal(home.reason,'PHASE4_ENGAGEMENT_OWNER');
   assert.match(home.plan?.text??'',/التفاعل/);
   const report=await engagementOwnerScreen(f.reports,OWNER,
    '/engagement '+GROUP+' WEEK');
   assert.ok(report);
   assert.match(report.text,/المشاهدات|الحضور|بيانات محلية/);
   assert.ok(report.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='er:1:g:'+GROUP+':DAY'));
   assert.equal(await engagementOwnerScreen(f.reports,MEMBER,'/engagement '+GROUP+' DAY'),null);
   const group=await f.app().handle(f.msg(2,OWNER,GROUP,'/engagement '+GROUP+' DAY'));
   assert.notEqual(group.reason,'PHASE4_ENGAGEMENT_OWNER');
   const forwarded=await f.app().handle(f.msg(3,OWNER,OWNER,
    '/engagement '+GROUP+' DAY',true));
   assert.equal(forwarded.status,'DENIED');
   await f.policy.revokeChat(OWNER,GROUP);
   assert.equal(await engagementOwnerScreen(f.reports,OWNER,'er:1:g:'+GROUP+':WEEK'),null);
  }finally{await f.close();}
 });
}
