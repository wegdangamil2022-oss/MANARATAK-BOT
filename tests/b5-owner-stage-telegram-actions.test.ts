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
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {menuLabels,isValidTelegramReplyKeyboard} from '../src/telegram-menu.js';
import {ownerMenuLabels} from '../src/telegram-owner-menu.js';
import {PlatformCatalogPreviewService} from '../src/platform-catalog-preview.js';

const OWNER=100,STUDENT=300;
const msg=(n:number,who:number,text:string,group=false)=>({
 update_id:n,message:{message_id:n,from:{id:who,is_bot:false},
 chat:{id:group?-100888:who,type:group?'supergroup':'private'},text}
});
const kb=(r:Awaited<ReturnType<TelegramUpdateApplication['handle']>>)=>
 r.plan?.replyMarkup?.keyboard.flat().map(b=>b.text)??[];
const rec=(id:string,version=1)=>({
 id,revision:version,scope:'private',publication:'PUBLISHED',
 title:'منحة صينية '+id,university:'جامعة',cycle:'2027',degree:'Bachelor'
});
const page=(rows:unknown[],nextCursor:string|null)=>({
 schema:'manaratak-readonly-catalog-v1',records:rows,nextCursor
});
async function setup(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-owner-stage-b5-'));
 const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
 const policy=new Policy(store,String(OWNER)),education=new EducationService(store,policy);
 const admin=new EducationAdminFacade(store,policy,education);
 const faq=new ApprovedAnswerService(store,policy),links=new ResourceLinkService(store,policy);
 const reads:{scope:string;limit:number;cursor:string|null}[]=[];
 let version=1;
 const reader={fetchPage:async(q:{scope:'private';limit:number;cursor:string|null})=>{
  reads.push(q);
  return q.cursor===null?page([rec('first',version)],'cursorNEXT'):
   page([rec('second',version)],null);
 }};
 const platform=new PlatformCatalogPreviewService(store,policy,reader);
 const app=()=>new TelegramUpdateApplication({store,policy,education,admin,faq,links,
  botId:'main',botUsername:'ManaratakBot',membership:async()=> 'UNKNOWN',platformCatalog:platform});
 return {store,platform,reads,app,setVersion:(v:number)=>version=v,
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test('B5 '+engine+': owner stages and reviews a current record using two separate safe Telegram buttons',async()=>{
  const f=await setup(engine);try{
   const first=await f.app().handle(msg(1,OWNER,ownerMenuLabels.platformCatalog));
   assert.equal(first.status,'APPLIED');
   const stage=kb(first).find(x=>x.startsWith('📥 تسجيل مرشح · first:'))!;
   assert.ok(stage);
   assert.equal(isValidTelegramReplyKeyboard(first.plan?.replyMarkup),true);
   const saved=await f.app().handle(msg(2,OWNER,stage));
   assert.equal(saved.status,'APPLIED');
   assert.match(saved.plan?.text??'',/سجل|حفظ/);
   const mark=kb(saved).find(x=>x.startsWith('✅ تدقيق بيانات · first:'))!;
   assert.ok(mark);
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'UNVERIFIED_EXTERNAL');
   const reviewed=await f.app().handle(msg(3,OWNER,mark));
   assert.equal(reviewed.status,'APPLIED');
   assert.match(reviewed.plan?.text??'',/مراجعة|تدقيق/);
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'REVIEWED_METADATA_ONLY');
   const state=await f.store.snapshot();
   assert.deepEqual(state.importRuns,[]);
   assert.deepEqual(state.educationResources,[]);
   assert.deepEqual(state.campaigns,[]);
   assert.deepEqual(state.deliveries,[]);
  }finally{await f.close();}
 });
 test('B5 '+engine+': owner can stage an external resource from second cursor page and recheck its exact page for review',async()=>{
  const f=await setup(engine);try{
   const first=await f.app().handle(msg(11,OWNER,ownerMenuLabels.platformCatalog));
   const next=kb(first).find(x=>x==='➡️ التالي · b5:cursorNEXT')!;
   assert.ok(next);
   const second=await f.app().handle(msg(12,OWNER,next));
   const stage=kb(second).find(x=>x.startsWith('📥 تسجيل مرشح · second:'))!;
   assert.ok(stage);
   const recorded=await f.app().handle(msg(13,OWNER,stage));
   assert.equal(recorded.status,'APPLIED');
   const queue=(await f.store.snapshot()).platformReviewQueue!;
   assert.equal(queue[0]?.sourceId,'second');
   assert.equal(queue[0]?.pageCursor,'cursorNEXT');
   const mark=kb(recorded).find(x=>x.startsWith('✅ تدقيق بيانات · second:'))!;
   const verified=await f.app().handle(msg(14,OWNER,mark));
   assert.equal(verified.status,'APPLIED');
   assert.ok(f.reads.some(x=>x.cursor==='cursorNEXT'));
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'REVIEWED_METADATA_ONLY');
  }finally{await f.close();}
 });
 test('B5 '+engine+': stale owner button after source revision update cannot stage or mark metadata reviewed',async()=>{
  const f=await setup(engine);try{
   const first=await f.app().handle(msg(21,OWNER,ownerMenuLabels.platformCatalog));
   const stage=kb(first).find(x=>x.startsWith('📥 تسجيل مرشح · first:'))!;
   f.setVersion(2);
   const old=await f.app().handle(msg(22,OWNER,stage));
   assert.equal(old.status,'DENIED');
   assert.deepEqual((await f.store.snapshot()).platformReviewQueue??[],[]);
   const current=await f.app().handle(msg(23,OWNER,ownerMenuLabels.platformCatalog));
   const newStage=kb(current).find(x=>x.startsWith('📥 تسجيل مرشح · first:'))!;
   const saved=await f.app().handle(msg(24,OWNER,newStage));
   assert.equal(saved.status,'APPLIED');
   const mark=kb(saved).find(x=>x.startsWith('✅ تدقيق بيانات · first:'))!;
   f.setVersion(3);
   const stale=await f.app().handle(msg(25,OWNER,mark));
   assert.equal(stale.status,'DENIED');
   assert.equal((await f.store.snapshot()).platformReviewQueue?.[0]?.status,'UNVERIFIED_EXTERNAL');
  }finally{await f.close();}
 });
 test('B5 '+engine+': student, group, and wrong cursor cannot stage external source from copied owner keys',async()=>{
  const f=await setup(engine);try{
   const preview=await f.app().handle(msg(31,OWNER,ownerMenuLabels.platformCatalog));
   const stage=kb(preview).find(x=>x.startsWith('📥 تسجيل مرشح · first:'))!;
   const invalid=[
    [32,STUDENT,stage,false],
    [33,OWNER,stage,true],
    [34,OWNER,stage.replace(':none:',':invalid:'),false],
    [35,OWNER,stage.slice(0,-1)+'X',false],
    [36,OWNER,'✅ تدقيق بيانات · first:'+('0'.repeat(64)),false]
   ] as const;
   for(const [n,who,button,group] of invalid){
    const r=await f.app().handle(msg(n,who,button,group));
    assert.equal(r.status,'DENIED',button);
    assert.equal(r.plan,undefined);
   }
   assert.equal((await f.store.snapshot()).platformReviewQueue?.length??0,0);
  }finally{await f.close();}
 });
}
test('B5 owner cannot save or review after owner.dashboard is switched off between showing and tapping button',async()=>{
 const f=await setup('sqlite');try{
  const preview=await f.app().handle(msg(41,OWNER,ownerMenuLabels.platformCatalog));
  const stage=kb(preview).find(x=>x.startsWith('📥 تسجيل مرشح · first:'))!;
  await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
  const blocked=await f.app().handle(msg(42,OWNER,stage));
  assert.equal(blocked.status,'DENIED');
  assert.equal(blocked.plan,undefined);
  assert.deepEqual((await f.store.snapshot()).platformReviewQueue??[],[]);
 }finally{await f.close();}
});
test('B5 stage source button cannot exceed Telegram reply-keyboard 256-byte label limit with maximum IDs/cursors',async()=>{
 const f=await setup('json');try{
  const result=await f.app().handle(msg(51,OWNER,ownerMenuLabels.platformCatalog));
  assert.equal(result.status,'APPLIED');
  for(const item of kb(result))assert.ok(Buffer.byteLength(item,'utf8')<=256);
 }finally{await f.close();}
});
