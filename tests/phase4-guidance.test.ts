import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {Phase4CommunityService} from '../src/phase4-community.js';
import {Phase4GuidanceService,parseGuidanceMemberCommand} from '../src/phase4-guidance.js';
import {phase4GuidanceOwnerScreen,validPhase4GuidanceOwnerRoute,
 parseGuidanceOwnerCommand} from '../src/phase4-guidance-owner.js';
import {isValidTelegramInlineKeyboard,ownerInlineConnection} from '../src/telegram-inline-owner.js';

const OWNER='100',STUDENT='200',OTHER='201',GROUP='-1001234',SECOND='-1005678',
 CHANNEL='-1009999',NOW=1_800_000_000_000;
const FAQ='11111111-2222-4333-8444-555555555555';
const ROOT='https://t.me/Official_rules_123';
const FOLDER='https://t.me/addlist/Guide_123';
const callback=(seq:number,actor:string,data:string)=>({
 update_id:seq,callback_query:{id:'guide-'+seq,from:{id:Number(actor),is_bot:false},
  data,message:{message_id:24,chat:{id:Number(actor),type:'private'},
   from:{id:900,is_bot:true}}}
});
const message=(seq:number,actor:string,text:string,origin:'private'|'supergroup'='private',
 forwarded=false)=>({
 update_id:seq,message:{message_id:seq,
  chat:{id:Number(origin==='private'?actor:GROUP),type:origin},
  from:{id:Number(actor),is_bot:false,first_name:'طالب'},
  text,...(forwarded?{forward_origin:{type:'user',date:1700000000,
   sender_user:{id:901,is_bot:false}}}:{})}
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'p4-guide-'));
 const store=new BotStore(join(dir,'state.'+engine),{engine});
 const policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['navigation','verification']);
 await policy.approveChat(OWNER,SECOND,['navigation']);
 await policy.approveChat(OWNER,CHANNEL,['verification']);
 const community=new Phase4CommunityService(store,policy,()=>NOW);
 const guidance=new Phase4GuidanceService(store,policy,community);
 const education=new EducationService(store,policy,()=>NOW);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy);
 const links=new ResourceLinkService(store,policy);
 let membership:'VERIFIED'|'NOT_MEMBER'|'UNKNOWN'='VERIFIED';
 let release:(()=>void)|null=null;
 let hold=false;
 const app=()=>new TelegramUpdateApplication({
  store,policy,community,education,admin,faq,links,ownerMenuMode:'inline',
  botId:'bot-main',botUsername:'ManaratakBot',clock:()=>NOW,
  membership:async()=>{if(hold)await new Promise<void>(ok=>{release=ok;});return membership;}
 });
 const approved=async(request:Parameters<typeof community.pending>[1])=>
  community.approve(OWNER,(await community.pending(OWNER,request,GROUP)).id);
 const sources=async()=>{
  await store.transaction(s=>{
   s.educationCategories.push({id:'cat-guide',scope:GROUP,parentId:null,
    title:'مراجعات',order:1,enabled:true,groupVisible:true});
   s.educationResources.push({id:'resource-guide',scope:GROUP,categoryId:'cat-guide',
    title:'مصدر معتمد',university:'منارتك',cycle:'2026',degree:'بكالوريوس',
    seats:null,sourceImportId:'manual',sourceLocator:'https://example.com',
    reviewedBy:OWNER,status:'PUBLISHED'});
   s.faqEntries.push({id:FAQ,scope:GROUP,question:'كيف أقدم <الآن>؟',
    aliases:[],answer:'المستند & الوثيقة <الأصلية> مطلوبة.',
    sourceResourceId:'resource-guide',createdBy:OWNER,approvedBy:OWNER,
    status:'APPROVED',createdAt:NOW});
  });
 };
 return {dir,store,policy,community,guidance,app,approved,sources,
  setMembership:(v:typeof membership)=>{membership=v;},
  hold:()=>{hold=true;},release:()=>{hold=false;release?.();},
  close:()=>rm(dir,{recursive:true,force:true})};
}
test('GUIDE-001 strict owner and member parsers and 64-byte callback contract',()=>{
 assert.deepEqual(parseGuidanceOwnerCommand('/newmemberguide'),{section:'GUIDE',kind:'HOME'});
 assert.deepEqual(parseGuidanceOwnerCommand('/groupfixed '+GROUP),
  {section:'FIXED',kind:'GROUP',chatId:GROUP});
 assert.deepEqual(parseGuidanceMemberCommand('/groupguide '+GROUP),
  {kind:'GUIDE',chatId:GROUP});
 assert.deepEqual(parseGuidanceMemberCommand('/grouprules '+GROUP),
  {kind:'RULES',chatId:GROUP});
 assert.deepEqual(parseGuidanceMemberCommand('/groupfaq '+GROUP+' '+FAQ),
  {kind:'FAQ',chatId:GROUP,faqId:FAQ});
 for(const s of ['/groupguide 100','/groupguide '+GROUP+'\n',
  '/groupfaq '+GROUP+' deadbeef','/grouprules '+GROUP+' extra',
  '/groupguide -9999999999999999'])
  assert.equal(parseGuidanceMemberCommand(s),null,s);
 assert.equal(validPhase4GuidanceOwnerRoute('gd:1:3:d:'+GROUP+':'+FAQ),true);
 for(const s of ['gd:1:3:d:'+GROUP+':other','gd:1:2:d:'+GROUP+':'+FAQ,
  'gd:1:3:r:123:1','gd:1:3:f:'+GROUP+':999','gd:1:2:g:'+GROUP+'\n'])
  assert.equal(validPhase4GuidanceOwnerRoute(s),false,s);
 assert.equal(ownerInlineConnection('mi:1:i:09:02'),'EDITOR');
 assert.equal(ownerInlineConnection('mi:1:i:09:03'),'EDITOR');
});
for(const engine of ['json','sqlite'] as const){
 test('GUIDE-002 '+engine+' owner menus are group-scoped, read only and produce valid keyboards',async()=>{
  const f=await fixture(engine);try{
   const before=JSON.stringify(await f.store.snapshot());
   for(const source of ['mi:1:i:09:02','mi:1:i:09:03']){
    const screen=await phase4GuidanceOwnerScreen(f.guidance,OWNER,source);
    assert.ok(screen);assert.equal(isValidTelegramInlineKeyboard(screen.keyboard),true);
    assert.ok(screen.keyboard.inline_keyboard.flat().some(b=>b.callback_data.includes(GROUP)));
    const reply=await f.app().handle(callback(10+(source.endsWith('2')?1:2),OWNER,source));
    assert.equal(reply.status,'APPLIED');assert.match(reply.reason??'',/GUIDANCE_OWNER/);
   }
   const guide=await phase4GuidanceOwnerScreen(f.guidance,OWNER,'gd:1:2:g:'+GROUP);
   assert.ok(guide);assert.match(guide.text,/دليل العضو الجديد/);
   const fixed=await phase4GuidanceOwnerScreen(f.guidance,OWNER,'gd:1:3:g:'+GROUP);
   assert.ok(fixed);assert.match(fixed.text,/القوانين والرسائل الثابتة/);
   assert.equal(JSON.stringify(await f.store.snapshot()),before);
   assert.equal(await phase4GuidanceOwnerScreen(f.guidance,STUDENT,'gd:1:2:g:'+GROUP),null);
   assert.equal(await phase4GuidanceOwnerScreen(f.guidance,OWNER,'gd:1:2:g:-1001111'),null);
   assert.equal((await f.app().handle(callback(13,STUDENT,'mi:1:i:09:02'))).status,'DENIED');
  }finally{await f.close();}
 });
 test('GUIDE-003 '+engine+' only approved community links appear, with safe HTML and no fake channel link',async()=>{
  const f=await fixture(engine);try{
   await f.approved({kind:'RULES_LINK_SET',text:ROOT});
   await f.approved({kind:'REPLY_ADD',match:'WORD',trigger:'ملاحظة',
    text:'انتبه إلى المصدر <المعتمد> & راجعه',source:'NOTE'});
   await f.sources();
   const first=await f.guidance.member(GROUP,'GUIDE');
   assert.ok(first);assert.match(first,/Official_rules_123/);
   assert.doesNotMatch(first,/Guide_123/);
   await f.store.transaction(s=>{s.communityFolders=[{chatId:GROUP,
    url:FOLDER,enabled:true,revision:1}];});
   const second=await f.guidance.member(GROUP,'GUIDE');
   assert.ok(second);assert.doesNotMatch(second,/Guide_123/);
   await f.store.transaction(s=>{s.subscriptionRequirements.push({
    chatId:GROUP,channelIds:[CHANNEL],mode:'ALL',version:1});});
   const active=await f.guidance.member(GROUP,'GUIDE');
   assert.ok(active);assert.match(active,/Guide_123/);
   assert.doesNotMatch(active,/t\.me\/addlist\/random/);
   const fixed=await f.guidance.member(GROUP,'RULES');
   assert.ok(fixed);assert.match(fixed,/&lt;المعتمد&gt; &amp;/);
   assert.doesNotMatch(fixed,/<المعتمد>/);
   assert.match(fixed,/Official_rules_123/);
   const faq=await f.guidance.member(GROUP,'FAQ',FAQ);
   assert.match(faq??'',/&lt;الأصلية&gt;/);
   await f.store.transaction(s=>{s.educationResources[0]!.status='ARCHIVED';});
   assert.equal(await f.guidance.member(GROUP,'FAQ',FAQ),null);
  }finally{await f.close();}
 });
 test('GUIDE-004 '+engine+' FAQ and fixed replies enumerate only reviewed same-group sources',async()=>{
  const f=await fixture(engine);try{
   await f.sources();
   await f.approved({kind:'REPLY_ADD',match:'WORD',trigger:'طلب',
    source:'FAQ',sourceFaqId:FAQ});
   const view=await phase4GuidanceOwnerScreen(f.guidance,OWNER,'gd:1:3:f:'+GROUP+':0');
   assert.ok(view);assert.match(view.text,/كيف أقدم/);
   assert.equal(isValidTelegramInlineKeyboard(view.keyboard),true);
   const detail=await phase4GuidanceOwnerScreen(f.guidance,OWNER,
    'gd:1:3:d:'+GROUP+':'+FAQ);
   assert.ok(detail);assert.match(detail.text,/&lt;الأصلية&gt;/);
   await f.store.transaction(s=>{s.educationCategories[0]!.enabled=false;});
   assert.equal(await phase4GuidanceOwnerScreen(f.guidance,OWNER,
    'gd:1:3:d:'+GROUP+':'+FAQ),null);
   const screen=await phase4GuidanceOwnerScreen(f.guidance,OWNER,'gd:1:3:f:'+GROUP+':0');
   assert.ok(screen);assert.doesNotMatch(screen.text,/كيف أقدم/);
  }finally{await f.close();}
 });
 test('GUIDE-005 '+engine+' private student commands require fresh group membership and no forwarded requests',async()=>{
  const f=await fixture(engine);try{
   assert.equal((await f.app().handle(message(30,STUDENT,'/groupguide '+GROUP))).status,'APPLIED');
   f.setMembership('NOT_MEMBER');
   assert.equal((await f.app().handle(message(31,STUDENT,'/grouprules '+GROUP))).status,'DENIED');
   f.setMembership('UNKNOWN');
   assert.equal((await f.app().handle(message(32,STUDENT,'/groupguide '+GROUP))).status,'DENIED');
   f.setMembership('VERIFIED');
   assert.equal((await f.app().handle(message(33,STUDENT,'/groupguide '+GROUP,'private',true))).status,'DENIED');
   assert.equal((await f.app().handle(message(34,STUDENT,'/groupguide '+GROUP,'supergroup'))).status,'DENIED');
   assert.equal((await f.app().handle(callback(35,STUDENT,'gd:1:2:g:'+GROUP))).status,'DENIED');
  }finally{await f.close();}
 });
 test('GUIDE-006 '+engine+' revocation during membership check blocks guide, including restored approval',async()=>{
  const f=await fixture(engine);try{
   f.hold();
   const request=f.app().handle(message(41,STUDENT,'/groupguide '+GROUP));
   for(let i=0;i<50;i++){if((f as any).released)break;await new Promise(ok=>setImmediate(ok));}
   await f.policy.revokeChat(OWNER,GROUP);
   f.release();
   const response=await request;
   assert.equal(response.status,'DENIED');
   assert.equal(response.plan,undefined);
  }finally{await f.close();}
 });
}
