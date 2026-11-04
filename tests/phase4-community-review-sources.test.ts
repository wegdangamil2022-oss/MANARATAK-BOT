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
import {Phase4CommunityService} from '../src/phase4-community.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {defaultCommunityConfig,validCommunityConfig,validCommunityState} from '../src/phase4-community-model.js';
import {parsePhase4CommunityCommand,phase4CommunityScreen} from '../src/phase4-community-ui.js';

const GROUP='-1001234578',OWNER='100',MEMBER='311';
const FAQ='b2ef67a1-1414-4141-8123-a21111aa11aa';
const SRC='published-scholarship',CATEGORY='visible-admissions';
const fixture=async(engine:'json'|'sqlite')=>{
 const dir=await mkdtemp(join(tmpdir(),'phase4-reply-sources-')),file=join(dir,engine==='json'?'state.json':'state.sqlite');
 let at=1_800_000_000_000;
 const clock=()=>at,store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,clock);
 await policy.approveChat(OWNER,GROUP,['navigation']);await policy.setPresence(GROUP,true);
 const community=new Phase4CommunityService(store,policy,clock);
 const education=new EducationService(store,policy);
 const app=new TelegramUpdateApplication({store,policy,community,education,
  admin:new EducationAdminFacade(store,policy,education),
  faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
  botId:'bot-main',botUsername:'ManaratakEduBot',membership:async()=> 'VERIFIED',clock});
 const addFAQ=async()=>{
  await store.transaction(s=>{
   s.educationCategories.push({id:CATEGORY,scope:GROUP,parentId:null,title:'دليل القبول',order:1,enabled:true,groupVisible:true});
   s.educationResources.push({id:SRC,scope:GROUP,categoryId:CATEGORY,title:'دليل رسمي',university:'منارتك',
    cycle:'2026',degree:'بكالوريوس',seats:null,sourceImportId:'manual',
    sourceLocator:'https://example.com',reviewedBy:OWNER,status:'PUBLISHED'});
   s.faqEntries.push({id:FAQ,scope:GROUP,question:'كيف أقدم؟',aliases:[],
    answer:'الخطوات المعتمدة: افتح المصدر <مراجَع> & اقرأه.',sourceResourceId:SRC,
    createdBy:OWNER,approvedBy:OWNER,status:'APPROVED',createdAt:clock()});
  });
 };
 const approve=async(request:Parameters<typeof community.pending>[1])=>
  community.approve(OWNER,(await community.pending(OWNER,request,GROUP)).id);
 const msg=(update_id:number,text:string,actor=Number(MEMBER))=>({update_id,message:{
  chat:{id:Number(GROUP),type:'supergroup',title:'منارتك'},from:{id:actor,is_bot:false,first_name:'طالب & مميز'},
  message_id:update_id,text
 }});
 return {dir,file,store,policy,community,app,approve,msg,addFAQ,clock,step:(ms:number)=>{at+=ms;},close:()=>rm(dir,{recursive:true,force:true})};
};
test('WELCOME-004: validated source types and strict command parsing',()=>{
 const common=defaultCommunityConfig(GROUP);
 assert.equal(validCommunityConfig(common),true);
 assert.equal(validCommunityConfig({...common,rules:[{id:'abcdef123456',trigger:'قوانين',response:'قوانين المجموعة: {رابط_القوانين}',match:'WORD',enabled:true,cooldownMs:60000,source:'RULES'}]}),true);
 assert.equal(validCommunityConfig({...common,rules:[{id:'abcdef123456',trigger:'منح',response:'📚 إجابة معتمدة',match:'WORD',enabled:true,cooldownMs:60000,source:'FAQ',sourceFaqId:FAQ}]}),true);
 for(const bad of [{source:'FAQ'}, {source:'FAQ',sourceFaqId:'x'}, {source:'STATIC',sourceFaqId:FAQ},
  {source:'RULES',sourceFaqId:FAQ},{source:'UNAPPROVED',sourceFaqId:FAQ}]){
  assert.equal(validCommunityConfig({...common,rules:[{id:'abcdef123456',trigger:'منح',response:'رسالة',match:'WORD',enabled:true,cooldownMs:60000,...bad}]}),false);
 }
 assert.equal(validCommunityState({configs:[],drafts:[],receipts:[]}),true);
 assert.deepEqual(parsePhase4CommunityCommand('/replyfaq '+GROUP+' WORD القبول | '+FAQ),{
  kind:'EDIT',chatId:GROUP,request:{kind:'REPLY_ADD',source:'FAQ',sourceFaqId:FAQ,match:'WORD',trigger:'القبول'}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/replyrules '+GROUP+' EXACT القوانين'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'REPLY_ADD',source:'RULES',match:'EXACT',trigger:'القوانين'}
 });
 assert.deepEqual(parsePhase4CommunityCommand('/replynote '+GROUP+' WORD تنبيه | اقرأ التعميم'),{
  kind:'EDIT',chatId:GROUP,request:{kind:'REPLY_ADD',source:'NOTE',match:'WORD',trigger:'تنبيه',text:'اقرأ التعميم'}
 });
 for(const bad of ['/replyfaq '+GROUP+' WORD القبول | xyz','/replyrules '+GROUP+' WORD', '/replyfaq 123 WORD سؤال | '+FAQ,
  '/replynote '+GROUP+' WORD تنبيه | ','/replyfaq '+GROUP+' COMMAND /ban | '+FAQ])assert.equal(parsePhase4CommunityCommand(bad),null,bad);
});
for(const engine of ['json','sqlite'] as const){
 test('WELCOME-004 '+engine+': cannot approve FAQ source without published visible material, and owner reviews all edits',async()=>{
  const f=await fixture(engine);
  try{
   await assert.rejects(f.community.pending(MEMBER,{kind:'REPLY_ADD',source:'FAQ',sourceFaqId:FAQ,trigger:'قبول',match:'WORD'},GROUP),
    /COMMUNITY_OWNER_DENIED/);
   await assert.rejects(f.community.pending(OWNER,{kind:'REPLY_ADD',source:'FAQ',sourceFaqId:FAQ,trigger:'قبول',match:'WORD'},GROUP),
    /COMMUNITY_FAQ_SOURCE_UNAVAILABLE/);
   await f.addFAQ();
   const draft=await f.community.pending(OWNER,{kind:'REPLY_ADD',source:'FAQ',sourceFaqId:FAQ,trigger:'قبول',match:'WORD'},GROUP);
   assert.equal((await f.community.view(OWNER,GROUP)).rules.length,0);
   assert.match(f.community.preview(draft),/FAQ|مراجعة/u);
   await f.community.approve(OWNER,draft.id);
   const config=await f.community.view(OWNER,GROUP);
   assert.equal(config.rules[0]?.source,'FAQ');
   assert.equal(config.rules[0]?.sourceFaqId,FAQ);
   assert.equal(JSON.stringify(config.rules).includes('الخطوات المعتمدة'),false);
   assert.equal((await new BotStore(f.file,{engine}).snapshot()).phase4Community?.configs[0]?.rules[0]?.sourceFaqId,FAQ);
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:r:'+GROUP+':0');
   assert.match(screen?.text??'',/FAQ/u);
   await assert.rejects(phase4CommunityScreen(f.community,MEMBER,'p4c:1:r:'+GROUP+':0'),/COMMUNITY_OWNER_DENIED/);
  }finally{await f.close();}
 });
 test('WELCOME-004 '+engine+': published and approved FAQ is escaped and queued by keyword with quotas',async()=>{
  const f=await fixture(engine);
  try{
   await f.addFAQ();
   await f.approve({kind:'REPLY_ADD',source:'FAQ',sourceFaqId:FAQ,trigger:'القبول',match:'WORD'});
   await f.approve({kind:'REPLIES_ON'});
   const response=await f.app.handle(f.msg(100,'كيف القبول عندكم؟'));
   assert.equal(response.status,'APPLIED');
   assert.match(response.plan?.text??'',/الخطوات المعتمدة/);
   assert.match(response.plan?.text??'',/&lt;مراجَع&gt; &amp;/u);
   assert.doesNotMatch(response.plan?.text??'',/<مراجَع>/u);
   assert.ok(response.deliveryKey);
   const encoded=JSON.stringify((await f.store.snapshot()).phase4Community);
   assert.equal(encoded.includes('كيف القبول عندكم'),false);
   assert.equal(encoded.includes('الخطوات المعتمدة'),false);
   assert.equal((await f.app.handle(f.msg(101,'القبول'))).plan,undefined);
   let sends=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,
    {send:async()=>{sends++;return {status:'CONFIRMED' as const,messageId:700};}},f.clock);
   assert.equal((await dispatcher.dispatch(response.deliveryKey!)).status,'CONFIRMED');
   assert.equal(sends,1);
  }finally{await f.close();}
 });
 test('WELCOME-004 '+engine+': archiving FAQ or its published source revokes unsent automation',async()=>{
  const f=await fixture(engine);
  try{
   await f.addFAQ();
   await f.approve({kind:'REPLY_ADD',source:'FAQ',sourceFaqId:FAQ,trigger:'القبول',match:'WORD'});
   await f.approve({kind:'REPLIES_ON'});
   const first=await f.app.handle(f.msg(202,'القبول'));
   assert.ok(first.deliveryKey);
   await f.store.transaction(s=>{s.faqEntries.find(x=>x.id===FAQ)!.status='ARCHIVED';});
   let sent=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,
    {send:async()=>{sent++;return {status:'CONFIRMED' as const,messageId:701};}},f.clock);
   assert.equal((await dispatcher.dispatch(first.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(sent,0);
   f.step(70_000);
   assert.equal((await f.app.handle(f.msg(203,'القبول'))).plan,undefined);
   const diag=await f.community.diagnose(OWNER,GROUP,'القبول');
   assert.equal(diag.status,'SOURCE_UNAVAILABLE');
   await f.store.transaction(s=>{s.faqEntries.find(x=>x.id===FAQ)!.status='APPROVED';});
   f.step(70_000);
   const second=await f.app.handle(f.msg(204,'القبول'));
   assert.ok(second.deliveryKey);
   await f.store.transaction(s=>{s.educationResources.find(x=>x.id===SRC)!.status='ARCHIVED';});
   assert.equal((await dispatcher.dispatch(second.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(sent,0);
  }finally{await f.close();}
 });
 test('WELCOME-004 '+engine+': RULES source uses reviewed URL and refuses stale or absent link',async()=>{
  const f=await fixture(engine);
  try{
   await assert.rejects(f.community.pending(OWNER,{kind:'REPLY_ADD',source:'RULES',match:'WORD',trigger:'القوانين'},GROUP),
    /COMMUNITY_RULES_SOURCE_UNAVAILABLE/);
   await f.approve({kind:'RULES_LINK_SET',text:'https://t.me/ManaratakRules'});
   await f.approve({kind:'REPLY_ADD',source:'RULES',match:'WORD',trigger:'القوانين'});
   await f.approve({kind:'REPLIES_ON'});
   const first=await f.app.handle(f.msg(301,'القوانين'));
   assert.match(first.plan?.text??'',/https:\/\/t.me\/ManaratakRules/u);
   await f.approve({kind:'RULES_LINK_CLEAR'});
   let attempts=0;
   const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,
    {send:async()=>{attempts++;return {status:'CONFIRMED' as const,messageId:704};}},f.clock);
   assert.equal((await dispatcher.dispatch(first.deliveryKey!)).status,'FAILED_CONFIRMED');
   assert.equal(attempts,0);
   f.step(61000);
   assert.equal((await f.app.handle(f.msg(302,'القوانين'))).plan,undefined);
   assert.equal((await f.community.diagnose(OWNER,GROUP,'القوانين')).status,'SOURCE_UNAVAILABLE');
  }finally{await f.close();}
 });
 test('WELCOME-004 '+engine+': static notes are owner reviewed, stay escaped and adhere to topic and quiet-hour fences',async()=>{
  const f=await fixture(engine);
  try{
   await f.approve({kind:'REPLY_ADD',source:'NOTE',match:'EXACT',trigger:'ملاحظة',
    text:'راجع الإعلانات <المثبتة> & للمساعدة {العضو}'});
   await f.approve({kind:'REPLIES_ON'});
   const reply=await f.app.handle(f.msg(401,'ملاحظة'));
   assert.match(reply.plan?.text??'',/راجع الإعلانات &lt;المثبتة&gt; &amp; للمساعدة طالب &amp; مميز/u);
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:r:'+GROUP+':0');
   assert.match(screen?.text??'',/NOTE/u);
   assert.equal((await f.app.handle(f.msg(402,'ملاحظة'))).plan,undefined);
   f.step(70_000);
   const further=await f.app.handle(f.msg(403,'ملاحظة'));
   assert.ok(further.deliveryKey);
   const rule=(await f.community.view(OWNER,GROUP)).rules[0]!;
   assert.equal(rule.source,'NOTE');
  }finally{await f.close();}
 });
}


for(const engine of ['json','sqlite'] as const){
 test('WELCOME-004 '+engine+': owner-only FAQ source catalogue excludes stale, hidden and other-group records',async()=>{
  const f=await fixture(engine);
  try{
   await f.addFAQ();
   assert.equal((await f.community.listReviewedFAQs(OWNER,GROUP)).length,1);
   assert.equal((await f.community.listReviewedFAQs(OWNER,GROUP))[0]?.id,FAQ);
   assert.equal((await f.community.listReviewedFAQs(OWNER,GROUP))[0]?.question,'كيف أقدم؟');
   const screen=await phase4CommunityScreen(f.community,OWNER,'p4c:1:f:'+GROUP+':0');
   assert.match(screen?.text??'',/كيف أقدم/u);
   assert.match(screen?.text??'',new RegExp(FAQ));
   assert.ok(screen?.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='p4c:1:g:'+GROUP));
   await assert.rejects(f.community.listReviewedFAQs(MEMBER,GROUP),/COMMUNITY_OWNER_DENIED/);
   await assert.rejects(phase4CommunityScreen(f.community,MEMBER,'p4c:1:f:'+GROUP+':0'),/COMMUNITY_OWNER_DENIED/);
   await f.store.transaction(s=>{s.educationCategories.find(c=>c.id===CATEGORY)!.groupVisible=false;});
   assert.equal((await f.community.listReviewedFAQs(OWNER,GROUP)).length,0);
   const blank=await phase4CommunityScreen(f.community,OWNER,'p4c:1:f:'+GROUP+':0');
   assert.doesNotMatch(blank?.text??'',new RegExp(FAQ));
  }finally{await f.close();}
 });
 test('WELCOME-004 '+engine+': FAQ draft cannot be approved if original published source becomes unavailable',async()=>{
  const f=await fixture(engine);
  try{
   await f.addFAQ();
   const draft=await f.community.pending(OWNER,{kind:'REPLY_ADD',source:'FAQ',sourceFaqId:FAQ,
    trigger:'قبول',match:'WORD'},GROUP);
   await f.store.transaction(s=>{s.educationCategories.find(c=>c.id===CATEGORY)!.enabled=false;});
   await assert.rejects(f.community.approve(OWNER,draft.id),/COMMUNITY_FAQ_SOURCE_UNAVAILABLE/);
   assert.equal((await f.community.view(OWNER,GROUP)).rules.length,0);
  }finally{await f.close();}
 });
}
