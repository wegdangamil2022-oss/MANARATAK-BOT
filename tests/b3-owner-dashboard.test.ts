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
import {ownerMenuLabels,parseOwnerMenuAction} from '../src/telegram-owner-menu.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
const OWNER='100',STUDENT='300',STAFF='200',GROUP='-100123';
function msg(id:number,actor:number,text:string,group=false){
 return {update_id:id,message:{message_id:id,chat:{id:group?Number(GROUP):actor,
 type:group?'supergroup':'private'},from:{id:actor,is_bot:false},text}};
}
const labels=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-menu-'));
 const file=join(dir,engine==='sqlite'?'bot.sqlite':'bot.json');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','publishing']);
 await education.createCategory(OWNER,{id:'scholarships',scope:GROUP,title:'المنح <المعتمدة> & فرص',order:1});
 await education.createCategory(OWNER,{id:'courses',scope:GROUP,title:'الدورات الرسمية',order:2});
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN'});
 const upload=async(title='Scholarship Alpha')=>{
  const run=await admin.upload({origin:'TELEGRAM_PRIVATE',actorId:OWNER,chatId:OWNER,verified:true},
   GROUP,'csv','scholarships.csv','title,university,cycle,degree,seats\n'+title+',University A,2026,Bachelor,5');
  return run;
 };
 return {dir,file,store,policy,education,admin,app,upload,close:()=>rm(dir,{force:true,recursive:true})};
}
test('owner dashboard has actual private keyboard with actionable internal sections and safe status',async()=>{
 const f=await fixture();try{
  const r=await f.app().handle(msg(1,100,'🔐 لوحة المالك'));
  assert.equal(r.status,'APPLIED');
  assert.match(r.plan?.text??'',/لوحة المالك/);
  assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
  for(const label of [ownerMenuLabels.imports,ownerMenuLabels.library,ownerMenuLabels.groups,
   ownerMenuLabels.delivery,ownerMenuLabels.settings])
   assert.ok(labels(r).includes(label),label);
  assert.ok(labels(r).includes('🏠 الرئيسية'));
 }finally{await f.close();}
});
test('students and delegated staff can never open owner sections or execute forged owner menu actions',async()=>{
 const f=await fixture();try{
  await f.policy.grant(OWNER,STAFF,'content.publish',GROUP,Date.now()+300_000);
  const run=await f.upload();
  const adminActions=[
   ownerMenuLabels.imports,ownerMenuLabels.library,ownerMenuLabels.groups,
   ownerMenuLabels.delivery,ownerMenuLabels.settings,
   '🗃️ الاستيراد · '+run.id,
   '📑 مرشح · '+run.id+':0',
   '✅ تأكيد الاعتماد · '+run.id+':0:scholarships',
   '📤 تأكيد النشر المحلي · '+run.id+':0:scholarships'
  ];
  for(const actor of [300,200]){
   for(const [i,label] of adminActions.entries()){
    const r=await f.app().handle(msg(20+actor+i,actor,label));
    assert.equal(r.status,'DENIED',label);
    assert.equal(r.plan,undefined);
   }
  }
  assert.equal((await f.store.snapshot()).educationResources.length,0);
  assert.equal((await f.store.snapshot()).importRuns[0]!.candidates[0]!.status,'READY');
 }finally{await f.close();}
});
test('owner review flow: list imported run, select candidate, choose category, confirm approval, preview and confirm local publication',async()=>{
 const f=await fixture();try{
  const run=await f.upload('Scholarship <Safe> & Verified');
  const list=await f.app().handle(msg(2,100,ownerMenuLabels.imports));
  assert.equal(list.status,'APPLIED');
  const chosen=labels(list).find(s=>s.includes(run.id));
  assert.ok(chosen);assert.match(chosen!,/🗃️ الاستيراد/);
  const opened=await f.app().handle(msg(3,100,chosen!));
  assert.equal(opened.status,'APPLIED');
  const candidate=labels(opened).find(s=>s.includes(run.id+':0'));
  assert.ok(candidate);
  const preview=await f.app().handle(msg(4,100,candidate!));
  assert.equal(preview.status,'APPLIED');
  assert.match(preview.plan?.text??'',/Scholarship &lt;Safe&gt; &amp; Verified/);
  const category=labels(preview).find(s=>s.includes(':scholarships'));
  assert.ok(category);
  const confirmView=await f.app().handle(msg(5,100,category!));
  assert.equal(confirmView.status,'APPLIED');
  assert.equal((await f.store.snapshot()).importRuns[0]!.candidates[0]!.status,'READY');
  const approve=labels(confirmView).find(s=>s.startsWith('✅ تأكيد الاعتماد'));
  assert.ok(approve);
  const approved=await f.app().handle(msg(6,100,approve!));
  assert.equal(approved.status,'APPLIED');
  assert.equal((await f.store.snapshot()).importRuns[0]!.candidates[0]!.status,'APPROVED');
  assert.equal((await f.store.snapshot()).educationResources.length,0);
  const prePublish=labels(approved).find(s=>s.startsWith('📝 معاينة النشر'));
  assert.ok(prePublish);
  const publishConfirm=await f.app().handle(msg(7,100,prePublish!));
  assert.equal(publishConfirm.status,'APPLIED');
  assert.equal((await f.store.snapshot()).educationResources.length,0);
  const publish=labels(publishConfirm).find(s=>s.startsWith('📤 تأكيد النشر المحلي'));
  assert.ok(publish);
  const published=await f.app().handle(msg(8,100,publish!));
  assert.equal(published.status,'APPLIED');assert.match(published.plan?.text??'',/المكتبة المحلية/);
  assert.equal((await f.store.snapshot()).educationResources.length,1);
  assert.equal((await f.store.snapshot()).deliveries.length,0);
 }finally{await f.close();}
});
test('owner deliberate local publish is idempotent across different Telegram updates and app restarts',async()=>{
 const f=await fixture('sqlite');try{
  const run=await f.upload();
  await f.admin.approve({origin:'TELEGRAM_PRIVATE',actorId:OWNER,chatId:OWNER,verified:true},
   run.id,0,'scholarships');
  const command='📤 تأكيد النشر المحلي · '+run.id+':0:scholarships';
  const first=await f.app().handle(msg(9,100,command));
  assert.equal(first.status,'APPLIED');
  const again=await f.app().handle(msg(10,100,command));
  assert.equal(again.status,'APPLIED');
  assert.equal((await f.store.snapshot()).educationResources.length,1);
  assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='RESOURCE_PUBLISHED_LOCALLY').length,1);
 }finally{await f.close();}
});
test('invalid, ambiguous and duplicate candidate cannot be approved by owner from forged confirmation',async()=>{
 const f=await fixture();try{
  const run=await f.upload();
  await f.store.transaction(s=>{s.importRuns[0]!.candidates[0]!.status='NEEDS_REVIEW';});
  for(const [i,action] of ['✅ تأكيد الاعتماد · '+run.id+':0:scholarships',
   '📤 تأكيد النشر المحلي · '+run.id+':0:scholarships',
   '✅ تأكيد الاعتماد · '+run.id+':0:missing',
   '✅ تأكيد الاعتماد · '+run.id+':1:scholarships'].entries()){
   const r=await f.app().handle(msg(30+i,100,action));
   assert.equal(r.status,'DENIED',action);
  }
  assert.equal((await f.store.snapshot()).educationResources.length,0);
 }finally{await f.close();}
});
test('owner category choice is revoked if scope no longer approved or category disabled',async()=>{
 const f=await fixture();try{
  const run=await f.upload();
  await f.education.setCategoryEnabled(OWNER,'scholarships',false);
  const denied=await f.app().handle(msg(42,100,'✅ تأكيد الاعتماد · '+run.id+':0:scholarships'));
  assert.equal(denied.status,'DENIED');
  assert.equal((await f.store.snapshot()).importRuns[0]!.candidates[0]!.status,'READY');
  await f.policy.revokeChat(OWNER,GROUP);
  const revoked=await f.app().handle(msg(43,100,'✅ تأكيد الاعتماد · '+run.id+':0:courses'));
  assert.equal(revoked.status,'DENIED');
 }finally{await f.close();}
});
test('owner dashboard shows real aggregate content, group, delivery and switch limitations without secrets',async()=>{
 const f=await fixture();try{
  await f.upload();
  await f.store.transaction(s=>{s.telegramReplyJobs=[{updateKey:'b3-webhook:bot-main:10',
   status:'UNKNOWN_OUTCOME',attemptId:'private-attempt-id',startedAt:Date.now()}];});
  for(const [idx,section] of [ownerMenuLabels.library,ownerMenuLabels.groups,
   ownerMenuLabels.delivery,ownerMenuLabels.settings].entries()){
   const r=await f.app().handle(msg(50+idx,100,section));
   assert.equal(r.status,'APPLIED',section);
   assert.ok((r.plan?.text??'').length>30);
   assert.equal(isValidTelegramReplyKeyboard(r.plan?.replyMarkup),true);
   assert.equal((r.plan?.text??'').includes('private-attempt-id'),false);
  }
  const delivery=await f.app().handle(msg(60,100,ownerMenuLabels.delivery));
  assert.match(delivery.plan?.text??'',/مجهولة|UNKNOWN/);
  const settings=await f.app().handle(msg(61,100,ownerMenuLabels.settings));
  assert.match(settings.plan?.text??'',/ملف|STOP|RUN/);
 }finally{await f.close();}
});
test('owner import view only shows current scope and does not reveal untrusted run IDs to students',async()=>{
 const f=await fixture();try{
  const run=await f.upload();
  const student=await f.app().handle(msg(70,300,ownerMenuLabels.imports));
  assert.equal(student.status,'DENIED');
  assert.equal((student.plan?.text??'').includes(run.id),false);
  await f.policy.revokeChat(OWNER,GROUP);
  const blocked=await f.app().handle(msg(71,100,'🗃️ الاستيراد · '+run.id));
  assert.equal(blocked.status,'DENIED');
 }finally{await f.close();}
});
test('owner actions rejected in group and malformed menu buttons are refused before mutation',async()=>{
 const f=await fixture();try{
  const run=await f.upload();
  const inGroup=await f.app().handle(msg(72,100,ownerMenuLabels.imports,true));
  assert.equal(inGroup.plan,undefined);
  for(const [i,action] of ['🗃️ الاستيراد · ../../unsafe',
    '✅ تأكيد الاعتماد · '+run.id+':0:scholarships:extra',
    '📤 تأكيد النشر المحلي · '+run.id+':00:scholarships',
    '📑 مرشح · '+run.id+':-1',
    '📂 اعتماد في · '+run.id+':0:../',
    '📝 معاينة النشر · '+run.id+':0:scholarships\n'].entries()){
    const r=await f.app().handle(msg(80+i,100,action));
    assert.equal(r.status,'DENIED',action);
  }
  assert.equal((await f.store.snapshot()).educationResources.length,0);
 }finally{await f.close();}
});
test('owner-only forged command parser does not treat random text or extra fields as authority',()=>{
 for(const command of ['🗃️ الاستيراد · aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
   '✅ تأكيد الاعتماد · 123e4567-e89b-12d3-a456-426614174000:0:scholarships'])
   assert.ok(parseOwnerMenuAction(command));
 for(const command of ['🗃️ الاستيراد · /etc/passwd',
   '✅ تأكيد الاعتماد · 123e4567-e89b-12d3-a456-426614174000:01:scholarships',
   '📤 تأكيد النشر المحلي · 123:0:scholarships\n',
   '📑 مرشح · 123:0:1:2','📂 اعتماد في · 123:0:scholarships\n'])
   assert.equal(parseOwnerMenuAction(command),null,command);
});
