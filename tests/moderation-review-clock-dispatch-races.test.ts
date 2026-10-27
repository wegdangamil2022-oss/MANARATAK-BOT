import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type BotState,type ModerationOperation,type AuditRecord} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,FakeModerationGateway,type ModerationGateway} from '../src/moderation.js';
import {moderationLedgerSafeForDispatch,moderationReviewEvidenceDigest} from '../src/moderation-review-integrity.js';
import {inspectLocalReversal,ModerationReversalPreflight} from '../src/moderation-reversal-preflight.js';

const NOW=1_800_000_000_000;
const OWNER='100',BAD_CHAT='-100123',GOOD_CHAT='-100456',TARGET='300';
const SHADOW='301';
const options=(ops:ModerationOperation[],audit:AuditRecord[])=>
 ({moderationOperations:ops,audit});
const noTimeLeak=(state:ReturnType<typeof options>,now:number)=>
 (moderationLedgerSafeForDispatch as unknown as
  (s:ReturnType<typeof options>,asOf:number)=>boolean)(state,now);
const localInspect=(s:BotState,policy:Policy,now:number)=>
 (inspectLocalReversal as unknown as
  (s:BotState,p:Policy,chat:string,member:string,asOf:number)=>ReturnType<typeof inspectLocalReversal>)
 (s,policy,GOOD_CHAT,TARGET,now);
