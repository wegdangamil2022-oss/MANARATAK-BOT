import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ButtonStudioService} from '../src/button-studio.js';
import {validStudioState,studioURL,defaultStudioSettings} from '../src/button-studio-model.js';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'studio-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=1700000000000;const policy=new Policy(store,'100',()=>now),svc=()=>new ButtonStudioService(store,policy,()=>now);return {store,svc,setTime:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};}
 test('adding, copying and deleting buttons preserve unaffected row layouts ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc().create('100','قالب');
   for(let i=0;i<5;i++)t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر '+i});
   t=await f.svc().edit('100',t.id,t.revision,{kind:'LAYOUT',value:'2-3'});
   t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'إضافي'});
   assert.deepEqual(t.draft.layout,[2,3,1]);
   t=await f.svc().edit('100',t.id,t.revision,{kind:'COPY_BUTTON',buttonId:t.draft.buttons[0]!.id});
   assert.deepEqual(t.draft.layout,[2,3,1,1]);
   const deleted=t.draft.buttons[2]!.id;
   const ref=await f.svc().issueDecision('100',t.id,t.revision,'DELETE_BUTTON',deleted);
   t=(await f.svc().confirmDecision('100',ref))!;
   assert.deepEqual(t.draft.layout,[2,2,1,1]);assert.equal(t.draft.buttons.some(b=>b.id===deleted),false);
   t=await f.svc().edit('100',t.id,t.revision,{kind:'DELETE_BUTTON',buttonId:t.draft.buttons[4]!.id});
   assert.deepEqual(t.draft.layout,[2,2,1]);
  }finally{await f.close();}
 });
 test('studio settings enforce stale revision, density, defaults, color and configured expiry ('+engine+')',async()=>{
  const f=await fixture();try{
   let config=await f.svc().settings('100');assert.equal(config.revision,1);
   await assert.rejects(f.svc().configure('300',1,'buttonLimit',8));
   config=await f.svc().configure('100',1,'colorsByFunction',true);
   await assert.rejects(f.svc().configure('100',1,'buttonLimit',8));
   config=await f.svc().configure('100',config.revision,'buttonLimit',1);
   config=await f.svc().configure('100',config.revision,'rowsPerPage',2);
   config=await f.svc().configure('100',config.revision,'inputSeconds',60);
   config=await f.svc().configure('100',config.revision,'confirmationSeconds',30);
   let t=await f.svc().create('100','أصل');assert.equal(t.draft.rowsPerPage,2);
   t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر'});assert.equal(t.draft.buttons[0]!.style,'success');
   await assert.rejects(f.svc().edit('100',t.id,t.revision,{kind:'COPY_BUTTON',buttonId:t.draft.buttons[0]!.id}));
   config=await f.svc().configure('100',config.revision,'defaultTemplateId',t.id);
   const copy=await f.svc().create('100','قالب جديد');assert.equal(copy.draft.buttons.length,1);assert.notEqual(copy.draft.buttons[0]!.id,t.draft.buttons[0]!.id);assert.deepEqual(copy.versions,[]);
   await f.svc().beginInput('100',t.id,t.revision,'TEXT');f.setTime(1700000060000);await assert.rejects(f.svc().acceptInput('100','منتهي'));
   f.setTime(1700000000000);const ref=await f.svc().issueDecision('100',t.id,t.revision,'DELETE_BUTTON',t.draft.buttons[0]!.id);f.setTime(1700000030000);assert.equal(await f.svc().confirmDecision('100',ref),null);
   assert.ok(validStudioState((await f.store.snapshot()).buttonStudio));
   await assert.rejects(f.svc().configure('100',config.revision,'inputSeconds',1));
  }finally{await f.close();}
 });
 test('studio persists drafts and rejects stale or unauthorized edits ('+engine+')',async()=>{
  const f=await fixture();try{
   const t=await f.svc().create('100','قالب المنح');assert.equal(t.revision,1);
   await assert.rejects(f.svc().create('300','دخيل'));
   const changed=await f.svc().edit('100',t.id,1,{kind:'TEXT',value:'أهلًا {العضو}'});assert.equal(changed.revision,2);
   await assert.rejects(f.svc().edit('100',t.id,1,{kind:'TEXT',value:'قديم'}));
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});
   await assert.rejects(f.svc().edit('100',t.id,2,{kind:'TEXT',value:'محجوب'}));
   assert.equal((await f.store.snapshot()).buttonStudio!.templates[0]!.draft.text,'أهلًا {العضو}');assert.equal((await f.store.snapshot()).deliveries.length,0);
  }finally{await f.close();}
 });
 test('studio duplicates drafts with independent identities and no copied approvals ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc().create('100','قالب');t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر'});t=await f.svc().save('100',t.id,t.revision);
   const copy=await f.svc().duplicate('100',t.id,t.revision);assert.notEqual(copy.id,t.id);assert.notEqual(copy.draft.buttons[0]!.id,t.draft.buttons[0]!.id);assert.deepEqual(copy.versions,[]);assert.equal(copy.revision,1);
   await f.svc().edit('100',copy.id,1,{kind:'TEXT',value:'نسخة مستقلة'});assert.deepEqual((await f.svc().list('100')).find(x=>x.id===t.id),t);
   await assert.rejects(f.svc().duplicate('300',t.id,t.revision));await assert.rejects(f.svc().duplicate('100',t.id,t.revision-1));
  }finally{await f.close();}
 });
 test('studio validates actions, layouts and safe variables with durable version restore ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc().create('100','قالب');
   for(let i=0;i<3;i++)t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر '+i});
   t=await f.svc().edit('100',t.id,t.revision,{kind:'LAYOUT',value:'1-2'});assert.deepEqual(t.draft.layout,[1,2]);
   await assert.rejects(f.svc().edit('100',t.id,t.revision,{kind:'LAYOUT',value:'3-2'}));
   await assert.rejects(f.svc().edit('100',t.id,t.revision,{kind:'TEXT',value:'{process.env.TOKEN}'}));
   const button=t.draft.buttons[0]!.id;
   await assert.rejects(f.svc().edit('100',t.id,t.revision,{kind:'ACTION',buttonId:button,action:{kind:'URL',target:'http://127.0.0.1/'}}));
   t=await f.svc().edit('100',t.id,t.revision,{kind:'ACTION',buttonId:button,action:{kind:'URL',target:'https://t.me/ManaratakEduBot'}});
   t=await f.svc().save('100',t.id,t.revision);const saved=t.versions.at(-1)!;
   const before=t.draft.text;t=await f.svc().edit('100',t.id,t.revision,{kind:'TEXT',value:'نسخة جديدة'});
   t=await f.svc().restore('100',t.id,t.revision,saved.revision);assert.equal(t.draft.text,before);assert.equal(t.versions.at(-1)!.content.text,before);
   assert.ok(validStudioState((await f.store.snapshot()).buttonStudio));
   const audit=(await f.store.snapshot()).audit;assert.ok(audit.some(a=>a.reason==='STUDIO_VERSION_RESTORED'));
  }finally{await f.close();}
 });
 test('studio confirms destructive decisions once and rechecks draft and dashboard ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc().create('100','قالب');t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر'});const b=t.draft.buttons[0]!.id;
   const ref=await f.svc().issueDecision('100',t.id,t.revision,'DELETE_BUTTON',b);
   const results=await Promise.all([f.svc().confirmDecision('100',ref),f.svc().confirmDecision('100',ref)]);assert.equal(results.filter(Boolean).length,1);
   t=(await f.store.snapshot()).buttonStudio!.templates[0]!;assert.equal(t.draft.buttons.length,0);
   t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'جديد'});const next=await f.svc().issueDecision('100',t.id,t.revision,'DELETE_BUTTON',t.draft.buttons[0]!.id);
   await f.svc().edit('100',t.id,t.revision,{kind:'NAME',value:'تغيير'});await assert.rejects(f.svc().confirmDecision('100',next));
   t=(await f.store.snapshot()).buttonStudio!.templates[0]!;const disabled=await f.svc().issueDecision('100',t.id,t.revision,'DELETE_BUTTON',t.draft.buttons[0]!.id);
   await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});await assert.rejects(f.svc().confirmDecision('100',disabled));assert.equal((await f.store.snapshot()).buttonStudio!.templates[0]!.draft.buttons.length,1);
  }finally{await f.close();}
 });
 test('studio preview time and seat conditions are checked atomically on every press ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc().create('100','قالب');t=await f.svc().edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'مقعد'});const b=t.draft.buttons[0]!.id;
   t=await f.svc().edit('100',t.id,t.revision,{kind:'CONDITION',buttonId:b,condition:{role:'ANY',opensAt:1700000001000,closesAt:1700000003000,seats:1}});
   await assert.rejects(f.svc().pressPreview('100',t.id,t.revision,b));f.setTime(1700000001000);
   await Promise.all([f.svc().pressPreview('100',t.id,t.revision,b),f.svc().pressPreview('100',t.id,t.revision,b)]);
   assert.equal((await f.store.snapshot()).callbacks.filter(c=>c.action.startsWith('studio.seat:')).length,1);
   const other=new ButtonStudioService(f.store,new Policy(f.store,'300'),()=>1700000001000);await assert.rejects(other.pressPreview('300',t.id,t.revision,b));
   f.setTime(1700000003000);await assert.rejects(f.svc().pressPreview('100',t.id,t.revision,b));
  }finally{await f.close();}
 });
 test('studio text input is owner bound, expires and cannot edit a changed draft ('+engine+')',async()=>{
  const f=await fixture();try{
   let t=await f.svc().create('100','قالب');await f.svc().beginInput('100',t.id,t.revision,'TEXT');
   assert.equal(await f.svc().acceptInput('300','نص مزور'),null);
   t=await f.svc().edit('100',t.id,t.revision,{kind:'NAME',value:'عنوان جديد'});
   await assert.rejects(f.svc().acceptInput('100','نص قديم'));
   await f.svc().beginInput('100',t.id,t.revision,'TEXT');f.setTime(1700000600000);
   await assert.rejects(f.svc().acceptInput('100','منتهي'));
   f.setTime(1700000000000);await f.svc().beginInput('100',t.id,t.revision,'TEXT');
   const result=await f.svc().acceptInput('100','نص محفوظ');assert.equal(result!.draft.text,'نص محفوظ');
   assert.equal((await f.store.snapshot()).buttonStudio!.inputs.length,0);
  }finally{await f.close();}
 });
}
test('studio refuses unsafe public URLs and malformed restored optional state',async()=>{
 for(const url of ['javascript:alert(1)','https://127.0.0.1/','https://[::1]/','https://user:pass@t.me/','https://bit.ly/x','https://localhost/','https://abc.local/'])assert.equal(studioURL(url),null,url);
 assert.equal(validStudioState({templates:[],inputs:[],extra:true}),false);
 assert.equal(validStudioState({templates:[],inputs:[],settings:defaultStudioSettings()}),true);
 for(const settings of [undefined,null,{...defaultStudioSettings(),colorsByFunction:1},{...defaultStudioSettings(),inputSeconds:'60'},{...defaultStudioSettings(),defaultTemplateId:'abcdef123456'},{...defaultStudioSettings(),confirmationSeconds:121},{...defaultStudioSettings(),extra:true}])assert.equal(validStudioState({templates:[],inputs:[],settings}),false);
 const dir=await mkdtemp(join(tmpdir(),'studio-schema-'));try{
  const file=join(dir,'state.json'),s=new BotStore(file);await s.transaction(()=>{});
  const value=JSON.parse(await readFile(file,'utf8'));value.buttonStudio={templates:'bad',inputs:[]};await writeFile(file,JSON.stringify(value));await assert.rejects(s.snapshot());
 }finally{await rm(dir,{recursive:true,force:true});}
});
