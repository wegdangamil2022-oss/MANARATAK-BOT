import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {PlatformCatalogPreviewService} from '../src/platform-catalog-preview.js';
import {isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';

const OWNER=100,STUDENT=300;
const message=(n:number,actor:number,label:string,group=false)=>({
 update_id:n,message:{message_id:n,from:{id:actor,is_bot:false},
  chat:{id:group?-100888:actor,type:group?'supergroup':'private'},text:label}
});
const keys=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(x=>x.text)??[];
type Mode='CURRENT'|'CHANGED'|'EMPTY'|'DOWN';
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'b5-telegram-source-integrity-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'store.sqlite':'store.json'),{engine});
 const policy=new Policy(store,String(OWNER)),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 await education.createCategory(String(OWNER),{id:'grants',scope:'private',title:'منح',order:0});
 let mode:Mode='CURRENT',calls=0;
 const platform=new PlatformCatalogPreviewService(store,policy,{fetchPage:async()=>{
  calls++;
  if(mode==='DOWN')throw Error('source-offline');
  return {schema:'manaratak-readonly-catalog-v1',records:mode==='EMPTY'?[]:[{
   id:'external-2027',revision:mode==='CHANGED'?2:1,
   scope:'private',publication:'PUBLISHED',title:mode==='CHANGED'?'عنوان معدل':'منحة أصلية',
   university:'جامعة',cycle:'2027',degree:'Bachelor'
  }],nextCursor:null};
 }});
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  membership:async()=> 'UNKNOWN',botId:'main',botUsername:'ManaratakBot',platformCatalog:platform});
 const publish=async()=>{
  const p=await platform.preview(String(OWNER));
  if(p.status!=='PREVIEW')throw Error('preview');
  const staged=await platform.stage(String(OWNER),'external-2027',p.fingerprint);
  if(staged.status!=='STAGED')throw Error('staged');
  if((await platform.review(String(OWNER),'external-2027',staged.entry.digest)).status!=='REVIEWED')throw Error('review');
  if((await platform.approveForLocal(String(OWNER),'external-2027',staged.entry.digest,'grants')).status!=='APPROVED')throw Error('approve');
  const pub=await platform.publishLocally(String(OWNER),'external-2027',staged.entry.digest,'grants');
  if(pub.status!=='PUBLISHED')throw Error('publish');
  return pub.resource;
 };
 return {store,app,publish,education,platform,setMode:(m:Mode)=>mode=m,
  calls:()=>calls,close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': published source integrity owner menu lists locally published B5 records without querying upstream',async()=>{
  const f=await setup(engine);try{
   await f.publish();const prior=f.calls();
   const menu=await f.app().handle(message(1,OWNER,ownerMenuLabels.platformIntegrity));
   assert.equal(menu.status,'APPLIED');
   assert.match(menu.plan?.text??'',/المصادر الخارجية/);
   assert.ok(keys(menu).some(x=>x.startsWith('🔬 فحص مصدر · ')));
   assert.equal(f.calls(),prior);
   assert.equal(isValidTelegramReplyKeyboard(menu.plan?.replyMarkup),true);
  }finally{await f.close();}
 });
 test('B5 '+engine+': owner source integrity check reports match and never changes published resources',async()=>{
  const f=await setup(engine);try{
   await f.publish();
   const menu=await f.app().handle(message(10,OWNER,ownerMenuLabels.platformIntegrity));
   const check=keys(menu).find(x=>x.startsWith('🔬 فحص مصدر · '))!;
   const before=(await f.store.snapshot()).educationResources;
   const result=await f.app().handle(message(11,OWNER,check));
   assert.equal(result.status,'APPLIED');
   assert.match(result.plan?.text??'',/متطابق/);
   assert.deepEqual((await f.store.snapshot()).educationResources,before);
   assert.deepEqual((await f.store.snapshot()).campaigns,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': changed, vanished or unreachable source renders distinct advisory warnings without automatic archiving',async()=>{
  const f=await setup(engine);try{
   await f.publish();
   const menu=await f.app().handle(message(20,OWNER,ownerMenuLabels.platformIntegrity));
   const check=keys(menu).find(x=>x.startsWith('🔬 فحص مصدر · '))!;
   for(const [mode,needle,n] of [
    ['CHANGED',/تغيّر|تغير/,21],['EMPTY',/لا يظهر|غير موجود/,22],
    ['DOWN',/تعذر/,23]
   ] as const){
    f.setMode(mode);
    const result=await f.app().handle(message(n,OWNER,check));
    assert.equal(result.status,'APPLIED',mode);
    assert.match(result.plan?.text??'',needle,mode);
    assert.equal((await f.store.snapshot()).educationResources[0]?.status,'PUBLISHED');
   }
  }finally{await f.close();}
 });
 test('B5 '+engine+': archived resource is visible as archived in owner check without a provider call',async()=>{
  const f=await setup(engine);try{
   const pub=await f.publish();
   const menu=await f.app().handle(message(31,OWNER,ownerMenuLabels.platformIntegrity));
   const check=keys(menu).find(x=>x.startsWith('🔬 فحص مصدر · '))!;
   await f.education.archiveResource(String(OWNER),pub.id);
   const calls=f.calls();
   const checked=await f.app().handle(message(32,OWNER,check));
   assert.equal(checked.status,'APPLIED');
   assert.match(checked.plan?.text??'',/مؤرشف/);
   assert.equal(f.calls(),calls);
  }finally{await f.close();}
 });
 test('B5 '+engine+': copied, invalid, stale source integrity check is never available to students or Telegram groups',async()=>{
  const f=await setup(engine);try{
   await f.publish();
   const menu=await f.app().handle(message(41,OWNER,ownerMenuLabels.platformIntegrity));
   const check=keys(menu).find(x=>x.startsWith('🔬 فحص مصدر · '))!;
   const calls=f.calls();
   for(const [n,actor,text,group] of [
    [42,STUDENT,check,false],[43,STUDENT,ownerMenuLabels.platformIntegrity,false],
    [44,OWNER,check,true],[45,OWNER,check.replace('external-2027','other'),false],
    [46,OWNER,'🔬 فحص مصدر · a:broken',false]
   ] as const){
    const result=await f.app().handle(message(n,actor,text,group));
    assert.equal(result.status,'DENIED');
   }
   assert.equal(f.calls(),calls);
  }finally{await f.close();}
 });
 test('B5 '+engine+': paginated B5 integrity inventory shows all verified local publications in bounded pages',async()=>{
  const f=await setup(engine);try{
   const original=await f.publish();
   await f.store.transaction(s=>{
    const q=s.platformReviewQueue![0]!;
    for(let i=0;i<11;i++){
     const resourceId=randomUUID(),sourceId='record-'+i;
     s.educationResources.push({...original,id:resourceId,sourceLocator:sourceId});
     s.platformReviewQueue!.push({...q,sourceId,publishedResourceId:resourceId});
    }
   });
   const first=await f.app().handle(message(60,OWNER,ownerMenuLabels.platformIntegrity));
   assert.equal(first.status,'APPLIED');
   assert.equal(keys(first).filter(x=>x.startsWith('🔬 فحص مصدر · ')).length,8);
   const next=keys(first).find(x=>x==='➡️ التالي · b5i:1')!;
   assert.ok(next);
   const second=await f.app().handle(message(61,OWNER,next));
   assert.equal(second.status,'APPLIED');
   assert.equal(keys(second).filter(x=>x.startsWith('🔬 فحص مصدر · ')).length,4);
   const prev=keys(second).find(x=>x==='⬅️ السابق · b5i:0')!;
   assert.equal((await f.app().handle(message(62,OWNER,prev))).status,'APPLIED');
   assert.equal((await f.app().handle(message(63,OWNER,'➡️ التالي · b5i:0')).status,'DENIED');
  }finally{await f.close();}
 });
}
test('B5 dashboard revocation suppresses owner source integrity inventory and no provider request is made',async()=>{
 const f=await setup('sqlite');try{
  await f.publish();const calls=f.calls();
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  assert.equal((await f.app().handle(message(80,OWNER,ownerMenuLabels.platformIntegrity))).status,'DENIED');
  assert.equal(f.calls(),calls);
 }finally{await f.close();}
});