const pending=(version=1):ModerationOperation=>({
 id:'historical-private-reference',chatId:BAD_CHAT,memberId:SHADOW,
 actorId:OWNER,kind:'MUTE',reasonFingerprint:'PRIVATE_FINGERPRINT',
 policyVersion:version,status:'UNKNOWN_OUTCOME',createdAt:NOW-20_000,
 attemptGateway:'TELEGRAM_API'
});
function reviewFixture(op:ModerationOperation,at=NOW+60_000,legacy=false){
 const digest=moderationReviewEvidenceDigest(op);
 const updated:ModerationOperation={...op,review:{
  decision:'ACKNOWLEDGED_UNRESOLVED',reviewedBy:OWNER,reviewedAt:at,
  policyVersion:op.policyVersion,...(legacy?{}:{evidenceDigest:digest})
 }};
 const audit:AuditRecord={
  updateKey:'owner:moderation:review:'+
   createHash('sha256').update('MODERATION:REVIEW:'+op.id).digest('hex').slice(0,32),
  actorId:OWNER,decision:'ALLOW',reason:'MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED',
  policyVersion:op.policyVersion,at,
  ...(legacy?{}:{moderationEvidenceDigest:digest})
 };
 return {updated,audit};
}
test('global sanction readiness rejects a digest-corroborated review from the future',()=>{
 const e=reviewFixture(pending());
 assert.equal(noTimeLeak(options([e.updated],[e.audit]),NOW),false);
});
test('future legacy unbound review still quarantines live dispatch',()=>{
 const e=reviewFixture(pending(),NOW+60_000,true);
 assert.equal(noTimeLeak(options([e.updated],[e.audit]),NOW),false);
});
test('the exact review timestamp restores local consistency without retry authorization',()=>{
 const e=reviewFixture(pending(),NOW+60_000);
 assert.equal(noTimeLeak(options([e.updated],[e.audit]),NOW+59_999),false);
 assert.equal(noTimeLeak(options([e.updated],[e.audit]),NOW+60_000),true);
});
test('unreviewed UNKNOWN and past valid bound review do not impose a global clock blockade',()=>{
 assert.equal(noTimeLeak(options([pending()],[]),NOW),true);
 const e=reviewFixture(pending(),NOW-500);
 assert.equal(noTimeLeak(options([e.updated],[e.audit]),NOW),true);
});
test('invalid current clock fails closed when time-bound review evidence exists',()=>{
 const e=reviewFixture(pending(),NOW-500);
 assert.equal(noTimeLeak(options([e.updated],[e.audit]),Number.NaN),false);
 assert.equal(noTimeLeak(options([e.updated],[e.audit]),-1),false);
});
async function fixture(engine:'json'|'sqlite'){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-review-race-clock-'));
 const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
 const store=new BotStore(file,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,BAD_CHAT,['moderation']);
 await policy.approveChat(OWNER,GOOD_CHAT,['moderation']);
 const revision=policy.chatRevision(await store.snapshot(),BAD_CHAT);
 let now=NOW;
 const clock=()=>now;
 const inject=async(at=NOW+60_000)=>{
  const e=reviewFixture(pending(revision),at);
  await store.transaction(s=>{s.moderationOperations.push(e.updated);s.audit.push(e.audit);});
 };
 return {store,policy,clock,inject,setNow:(value:number)=>{now=value},
  close:()=>rm(dir,{recursive:true,force:true})};
}
for(const engine of ['json','sqlite'] as const){
 test(engine+' rejects future-dated review restored during awaited canRestrict before STARTED',async()=>{
  const f=await fixture(engine);try{
   const gateway=new FakeModerationGateway();
   const service=new ModerationService(f.store,f.policy,gateway,f.clock);
   service.beforeDispatch=async()=>{await f.inject();};
   const result=await service.addManualReason(OWNER,GOOD_CHAT,TARGET,'fresh','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0,'the provider mutation must never start');
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations.find(o=>o.id==='historical-private-reference')?.review?.reviewedAt,NOW+60_000);
   assert.equal(s.audit.some(a=>a.reason==='MODERATION_UNKNOWN_OWNER_ACKNOWLEDGED'),true);
   assert.equal(s.moderationOperations.filter(o=>o.chatId===GOOD_CHAT&&o.memberId===TARGET)
    .every(o=>o.status!=='CONFIRMED'),true);
  }finally{await f.close();}
 });
 test(engine+' authority callback detects a future review injected AFTER STARTED but before remote mutation',async()=>{
  const f=await fixture(engine);try{
   let verifierResult:boolean|undefined;
   let sends=0;
   const gateway:ModerationGateway={
    canRestrict:async()=>true,isProtected:async()=>false,
    setRestriction:async(_chat,_target,_kind,verify)=>{
     await f.inject();
     verifierResult=await verify?.();
     if(verifierResult)sends++;
     return verifierResult?'CONFIRMED':'UNKNOWN_OUTCOME';
    }
   };
   const service=new ModerationService(f.store,f.policy,gateway,f.clock);
   const result=await service.addManualReason(OWNER,GOOD_CHAT,TARGET,'fresh','BAN');
   assert.equal(verifierResult,false);
   assert.equal(sends,0);
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   const s=await f.store.snapshot();
   assert.equal(s.moderationOperations.some(o=>o.chatId===GOOD_CHAT&&
     o.memberId===TARGET&&o.status==='UNKNOWN_OUTCOME'),true);
  }finally{await f.close();}
 });
 test(engine+' clock rollback during dispatch preparation invalidates restored review authority',async()=>{
  const f=await fixture(engine);try{
   const gateway=new FakeModerationGateway();
   await f.inject(NOW-1000);
   const service=new ModerationService(f.store,f.policy,gateway,f.clock);
   service.beforeDispatch=async()=>{f.setNow(NOW-2000);};
   const result=await service.addManualReason(OWNER,GOOD_CHAT,TARGET,'fresh','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(gateway.calls.length,0);
  }finally{await f.close();}
 });
 test(engine+' reversal assessment suppresses remote observation for future audited review in other group',async()=>{
  const f=await fixture(engine);try{
   await f.inject();
   await f.store.transaction(s=>s.moderationOperations.push({
    id:'known-restriction',chatId:GOOD_CHAT,memberId:TARGET,actorId:OWNER,
    kind:'BAN',reasonFingerprint:'OTHER_PRIVATE_PROOF',
    policyVersion:f.policy.chatRevision(s,GOOD_CHAT),status:'CONFIRMED',
    createdAt:NOW-1000,attemptGateway:'TELEGRAM_API'
   }));
   const s=await f.store.snapshot();
   assert.equal(localInspect(s,f.policy,NOW).status,'BLOCKED_UNPROVEN');
   let remote=0;
   const observer={observeRestriction:async()=>{remote++;return 'BAN_PRESENT' as const;}};
   const Preflight=ModerationReversalPreflight as unknown as
    new(store:BotStore,policy:Policy,observer:{observeRestriction:(chat:string,member:string)=>Promise<'BAN_PRESENT'>},clock:()=>number)=>ModerationReversalPreflight;
   const result=await new Preflight(f.store,f.policy,observer,f.clock).assess(OWNER,GOOD_CHAT,TARGET);
   assert.equal(result.status,'BLOCKED_UNPROVEN');
   assert.equal(remote,0);
  }finally{await f.close();}
 });
}
