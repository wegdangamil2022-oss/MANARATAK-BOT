import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {Phase4BadgesService} from '../src/phase4-badges.js';
import {validBadgeState} from '../src/phase4-badge-model.js';
import {badgeOwnerScreen} from '../src/phase4-badge-owner.js';
import {badgeMemberScreen,parseBadgeMemberCommand} from '../src/phase4-badge-member.js';
import {startPhase4BadgeMaintenance} from '../src/phase4-badge-maintenance.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
const OWNER='100',GROUP='-1001234',OTHER='-1005678',USER='200',NOW=1_700_000_000_000;
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'phase4-badges-'));let now=NOW;
 let proof:'VERIFIED'|'UNKNOWN'|'NOT_MEMBER'='VERIFIED';
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>now);
 await policy.approveChat(OWNER,GROUP,['navigation']);
 await policy.approveChat(OWNER,OTHER,['navigation']);
 const svc=new Phase4BadgesService(store,policy,()=>now,async()=>proof);
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
  update_id:n,callback_query:{id:'b'+n,data,from:{id:Number(actor),is_bot:false},
   message:{message_id:20,chat:{id:Number(actor),type:'private'},from:{id:901,is_bot:true}}}
 });
 return {svc,store,policy,app,message,cb,clock:()=>now,
  advance:(ms:number)=>{now+=ms;},setProof:(v:typeof proof)=>{proof=v;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('BADGE-001 validates only configured non-credential recognition types and strict state',()=>{
 assert.equal(validBadgeState({consents:[],awards:[]}),true);
 for(const bad of [null,[],{}, {consents:[]},
  {consents:[],awards:[],unknown:1},
  {consents:[{id:'fake'}],awards:[]},
  {consents:[],awards:[{id:'fake'}]}])
  assert.equal(validBadgeState(bad),false);
 assert.deepEqual(parseBadgeMemberCommand('/badgeon '+GROUP),
  {kind:'ON',chatId:GROUP});
 assert.deepEqual(parseBadgeMemberCommand('/badgeoff '+GROUP),
  {kind:'OFF',chatId:GROUP});
 assert.deepEqual(parseBadgeMemberCommand('/mybadges '+GROUP),
  {kind:'VIEW',chatId:GROUP});
 assert.equal(parseBadgeMemberCommand('/badgeon '+GROUP+'\n/ban all'),null);
});
for(const engine of ['json','sqlite'] as const){
 test('BADGE-001 '+engine+': per-group student opt-in is mandatory before owner can even draft a badge',async()=>{
  const f=await fixture(engine);try{
   await assert.rejects(f.svc.draft(OWNER,GROUP,USER,'STUDY_SUPPORT'),/BADGE_CONSENT_REQUIRED/);
   assert.equal((await f.svc.consent(USER,GROUP,true)).status,'ENABLED');
   assert.equal((await f.svc.consent(USER,GROUP,true)).status,'ALREADY_ENABLED');
   await assert.rejects(f.svc.draft(USER,GROUP,USER,'STUDY_SUPPORT'),/BADGE_DENIED/);
   await assert.rejects(f.svc.draft(OWNER,GROUP,USER,'SCHOLARSHIP_PRIORITY' as never),/BADGE_INVALID/);
   const b=await f.svc.draft(OWNER,GROUP,USER,'STUDY_SUPPORT');
   assert.equal(b.status,'DRAFT');assert.equal(b.revision,1);
   assert.equal((await f.svc.myBadges(USER,GROUP))?.length,0);
   assert.equal(await f.svc.approve(OWNER,b.id,1),true);
   assert.equal(await f.svc.approve(OWNER,b.id,1),false);
   const own=await f.svc.myBadges(USER,GROUP);
   assert.deepEqual(own?.map(x=>x.code),['STUDY_SUPPORT']);
   assert.doesNotMatch(JSON.stringify(own),/memberId|ownerId|200/);
   assert.equal(await f.svc.ownerCount(OWNER,GROUP),1);
   assert.equal(await f.svc.ownerCount(USER,GROUP),null);
  }finally{await f.close();}
 });
 test('BADGE-002 '+engine+': one badge of each type per member, approval is atomic under multiple taps',async()=>{
  const f=await fixture(engine);try{
   await f.svc.consent(USER,GROUP,true);
   const badge=await f.svc.draft(OWNER,GROUP,USER,'HELPFULNESS');
   const result=await Promise.all(Array.from({length:40},()=>
    f.svc.approve(OWNER,badge.id,1)));
   assert.equal(result.filter(Boolean).length,1);
   assert.equal((await f.svc.myBadges(USER,GROUP))?.length,1);
   await assert.rejects(f.svc.draft(OWNER,GROUP,USER,'HELPFULNESS'),/BADGE_DUPLICATE/);
   const saved=(await new BotStore(f.store.file,{engine}).snapshot()).phase4Badges;
   assert.equal(saved?.awards.length,1);
  }finally{await f.close();}
 });
 test('BADGE-003 '+engine+': consent withdrawal needs no Telegram proof and deletes all personally linked awards immediately',async()=>{
  const f=await fixture(engine);try{
   await f.svc.consent(USER,GROUP,true);
   const b=await f.svc.draft(OWNER,GROUP,USER,'RESOURCE_GUIDE');
   await f.svc.approve(OWNER,b.id,1);
   f.setProof('UNKNOWN');
   assert.equal((await f.svc.consent(USER,GROUP,false)).status,'DISABLED');
   assert.equal((await f.svc.consent(USER,GROUP,false)).status,'ALREADY_DISABLED');
   const saved=(await f.store.snapshot()).phase4Badges;
   assert.equal(saved?.consents.length,0);
   assert.equal(saved?.awards.length,0);
   assert.equal(JSON.stringify(saved).includes('"200"'),false);
   assert.equal(await f.svc.approve(OWNER,b.id,1),false);
   f.setProof('VERIFIED');
   assert.equal((await f.svc.myBadges(USER,GROUP))?.length??0,0);
   assert.equal((await f.svc.consent(USER,GROUP,true)).status,'ENABLED');
   assert.equal((await f.svc.myBadges(USER,GROUP))?.length,0);
  }finally{await f.close();}
 });
 test('BADGE-004 '+engine+': owner can revoke, no auto-public leaderboards, eligibility or privileged permissions',async()=>{
  const f=await fixture(engine);try{
   await f.svc.consent(USER,GROUP,true);
   const b=await f.svc.draft(OWNER,GROUP,USER,'COMMUNITY_CARE');
   await f.svc.approve(OWNER,b.id,1);
   assert.equal(await f.svc.revoke(USER,b.id,2),false);
   assert.equal(await f.svc.revoke(OWNER,b.id,1),false);
   assert.equal(await f.svc.revoke(OWNER,b.id,2),true);
   assert.equal(await f.svc.revoke(OWNER,b.id,2),false);
   assert.deepEqual(await f.svc.myBadges(USER,GROUP),[]);
   assert.equal(await f.svc.ownerCount(OWNER,GROUP),0);
   assert.equal((await f.store.snapshot()).telegramReplyJobs?.length??0,0);
  }finally{await f.close();}
 });
 test('BADGE-005 '+engine+': membership failures and chat approval epoch changes block consent and viewing',async()=>{
  const f=await fixture(engine);try{
   f.setProof('UNKNOWN');
   assert.equal((await f.svc.consent(USER,GROUP,true)).status,'VERIFICATION_REQUIRED');
   f.setProof('VERIFIED');
   assert.equal((await f.svc.consent(USER,GROUP,true)).status,'ENABLED');
   const b=await f.svc.draft(OWNER,GROUP,USER,'HELPFULNESS');
   await f.svc.approve(OWNER,b.id,1);
   await f.policy.revokeChat(OWNER,GROUP);
   await f.policy.approveChat(OWNER,GROUP,['navigation']);
   assert.equal(await f.svc.myBadges(USER,GROUP),null);
   await assert.rejects(f.svc.draft(OWNER,GROUP,USER,'STUDY_SUPPORT'),/BADGE_CONSENT_REQUIRED/);
  }finally{await f.close();}
 });
 test('BADGE-006 '+engine+': member/owner Telegram routing strictly private and consent confirmed by sender',async()=>{
  const f=await fixture(engine);try{
   const menu=await f.app().handle(f.cb(1,OWNER,'mi:1:i:09:12'));
   assert.equal(menu.status,'APPLIED');assert.equal(menu.reason,'PHASE4_BADGE_OWNER');
   const consent=await f.app().handle(f.message(2,USER,USER,'/badgeon '+GROUP));
   assert.equal(consent.status,'APPLIED');assert.equal(consent.reason,'PHASE4_BADGE_MEMBER');
   const draft=await badgeOwnerScreen(f.svc,OWNER,'/badgedraft '+GROUP+' '+USER+' STUDY_SUPPORT');
   assert.match(draft?.text??'',/دراسة|مذاكرة|تقدير|الشارة/);
   const b=(await f.store.snapshot()).phase4Badges?.awards[0]!;
   const applied=await f.app().handle(f.cb(3,OWNER,'bg:1:a:'+b.id+':1'));
   assert.equal(applied.status,'APPLIED');
   const student=await badgeMemberScreen(f.svc,USER,'/mybadges '+GROUP);
   assert.match(student?.text??'',/مذاكرة|دعم/);
   const group=await f.app().handle(f.message(4,USER,GROUP,'/badgeoff '+GROUP));
   assert.notEqual(group.reason,'PHASE4_BADGE_MEMBER');
   const forwarded=await f.app().handle(f.message(5,USER,USER,'/badgeoff '+GROUP,true));
   assert.equal(forwarded.status,'DENIED');
   assert.equal((await f.store.snapshot()).phase4Badges?.consents.length,1);
  }finally{await f.close();}
 });
 test('BADGE-007 '+engine+': expiry sweeps badge-linked identities with no Telegram sending',async()=>{
  const f=await fixture(engine);try{
   await f.svc.consent(USER,GROUP,true);
   const b=await f.svc.draft(OWNER,GROUP,USER,'HELPFULNESS');
   await f.svc.approve(OWNER,b.id,1);
   f.advance(91*86_400_000);
   const worker=startPhase4BadgeMaintenance(f.svc,()=>()=>{});
   await worker.stop();
   const state=(await f.store.snapshot()).phase4Badges!;
   assert.deepEqual(state.awards,[]);
   assert.equal((await f.svc.myBadges(USER,GROUP))?.length,0);
   assert.doesNotMatch(JSON.stringify(state.awards),/200/);
  }finally{await f.close();}
 });
}
