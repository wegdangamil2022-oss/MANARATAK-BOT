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
import {ButtonStudioService} from '../src/button-studio.js';
import {validOwnerPreviewCancelRoute,ownerPreviewCancelData} from '../src/telegram-owner-preview-cancel.js';
const NOW=1700000000000;
const cb=(id:number,data:string,actor=100,group=false)=>({update_id:id,callback_query:{id:'cancel_'+id,from:{id:actor,is_bot:false},data,message:{message_id:77,from:{id:999,is_bot:true},chat:{id:group?-100123:actor,type:group?'supergroup':'private'}}}});
type Result=Awaited<ReturnType<TelegramUpdateApplication['handle']>>;
const choose=(r:Result,label:string)=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(b,'missing '+label);return b.callback_data;};
test('owner cancellation routes reject malformed and oversized references',()=>{
 assert.equal(validOwnerPreviewCancelRoute('oc:1:k:'+'A'.repeat(24)),true);
 for(const value of ['oc:1:k:short','oc:1:k:'+'A'.repeat(25),'oc:1:k:'+'A'.repeat(24)+'\n','oc:2:k:'+'A'.repeat(24)])assert.equal(validOwnerPreviewCancelRoute(value),false);
 assert.throws(()=>ownerPreviewCancelData('not-a-ref'));
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'owner-cancel-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),botId:'cancel-test',botUsername:'ManaratakBot',clock:()=>now,membership:async()=>{throw Error('network disabled');}});
  return {store,app,svc:new ButtonStudioService(store,policy,()=>now),time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' owner cancellation revokes one pending preview in each supported family',async()=>{
  const f=await fixture();try{
   const actions=['studio.RESTORE:','studio.DELETE_BUTTON:','delegation.confirm:','category.write:','owner.faq.APPROVED:','owner.faq.ARCHIVED:','owner.library.archive:'];let seq=1;
   for(const [i,action] of actions.entries()){
    const ref='c_'+String(i).padStart(24,'A'),sibling='c_'+String(i).padStart(24,'B');
    await f.store.transaction(s=>{s.callbacks.push(...[ref,sibling].map(ref=>({ref,action:action+'local-preview',actorId:'100',chatId:action.startsWith('owner.faq')?'-100123':'private',policyVersion:0,oneShot:true,used:false,revoked:false,expiresAt:NOW+120000})));});
    const data=ownerPreviewCancelData(ref);
    assert.equal((await f.app.handle(cb(seq++,data,300))).status,'DENIED');assert.equal((await f.app.handle(cb(seq++,data,100,true))).status,'DENIED');
    assert.equal((await f.app.handle(cb(seq++,data))).status,'APPLIED');assert.equal((await f.app.handle(cb(seq++,data))).status,'DENIED');
    const state=await f.store.snapshot();assert.equal(state.callbacks.find(c=>c.ref===ref)!.revoked,true);assert.equal(state.callbacks.find(c=>c.ref===sibling)!.revoked,false);
   }
   assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='OWNER_PREVIEW_CANCELLED').length,actions.length);
  }finally{await f.close();}
 });
 test(engine+' cancelling studio deletion or restoration prevents its old confirmation',async()=>{
  const f=await fixture();try{
   let t=await f.svc.create('100','قالب');t=await f.svc.edit('100',t.id,t.revision,{kind:'ADD_BUTTON',value:'زر'});t=await f.svc.save('100',t.id,t.revision);
   const deletion=await f.app.handle(cb(1,'st:1:x:'+t.id+':'+t.revision+':'+t.draft.buttons[0]!.id)),del=choose(deletion,'تأكيد');
   assert.equal((await f.app.handle(cb(2,choose(deletion,'إلغاء')))).status,'APPLIED');assert.equal((await f.app.handle(cb(3,del))).status,'DENIED');
   t=await f.svc.edit('100',t.id,t.revision,{kind:'TEXT',value:'نص جديد'});
   const restore=await f.app.handle(cb(4,'st:1:r:'+t.id+':'+t.revision+':'+t.versions[0]!.revision)),confirm=choose(restore,'تأكيد');
   assert.equal((await f.app.handle(cb(5,choose(restore,'إلغاء')))).status,'APPLIED');assert.equal((await f.app.handle(cb(6,confirm))).status,'DENIED');
   const saved=(await f.svc.list('100'))[0]!;assert.equal(saved.draft.text,'نص جديد');assert.equal(saved.draft.buttons.length,1);assert.equal(saved.versions.length,1);
  }finally{await f.close();}
 });
 test(engine+' cancellation denies expiry, consumed tokens, unknown families and duplicate references',async()=>{
  const f=await fixture();try{
   const refs=['A','B','C','D'].map(x=>'c_'+x.repeat(24));
   await f.store.transaction(s=>{for(const [i,ref] of refs.entries())s.callbacks.push({ref,action:i===2?'unrelated.preview:':'studio.RESTORE:preview',actorId:'100',chatId:'private',policyVersion:0,oneShot:true,used:i===1,revoked:false,expiresAt:i===0?NOW:NOW+120000});s.callbacks.push({...s.callbacks.find(c=>c.ref===refs[3])!});});
   for(const [i,ref] of refs.entries())assert.equal((await f.app.handle(cb(i+1,ownerPreviewCancelData(ref)))).status,'DENIED');
   assert.equal((await f.store.snapshot()).callbacks.some(c=>c.revoked),false);
  }finally{await f.close();}
 });
}
