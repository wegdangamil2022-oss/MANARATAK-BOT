import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {TelegramAdminRoles} from '../src/telegram-admin-roles.js';
import {TelegramAdminRoleGateway} from '../src/telegram-admin-role-gateway.js';
import {isValidTelegramInlineKeyboard,type OwnerInlineScreen} from '../src/telegram-inline-owner.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
const NOW=1700000000000,GROUP='-100123',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const button=(view:OwnerInlineScreen|null,prefix:string)=>{assert.ok(view);assert.ok(isValidTelegramInlineKeyboard(view.keyboard));const b=view.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'admin-roles-')),file=join(dir,'state.'+engine),store=new BotStore(file,{engine}),policy=new Policy(store,'100',()=>now);let hook:()=>Promise<void>=async()=>{};let now=NOW,allowed=true,writes=0,timeout=false,member:Record<string,unknown>={status:'member',user:{id:301,is_bot:false}};
  await policy.approveChat('100',GROUP,['moderation']);
  const request=(async(url:unknown,init?:RequestInit)=>{await hook();const method=String(url).split('/').at(-1),body=JSON.parse(String(init?.body));let result:unknown;if(method==='getChat')result={id:Number(GROUP),type:'supergroup'};else if(method==='getChatMember')result=body.user_id===123456789?{status:'administrator',user:{id:123456789,is_bot:true},can_manage_chat:true,can_promote_members:true,can_delete_messages:true,can_restrict_members:true}:member;else {writes++;if(timeout)throw Error('lost reply');member=body.can_manage_chat?{...body,status:'administrator',user:{id:301,is_bot:false},can_be_edited:true}:{status:'member',user:{id:301,is_bot:false}};result=true;}return new Response(JSON.stringify({ok:true,result}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
  const gateway=new TelegramAdminRoleGateway(TOKEN,request,async()=>allowed),ui=()=>new TelegramAdminRoles(store,policy,gateway,()=>now);
  const preview=async()=>{assert.ok(await ui().handle('100','ar:1:g:'+GROUP));const choices=await ui().input('100','301');return ui().handle('100',button(choices,'ar:1:p:'));};
  return {store,policy,file,gateway,ui,preview,hook:(f:()=>Promise<void>)=>{hook=f;},writes:()=>writes,stop:()=>{allowed=false;},expire:()=>{now+=120000;},timeout:()=>{timeout=true;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' private buttons preview, confirm once, persist receipt and support return',async()=>{
  const f=await fixture();try{const view=await f.preview(),confirm=button(view,'ar:1:c:');assert.equal(f.writes(),0);assert.equal(await f.ui().handle('301',confirm),null);const result=await f.ui().handle('100',confirm);assert.match(result!.text,/تأكد/u);assert.equal(f.writes(),1);assert.equal(await f.ui().handle('100',confirm),null);assert.ok((await f.store.snapshot()).audit.some(a=>a.reason==='ADMIN_ROLE_CONFIRMED'));assert.equal(button(result,'mi:1:i:03:06'),'mi:1:i:03:06');}finally{await f.close();}
 });
 test(engine+' STOP, expired confirmation, revoked group and cancelled navigation deny mutation',async()=>{
  for(const change of ['stop','expire','revoke','cancel'] as const){const f=await fixture();try{const view=await f.preview(),confirm=button(view,'ar:1:c:');if(change==='revoke')await f.policy.revokeChat('100',GROUP);else if(change==='cancel')await f.ui().cancel('100');else f[change]();const result=await f.ui().handle('100',confirm);assert.ok(!result||!result.text.includes('تأكد تنفيذ'));assert.equal(f.writes(),0);}finally{await f.close();}}
 });
 test(engine+' concurrent confirmation and unknown response never repeat dispatch',async()=>{
  const f=await fixture();try{const view=await f.preview(),confirm=button(view,'ar:1:c:');f.timeout();const results=await Promise.all([f.ui().handle('100',confirm),f.ui().handle('100',confirm)]);assert.equal(f.writes(),1);assert.ok(results.some(v=>v?.text.includes('غير محسومة')));assert.equal(await f.ui().handle('100',confirm),null);assert.ok((await f.store.snapshot()).audit.some(a=>a.reason==='ADMIN_ROLE_UNKNOWN_OUTCOME'));}finally{await f.close();}
 });
 test(engine+' owner, bot and malformed target IDs cannot enter confirmation',async()=>{
  const f=await fixture();try{for(const target of ['100','123456789','@user','0301','301\n']){await f.ui().handle('100','ar:1:g:'+GROUP);const view=await f.ui().input('100',target);assert.ok(!view||!view.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('ar:1:p:')));}assert.equal(f.writes(),0);}finally{await f.close();}
 });
 test(engine+' unknown attempt blocks a fresh preview for the same member after reopening state',async()=>{
  const f=await fixture();try{const view=await f.preview(),confirm=button(view,'ar:1:c:');f.timeout();await f.ui().handle('100',confirm);const reopened=new BotStore(f.file,{engine}),ui=new TelegramAdminRoles(reopened,new Policy(reopened,'100',()=>NOW),f.gateway,()=>NOW);await ui.handle('100','ar:1:g:'+GROUP);const choices=await ui.input('100','301');assert.equal(await ui.handle('100',button(choices,'ar:1:p:')),null);assert.equal(f.writes(),1);}finally{await f.close();}
 });
 test(engine+' transport carries buttons, numeric input, back cancellation and one-shot execution',async()=>{
  const f=await fixture();try{
   const education=new EducationService(f.store,f.policy,()=>NOW),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,()=>NOW),faq:new ApprovedAnswerService(f.store,f.policy,()=>NOW),links:new ResourceLinkService(f.store,f.policy,()=>NOW),adminRoles:f.gateway,membership:async()=>{throw Error('NO_MEMBERSHIP_NETWORK');},clock:()=>NOW,botId:'roles',botUsername:'ManaratakBot'});
   let update=0;const tap=(data:string,actor=100,group=false)=>app.handle({update_id:++update,callback_query:{id:'admin-'+update,from:{id:actor,is_bot:false},data,message:{message_id:55,from:{id:999,is_bot:true},chat:{id:group?Number(GROUP):actor,type:group?'supergroup':'private'}}}}),input=()=>app.handle({update_id:++update,message:{message_id:77,date:Math.floor(NOW/1000),from:{id:100,is_bot:false},chat:{id:100,type:'private'},text:'301'}});
   assert.equal((await tap('ar:1:g:'+GROUP,301)).status,'DENIED');assert.equal((await tap('ar:1:g:'+GROUP,100,true)).status,'DENIED');
   assert.equal((await tap('ar:1:g:'+GROUP)).status,'APPLIED');let choices=await input();assert.equal(choices.status,'APPLIED');const selection=choices.plan!.inlineMarkup!.inline_keyboard.flat()[0]!.callback_data;let view=await tap(selection);assert.equal(view.status,'APPLIED');let confirm=view.plan!.inlineMarkup!.inline_keyboard.flat()[0]!.callback_data;
   assert.equal((await tap('mi:1:s:03:0')).status,'APPLIED');assert.equal((await tap(confirm)).status,'DENIED');assert.equal(f.writes(),0);
   await tap('ar:1:g:'+GROUP);choices=await input();view=await tap(choices.plan!.inlineMarkup!.inline_keyboard.flat()[0]!.callback_data);confirm=view.plan!.inlineMarkup!.inline_keyboard.flat()[0]!.callback_data;assert.equal((await tap(confirm)).status,'APPLIED');assert.equal(f.writes(),1);assert.equal((await tap(confirm)).status,'DENIED');
  }finally{await f.close();}
 });
 test(engine+' malformed restored review sessions cannot dispatch or render a confirmation',async()=>{
  for(const corrupt of ['target','role','baseline','extra']){const f=await fixture();try{const view=await f.preview(),confirm=button(view,'ar:1:c:');await f.store.transaction(s=>{const w=s.wizards.find(w=>w.key==='admin-role:100')!,d=JSON.parse(w.flow.slice('admin-role:'.length));d[corrupt]=corrupt==='target'?'<b>301</b>':corrupt==='role'?'OWNER':corrupt==='baseline'?'0':'unexpected';w.flow='admin-role:'+JSON.stringify(d);});assert.equal(await f.ui().handle('100',confirm),null);assert.equal(f.writes(),0);}finally{await f.close();}}
 });
 test(engine+' promoted member can be explicitly demoted through a separate fresh confirmation',async()=>{
  const f=await fixture();try{const first=await f.preview();assert.match((await f.ui().handle('100',button(first,'ar:1:c:')))!.text,/تأكد/u);await f.ui().handle('100','ar:1:g:'+GROUP);const choices=await f.ui().input('100','301');assert.ok(choices);const demote=choices.keyboard.inline_keyboard.flat().find(b=>b.callback_data.endsWith(':DEMOTE'))!;const view=await f.ui().handle('100',demote.callback_data);assert.match(view!.text,/عزل المشرف/u);assert.equal(f.writes(),1);assert.match((await f.ui().handle('100',button(view,'ar:1:c:')))!.text,/تأكد/u);assert.equal(f.writes(),2);}finally{await f.close();}
 });
 test(engine+' a late provider read cannot cancel a replacement wizard or display a stale review',async()=>{
  const f=await fixture();try{await f.ui().handle('100','ar:1:g:'+GROUP);const choices=await f.ui().input('100','301');f.hook(async()=>{f.hook(async()=>{});await f.ui().handle('100','ar:1:g:'+GROUP);});assert.equal(await f.ui().handle('100',button(choices,'ar:1:p:')),null);assert.ok(await f.ui().input('100','301'));assert.equal(f.writes(),0);}finally{await f.close();}
 });
}
