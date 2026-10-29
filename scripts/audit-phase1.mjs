import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ownerInlineSections,ownerInlineRender,isValidTelegramInlineKeyboard,ownerInlineLinkedReadOnly} from '../dist/src/telegram-inline-owner.js';
import {BotStore} from '../dist/src/store.js';
import {Policy} from '../dist/src/policy.js';
import {EducationService} from '../dist/src/education.js';
import {EducationAdminFacade} from '../dist/src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../dist/src/education-interactions.js';
import {TelegramUpdateApplication} from '../dist/src/telegram-transport.js';

// Explicit offline audit. No deployment, credentials, real groups or network.
const doc=await readFile(new URL('../docs/أزرار_منارتك.md',import.meta.url),'utf8');
const code=(n)=>String(n).padStart(2,'0');
const rows=[];
for(let s=0;s<ownerInlineSections.length;s++){
 const section=ownerInlineSections[s],key=code(s+1);
 // A simpler bounded slice avoids treating intermediate headings as sections.
 const start=doc.indexOf('### '+key+'. ');
 const next=s<15?doc.indexOf('### '+code(s+2)+'. ',start+1):doc.indexOf('## سجل الاعتمادات',start+1);
 assert.ok(start>=0&&next>start,'official section '+key);
 const official=doc.slice(start,next);
 assert.equal(official.split('\n')[0],'### '+key+'. '+section.title);
 const labels=[...official.matchAll(/^\| \d\d \| (.*?) \|/gm)].map(m=>m[1]);
 assert.deepEqual(section.items,labels,'official button names/order '+key);
 assert.equal(section.descriptions.length,labels.length);
 for(let p=0;p<Math.ceil(labels.length/8);p++){
  const page=ownerInlineRender('mi:1:s:'+key+':'+p);
  assert.ok(page&&isValidTelegramInlineKeyboard(page.keyboard));
  assert.equal(page.keyboard.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('mi:1:i:')).length,labels.slice(p*8,p*8+8).length);
 }
 for(let i=0;i<labels.length;i++){
  const route='mi:1:i:'+key+':'+code(i+1);
  const screen=ownerInlineRender(route);
  assert.ok(screen&&isValidTelegramInlineKeyboard(screen.keyboard),route);
  assert.ok(screen.keyboard.inline_keyboard.flat().some(b=>b.callback_data==='mi:1:s:'+key+':'+Math.floor(i/8)),route+' back');
  const special=new Set(['mi:1:i:03:01','mi:1:i:02:01','mi:1:i:02:15','mi:1:i:02:16','mi:1:i:02:13','mi:1:i:02:07']);
  rows.push({section:key,sectionTitle:section.title,button:code(i+1),label:labels[i],callback:route,
   status:ownerInlineLinkedReadOnly(route)!==null||special.has(route)?'LOCAL_VIEW':'DESIGN_ONLY'});
 }
}
assert.equal(rows.length,253);
let update=0,networkCalls=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{networkCalls++;throw Error('PHASE1_NETWORK_FORBIDDEN');};
const callbacks=(actor,data,group=false)=>({update_id:++update,callback_query:{id:'audit_'+update,from:{id:actor,is_bot:false},data,
 message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
const engines=[];
try{
 for(const engine of ['json','sqlite']){
  const dir=await mkdtemp(join(tmpdir(),'manaratak-phase1-'));
  try{
   const store=new BotStore(join(dir,'state.'+engine),{engine});
   const policy=new Policy(store,'100');
   const education=new EducationService(store,policy);
   const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education),
    faq:new ApprovedAnswerService(store,policy),links:new ResourceLinkService(store,policy),
    botId:'phase1-offline',botUsername:'ManaratakBot',membership:async()=>{networkCalls++;throw Error('PHASE1_MEMBERSHIP_FORBIDDEN');}});
   const initial=await store.snapshot();
   for(const row of rows){
    const ownerEvent=callbacks(100,row.callback);
    const owner=await app.handle(ownerEvent);
    assert.equal(owner.status,'APPLIED',engine+' '+row.callback);
    assert.equal(owner.plan?.editMessageId,55);
    assert.ok(isValidTelegramInlineKeyboard(owner.plan?.inlineMarkup),row.callback);
    assert.equal((await app.handle(ownerEvent)).status,'DUPLICATE');
    assert.equal((await app.handle(callbacks(300,row.callback))).status,'DENIED');
    assert.equal((await app.handle(callbacks(100,row.callback,true))).status,'DENIED');
   }
   const final=await store.snapshot();
   for(const key of Object.keys(initial))if(!['updates','audit','telegramReplyJobs'].includes(key))
    assert.deepEqual(final[key],initial[key],'navigation changed '+key);
   engines.push({engine,buttonsPassed:253,duplicateProtectionPassed:253,unauthorizedDenied:253,groupContextDenied:253,businessStateUnchanged:true});
  }finally{await rm(dir,{recursive:true,force:true});}
 }
}finally{globalThis.fetch=originalFetch;}
assert.equal(networkCalls,0);
const report={schemaVersion:1,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 sourceDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,
 officialPlan:'docs/MANARATAK_BOT_MASTER_v1.2.1_AR.md',officialButtons:'docs/أزرار_منارتك.md',
 scope:'LOCAL_PHASE1_INVENTORY_ONLY',liveTelegram:'NOT_TESTED_DEFERRED_BY_OWNER',networkCalls,
 ownerSections:16,ownerButtons:253,localViews:rows.filter(r=>r.status==='LOCAL_VIEW').length,
 designOnly:rows.filter(r=>r.status==='DESIGN_ONLY').length,engines,buttons:rows};
if(process.argv.includes('--write')){
 await writeFile(new URL('../docs/PHASE1_BUTTON_INVENTORY.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 const lines=['# جرد أزرار المرحلة الأولى','',
  'هذا جرد للنسخة المحلية: LOCAL_VIEW شاشة مرتبطة ببيانات محلية؛ DESIGN_ONLY مواصفة للعرض فقط. لا يثبت أي تصنيف تشغيل الوظيفة على Telegram.',
  '', '| القسم | الزر | الحالة المحلية | callback |','|---|---|---|---|',
  ...rows.map(r=>'| '+r.section+' — '+r.sectionTitle+' | '+r.button+' — '+r.label+' | '+r.status+' | `'+r.callback+'` |')];
 await writeFile(new URL('../docs/PHASE1_BUTTON_INVENTORY_AR.md',import.meta.url),lines.join('\n')+'\n');
}
console.log(JSON.stringify({...report,buttons:undefined},null,2));
