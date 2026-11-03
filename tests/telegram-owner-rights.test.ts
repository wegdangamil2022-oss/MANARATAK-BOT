import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {TelegramOwnerRights} from '../src/telegram-owner-rights.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
const NOW=1700000000000,CHAT='-100123',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const button=(screen:OwnerInlineScreen|null,prefix:string)=>{assert.ok(screen&&isValidTelegramInlineKeyboard(screen.keyboard));const value=screen.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(value);return value.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'owner-rights-')),store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);await policy.approveChat('100',CHAT,['moderation']);
  let reads=0,allowed=true,admin=true,malformed=false,hook:()=>Promise<void>=async()=>{};
  const request=(async(url:string|URL|Request,init?:RequestInit)=>{reads++;assert.equal(String(url).split('/').at(-1),'getChatMember');assert.deepEqual(JSON.parse(String(init?.body)),{chat_id:CHAT,user_id:123456789});await hook();return new Response(JSON.stringify({ok:true,result:malformed?{status:'administrator',user:{id:7,is_bot:true}}:{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:admin,can_delete_messages:true,can_invite_users:false,can_pin_messages:'invalid',can_promote_members:false}}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,request),ui=()=>new TelegramOwnerRights(store,policy,gateway,()=>NOW,async()=>allowed);
  return {store,policy,gateway,safety:async()=>allowed,ui,reads:()=>reads,stop:()=>{allowed=false;},deny:()=>{admin=false;},bad:()=>{malformed=true;},hook:(f:()=>Promise<void>)=>{hook=f;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' owner can inspect only approved group bot restriction rights, with private return',async()=>{
  const f=await fixture();try{
   const root=await f.ui().handle('100','mi:1:i:03:06'),select=button(root,'tr:1:g:');assert.equal(f.reads(),0);assert.equal(await f.ui().handle('301',select),null);assert.equal(f.reads(),0);
   const view=await f.ui().handle('100',select);assert.ok(view);assert.match(view.text,/حق تقييد الأعضاء: متاح/u);assert.match(view.text,/حذف الرسائل: متاح/u);assert.match(view.text,/دعوة المستخدمين: غير متاح/u);assert.match(view.text,/تثبيت الرسائل: تعذر التحقق/u);assert.match(view.text,/تغيير معلومات المجموعة: تعذر التحقق/u);assert.match(view.text,/إدارة المشرفين: غير متاح/u);assert.match(view.text,/لحظة الفحص/u);assert.equal(f.reads(),1);assert.ok(await f.ui().handle('100',button(view,'tr:1:p:')));
   const next=await f.ui().handle('100','mi:1:i:03:06');f.deny();assert.match((await f.ui().handle('100',button(next,'tr:1:g:')))!.text,/حق تقييد الأعضاء: غير متاح/u);
  }finally{await f.close();}
 });
 test(engine+' failed identity, STOP, absent adapter and stale source never grant rights',async()=>{
  const f=await fixture();try{
   let root=await f.ui().handle('100','mi:1:i:03:06');f.bad();let view=await f.ui().handle('100',button(root,'tr:1:g:'));assert.match(view!.text,/تعذر التحقق/u);
   root=await f.ui().handle('100','mi:1:i:03:06');f.stop();view=await f.ui().handle('100',button(root,'tr:1:g:'));assert.match(view!.text,/تعذر التحقق/u);assert.equal(f.reads(),1);
   const unavailable=new TelegramOwnerRights(f.store,f.policy,undefined,()=>NOW,async()=>false);root=await unavailable.handle('100','mi:1:i:03:06');assert.match(root!.text,/غير مهيأ/u);
   assert.equal(await unavailable.handle('100','tr:1:g:00:1:0123456789abcdef'),null);await f.store.transaction(s=>{s.privateFeatures['owner.dashboard']=false;});assert.equal(await f.ui().handle('100','mi:1:i:03:06'),null);
  }finally{await f.close();}
 });
 test(engine+' revocation during a provider read prevents the stale result from being displayed',async()=>{
  const f=await fixture();try{
   const root=await f.ui().handle('100','mi:1:i:03:06'),select=button(root,'tr:1:g:');f.hook(()=>f.policy.revokeChat('100',CHAT));assert.equal(await f.ui().handle('100',select),null);assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' navigation cancels an in-flight read and invalidates its old selection',async()=>{
  const f=await fixture();try{
   const root=await f.ui().handle('100','mi:1:i:03:06'),select=button(root,'tr:1:g:');f.hook(()=>f.ui().cancel('100'));
   assert.equal(await f.ui().handle('100',select),null);assert.equal(await f.ui().handle('100',select),null);assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' revocation while the safety gate waits prevents even the provider read',async()=>{
  const f=await fixture();try{
   const slowGate=async()=>{await f.policy.revokeChat('100',CHAT);return true;},ui=new TelegramOwnerRights(f.store,f.policy,f.gateway,()=>NOW,slowGate);
   const root=await ui.handle('100','mi:1:i:03:06'),select=button(root,'tr:1:g:');assert.equal(await ui.handle('100',select),null);assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' malformed restored session is denied without any provider request',async()=>{
  const f=await fixture();try{
   const root=await f.ui().handle('100','mi:1:i:03:06'),select=button(root,'tr:1:g:');await f.store.transaction(s=>{s.wizards.find(w=>w.key==='owner-rights:100')!.flow=7 as unknown as string;});
   assert.equal(await f.ui().handle('100',select),null);assert.equal(f.reads(),0);
  }finally{await f.close();}
 });
 test(engine+' expired controls and an untrusted adapter cannot claim verified rights',async()=>{
  const f=await fixture();try{
   let now=NOW,calls=0;const fake={inspectBotModerationRights:async()=>{calls++;return 'GRANTED' as const;}} as unknown as TelegramBotApiModerationGateway;
   const ui=new TelegramOwnerRights(f.store,f.policy,fake,()=>now,async()=>true);let root=await ui.handle('100','mi:1:i:03:06');let selected=button(root,'tr:1:g:');const result=await ui.handle('100',selected);assert.match(result!.text,/تعذر التحقق/u);assert.equal(calls,0);
   root=await ui.handle('100','mi:1:i:03:06');selected=button(root,'tr:1:g:');now+=120000;assert.equal(await ui.handle('100',selected),null);assert.equal(calls,0);
  }finally{await f.close();}
 });
 test(engine+' repeated selection cannot race or return an older rights result',async()=>{
  const f=await fixture();try{
   const root=await f.ui().handle('100','mi:1:i:03:06'),select=button(root,'tr:1:g:');let started!:()=>void,release!:()=>void;
   const began=new Promise<void>(resolve=>{started=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});let calls=0;f.hook(async()=>{if(++calls===1){started();await hold;}});
   const first=f.ui().handle('100',select);await began;const second=await f.ui().handle('100',select);release();assert.equal(second,null);assert.ok(await first);assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' actual owner button and private callback reach the read-only probe and back cancels old buttons',async()=>{
  const f=await fixture();try{
   const education=new EducationService(f.store,f.policy,()=>NOW),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,()=>NOW),faq:new ApprovedAnswerService(f.store,f.policy,()=>NOW),links:new ResourceLinkService(f.store,f.policy,()=>NOW),moderationRights:{gateway:f.gateway,safety:f.safety},membership:async()=>{throw Error('NETWORK_FORBIDDEN');},clock:()=>NOW,botId:'rights',botUsername:'ManaratakBot'});
   const tap=(id:number,data:string,actor=100,group=false)=>app.handle({update_id:id,callback_query:{id:'rights-'+id,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}}}});
   const root=await tap(1,'mi:1:i:03:06');assert.equal(root.status,'APPLIED');const select=root.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith('tr:1:g:'))!.callback_data;
   assert.equal((await tap(2,select,100,true)).status,'DENIED');assert.equal((await tap(3,select,301)).status,'DENIED');assert.equal(f.reads(),0);
   const view=await tap(4,select);assert.equal(view.status,'APPLIED');assert.match(view.plan!.text,/حق تقييد الأعضاء: متاح/u);assert.equal(f.reads(),1);
   assert.equal((await tap(5,'mi:1:s:03:0')).status,'APPLIED');assert.equal((await tap(6,select)).status,'DENIED');assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
}
