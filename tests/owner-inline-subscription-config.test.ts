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
import {SubscriptionGate,FakeMembershipGateway} from '../src/subscription.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {subscriptionConfigEpoch} from '../src/subscription-config-epoch.js';
const NOW=1700000000000,GROUP='-100100';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'subscription-ui-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,id=0;
  const policy=new Policy(store,'100',()=>now),education=new EducationService(store,policy,()=>now),membership=new FakeMembershipGateway();
  await policy.approveChat('100',GROUP,['navigation','verification']);for(let i=0;i<12;i++)await policy.approveChat('100',String(-100200-i),['verification']);
  const gate=new SubscriptionGate(store,policy,membership,new ModerationService(store,policy,new FakeModerationGateway()),()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),subscription:gate,clock:()=>now,botId:'subscription-ui',botUsername:'ManaratakBot',ownerMenuMode:'inline',membership:async()=>{throw Error('UNEXPECTED_NETWORK');}});
  const click=(data:string,actor=100,group=false)=>app.handle({update_id:++id,callback_query:{id:'subscription-'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?-100999:actor,type:group?'supergroup':'private'}}}});
  return {store,policy,membership,gate,click,time:(n:number)=>{now=n;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 type Result=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['click']>>;
 const choose=(r:Result,label:string)=>{const b=r.plan?.inlineMarkup?.inline_keyboard.flat().find(b=>b.text.startsWith(label));assert.ok(b,label+' '+r.reason);return b.callback_data;};
 test(engine+' subscription picker preserves selected channels across pages and separately confirms ANY rule',async()=>{
  const f=await fixture();try{
   let r=await f.click('mi:1:i:04:02');r=await f.click(choose(r,'👥 '+GROUP));assert.equal(r.plan!.editMessageId,55);r=await f.click(choose(r,'▫️ -100200'));r=await f.click(choose(r,'➡️ التالي'));r=await f.click(choose(r,'▫️ -100211'));r=await f.click(choose(r,'🔘 قناة واحدة'));r=await f.click(choose(r,'👁️ معاينة'));assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
   const confirm=choose(r,'✅ حفظ');r=await f.click(confirm);assert.ok(r.plan!.text.includes('حُفظ'));assert.equal((await f.click(confirm)).status,'DENIED');const rule=(await f.store.snapshot()).subscriptionRequirements[0]!;assert.equal(rule.mode,'ANY');assert.deepEqual([...rule.channelIds].sort(),['-100200','-100211']);
  }finally{await f.close();}
 });
 test(engine+' subscription config rejects unauthorized, expired, cancelled, unverifiable and stale confirmations',async()=>{
  const f=await fixture();try{
   let r=await f.click('mi:1:i:04:04'),route=choose(r,'👥 '+GROUP);assert.equal((await f.click(route,300)).status,'DENIED');assert.equal((await f.click(route,100,true)).status,'DENIED');f.time(NOW+120000);assert.equal((await f.click(route)).status,'DENIED');f.time(NOW);
   r=await f.click('mi:1:i:04:02');r=await f.click(choose(r,'👥 '+GROUP));r=await f.click(choose(r,'▫️ -100200'));r=await f.click(choose(r,'👁️ معاينة'));route=choose(r,'✅ حفظ');await f.click(choose(r,'↩️ إلغاء'));assert.equal((await f.click(route)).status,'DENIED');
   r=await f.click('mi:1:i:04:02');r=await f.click(choose(r,'👥 '+GROUP));r=await f.click(choose(r,'▫️ -100200'));r=await f.click(choose(r,'👁️ معاينة'));route=choose(r,'✅ حفظ');f.membership.verifiable=false;assert.equal((await f.click(route)).status,'DENIED');assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);f.membership.verifiable=true;
   r=await f.click('mi:1:i:04:02');r=await f.click(choose(r,'👥 '+GROUP));r=await f.click(choose(r,'▫️ -100200'));r=await f.click(choose(r,'👁️ معاينة'));route=choose(r,'✅ حفظ');await f.policy.revokeChat('100','-100200');assert.equal((await f.click(route)).status,'DENIED');assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
  }finally{await f.close();}
 });
 test(engine+' confirmation is fenced through asynchronous provider checks and queued subscription views are source-bound',async()=>{
  const f=await fixture();try{
   let r=await f.click('sc:1:h');const queued=r.deliveryKey!;r=await f.click(choose(r,'👥 '+GROUP));r=await f.click(choose(r,'▫️ -100200'));r=await f.click(choose(r,'👁️ معاينة'));const confirm=choose(r,'✅ حفظ');
   f.membership.canVerifyChannel=async()=>{await f.store.transaction(s=>{s.privateSettingsRevision=(s.privateSettingsRevision??0)+1;});return true;};assert.equal((await f.click(confirm)).status,'DENIED');assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
   let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);assert.equal((await dispatcher.dispatch(queued)).status,'FAILED_CONFIRMED');assert.equal(sent,0);
  }finally{await f.close();}
 });
 test(engine+' disabling an existing requirement is a separate confirmed local action and does not require provider calls',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{s.subscriptionRequirements.push({chatId:GROUP,channelIds:['-100200'],mode:'ALL',version:1});});f.membership.canVerifyChannel=async()=>{throw Error('SHOULD_NOT_CALL_PROVIDER');};
   let r=await f.click('sc:1:h');r=await f.click(choose(r,'👥 '+GROUP));r=await f.click(choose(r,'⏸️ معاينة تعطيل'));assert.equal((await f.store.snapshot()).subscriptionRequirements[0]!.channelIds.length,1);r=await f.click(choose(r,'✅ حفظ'));assert.ok(r.plan!.text.includes('حُفظ'));const rule=(await f.store.snapshot()).subscriptionRequirements[0]!;assert.equal(rule.version,2);assert.deepEqual(rule.channelIds,[]);assert.equal((await f.store.snapshot()).audit.filter(a=>a.reason==='SUBSCRIPTION_CONFIG_CONFIRMED').length,1);
  }finally{await f.close();}
 });
 test(engine+' independent channel rights checks run together before a single guarded save',async()=>{
  const f=await fixture();let release=()=>{};
  try{
   const ready=new Promise<void>(r=>{release=r;}),started:string[]=[];let first=()=>{};const firstStarted=new Promise<void>(r=>{first=r;});
   f.membership.canVerifyChannel=async id=>{started.push(id);first();await ready;return true;};
   const pending=f.gate.configure('100',GROUP,['-100200','-100201'],'ALL',subscriptionConfigEpoch(await f.store.snapshot()));
   await firstStarted;const count=started.length;release();await pending;assert.equal(count,2);assert.equal((await f.store.snapshot()).subscriptionRequirements.length,1);
  }finally{release();await f.close();}
 });
 test(engine+' channel selections stop at ten and duplicate or forged server records cannot execute a save',async()=>{
  const f=await fixture();try{
   let r=await f.click('sc:1:h');r=await f.click(choose(r,'👥 '+GROUP));for(let i=0;i<8;i++)r=await f.click(choose(r,'▫️ -10020'+i));r=await f.click(choose(r,'➡️ التالي'));r=await f.click(choose(r,'▫️ -100208'));r=await f.click(choose(r,'▫️ -100209'));assert.equal(r.plan!.inlineMarkup!.inline_keyboard.flat().some(b=>b.text.startsWith('▫️')),false);assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
   r=await f.click(choose(r,'👁️ معاينة'));const route=choose(r,'✅ حفظ'),ref='subscription-editor:'+route.slice(5);const record=(await f.store.snapshot()).callbacks.find(c=>c.ref===ref)!;
   await f.store.transaction(s=>{s.callbacks.push({...record});});assert.equal((await f.click(route)).status,'DENIED');await f.store.transaction(s=>{s.callbacks=s.callbacks.filter(c=>c.ref!==ref);s.callbacks.push({...record,oneShot:false});});assert.equal((await f.click(route)).status,'DENIED');assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
   assert.ok(r.plan!.inlineMarkup!.inline_keyboard.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
  }finally{await f.close();}
 });
 test(engine+' leaving the editor revokes pending confirmations and withholds queued previews even without source changes',async()=>{
  const f=await fixture();try{
   let r=await f.click('sc:1:h');r=await f.click(choose(r,'👥 '+GROUP));r=await f.click(choose(r,'▫️ -100200'));r=await f.click(choose(r,'👁️ معاينة'));const route=choose(r,'✅ حفظ'),queued=r.deliveryKey!;
   await f.click('mi:1:h');assert.equal((await f.click(route)).status,'DENIED');assert.equal((await f.store.snapshot()).subscriptionRequirements.length,0);
   let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:55};}},()=>NOW);assert.equal((await dispatcher.dispatch(queued)).status,'FAILED_CONFIRMED');assert.equal(sent,0);
  }finally{await f.close();}
 });
}
