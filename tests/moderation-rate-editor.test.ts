import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {TelegramModerationRateEditor} from '../src/telegram-moderation-rate-editor.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
const NOW=1700000000000,CHAT='-100123';
for(const engine of ['json','sqlite'] as const){
 async function fixture(){const dir=await mkdtemp(join(tmpdir(),'rate-editor-'));let now=NOW;const clock=()=>now,filename=join(dir,'state.'+engine),store=new BotStore(filename,{engine}),policy=new Policy(store,'100',clock);await policy.approveChat('100',CHAT,['moderation']);const gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,clock),education=new EducationService(store,policy,clock),app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,clock),faq:new ApprovedAnswerService(store,policy,clock),links:new ResourceLinkService(store,policy,clock),membership:async()=> 'VERIFIED',moderation,botId:'rate-editor',botUsername:'ManaratakBot',clock});let update=0;const tap=(data:string,actor=100,group=false)=>app.handle({update_id:++update,callback_query:{id:'rate'+update,from:{id:actor,is_bot:false},message:{message_id:5,from:{id:999,is_bot:true},chat:{id:group?Number(CHAT):actor,type:group?'supergroup':'private'}},data}});return {store,policy,gateway,moderation,app,tap,clock,filename,time:(v:number)=>{now=v;},close:()=>rm(dir,{recursive:true,force:true})};}
 const button=(result:Awaited<ReturnType<TelegramUpdateApplication['handle']>>,prefix:string)=>{const b=result.plan?.inlineMarkup?.inline_keyboard.flat().find(x=>x.callback_data.startsWith(prefix));assert.ok(b);return b.callback_data;};
 test(engine+' owner reviews and applies a rate limit, with previous operations counted',async()=>{const f=await fixture();try{
  assert.equal((await f.moderation.addManualReason('100',CHAT,'300','case-one','MUTE')).status,'APPLIED');const status=await f.tap('mi:1:i:02:15');assert.ok(button(status,'rf:1:e'));const editor=await f.tap('rf:1:e');assert.equal(isValidTelegramInlineKeyboard(editor.plan?.inlineMarkup),true);const choice=button(editor,'rf:1:p:a:1:');assert.equal((await f.tap(choice.replace(':p:',':c:'))).status,'DENIED');
  const preview=await f.tap(choice);assert.equal(isValidTelegramInlineKeyboard(preview.plan?.inlineMarkup),true);assert.match(preview.plan!.text,/المقترح: 1/u);assert.equal((await f.store.snapshot()).moderationRateConfig,undefined);const confirm=button(preview,'rf:1:c:');assert.equal((await f.tap(confirm)).status,'APPLIED');assert.equal((await f.tap(confirm)).status,'DENIED');
  assert.equal((await f.moderation.addManualReason('100',CHAT,'301','case-two','MUTE')).reason,'MODERATION_RATE_LIMIT_ACTOR_CHAT');assert.equal(f.gateway.calls.length,1);const reopened=new BotStore(f.filename,{engine});assert.equal((await reopened.snapshot()).moderationRateConfig?.actorChatTenMinutes,1);
  assert.match((await f.tap('mi:1:i:02:15')).plan!.text,/1 إجراءات/u);
 }finally{await f.close();}});
 test(engine+' rate controls reject group, non-owner, expired, cancelled and changed sources',async()=>{const f=await fixture();try{
  assert.equal((await f.tap('rf:1:e',301)).status,'DENIED');assert.equal((await f.tap('rf:1:e',100,true)).status,'DENIED');
  let editor=await f.tap('rf:1:e'),preview=await f.tap(button(editor,'rf:1:p:g:6:')),confirm=button(preview,'rf:1:c:');await f.tap('mi:1:i:02:15');assert.equal((await f.tap(confirm)).status,'DENIED');
  editor=await f.tap('rf:1:e');preview=await f.tap(button(editor,'rf:1:p:d:15:'));confirm=button(preview,'rf:1:c:');f.time(NOW+120000);assert.equal((await f.tap(confirm)).status,'DENIED');
  f.time(NOW+121000);editor=await f.tap('rf:1:e');preview=await f.tap(button(editor,'rf:1:p:a:3:'));confirm=button(preview,'rf:1:c:');await f.store.transaction(s=>{s.moderationRateConfig={actorChatTenMinutes:5,groupTenMinutes:12,actorAllChatsDay:30,revision:1};});assert.equal((await f.tap(confirm)).status,'DENIED');
  const direct=new TelegramModerationRateEditor(f.store,f.policy,f.clock);assert.equal(await direct.handle('301','rf:1:e'),null);
 }finally{await f.close();}});
 test(engine+' all three rate settings persist and one confirmation wins concurrent taps',async()=>{const f=await fixture();try{
  for(const [key,value] of [['g',6],['d',15]] as const){const editor=await f.tap('rf:1:e'),preview=await f.tap(button(editor,'rf:1:p:'+key+':'+value+':')),confirm=button(preview,'rf:1:c:');assert.equal((await f.tap(confirm)).status,'APPLIED');}
  const editor=new TelegramModerationRateEditor(f.store,f.policy,f.clock),screen=await editor.handle('100','rf:1:e');assert.ok(screen);const choice=screen.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rf:1:p:a:3:'))!.callback_data,preview=await editor.handle('100',choice);assert.ok(preview);const confirm=preview.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('rf:1:c:'))!.callback_data;
  const results=await Promise.all([editor.handle('100',confirm),editor.handle('100',confirm)]);assert.equal(results.filter(Boolean).length,1);assert.deepEqual((await f.store.snapshot()).moderationRateConfig,{actorChatTenMinutes:3,groupTenMinutes:6,actorAllChatsDay:15,revision:3});
 }finally{await f.close();}});
}
