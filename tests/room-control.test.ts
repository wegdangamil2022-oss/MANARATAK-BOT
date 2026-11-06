import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {AdminRoomLinks} from '../src/admin-room-links.js';
import {TelegramRoomControl} from '../src/telegram-room-control.js';
import {TelegramModerationReports} from '../src/telegram-moderation-reports.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {TelegramReplyDispatcher} from '../src/telegram-replies.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
const NOW=1700000000000;
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'room-control-'));let now=NOW;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now),gateway=new FakeModerationGateway();for(const c of ['-100','-200','-300'])await policy.approveChat('100',c,['moderation']);const links=new AdminRoomLinks(store,policy,()=>now),service=new ModerationService(store,policy,gateway,()=>now),ui=new TelegramRoomControl(store,policy,service,()=>now);
  const activate=async(group:string,mode:'CONTROL'|'CENTRAL'|'NOTIFICATIONS')=>{const id=await links.propose('100',group,'-200',mode);assert.ok(id);await links.approve('100',id,'GROUP');await links.approve('100',id,'ROOM');return id;};
  return {store,policy,gateway,links,ui,service,activate,now:()=>now,advance:(ms:number)=>{now+=ms;},close:()=>rm(dir,{recursive:true,force:true})};}
 const token=(screen:Awaited<ReturnType<TelegramRoomControl['central']>>)=>{assert.ok(screen);assert.ok(isValidTelegramInlineKeyboard(screen.keyboard));const route=screen.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rc:1:c:'));assert.ok(route);return route.callback_data.slice(7);};
 test(engine+' control button binds report, room, group and real actor, with private confirmation and cancellation',async()=>{const f=await fixture();try{
  await f.activate('-100','NOTIFICATIONS');assert.equal(await new TelegramModerationReports(f.store,f.policy,f.now).submit('400','-100',101,{message_id:1,chat:{id:-100,type:'supergroup'},from:{id:500,is_bot:false}}),'RECORDED');const id=(await f.store.snapshot()).audit.find(a=>a.reason.startsWith('MODERATION_REPORT:'))!.updateKey.slice('moderation:report:'.length);
  assert.equal(await f.ui.fromRoom('100','-200',id),null);const control=await f.activate('-100','CONTROL');assert.equal(await f.ui.fromRoom('999','-200',id),null);assert.equal(await f.ui.fromRoom('100','-300',id),null);
  let preview=await f.ui.fromRoom('100','-200',id);const cancelled=token(preview);await f.ui.cancel('100');assert.equal(await f.ui.confirm('100',cancelled),null);
  preview=await f.ui.fromRoom('100','-200',id);const stale=token(preview);await f.links.revoke('100',control);assert.equal(await f.ui.confirm('100',stale),null);
  await f.activate('-100','CONTROL');const fresh=token(await f.ui.fromRoom('100','-200',id));assert.ok(await f.ui.confirm('100',fresh));assert.equal(await f.ui.confirm('100',fresh),null);assert.equal(f.gateway.calls.length,0);assert.equal((await f.store.snapshot()).audit.filter(a=>a.updateKey==='moderation:report:'+id+':closed').length,1);
 }finally{await f.close();}});
 test(engine+' control report list is independent from notifications and filters foreign groups',async()=>{const f=await fixture();try{
  await f.activate('-100','CONTROL');const reports=new TelegramModerationReports(f.store,f.policy,f.now);for(const group of ['-100','-300'])assert.equal(await reports.submit('400',group,101,{message_id:1,chat:{id:Number(group),type:'supergroup'},from:{id:500,is_bot:false}}),'RECORDED');
  const list=await f.ui.listFromRoom('100','-200');assert.ok(list);assert.ok(isValidTelegramInlineKeyboard(list.keyboard));assert.equal(list.keyboard.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('rc:1:p:')).length,1);assert.doesNotMatch(list.text,/-300|500|400/u);assert.equal(await f.ui.listFromRoom('999','-200'),null);
  const route=list.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rc:1:p:'))!.callback_data;assert.ok(await f.ui.fromPrivate('100',route.slice(7),'CLOSE'));
 }finally{await f.close();}});
 test(engine+' central selection requires independent grants for every group and executes one reviewed batch',async()=>{const f=await fixture();try{
  await f.activate('-100','CENTRAL');assert.equal(await f.ui.central('100','/centralban -200 500 60 -100 -300'),null);await f.activate('-300','CENTRAL');assert.equal(await f.ui.central('999','/centralban -200 500 60 -100 -300'),null);assert.equal(await f.ui.central('100','/centralban -200 500 59 -100'),null);
  const confirmation=token(await f.ui.central('100','/centralban -200 500 60 -100 -300'));const result=await f.ui.confirm('100',confirmation);assert.ok(result);assert.match(result.text,/-100: APPLIED/u);assert.match(result.text,/-300: APPLIED/u);assert.equal(f.gateway.calls.length,2);assert.equal(await f.ui.confirm('100',confirmation),null);assert.equal(f.gateway.calls.length,2);
 }finally{await f.close();}});
 test(engine+' revoking one central grant before confirmation blocks the batch and expiry cannot extend',async()=>{const f=await fixture();try{
  await f.activate('-100','CENTRAL');const id=await f.activate('-300','CENTRAL');const confirmation=token(await f.ui.central('100','/centralban -200 500 60 -100 -300'));await f.links.revoke('100',id);assert.equal(await f.ui.confirm('100',confirmation),null);assert.equal(f.gateway.calls.length,0);
  const expired=token(await f.ui.central('100','/centralban -200 500 60 -100'));f.advance(120000);assert.equal(await f.ui.confirm('100',expired),null);assert.equal(f.gateway.calls.length,0);
 }finally{await f.close();}});
 test(engine+' real-shaped room callback privately confirms the exact warning and queued screen is withdrawn on unlink',async()=>{const f=await fixture();try{
  const link=await f.activate('-100','CONTROL');assert.equal(await new TelegramModerationReports(f.store,f.policy,f.now).submit('400','-100',101,{message_id:1,chat:{id:-100,type:'supergroup'},from:{id:500,is_bot:false}}),'RECORDED');const id=(await f.store.snapshot()).audit.find(a=>a.reason.startsWith('MODERATION_REPORT:'))!.updateKey.slice('moderation:report:'.length);
  const education=new EducationService(f.store,f.policy,f.now),app=new TelegramUpdateApplication({store:f.store,policy:f.policy,education,admin:new EducationAdminFacade(f.store,f.policy,education,f.now),faq:new ApprovedAnswerService(f.store,f.policy,f.now),links:new ResourceLinkService(f.store,f.policy,f.now),membership:async()=> 'VERIFIED',clock:f.now,botId:'control-test',botUsername:'ManaratakBot',moderation:f.service});
  const preview=await app.handle({update_id:1,callback_query:{id:'room1',from:{id:100,is_bot:false},data:'rc:1:w:'+id,message:{message_id:10,chat:{id:-200,type:'supergroup'},from:{id:999,is_bot:true}}}});assert.equal(preview.status,'APPLIED');assert.equal(preview.plan!.chatId,'100');assert.equal((await f.store.snapshot()).warnings.length,0);
  const confirm=preview.plan!.inlineMarkup!.inline_keyboard[0]![0]!.callback_data;const result=await app.handle({update_id:2,callback_query:{id:'room2',from:{id:100,is_bot:false},data:confirm,message:{message_id:11,chat:{id:100,type:'private'},from:{id:999,is_bot:true}}}});assert.equal(result.status,'APPLIED');assert.equal((await f.store.snapshot()).warnings.filter(w=>w.active&&w.memberId==='500').length,1);assert.equal(f.gateway.calls.length,0);
  const delayed=await f.ui.fromRoom('100','-200',id,'MUTE');assert.ok(delayed);await f.links.revoke('100',link);assert.equal(await f.ui.confirm('100',token(delayed)),null);
  let sent=0;const dispatcher=new TelegramReplyDispatcher(f.store,f.policy,{send:async()=>{sent++;return {status:'CONFIRMED',messageId:1};}},f.now);assert.equal((await dispatcher.dispatch(preview.deliveryKey!)).status,'FAILED_CONFIRMED');assert.equal(sent,0);
 }finally{await f.close();}});
 test(engine+' central batch stops an individually revoked target after another group succeeds',async()=>{const f=await fixture();try{
  await f.activate('-100','CENTRAL');const second=await f.activate('-300','CENTRAL');const original=f.gateway.setRestriction.bind(f.gateway);f.gateway.setRestriction=async(chat,member,kind)=>{const result=await original(chat,member,kind);await f.links.revoke('100',second);return result;};
  const result=await f.ui.confirm('100',token(await f.ui.central('100','/centralban -200 500 60 -100 -300')));assert.ok(result);assert.match(result.text,/-100: APPLIED/u);assert.match(result.text,/-300: DENIED/u);assert.equal(f.gateway.calls.length,1);
 }finally{await f.close();}});
 test(engine+' central buttons select only explicit groups and stale selection cannot advance',async()=>{const f=await fixture();try{
  await f.activate('-100','CENTRAL');await f.activate('-300','CENTRAL');const initial=await f.ui.central('100','/centralban -200 500 60');assert.ok(initial);assert.ok(isValidTelegramInlineKeyboard(initial.keyboard));assert.equal(initial.keyboard.inline_keyboard.flat().some(b=>b.callback_data.startsWith('rc:1:v:')),false);
  const choose=initial.keyboard.inline_keyboard.flat().find(b=>b.text.includes('-300'))!.callback_data,parts=choose.split(':'),selected=await f.ui.selection('100',parts[3]!,Number(parts[4]));assert.ok(selected);assert.equal(await f.ui.selection('100',parts[3]!,Number(parts[4])),null);const review=selected.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rc:1:v:'))!.callback_data;
  const preview=await f.ui.selection('100',review.slice(7));const result=await f.ui.confirm('100',token(preview));assert.ok(result);assert.match(result.text,/-300: APPLIED/u);assert.doesNotMatch(result.text,/-100:/u);assert.equal(f.gateway.calls.length,1);assert.equal(f.gateway.calls[0]!.chatId,'-300');
 }finally{await f.close();}});
 for(const variant of ['private','public','stop','revoke','unknown'] as const)test(engine+' official central '+variant+' checks room privacy and STOP before a mutation',async()=>{const f=await fixture();try{
  const link=await f.activate('-100','CENTRAL');let writes=0;const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));if(method==='getChat'){
   if(body.chat_id==='-200'&&variant==='revoke')await f.links.revoke('100',link);if(body.chat_id==='-200'&&variant==='unknown')throw Error('unknown privacy');return Response.json({ok:true,result:{id:Number(body.chat_id),type:'supergroup',...(body.chat_id==='-200'&&variant==='public'?{username:'PublicRoom'}:{})}});
  }if(method==='getChatMember')return Response.json({ok:true,result:{status:body.user_id===123456789?'administrator':'member',user:{id:body.user_id,is_bot:body.user_id===123456789},can_restrict_members:true}});assert.equal(method,'banChatMember');writes++;return Response.json({ok:true,result:true});}) as typeof fetch;
  const gateway=new TelegramBotApiModerationGateway('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',request,async()=>variant!=='stop',f.now),service=new ModerationService(f.store,f.policy,gateway,f.now),ui=new TelegramRoomControl(f.store,f.policy,service,f.now,gateway,async()=>variant!=='stop');
  const confirmation=token(await ui.central('100','/centralban -200 500 60 -100'));const result=await ui.confirm('100',confirmation);assert.equal(writes,variant==='private'?1:0);if(variant==='private'){assert.ok(result);assert.match(result.text,/APPLIED/u);}assert.equal(await ui.confirm('100',confirmation),null);assert.equal(writes,variant==='private'?1:0);
 }finally{await f.close();}});
}
