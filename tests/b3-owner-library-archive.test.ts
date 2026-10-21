import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {parseOwnerLibraryAction,parseOwnerLibraryPage} from '../src/telegram-owner-library.js';
import {resourceArchiveFingerprint} from '../src/education-archive.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER='100',GROUP='-100123',STUDENT=300;
const m=(id:number,text:string,actor=100,group=false)=>({
 update_id:id,message:{message_id:id,chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'},
 from:{id:actor,is_bot:false},text}
});
const keys=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function fixture(engine:'json'|'sqlite'='json'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-library-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine}),policy=new Policy(store,OWNER);
 const education=new EducationService(store,policy),admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await policy.approveChat(OWNER,GROUP,['navigation','publishing']);
 await education.createCategory(OWNER,{id:'scholarships',scope:GROUP,title:'المنح',order:1});
 const ctx={origin:'TELEGRAM_PRIVATE' as const,actorId:OWNER,chatId:OWNER,verified:true};
 async function publish(title='Study <Scholarship> & 2026'){
  const run=await admin.upload(ctx,GROUP,'csv','scholarships.csv',
   'title,university,cycle,degree,seats\n'+title+',University A,2026,Bachelor,5');
  await admin.approve(ctx,run.id,0,'scholarships');
  return admin.publish(ctx,run.id,0,'scholarships');
 }
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'bot-main',botUsername:'ManaratakBot',membership:async()=> 'VERIFIED'});
 return {dir,store,policy,education,app,publish,close:()=>rm(dir,{recursive:true,force:true})};
}
test('B3 owner library lists real published resources, contains safe navigation and escaped details',async()=>{
 const f=await fixture();try{
  const item=await f.publish();
  const list=await f.app().handle(m(1,ownerMenuLabels.library));
  assert.equal(list.status,'APPLIED');
  assert.match(list.plan?.text??'',/المكتبة/);
  assert.ok(keys(list).includes('📚 المورد · '+item.id));
  assert.equal(isValidTelegramReplyKeyboard(list.plan?.replyMarkup),true);
  const opened=await f.app().handle(m(2,'📚 المورد · '+item.id));
  assert.equal(opened.status,'APPLIED');
  assert.match(opened.plan?.text??'',/Study &lt;Scholarship&gt; &amp; 2026/);
  assert.equal((opened.plan?.text??'').includes('sourceImportId'),false);
  assert.equal(isValidTelegramReplyKeyboard(opened.plan?.replyMarkup),true);
  assert.ok(keys(opened).some(x=>x.startsWith('🗃️ معاينة الأرشفة · '+item.id+':')));
 }finally{await f.close();}
});
for(const engine of ['json','sqlite'] as const){
 test('B3 '+engine+' deliberate preview then atomic archive affects published library without channel sends',async()=>{
  const f=await fixture(engine);try{
   const item=await f.publish(),opened=await f.app().handle(m(10,'📚 المورد · '+item.id));
   const previewLabel=keys(opened).find(x=>x.startsWith('🗃️ معاينة الأرشفة · '))!;
   const before=await f.store.snapshot();
   const preview=await f.app().handle(m(11,previewLabel));
   assert.equal(preview.status,'APPLIED');assert.match(preview.plan?.text??'',/تأكيد|مراجعة/);
   assert.deepEqual((await f.store.snapshot()).educationResources,before.educationResources);
   const confirm=keys(preview).find(x=>x.startsWith('⛔ تأكيد الأرشفة · '))!;
   const done=await f.app().handle(m(12,confirm));
   assert.equal(done.status,'APPLIED');assert.match(done.plan?.text??'',/الأرشفة/);
   const after=await f.store.snapshot();
   assert.equal(after.educationResources.find(r=>r.id===item.id)!.status,'ARCHIVED');
   assert.equal(after.audit.filter(r=>r.reason==='RESOURCE_ARCHIVED').length,1);
   assert.equal(after.deliveries.length,0);
   assert.deepEqual(await f.education.listResources(OWNER,GROUP,'scholarships'),[]);
   assert.equal((await f.app().handle(m(13,confirm))).status,'DENIED');
   assert.equal((await f.app().handle(m(14,'📚 المورد · '+item.id))).status,'DENIED');
  }finally{await f.close();}
 });
}
test('B3 archive is rejected on stale content fingerprint after reviewed publication text changes',async()=>{
 const f=await fixture('sqlite');try{
  const r=await f.publish(),opened=await f.app().handle(m(20,'📚 المورد · '+r.id));
  const review=keys(opened).find(x=>x.startsWith('🗃️ معاينة الأرشفة · '))!;
  const before=await f.app().handle(m(21,review));
  const confirm=keys(before).find(x=>x.startsWith('⛔ تأكيد الأرشفة · '))!;
  await f.education.setPublicationText(OWNER,r.id,'Revised human-reviewed text');
  assert.equal((await f.app().handle(m(22,confirm))).status,'DENIED');
  assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
 }finally{await f.close();}
});
test('B3 group revoke and reapprove invalidate old archive confirmation under a new policy revision',async()=>{
 const f=await fixture();try{
  const r=await f.publish(),opened=await f.app().handle(m(30,'📚 المورد · '+r.id));
  const preview=await f.app().handle(m(31,keys(opened).find(x=>x.startsWith('🗃️ معاينة الأرشفة · '))!));
  const confirm=keys(preview).find(x=>x.startsWith('⛔ تأكيد الأرشفة · '))!;
  await f.policy.revokeChat(OWNER,GROUP);
  assert.equal((await f.app().handle(m(32,confirm))).status,'DENIED');
  await f.policy.approveChat(OWNER,GROUP,['navigation','publishing']);
  assert.equal((await f.app().handle(m(33,confirm))).status,'DENIED');
  assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
 }finally{await f.close();}
});
test('B3 current archived or revoked-scope items never surface in owner listing',async()=>{
 const f=await fixture();try{
  const r=await f.publish();
  await f.policy.revokeChat(OWNER,GROUP);
  const list=await f.app().handle(m(40,ownerMenuLabels.library));
  assert.equal(list.status,'APPLIED');assert.ok(!keys(list).includes('📚 المورد · '+r.id));
  assert.equal((await f.app().handle(m(41,'📚 المورد · '+r.id))).status,'DENIED');
  await f.policy.approveChat(OWNER,GROUP,['navigation','publishing']);
  await f.education.archiveResource(OWNER,r.id);
  const list2=await f.app().handle(m(42,ownerMenuLabels.library));
  assert.equal(keys(list2).includes('📚 المورد · '+r.id),false);
 }finally{await f.close();}
});
test('B3 owner library lists 13 resources in stable 10-item pages with no repeated items',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{
   for(let i=0;i<13;i++)s.educationResources.push({
    id:randomUUID(),categoryId:'scholarships',scope:GROUP,title:'Item '+String(i).padStart(2,'0'),
    university:'Uni',cycle:'2026',degree:'Bachelor',seats:1,
    sourceImportId:randomUUID(),sourceLocator:'row:'+i,reviewedBy:OWNER,status:'PUBLISHED'
   });
  });
  const first=await f.app().handle(m(50,ownerMenuLabels.library));
  assert.match(first.plan?.text??'',/صفحة 1 من 2/);
  assert.equal(keys(first).filter(x=>x.startsWith('📚 المورد · ')).length,10);
  assert.equal(isValidTelegramReplyKeyboard(first.plan?.replyMarkup),true);
  const next=keys(first).find(x=>x==='➡️ التالي · o:l:1')!;
  assert.ok(next);
  const second=await f.app().handle(m(51,next));
  assert.match(second.plan?.text??'',/صفحة 2 من 2/);
  assert.equal(keys(second).filter(x=>x.startsWith('📚 المورد · ')).length,3);
  assert.equal(isValidTelegramReplyKeyboard(second.plan?.replyMarkup),true);
  const prev=await f.app().handle(m(52,'⬅️ السابق · o:l:0'));
  assert.equal(prev.status,'APPLIED');
  for(const [i,cmd] of ['➡️ التالي · o:l:0','⬅️ السابق · o:l:1',
   '➡️ التالي · o:l:10','➡️ التالي · o:l:01','⬅️ السابق · o:l:-1'].entries())
   assert.equal((await f.app().handle(m(53+i,cmd))).status,'DENIED',cmd);
 }finally{await f.close();}
});
test('B3 owner-only library review/actions deny student, delegated staff and group context',async()=>{
 const f=await fixture();try{
  const r=await f.publish(),opened=await f.app().handle(m(70,'📚 المورد · '+r.id));
  const review=keys(opened).find(x=>x.startsWith('🗃️ معاينة الأرشفة · '))!;
  const preview=await f.app().handle(m(71,review));
  const confirm=keys(preview).find(x=>x.startsWith('⛔ تأكيد الأرشفة · '))!;
  await f.policy.grant(OWNER,'200','content.publish',GROUP,Date.now()+300_000);
  for(const [i,cmd] of [ownerMenuLabels.library,'📚 المورد · '+r.id,review,confirm,'➡️ التالي · o:l:1'].entries()){
   for(const actor of [200,300]){
    const denied=await f.app().handle(m(100+i*10+actor,cmd,actor));
    assert.equal(denied.status,'DENIED',cmd);assert.equal(denied.plan,undefined);
   }
  }
  assert.equal((await f.app().handle(m(200,confirm,100,true))).plan,undefined);
  assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
 }finally{await f.close();}
});
test('B3 archive state mutation requires configured owner and exact current fingerprint and policy revision',async()=>{
 const f=await fixture();try{
  const r=await f.publish();
  const token=resourceArchiveFingerprint(r);
  const version=(await f.store.snapshot()).chats.find(c=>c.id===GROUP)!.version;
  await assert.rejects(f.education.archiveResourceIfCurrent('200',r.id,token,version),/OWNER_ONLY/);
  await assert.rejects(f.education.archiveResourceIfCurrent(OWNER,r.id,'~0000000000000000',version),/RESOURCE_ARCHIVE_STALE/);
  await assert.rejects(f.education.archiveResourceIfCurrent(OWNER,r.id,token,version+1),/RESOURCE_ARCHIVE_STALE/);
  assert.equal((await f.store.snapshot()).educationResources[0]!.status,'PUBLISHED');
 }finally{await f.close();}
});
test('B3 archive command parser accepts only canonical current button shapes',async()=>{
 const id='123e4567-e89b-12d3-a456-426614174000',h='~0123456789abcdef';
 assert.deepEqual(parseOwnerLibraryAction('📚 المورد · '+id),{kind:'detail',id});
 assert.deepEqual(parseOwnerLibraryAction('🗃️ معاينة الأرشفة · '+id+':'+h+':0'),{
  kind:'review',id,token:h,policyVersion:0
 });
 assert.deepEqual(parseOwnerLibraryAction('⛔ تأكيد الأرشفة · '+id+':'+h+':12'),{
  kind:'confirm',id,token:h,policyVersion:12
 });
 assert.deepEqual(parseOwnerLibraryPage('➡️ التالي · o:l:10'),{page:10,direction:'next'});
 for(const x of ['📚 المورد · ../../path','📚 المورد · '+id+'\n',
  '🗃️ معاينة الأرشفة · '+id+':'+h+':01',
  '⛔ تأكيد الأرشفة · '+id+':'+h+':-1',
  '⛔ تأكيد الأرشفة · '+id+':~wrong:1',
  '⛔ تأكيد الأرشفة · '+id+':'+h+':1 extra'])
  assert.equal(parseOwnerLibraryAction(x),null,x);
 for(const x of ['➡️ التالي · o:l:01','⬅️ السابق · o:l:1000',
  '➡️ التالي · o:l:-1','➡️ التالي · o:l:1 extra'])
  assert.equal(parseOwnerLibraryPage(x),null,x);
});
