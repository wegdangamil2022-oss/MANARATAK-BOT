import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {ModerationCommandReview,type ModerationCommandScreen} from '../src/telegram-moderation-command-review.js';
import {GROUP_PERMISSION_KEYS} from '../src/group-permission-model.js';

const NOW=1700000000000,CHAT='-100123',TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const route=(s:ModerationCommandScreen|null,letter='c')=>{assert.ok(s);const b=s.keyboard.inline_keyboard.flat().find(b=>b.callback_data.startsWith('mc:1:'+letter+':'));assert.ok(b);return b.callback_data;};
for(const engine of ['json','sqlite'] as const){
 async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'reviewed-restoration-')),store=new BotStore(join(dir,'state.'+engine),{engine});let now=NOW,running=true,rights=true,lost=false,retain=false;
  let target:Record<string,unknown>={status:'member',user:{id:300,is_bot:false}};
  const writes:{method:string;body:Record<string,unknown>}[]=[];let readHook:(()=>Promise<void>)|undefined;
  const request=(async(url:unknown,init:RequestInit)=>{
   const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));let result:unknown;
   if(method==='getChat')result={id:Number(CHAT),type:'supergroup',permissions:{can_send_messages:true,can_invite_users:false,can_pin_messages:false}};
   else if(method==='getChatMember'){
    if(readHook)await readHook();result=body.user_id===123456789?{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:rights}:structuredClone(target);
   }else{
    writes.push({method,body});const isRestore=method==='unbanChatMember'||method==='restrictChatMember'&&Object.values(body.permissions).every(v=>v===true);
    if(!retain){
     if(method==='banChatMember')target={status:'kicked',user:{id:300,is_bot:false},until_date:body.until_date??0};
     else if(method==='unbanChatMember')target={status:'left',user:{id:300,is_bot:false}};
     else if(method==='restrictChatMember'&&isRestore)target={status:'member',user:{id:300,is_bot:false}};
     else if(method==='restrictChatMember')target={status:'restricted',user:{id:300,is_bot:false},is_member:true,until_date:body.until_date??0,...Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,false]))};
     else assert.fail('Unexpected mutating method');
    }
    if(lost&&isRestore)throw Error('Lost acknowledgement');result=true;
   }
   return Response.json({ok:true,result});
  }) as typeof fetch;
  const policy=new Policy(store,'100',()=>now);await policy.approveChat('100',CHAT,['moderation']);await policy.grant('100','200','chat.manage',CHAT,NOW+1000000);
  const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>running,()=>now),service=new ModerationService(store,policy,gateway,()=>now),review=new ModerationCommandReview(store,policy,service,()=>now);
  const sanction=async(kind:'MUTE'|'BAN'='MUTE')=>{assert.equal((await service.addManualReason('100',CHAT,'300','case',kind,undefined,600)).status,'APPLIED');now+=1000;};
  const preview=(kind:'unban'|'unmute'='unmute',actor='100')=>review.preview(actor,CHAT,{kind,reference:'case',memberId:'300'});
  return {store,policy,gateway,service,review,writes,sanction,preview,target:()=>target,change:(v:Record<string,unknown>)=>{target=v;},time:(v:number)=>{now=v;},stop:()=>{running=false;},noRights:()=>{rights=false;},lose:()=>{lost=true;},retain:()=>{retain=true;},hook:(v:()=>Promise<void>)=>{readHook=v;},close:()=>rm(dir,{recursive:true,force:true})};
 }
 test(engine+' explicit owner review restores an originally unrestricted member through the existing ledger and verifies readback',async()=>{
  for(const kind of ['MUTE','BAN'] as const){
   const f=await fixture();try{
    await f.sanction(kind);assert.equal(f.writes.length,1);const original=(await f.store.snapshot()).moderationOperations[0]!;assert.equal(original.baselineMode,'INHERIT_GROUP_DEFAULTS');
    assert.equal(await f.preview(kind==='BAN'?'unban':'unmute','200'),null);
    const p=await f.preview(kind==='BAN'?'unban':'unmute');assert.ok(p);assert.match(p.text,/تطابق الحالة لا يثبت/u);assert.equal(f.writes.length,1);
    const confirm=route(p);assert.equal(await f.review.handle('200',confirm),null);
    const result=await f.review.handle('100',confirm);assert.equal(result?.status,'APPLIED');assert.equal(f.writes.length,2);
    const last=f.writes[1]!;assert.equal(last.method,kind==='BAN'?'unbanChatMember':'restrictChatMember');
    if(kind==='BAN'){assert.equal(last.body.only_if_banned,true);assert.equal(f.target().status,'left');}
    else{assert.equal(last.body.use_independent_chat_permissions,true);assert.ok(GROUP_PERMISSION_KEYS.every(k=>(last.body.permissions as Record<string,unknown>)[k]===true));assert.equal(f.target().status,'member');}
    const state=await f.store.snapshot();assert.equal(state.moderationReasons[0]!.active,false);assert.equal(state.moderationOperations.at(-1)!.reverses,original.id);assert.equal(state.moderationOperations.at(-1)!.status,'CONFIRMED');
    assert.equal(await f.review.handle('100',confirm),null);assert.equal(f.writes.length,2);
   }finally{await f.close();}
  }
 });
 test(engine+' legacy provenance, independent reasons, altered permissions or deadline cannot authorize restoration',async()=>{
  for(const reason of ['legacy','independent','permission','deadline','administrator','bot'] as const){
   const f=await fixture();try{
    await f.sanction();
    if(reason==='legacy')await f.store.transaction(s=>{delete s.moderationOperations[0]!.baselineMode;});
    if(reason==='independent')await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'SUBSCRIPTION',kind:'MUTE',reference:'gate',createdBy:'100',active:true});});
    if(reason==='permission')f.change({...f.target(),can_send_photos:true});
    if(reason==='deadline')f.change({...f.target(),until_date:NOW/1000+900});
    if(reason==='administrator')f.change({...f.target(),status:'administrator'});
    if(reason==='bot')f.change({...f.target(),user:{id:300,is_bot:true}});
    assert.equal(await f.preview(),null);assert.equal(f.writes.length,1);assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);
   }finally{await f.close();}
  }
 });
 test(engine+' direct removals and read-only observers cannot use the reviewed restoration path',async()=>{
  const f=await fixture();try{
   await f.sanction();assert.equal((await f.service.removeManualReason('100',CHAT,'300','case','MUTE')).status,'DENIED');
   assert.equal(await f.gateway.observeRestriction(CHAT,'300'),'MUTE_PRESENT');assert.equal(await f.gateway.setRestriction(CHAT,'300','NONE',async()=>true),'FAILED_CONFIRMED');
   assert.equal(f.writes.length,1);assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);
  }finally{await f.close();}
 });
 test(engine+' expired/cancelled decisions, emergency STOP and revoked rights deny before release',async()=>{
  for(const reason of ['expiry','cancel','stop','rights','source'] as const){
   const f=await fixture();try{
    await f.sanction();const p=await f.preview(),confirm=route(p);
    if(reason==='expiry')f.time(NOW+121000);if(reason==='cancel')await f.review.handle('100',route(p,'x'));if(reason==='stop')f.stop();if(reason==='rights')f.noRights();
    if(reason==='source')await f.store.transaction(s=>{delete s.moderationOperations[0]!.baselineMode;});
    const result=await f.review.handle('100',confirm);assert.notEqual(result?.status,'APPLIED');assert.equal(f.writes.length,1);
   }finally{await f.close();}
  }
 });
 test(engine+' lost response or failed readback stays unknown and never retries restoration',async()=>{
  for(const mode of ['lost','readback'] as const){
   const f=await fixture();try{
    await f.sanction();const p=await f.preview();if(mode==='lost')f.lose();else f.retain();
    const confirm=route(p);assert.equal((await f.review.handle('100',confirm))?.status,'UNKNOWN');assert.equal(f.writes.length,2);assert.equal((await f.store.snapshot()).moderationOperations.at(-1)!.status,'UNKNOWN_OUTCOME');assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);
    assert.equal(await f.review.handle('100',confirm),null);assert.equal(await f.preview(),null);assert.equal(f.writes.length,2);
   }finally{await f.close();}
  }
 });
 test(engine+' late remote conflict keeps the local reason active and a fresh human decision is required for recovery',async()=>{
  const f=await fixture();try{
   await f.sanction();const p=await f.preview();let changed=false;
   f.service.beforeDispatch=async()=>{changed=true;f.change({...f.target(),can_send_photos:true});};
   assert.equal((await f.review.handle('100',route(p)))?.status,'DENIED');assert.equal(changed,true);assert.equal(f.writes.length,1);
   assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);assert.equal((await f.store.snapshot()).moderationOperations.at(-1)!.status,'CANCELLED');
   assert.equal(await f.preview(),null);f.change({...f.target(),can_send_photos:false});f.service.beforeDispatch=undefined;
   const fresh=await f.preview();assert.ok(fresh);assert.equal((await f.review.handle('100',route(fresh)))?.status,'APPLIED');assert.equal(f.writes.length,2);
  }finally{await f.close();}
 });
 test(engine+' an independent reason arriving after intent cancels restoration and preserves both reasons',async()=>{
  const f=await fixture();try{
   await f.sanction();const p=await f.preview();f.service.beforeDispatch=async()=>{await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'SUBSCRIPTION',kind:'MUTE',reference:'late_gate',createdBy:'100',active:true});});};
   assert.equal((await f.review.handle('100',route(p)))?.status,'DENIED');assert.equal(f.writes.length,1);assert.ok((await f.store.snapshot()).moderationReasons.every(r=>r.active));
  }finally{await f.close();}
 });
 test(engine+' rewritten restoration receipts/source evidence and a late STOP cannot release the member',async()=>{
  for(const mode of ['receipt','baseline','stop'] as const){
   const f=await fixture();try{
    await f.sanction();const p=await f.preview();
    if(mode==='stop')f.hook(async()=>{if((await f.store.snapshot()).moderationOperations.some(o=>o.kind==='NONE'&&o.status==='STARTED'))f.stop();});
    else f.service.beforeDispatch=async()=>{await f.store.transaction(s=>{if(mode==='receipt')s.moderationOperations.at(-1)!.reverses='rewritten';else delete s.moderationOperations[0]!.baselineMode;});};
    assert.notEqual((await f.review.handle('100',route(p)))?.status,'APPLIED');assert.equal(f.writes.length,1);assert.equal((await f.store.snapshot()).moderationReasons[0]!.active,true);
   }finally{await f.close();}
  }
 });
 test(engine+' replacing a restoration gateway method cannot certify dispatch provenance',async()=>{
  const f=await fixture();try{
   await f.sanction();f.gateway.restoreFromReviewedDecision=async()=> 'CONFIRMED';assert.equal(TelegramBotApiModerationGateway.usesOfficialDispatch(f.gateway),false);assert.equal(await f.preview(),null);assert.equal(f.writes.length,1);
  }finally{await f.close();}
 });
 test(engine+' retiring a satisfied manual reason preserves an independent sanction and its later reviewed restoration',async()=>{for(const kind of ['MUTE','BAN'] as const){const f=await fixture();try{await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'MANUAL',reference:'captcha_case',kind:'MUTE',createdBy:'100',active:true,expiresAt:NOW+600000});});await f.sanction(kind);const before=await f.store.snapshot(),remote=structuredClone(f.target());assert.equal((await f.service.retireManualReasonPreservingRestriction('100',CHAT,'300','captcha_case','MUTE',()=>true,NOW+121000)).status,'APPLIED');const after=await f.store.snapshot();assert.equal(after.moderationReasons.find(r=>r.reference==='captcha_case')!.active,false);assert.equal(after.moderationReasons.find(r=>r.reference==='case')!.active,true);assert.deepEqual(after.moderationOperations,before.moderationOperations);assert.deepEqual(f.target(),remote);assert.equal(f.writes.length,1);const reopened=new BotStore(f.store.file,{engine}),service=new ModerationService(reopened,f.policy,f.gateway,()=>NOW+1000),review=new ModerationCommandReview(reopened,f.policy,service,()=>NOW+1000),preview=await review.preview('100',CHAT,{kind:kind==='BAN'?'unban':'unmute',reference:'case',memberId:'300'});assert.ok(preview);const result=await review.handle('100',route(preview));assert.equal(result?.status,'APPLIED');assert.equal(f.writes.length,2);}finally{await f.close();}}});

 test(engine+' retirement refuses changed remote state, changed evidence, expired review and unresolved operations',async()=>{for(const mode of ['clear','permission','deadline','rights','stop','expired','stale','pending','unknown','last','weaker'] as const){const f=await fixture();try{if(mode!=='last')await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'MANUAL',reference:'captcha_case',kind:'MUTE',createdBy:'100',active:true,...(mode==='weaker'?{}:{expiresAt:NOW+600000})});});await f.sanction();if(mode==='last'){}else if(mode==='clear')f.change({status:'member',user:{id:300,is_bot:false}});else if(mode==='permission')f.change({...f.target(),can_send_photos:true});else if(mode==='deadline')f.change({...f.target(),until_date:NOW/1000+900});else if(mode==='rights')f.noRights();else if(mode==='stop')f.stop();else if(mode==='expired')f.time(NOW+121000);else if(mode==='stale'){let once=false;f.hook(async()=>{if(!once){once=true;await f.store.transaction(s=>{s.moderationReasons.find(r=>r.reference==='case')!.expiresAt=NOW+900000;});}});}else if(mode==='pending'||mode==='unknown')await f.store.transaction(s=>{s.moderationOperations.push({...s.moderationOperations[0]!,id:'2d33b4c5-e67f-4890-a123-4567890abcde',status:mode==='pending'?'STARTED':'UNKNOWN_OUTCOME',createdAt:NOW+1000});});const result=await f.service.retireManualReasonPreservingRestriction('100',CHAT,'300',mode==='last'?'case':'captcha_case','MUTE',()=>true,NOW+121000);assert.notEqual(result.status,'APPLIED',mode);assert.equal((await f.store.snapshot()).audit.filter(a=>a.updateKey.startsWith('moderation:reason-retired:')).length,0);assert.ok((await f.store.snapshot()).moderationReasons.every(r=>r.active));assert.equal(f.writes.length,1);}finally{await f.close();}}});
 test(engine+' a retirement chain preserves the original operation and rejects modified or duplicated local receipts',async()=>{for(const mode of ['valid','duplicate','modified','missing','owner','source','reordered'] as const){const f=await fixture();try{await f.store.transaction(s=>{for(const reference of ['captcha_case','captcha_other'])s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'MANUAL',reference,kind:'MUTE',createdBy:'100',active:true,expiresAt:NOW+600000});});await f.sanction();for(const reference of ['captcha_case','captcha_other'])assert.equal((await f.service.retireManualReasonPreservingRestriction('100',CHAT,'300',reference,'MUTE',()=>true,NOW+121000)).status,'APPLIED');assert.equal(f.writes.length,1);assert.equal((await f.store.snapshot()).moderationOperations.length,1);await f.store.transaction(s=>{const rows=s.audit.filter(a=>a.updateKey.startsWith('moderation:reason-retired:')),a=rows[0]!;if(mode==='duplicate')s.audit.push({...a});if(mode==='modified'){const v=JSON.parse(a.reason);v.after='[]';a.reason=JSON.stringify(v);}if(mode==='missing')s.audit=s.audit.filter(x=>x!==a);if(mode==='owner')a.actorId='200';if(mode==='source')s.moderationOperations[0]!.reasonFingerprint='[]';if(mode==='reordered')s.audit.reverse();});assert.equal((await f.preview())!==null,mode==='valid'||mode==='reordered',mode);assert.equal(f.writes.length,1);}finally{await f.close();}}});

 test(engine+' independent timed sanctions still expire after a locally retired reason without a remote unmute',async()=>{const f=await fixture();try{await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'MANUAL',reference:'captcha_case',kind:'MUTE',createdBy:'100',active:true,expiresAt:NOW+600000});});await f.sanction();assert.equal((await f.service.retireManualReasonPreservingRestriction('100',CHAT,'300','captcha_case','MUTE',()=>true,NOW+121000)).status,'APPLIED');f.time(NOW+600001);f.change({status:'member',user:{id:300,is_bot:false}});assert.equal((await f.service.expireManualReasons('100',CHAT,'300')).status,'APPLIED');assert.equal(f.writes.length,1);const s=await f.store.snapshot();assert.ok(s.moderationReasons.every(r=>!r.active));assert.equal(s.moderationOperations.at(-1)!.kind,'NONE');}finally{await f.close();}});

 test(engine+' retirement requires owner authority, a current decision and the official preservation reader',async()=>{for(const mode of ['delegate','cancelled','shadow'] as const){const f=await fixture();try{await f.store.transaction(s=>{s.moderationReasons.push({chatId:CHAT,memberId:'300',source:'MANUAL',reference:'captcha_case',kind:'MUTE',createdBy:'100',active:true,expiresAt:NOW+600000});});await f.sanction();if(mode==='shadow')f.gateway.confirmPreservedRestriction=async()=>true;const result=await f.service.retireManualReasonPreservingRestriction(mode==='delegate'?'200':'100',CHAT,'300','captcha_case','MUTE',()=>mode!=='cancelled',NOW+121000);assert.notEqual(result.status,'APPLIED');assert.equal(f.writes.length,1);assert.ok((await f.store.snapshot()).moderationReasons.every(r=>r.active));}finally{await f.close();}}});

}
