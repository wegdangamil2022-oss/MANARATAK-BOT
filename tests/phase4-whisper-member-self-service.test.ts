import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4WhisperService} from '../src/phase4-whispers.js';
import {parseWhisperMemberCommand,whisperMemberScreen} from '../src/phase4-whisper-member.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';

const OWNER='100',GROUP='-1001234',USER='200',START=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-whisper-member-'));let now=START;
 const store=new BotStore(join(dir,'s.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 const verify=async()=>membership;
 const service=new Phase4WhisperService(store,policy,()=>now,verify);
 const education=new EducationService(store,policy,()=>now);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=>membership,clock:()=>now});
 const incoming=(id:number,chatId:string,actor:string,text:string,forwarded=false)=>({
  update_id:id,message:{message_id:id,chat:{id:Number(chatId),type:chatId===GROUP?'supergroup':'private'},
   from:{id:Number(actor),is_bot:false,first_name:'عضو'},
   text,...(forwarded?{forward_origin:{type:'user',sender_user:{id:900,is_bot:false}}}:{})}
 });
 return {store,policy,service,app,incoming,setMembership:(x:typeof membership)=>{membership=x;},
  clock:()=>now,advance:(n:number)=>{now+=n;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('WHISPER-004 self-service parser accepts only canonical commands and numeric group IDs',()=>{
 assert.deepEqual(parseWhisperMemberCommand('/whisperon -1001234'),
  {kind:'ON',chatId:GROUP});
 assert.deepEqual(parseWhisperMemberCommand('/whisperoff -1001234'),
  {kind:'OFF',chatId:GROUP});
 assert.deepEqual(parseWhisperMemberCommand('/whisperseat abcdef123456abcdef123456'),
  {kind:'RESERVE',id:'abcdef123456abcdef123456'});
 for(const value of ['/whisperon -0','/whisperoff 1234','/whisperseat ABCDEF123456abcdef123456',
  '/whisperon -1001234 now','/whisperseat abc','/whisperon -1001234\n/ban 100']){
  assert.equal(parseWhisperMemberCommand(value),null);
 }
});
for(const engine of ['json','sqlite'] as const){
 test('WHISPER-004 private consent uses live member status and stores no member message text ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   f.setMembership('UNKNOWN');
   const unknown=await whisperMemberScreen(f.service,USER,'/whisperon '+GROUP);
   assert.match(unknown?.text??'',/تعذّر|التحقق/);
   assert.equal((await f.store.snapshot()).phase4Whispers?.consents.length??0,0);
   f.setMembership('VERIFIED');
   const accepted=await whisperMemberScreen(f.service,USER,'/whisperon '+GROUP);
   assert.match(accepted?.text??'',/تفعيل|الموافقة/);
   const s=await f.store.snapshot();
   assert.equal(s.phase4Whispers?.consents.length,1);
   assert.equal(s.phase4Whispers?.consents[0]?.memberId,USER);
   assert.equal(JSON.stringify(s.phase4Whispers).includes('/whisperon'),false);
   f.setMembership('NOT_MEMBER');
   const off=await whisperMemberScreen(f.service,USER,'/whisperoff '+GROUP);
   assert.match(off?.text??'',/إيقاف|إلغاء/);
   assert.equal((await f.store.snapshot()).phase4Whispers?.consents[0]?.enabled,false);
  }finally{await f.close();}
 });
 test('WHISPER-018 member claims never reveal secret, recipient or a share link ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:1,
    durationMinutes:10,text:'PRIVATE SECRET & <tag>'});
   await f.service.approve(OWNER,d.id);
   await f.service.consent(USER,GROUP,true);
   const result=await whisperMemberScreen(f.service,USER,'/whisperseat '+d.id);
   assert.ok(result);
   assert.doesNotMatch(result.text,/PRIVATE SECRET|<tag>|\\/start|\/whisperseat/);
   assert.match(result.text,/حجز|مقعد/);
   assert.equal((await f.store.snapshot()).phase4Whispers?.reservations.length,1);
   const again=await whisperMemberScreen(f.service,USER,'/whisperseat '+d.id);
   assert.match(again?.text??'',/محجوز|سبق/);
   const other=await whisperMemberScreen(f.service,'201','/whisperseat '+d.id);
   assert.doesNotMatch(other?.text??'',/PRIVATE SECRET|<tag>/);
  }finally{await f.close();}
 });
 test('WHISPER-019 expiration during awaited membership cannot claim seat ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const d=await f.service.draft(OWNER,GROUP,{kind:'FIRST_N',seats:1,
    durationMinutes:1,text:'SECRET'});
   await f.service.approve(OWNER,d.id);
   await f.service.consent(USER,GROUP,true);
   let release!:()=>void,arrived!:()=>void;
   const blocked=new Promise<void>(resolve=>{release=resolve;});
   const entered=new Promise<void>(resolve=>{arrived=resolve;});
   const checking=new Phase4WhisperService(f.store,f.policy,f.clock,async()=>{
    arrived();await blocked;return 'VERIFIED';
   });
   const pending=checking.reserve(USER,d.id);
   await entered;
   f.advance(60_001);
   release();
   const result=await pending;
   assert.equal(result.status,'EXPIRED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.reservations.length,0);
  }finally{await f.close();}
 });
 test('WHISPER-004 private command is bound to sender; group/forwarded messages are rejected ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   const valid=await f.app().handle(f.incoming(40,USER,USER,'/whisperon '+GROUP));
   assert.equal(valid.status,'APPLIED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.consents.length,1);
   const forged=await f.app().handle(f.incoming(41,GROUP,USER,'/whisperoff '+GROUP));
   assert.notEqual(forged.reason,'WHISPER_MEMBER_SELF_SERVICE');
   const forwarded=await f.app().handle(f.incoming(42,USER,USER,'/whisperoff '+GROUP,true));
   assert.equal(forwarded.status,'DENIED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.consents[0]?.enabled,true);
   const wrong=await f.app().handle(f.incoming(43,OWNER,USER,'/whisperoff '+GROUP));
   assert.equal(wrong.status,'DENIED');
   assert.equal((await f.store.snapshot()).phase4Whispers?.consents[0]?.enabled,true);
  }finally{await f.close();}
 });
 test('WHISPER-004 old consent can be revoked after loss of group approval ('+engine+')',async()=>{
  const f=await fixture(engine);try{
   assert.equal(await f.service.consent(USER,GROUP,true),true);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   f.setMembership('UNKNOWN');
   assert.equal(await f.service.consent(USER,GROUP,false),true);
   const s=await f.store.snapshot();
   assert.equal(s.phase4Whispers?.consents[0]?.enabled,false);
   assert.equal(s.phase4Whispers?.consents[0]?.revision,2);
  }finally{await f.close();}
 });
}
