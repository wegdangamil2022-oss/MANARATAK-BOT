import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4PollService} from '../src/phase4-polls.js';
import {validPollState} from '../src/phase4-poll-model.js';
import {pollMemberScreen,parsePollMemberCommand} from '../src/phase4-poll-member.js';
import {pollOwnerScreen} from '../src/phase4-poll-owner.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
const OWNER='100',GROUP='-1001234',OTHER='-1001235',USER='200',NOW=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-polls-'));let now=NOW;
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const service=new Phase4PollService(store,policy,()=>now,async()=>membership);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,botId:'bot-main',botUsername:'ManaratakBot',
  clock:()=>now,ownerMenuMode:'inline',membership:async()=>membership});
 const msg=(update:number,actor:string,chat:string,text:string,forward=false)=>({
  update_id:update,message:{message_id:update,chat:{id:Number(chat),
   type:chat.startsWith('-')?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'Student'},text,
   ...(forward?{forward_origin:{type:'user',date:1700000000,sender_user:{id:777,is_bot:false}}}:{})}
 });
 const cb=(update:number,actor:string,data:string)=>({
  update_id:update,callback_query:{id:'poll'+update,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:99,chat:{id:Number(actor),type:'private'},
    from:{id:900,is_bot:true}}}
 });
 return {store,policy,service,app,msg,cb,setMembership:(v:typeof membership)=>{membership=v;},
  clock:()=>now,advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
}
const draft={kind:'NEEDS' as const,question:'ما نوع المنح الأكثر فائدة؟',options:['البكالوريوس','الماجستير','الدكتوراه'],durationMinutes:60};
test('POLL-001 strict restored model refuses forged state and duplicates',()=>{
 assert.equal(validPollState({polls:[],ballots:[]}),true);
 for(const x of [null,[],{}, {polls:[],ballots:[],extra:1},
  {polls:[{id:'abc'}],ballots:[]}, {polls:[],ballots:[{id:'abc'}]}])
  assert.equal(validPollState(x),false);
 assert.deepEqual(parsePollMemberCommand('/pollvote abcdefabcdefabcdefabcdef 2'),
  {kind:'VOTE',pollId:'abcdefabcdefabcdefabcdef',option:2});
 assert.deepEqual(parsePollMemberCommand('/pollwithdraw abcdefabcdefabcdefabcdef'),
  {kind:'WITHDRAW',pollId:'abcdefabcdefabcdefabcdef'});
 assert.equal(parsePollMemberCommand('/pollvote abcdefabcdefabcdefabcdef 0'),null);
});
for(const engine of ['json','sqlite'] as const){
 test('POLL-001 '+engine+': owner drafts and reviews a local poll; nothing goes to Telegram',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.service.draft(USER,GROUP,draft),/POLL_DENIED/);
   await assert.rejects(f.service.draft(OWNER,GROUP,{...draft,options:[' مكرر','مكرر']}),/POLL_INPUT_INVALID/);
   await assert.rejects(f.service.draft(OWNER,GROUP,{...draft,options:['ماجستير','ماجستير']}),/POLL_INPUT_INVALID/);
   const d=await f.service.draft(OWNER,GROUP,draft);
   assert.equal(d.status,'DRAFT');assert.equal(d.revision,1);
   assert.equal((await f.service.vote(USER,d.id,0)).status,'CLOSED');
   assert.equal(await f.service.open(OWNER,d.id,1),true);
   assert.equal(await f.service.open(OWNER,d.id,1),false);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('POLL-002 '+engine+': 1000 concurrent clicks count each verified Telegram ID once',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,draft);
   assert.equal(await f.service.open(OWNER,d.id,1),true);
   const members=Array.from({length:100},(_,i)=>String(200+i));
   const result=await Promise.all(Array.from({length:1000},(_,i)=>
    f.service.vote(members[i%members.length]!,d.id,i%3)));
   assert.equal(result.filter(x=>x.status==='CAST').length,100);
   assert.equal(result.filter(x=>x.status==='ALREADY_VOTED').length,900);
   const state=await new BotStore(f.store.file,{engine}).snapshot();
   assert.equal(state.phase4Polls?.ballots.length,100);
   assert.equal(await f.service.results(OWNER,d.id),null); // results not revealed before close
  }finally{await f.close();}
 });
 test('POLL-003 '+engine+': member revocation scrubs vote and never grants re-vote',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,draft);await f.service.open(OWNER,d.id,1);
   assert.equal((await f.service.vote(USER,d.id,1)).status,'CAST');
   f.setMembership('NOT_MEMBER');
   assert.equal(await f.service.withdraw(USER,d.id),true);
   assert.equal(await f.service.withdraw(USER,d.id),false);
   assert.equal((await f.service.myVote(USER,d.id))?.status,'WITHDRAWN');
   f.setMembership('VERIFIED');
   assert.equal((await f.service.vote(USER,d.id,0)).status,'ALREADY_VOTED');
   const ballot=(await f.store.snapshot()).phase4Polls?.ballots[0];
   assert.equal(ballot?.option,undefined);
  }finally{await f.close();}
 });
 test('POLL-004 '+engine+': results only after closure and minimum aggregate privacy threshold',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,draft);await f.service.open(OWNER,d.id,1);
   assert.equal((await f.service.vote(USER,d.id,0)).status,'CAST');
   assert.equal(await f.service.close(OWNER,d.id,2),true);
   assert.equal(await f.service.close(OWNER,d.id,2),false);
   assert.equal(await f.service.results(OWNER,d.id),null);
   const next=await f.service.draft(OWNER,GROUP,{...draft,question:'ما نوع المحتوى الذي تفضله؟'});
   await f.service.open(OWNER,next.id,1);
   for(let i=0;i<5;i++)assert.equal((await f.service.vote(String(300+i),next.id,i%3)).status,'CAST');
   assert.equal(await f.service.close(OWNER,next.id,2),true);
   const results=await f.service.results(OWNER,next.id);
   assert.deepEqual(results?.counts,[2,2,1]);
   assert.equal(results?.total,5);
   assert.equal(JSON.stringify(results).includes('300'),false);
   assert.equal(await f.service.results(USER,next.id),null);
  }finally{await f.close();}
 });
 test('POLL-005 '+engine+': membership, stale policy and expiry checks fail closed',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,draft);await f.service.open(OWNER,d.id,1);
   f.setMembership('UNKNOWN');
   assert.equal((await f.service.vote(USER,d.id,0)).status,'VERIFICATION_REQUIRED');
   assert.equal((await f.store.snapshot()).phase4Polls?.ballots.length,0);
   f.setMembership('VERIFIED');
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal((await f.service.vote(USER,d.id,0)).status,'STALE');
  }finally{await f.close();}
 });
 test('POLL-006 '+engine+': expiry scrubs old ballots after 24h without publishing',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{...draft,durationMinutes:10});
   await f.service.open(OWNER,d.id,1);
   await f.service.vote(USER,d.id,1);
   f.advance(600_001);
   assert.equal((await f.service.vote('300',d.id,0)).status,'EXPIRED');
   assert.equal(await f.service.expire(),1);
   f.advance(86_400_001);
   await f.service.expire();
   assert.deepEqual((await f.store.snapshot()).phase4Polls,{polls:[],ballots:[]});
  }finally{await f.close();}
 });
 test('POLL-007 '+engine+': private Telegram routes require sender identity and never count forwarded/group votes',async()=>{
  const f=await fixture(engine);try{
   const home=await f.app().handle(f.cb(10,OWNER,'mi:1:i:09:08'));
   assert.equal(home.status,'APPLIED');assert.equal(home.reason,'PHASE4_POLL_OWNER');
   const preview=await pollOwnerScreen(f.service,OWNER,'/pollnew '+GROUP+' 60 أي نوع دراسة تفضله؟ | بكالوريوس | ماجستير');
   assert.match(preview?.text??'',/معاينة|مسودة/);
   const d=(await f.store.snapshot()).phase4Polls?.polls[0]!;
   const opened=await f.app().handle(f.cb(11,OWNER,'po:1:o:'+d.id+':1'));
   assert.equal(opened.status,'APPLIED');
   const valid=await f.app().handle(f.msg(12,USER,USER,'/pollvote '+d.id+' 1'));
   assert.equal(valid.reason,'PHASE4_POLL_MEMBER');
   const group=await f.app().handle(f.msg(13,USER,GROUP,'/pollvote '+d.id+' 2'));
   assert.notEqual(group.reason,'PHASE4_POLL_MEMBER');
   const forward=await f.app().handle(f.msg(14,USER,USER,'/pollwithdraw '+d.id,true));
   assert.equal(forward.status,'DENIED');
   const forged=await f.app().handle(f.msg(15,USER,OTHER,'/pollwithdraw '+d.id));
   assert.notEqual(forged.reason,'PHASE4_POLL_MEMBER');
   assert.equal((await f.store.snapshot()).phase4Polls?.ballots.length,1);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.some(j=>j.plan?.chatId===GROUP),false);
  }finally{await f.close();}
 });
}
