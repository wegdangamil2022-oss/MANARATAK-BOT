import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway} from '../src/moderation.js';
import {TelegramUpdateApplication} from '../src/telegram-transport.js';
import {EducationService} from '../src/education.js';
import {EducationAdminFacade} from '../src/education-admin.js';
import {ApprovedAnswerService,ResourceLinkService} from '../src/education-interactions.js';
import {validModerationCaseRoute} from '../src/telegram-moderation-cases.js';
import {isValidTelegramInlineKeyboard} from '../src/telegram-inline-owner.js';

test('case selectors reject malformed numbers, shapes and trailing data',()=>{
 for(const route of ['cs:1:h:b:00','cs:1:h:x:0','cs:1:g:b:0:1:abcdef0123456789:0','cs:1:d:b:0:1:abcdef0123456789','cs:1:l:b:0:1:abcdef0123456789:0:1','cs:1:h:b:0\n'])assert.equal(validModerationCaseRoute(route),false,route);
});
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'moderation-cases-')),store=new BotStore(join(dir,'state.'+engine),{engine}),now=100000;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);await policy.grant('100','200','chat.manage','-100',200000);
  const education=new EducationService(store,policy,()=>now),gateway=new FakeModerationGateway(),moderation=new ModerationService(store,policy,gateway,()=>now);
  const app=new TelegramUpdateApplication({store,policy,education,admin:new EducationAdminFacade(store,policy,education,()=>now),faq:new ApprovedAnswerService(store,policy,()=>now),links:new ResourceLinkService(store,policy,()=>now),moderation,clock:()=>now,
   ownerMenuMode:'inline',botId:'cases',botUsername:'ManaratakBot',membership:async()=>{throw Error('No network');}});
  let id=0;const click=(data:string,actor=100,group=false)=>app.handle({update_id:++id,callback_query:{id:'case'+id,from:{id:actor,is_bot:false},data,message:{message_id:77,from:{id:999,is_bot:true},chat:{id:group?-100:actor,type:group?'supergroup':'private'}}}});
  return {store,policy,gateway,moderation,click,close:()=>rm(dir,{recursive:true,force:true})};
 }
 type Result=Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['click']>>;
 const find=(r:Result,prefix:string)=>{assert.ok(r.plan,JSON.stringify(r));assert.ok(isValidTelegramInlineKeyboard(r.plan.inlineMarkup));const b=r.plan.inlineMarkup!.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix));assert.ok(b,'Missing '+prefix);return b.callback_data;};
 test(engine+' owner and staff warning menus review one cancellation and reject stale/cross-user selectors',async()=>{
  const f=await fixture();try{
   await f.moderation.issueWarning('100','-100','300','reviewed_case');
   const root=await f.click('mi:1:i:02:03'),g=find(root,'cs:1:g:');
   assert.equal((await f.click(g,300)).status,'DENIED');assert.equal((await f.click(g,100,true)).status,'DENIED');assert.equal((await f.click(g,200)).status,'DENIED');
   const list=await f.click(g),detail=find(list,'cs:1:d:'),view=await f.click(detail),review=find(view,'cs:1:a:');
   assert.equal((await f.store.snapshot()).warnings[0]!.active,true);assert.match(view.plan!.text,/تحذيرات العضو النشطة: 1/u);
   const preview=await f.click(review),confirm=find(preview,'mc:1:c:');assert.equal((await f.store.snapshot()).warnings[0]!.active,true);
   assert.equal((await f.click(confirm)).status,'APPLIED');assert.equal((await f.store.snapshot()).warnings[0]!.active,false);assert.equal((await f.click(confirm)).status,'DENIED');assert.equal((await f.click(detail)).status,'DENIED');assert.equal(f.gateway.calls.length,0);
   assert.equal((await f.click('mi:1:i:02:03',200)).status,'DENIED');const staff=await f.click('cs:1:h:w:0',200);assert.ok(find(staff,'cs:1:g:'));
  }finally{await f.close();}
 });
 test(engine+' cases and groups page with exact return; subscription reasons have no manual removal',async()=>{
  const f=await fixture();try{
   await f.store.transaction(s=>{for(let i=0;i<10;i++)s.warnings.push({chatId:'-100',memberId:String(300+i),reference:'case_'+i,actorId:'100',at:100000,active:true});s.moderationReasons.push({chatId:'-100',memberId:'300',source:'SUBSCRIPTION',kind:'MUTE',reference:'gate',createdBy:'100',active:true});});
   const root=await f.click('mi:1:i:02:03'),group=find(root,'cs:1:g:'),list=await f.click(group);
   const next=list.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.text==='➡️ التالي')!;assert.ok(next);
   const second=await f.click(next.callback_data);assert.match(second.plan!.text,/صفحة 2 من 2/u);
   const view=await f.click(find(second,'cs:1:d:'));const back=find(view,'cs:1:l:');assert.equal(back,next.callback_data);
   assert.match((await f.click(back)).plan!.text,/صفحة 2 من 2/u);
   const sanctions=await f.click('mi:1:i:02:02'),sl=await f.click(find(sanctions,'cs:1:g:')),sv=await f.click(find(sl,'cs:1:d:'));
   assert.match(sv.plan!.text,/سبب اشتراك مستقل/u);assert.equal(sv.plan!.inlineMarkup!.inline_keyboard.flat().some(b=>b.callback_data.startsWith('cs:1:a:')),false);
   for(let i=0;i<8;i++)await f.policy.approveChat('100',String(-101-i),['moderation']);
   const many=await f.click('cs:1:h:w:0');const np=many.plan!.inlineMarkup!.inline_keyboard.flat().find(b=>b.text==='➡️ التالي')!;assert.ok(np);assert.match((await f.click(np.callback_data)).plan!.text,/صفحة 2 من 2/u);
  }finally{await f.close();}
 });
 test(engine+' revoked staff cannot read or cancel a case from their previous screen',async()=>{
  const f=await fixture();try{
   await f.moderation.issueWarning('100','-100','300','case');const root=await f.click('cs:1:h:w:0',200),list=await f.click(find(root,'cs:1:g:'),200),detail=find(list,'cs:1:d:');
   await f.store.transaction(s=>{s.grants[0]!.revoked=true;});assert.equal((await f.click(detail,200)).status,'DENIED');assert.equal((await f.store.snapshot()).warnings[0]!.active,true);
  }finally{await f.close();}
 });
}
