import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore,type Chat,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {renderOwnerInlineGroups} from '../src/telegram-inline-groups.js';
import {OwnerTelegramGroupMenu,groupMenuLabel} from '../src/telegram-owner-groups.js';
import {groupReversalInventory,renderReversalInventory} from '../src/moderation-reversal-inventory.js';
import {ModerationReversalPreflight,type RestrictionObserver} from '../src/moderation-reversal-preflight.js';

const OWNER='100',A='-100123',B='-100456',TARGET='300',NOW=1_700_000_000_000;
type Engine='json'|'sqlite';
async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-restored-owner-views-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,A,['navigation','moderation','verification','assistant']);
 await policy.approveChat(OWNER,B,['navigation','moderation']);
 const group=(await store.snapshot()).chats.find(c=>c.id===A)!;
 const addOp=async()=>{
  await store.transaction(s=>s.moderationOperations.push({
   id:'confirmed-A',chatId:A,memberId:TARGET,actorId:OWNER,kind:'BAN',
   reasonFingerprint:'PRIVATE-SEALED',policyVersion:group.version,
   createdAt:NOW,status:'CONFIRMED',attemptGateway:'TELEGRAM_API'
  }));
 };
 const duplicate=async(copy:Chat=group)=>store.transaction(s=>
  s.chats.push({...copy,scopes:[...copy.scopes]})
 );
 const inline=(data:string,actor=OWNER)=>renderOwnerInlineGroups(
  new BotStore(path,{engine}),policy,actor,data);
 const legacy=(data:string,actor=OWNER)=>new OwnerTelegramGroupMenu(
  new BotStore(path,{engine}),policy).handle(data,{
   origin:'TELEGRAM_PRIVATE',actorId:actor,chatId:actor,verified:true
  });
 const inlineDetails=async(chatId:string)=>{
  const state=await store.snapshot();
  const c=state.chats.find(x=>x.id===chatId)!;
  return inline('mi:1:g:d:'+chatId+':'+c.version+':0');
 };
 const iButtons=(v:Awaited<ReturnType<typeof inline>>)=>
  v?.keyboard.inline_keyboard.flat()??[];
 const legacyButtons=(v:Awaited<ReturnType<typeof legacy>>)=>
  v?.keyboard.keyboard.flat().map(x=>x.text)??[];
 const snap=()=>store.snapshot();
 const close=()=>rm(dir,{recursive:true,force:true});
 return {store,policy,group,duplicate,addOp,inline,legacy,inlineDetails,
  iButtons,legacyButtons,snap,close};
}
for(const engine of ['json','sqlite'] as const){
 for(const [name,transform] of [
  ['exact copy',(c:Chat):Chat=>({...c,scopes:[...c.scopes]})],
  ['revoked later approval',(c:Chat):Chat=>({...c,approved:false,scopes:[],version:c.version+1})],
  ['newer version',(c:Chat):Chat=>({...c,version:c.version+3})],
  ['scope drift',(c:Chat):Chat=>({...c,scopes:['navigation']})]
 ] as const){
  test(engine+' owner group interfaces quarantine '+name+' and keep unrelated group available',async()=>{
   const f=await fixture(engine);try{
    await f.duplicate(transform(f.group));
    const before=await f.snap();
    const inline=await f.inline('mi:1:g:p:0');
    const legacy=await f.legacy(groupMenuLabel);
    const i=f.iButtons(inline).filter(x=>x.callback_data.startsWith('mi:1:g:d:'));
    const k=f.legacyButtons(legacy).filter(x=>x.startsWith('🏷️ محادثة · '));
    assert.equal(i.length,1);
    assert.equal(k.length,1);
    assert.match(i[0]!.callback_data,new RegExp(B));
    assert.equal(k[0],'🏷️ محادثة · '+B);
    assert.match(inline?.text??'',/مجموعات متعارضة محجوبة: 1/);
    assert.match(legacy?.text??'',/مجموعات متعارضة محجوبة: 1/);
    assert.equal(await f.inlineDetails(A),null);
    assert.equal(await f.legacy('🏷️ محادثة · '+A),null);
    assert.ok(await f.inline(i[0]!.callback_data));
    assert.ok(await f.legacy('🏷️ محادثة · '+B));
    assert.deepEqual(await f.snap(),before);
   }finally{await f.close();}
  });
 }
 test(engine+' revoked-first restored approval cannot be reopened by later approved duplicate',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    const c=s.chats.find(x=>x.id===A)!;c.approved=false;c.scopes=[];
   });
   await f.duplicate();
   assert.equal(await f.inlineDetails(A),null);
   assert.equal(await f.legacy('🏷️ محادثة · '+A),null);
   assert.equal(f.iButtons(await f.inline('mi:1:g:p:0')).filter(x=>
    x.callback_data.includes(':'+A+':')).length,0);
  }finally{await f.close();}
 });
 test(engine+' existing opaque inline group selectors and reversal selector expire on duplicate restore',async()=>{
  const f=await fixture(engine);try{
   await f.addOp();
   const before=await f.inline('mi:1:g:p:0');
   const selector=f.iButtons(before).find(x=>x.callback_data.includes(':'+A+':'))!;
   const details=await f.inline(selector.callback_data);
   const reversal=f.iButtons(details).find(x=>x.callback_data.startsWith('mi:1:g:r:'))!;
   assert.ok(reversal);
   const review=await f.legacy('🏷️ محادثة · '+A);
   const oldLabel=f.legacyButtons(review).find(x=>x.startsWith('🚫 مراجعة الإلغاء · '))!;
   await f.duplicate();
   const frozen=await f.snap();
   assert.equal(await f.inline(selector.callback_data),null);
   assert.equal(await f.inline(reversal.callback_data),null);
   assert.equal(await f.legacy(oldLabel),null);
   assert.deepEqual(await f.snap(),frozen);
  }finally{await f.close();}
 });
 test(engine+' restored duplicate approval prevents direct reversal inventory from claiming an empty clean ledger',async()=>{
  const f=await fixture(engine);try{
   await f.addOp();await f.duplicate();
   const state=await f.snap();
   assert.deepEqual(groupReversalInventory(state,f.policy,f.group),
    {total:0,unknown:0,pending:0,activeReasons:0,unproven:0,stale:0,inspect:0});
   const displayed=renderReversalInventory(state,f.policy,f.group);
   assert.match(displayed,/متعذر|تعارض|غير موثوق/);
   assert.doesNotMatch(displayed,/لا توجد سجلات عقوبات/);
   assert.doesNotMatch(displayed,/مرشحة لفحص خارجي: [1-9]/);
  }finally{await f.close();}
 });
 test(engine+' owner group dashboards remain restricted to verified owner-private origin',async()=>{
  const f=await fixture(engine);try{
   await f.duplicate();
   assert.equal(await f.inline('mi:1:g:p:0','200'),null);
   assert.equal(await f.legacy(groupMenuLabel,'200'),null);
  }finally{await f.close();}
 });
 test(engine+' duplicate group with only revoked copies never appears as authorized',async()=>{
  const f=await fixture(engine);try{
   await f.store.transaction(s=>{
    const c=s.chats.find(x=>x.id===A)!;c.approved=false;
    s.chats.push({...c,version:c.version+2});
   });
   assert.equal(f.iButtons(await f.inline('mi:1:g:p:0')).filter(x=>
    x.callback_data.includes(':'+A+':')).length,0);
   assert.equal(await f.legacy('🏷️ محادثة · '+A),null);
  }finally{await f.close();}
 });
}

