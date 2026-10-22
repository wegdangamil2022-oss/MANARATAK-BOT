import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {PlatformCatalogPreviewService} from '../src/platform-catalog-preview.js';
import {resourceArchiveFingerprint} from '../src/education-archive.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';

const OWNER='100',STUDENT='300';
const msg=(n:number,id:string,text:string,group=false)=>({
 update_id:n,message:{message_id:n,from:{id:Number(id),is_bot:false},
  chat:{id:group?-100999:Number(id),type:group?'supergroup':'private'},text}
});
const buttons=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'b5-local-archive-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'bot.sqlite':'bot.json'),{engine});
 const policy=new Policy(store,OWNER),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await education.createCategory(OWNER,{id:'grants',scope:'private',title:'المنح',order:0});
 let available=true,revision=1,calls=0;
 const catalog=new PlatformCatalogPreviewService(store,policy,{fetchPage:async()=>{
  calls++;if(!available)throw Error('offline');
  return {schema:'manaratak-readonly-catalog-v1',records:[{
   id:'grant-2027',revision,scope:'private',publication:'PUBLISHED',
   title:'منحة الصين',university:'جامعة الصين',cycle:'2027',degree:'Bachelor'
  }],nextCursor:null};
 }});
 const application=()=>new TelegramUpdateApplication({
  store,policy,education,admin,faq,links,membership:async()=> 'UNKNOWN',
  botId:'main',botUsername:'ManaratakBot',platformCatalog:catalog
 });
 const create=async()=>{
  const preview=await catalog.preview(OWNER);if(preview.status!=='PREVIEW')throw Error('p');
  const staged=await catalog.stage(OWNER,'grant-2027',preview.fingerprint);
  if(staged.status!=='STAGED')throw Error('staged');
  if((await catalog.review(OWNER,'grant-2027',staged.entry.digest)).status!=='REVIEWED')throw Error('review');
  if((await catalog.approveForLocal(OWNER,'grant-2027',staged.entry.digest,'grants')).status!=='APPROVED')throw Error('approve');
  const pub=await catalog.publishLocally(OWNER,'grant-2027',staged.entry.digest,'grants');
  if(pub.status!=='PUBLISHED')throw Error('publish');
  return {digest:staged.entry.digest,resource:pub.resource,proof:resourceArchiveFingerprint(pub.resource)};
 };
 return {store,policy,catalog,application,education,create,
  offline:()=>{available=false;},change:()=>{revision=2;},calls:()=>calls,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': only a second explicit owner archival action hides one local source resource',async()=>{
  const f=await setup(engine);try{
   const {digest,resource,proof}=await f.create();
   assert.equal((await f.education.listResources(STUDENT,'private','grants')).length,1);
   const result=await f.catalog.archiveLocal(OWNER,'grant-2027',digest,proof);
   assert.equal(result.status,'ARCHIVED');
   if(result.status==='ARCHIVED')assert.equal(result.resourceId,resource.id);
   assert.deepEqual(await f.education.listResources(STUDENT,'private','grants'),[]);
   assert.equal((await f.catalog.inspectPublished(OWNER,'grant-2027',digest)).status,'LOCAL_ARCHIVED');
   const state=await f.store.snapshot();
   assert.equal(state.platformReviewQueue?.[0]?.status,'PUBLISHED_LOCALLY');
   assert.deepEqual(state.campaigns,[]);
   assert.deepEqual(state.deliveries,[]);
   assert.equal((await f.catalog.archiveLocal(OWNER,'grant-2027',digest,proof)).status,'STALE');
  }finally{await f.close();}
 });
 test('B5 '+engine+': source network unavailable or source revision changed cannot trigger archive automatically and does not prevent explicit local archival',async()=>{
  const f=await setup(engine);try{
   const {digest,proof}=await f.create();f.offline();
   assert.equal((await f.catalog.inspectPublished(OWNER,'grant-2027',digest)).status,'UNAVAILABLE');
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
   const calls=f.calls();
   assert.equal((await f.catalog.archiveLocal(OWNER,'grant-2027',digest,proof)).status,'ARCHIVED');
   assert.equal(f.calls(),calls);
  }finally{await f.close();}
 });
 test('B5 '+engine+': forgery, wrong source, wrong digest and stale resource proof never archives a resource',async()=>{
  const f=await setup(engine);try{
   const {digest,resource,proof}=await f.create();
   for(const [sid,d,p] of [
    ['../../untrusted',digest,proof],
    ['another-grant',digest,proof],
    ['grant-2027','0'.repeat(64),proof],
    ['grant-2027',digest,'~0000000000000000'],
    ['grant-2027',digest,'invalid']
   ] as const)assert.notEqual((await f.catalog.archiveLocal(OWNER,sid,d,p)).status,'ARCHIVED');
   await f.store.transaction(s=>{s.educationResources.find(r=>r.id===resource.id)!.publicationText='New reviewed copy';});
   assert.equal((await f.catalog.archiveLocal(OWNER,'grant-2027',digest,proof)).status,'STALE');
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
  }finally{await f.close();}
 });
 test('B5 '+engine+': nonowner and disabled dashboard deny archive without changing records',async()=>{
  const f=await setup(engine);try{
   const {digest,proof}=await f.create();
   assert.equal((await f.catalog.archiveLocal(STUDENT,'grant-2027',digest,proof)).status,'DENIED');
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   assert.equal((await f.catalog.archiveLocal(OWNER,'grant-2027',digest,proof)).status,'DENIED');
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
  }finally{await f.close();}
 });
 test('B5 '+engine+': concurrent archive clicks produce one archival transition, never duplicate audit effects',async()=>{
  const f=await setup(engine);try{
   const {digest,proof}=await f.create();
   const [a,b]=await Promise.all([
    f.catalog.archiveLocal(OWNER,'grant-2027',digest,proof),
    f.catalog.archiveLocal(OWNER,'grant-2027',digest,proof)
   ]);
   assert.equal([a.status,b.status].filter(x=>x==='ARCHIVED').length,1);
   assert.equal([a.status,b.status].filter(x=>x==='STALE').length,1);
   assert.equal((await f.store.snapshot()).audit.filter(x=>x.reason==='B5_EXTERNAL_RESOURCE_ARCHIVED_LOCALLY').length,1);
  }finally{await f.close();}
 });
 test('B5 '+engine+': Telegram owner opens archived-source preview and independently confirms archival; student copy is denied',async()=>{
  const f=await setup(engine);try{
   await f.create();
   const list=await f.application().handle(msg(10,OWNER,ownerMenuLabels.platformIntegrity));
   const select=buttons(list).find(x=>x.startsWith('🔬 فحص مصدر · '))!;
   const checked=await f.application().handle(msg(11,OWNER,select));
   assert.equal(checked.status,'APPLIED');
   const preview=buttons(checked).find(x=>x.startsWith('🗂️ معاينة أرشفة · '))!;
   assert.ok(preview);
   assert.equal((await f.application().handle(msg(12,STUDENT,preview))).status,'DENIED');
   const confirm=await f.application().handle(msg(13,OWNER,preview));
   assert.equal(confirm.status,'APPLIED');
   assert.match(confirm.plan?.text??'',/لا يثبت|لا يعني|لا تعني/);
   const archive=buttons(confirm).find(x=>x.startsWith('✅ تأكيد أرشفة محلية · '))!;
   assert.ok(archive);
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
   const completed=await f.application().handle(msg(14,OWNER,archive));
   assert.equal(completed.status,'APPLIED');
   assert.match(completed.plan?.text??'',/مؤرشف|الأرشفة/);
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'ARCHIVED');
   assert.equal((await f.application().handle(msg(15,OWNER,archive))).status,'DENIED');
  }finally{await f.close();}
 });
 test('B5 '+engine+': source-check failure still offers manual local archive without claiming that the grant is closed',async()=>{
  const f=await setup(engine);try{
   await f.create();f.offline();
   const list=await f.application().handle(msg(20,OWNER,ownerMenuLabels.platformIntegrity));
   const select=buttons(list).find(x=>x.startsWith('🔬 فحص مصدر · '))!;
   const report=await f.application().handle(msg(21,OWNER,select));
   assert.match(report.plan?.text??'',/تعذر/);
   assert.ok(buttons(report).some(x=>x.startsWith('🗂️ معاينة أرشفة · ')));
   assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
  }finally{await f.close();}
 });
}