async function reversalFixture(engine:Engine){
 const f=await fixture(engine);await f.addOp();
 let reads=0,during:(()=>Promise<void>)|undefined;
 const observer:RestrictionObserver={observeRestriction:async()=>{
  reads++;if(during)await during();return 'BAN_PRESENT';
 }};
 const inspect=()=>new ModerationReversalPreflight(f.store,f.policy,observer)
  .assess(OWNER,A,TARGET);
 const operation=(id:string,chatId=B):ModerationOperation=>({
  id,chatId,memberId:'401',actorId:OWNER,kind:'BAN',
  reasonFingerprint:'REDACTED',policyVersion:1,
  status:'CONFIRMED',createdAt:NOW-200,attemptGateway:'TELEGRAM_API'
 });
 return {...f,inspect,operation,reads:()=>reads,
  during:(callback:()=>Promise<void>)=>{during=callback}};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' global duplicate operation ID injected while Telegram observer awaits blocks stale read',async()=>{
  const f=await reversalFixture(engine);try{
   f.during(()=>f.store.transaction(s=>s.moderationOperations.push(
    f.operation('confirmed-A'))));
   assert.equal((await f.inspect()).status,'BLOCKED_STALE');
   assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' malformed unrelated moderation outcome injected during observer blocks stale read',async()=>{
  const f=await reversalFixture(engine);try{
   f.during(()=>f.store.transaction(s=>s.moderationOperations.push(
    {...f.operation('corrupt-elsewhere'),status:'NOT_REAL' as ModerationOperation['status']})));
   assert.equal((await f.inspect()).status,'BLOCKED_STALE');
   assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' valid unrelated moderation operation during observer does not unnecessarily hide independent evidence',async()=>{
  const f=await reversalFixture(engine);try{
   f.during(()=>f.store.transaction(s=>s.moderationOperations.push(
    f.operation('unrelated-unique'))));
   assert.deepEqual(await f.inspect(),
    {status:'OBSERVED_NOT_ATTRIBUTABLE',kind:'BAN'});
   assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
 test(engine+' altered owner target record during observer remains BLOCKED_STALE',async()=>{
  const f=await reversalFixture(engine);try{
   f.during(()=>f.store.transaction(s=>{
    s.moderationOperations[0]!.createdAt=NOW+1;
   }));
   assert.equal((await f.inspect()).status,'BLOCKED_STALE');
   assert.equal(f.reads(),1);
  }finally{await f.close();}
 });
}
