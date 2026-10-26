import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type ModerationOperation} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway} from '../src/moderation.js';

const OWNER='100',GROUP='-100123',TARGET='300',OTHER='301',NOW=1_700_000_000_000;
type Engine='json'|'sqlite';
const historical=(id:string,status:ModerationOperation['status']='CONFIRMED'):
 ModerationOperation=>({
 id,chatId:'-100999',memberId:'399',actorId:OWNER,kind:'BAN',
 reasonFingerprint:'restored-opaque',policyVersion:1,status,createdAt:NOW-5000
});

async function fixture(engine:Engine){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-quarantine-'));
 const path=join(dir,engine==='json'?'state.json':'state.sqlite');
 const store=new BotStore(path,{engine}),policy=new Policy(store,OWNER,()=>NOW);
 await policy.approveChat(OWNER,GROUP,['moderation']);
 let sends=0;
 let inject:((s:BotStore)=>Promise<void>)|undefined;
 const gateway:ModerationGateway={
  canRestrict:async()=>true,
  isProtected:async()=>false,
  setRestriction:async()=>{sends++;if(inject)await inject(store);return 'CONFIRMED';}
 };
 const service=new ModerationService(store,policy,gateway,()=>NOW);
 const reopened=()=>new ModerationService(new BotStore(path,{engine}),
  new Policy(new BotStore(path,{engine}),OWNER,()=>NOW),gateway,()=>NOW);
 return {store,service,reopened,sends:()=>sends,
  onSend:(fn:(s:BotStore)=>Promise<void>)=>{inject=fn;},
  close:()=>rm(dir,{recursive:true,force:true})};
}
const recovery=(ops:ModerationOperation[])=>
 ops.find(x=>x.status==='UNKNOWN_OUTCOME'&&x.memberId===TARGET);
const preserved=(ops:ModerationOperation[],originalId:string)=>
 ops.find(x=>x.id===originalId);

for(const engine of ['json','sqlite'] as const){
 test(engine+' preserves terminal rewrite after network and appends a separate unresolved recovery',async()=>{
  const f=await fixture(engine);
  try{
   let originalId='';
   f.onSend(async store=>store.transaction(s=>{
    const item=s.moderationOperations.at(-1)!;
    originalId=item.id;
    item.status='CONFIRMED';
   }));
   const result=await f.service.addManualReason(OWNER,GROUP,TARGET,'case','BAN');
   assert.equal(result.status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
   const rows=(await f.store.snapshot()).moderationOperations;
   assert.equal(rows.length,2);
   assert.equal(preserved(rows,originalId)?.status,'CONFIRMED',
    'do not destroy an independently changed terminal status');
   assert.equal(recovery(rows)?.kind,'BAN');
   assert.notEqual(recovery(rows)?.id,originalId);
   assert.equal((await f.reopened().reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' preserves externally changed member and protects BOTH restored targets',async()=>{
  const f=await fixture(engine);
  try{
   let originalId='';
   f.onSend(async store=>store.transaction(s=>{
    const item=s.moderationOperations.at(-1)!;
    originalId=item.id;item.memberId=OTHER;
   }));
   assert.equal((await f.service.addManualReason(OWNER,GROUP,TARGET,'case','MUTE')).status,
    'BLOCKED_UNKNOWN');
   const rows=(await f.store.snapshot()).moderationOperations;
   assert.equal(rows.length,2);
   assert.equal(preserved(rows,originalId)?.memberId,OTHER);
   assert.equal(preserved(rows,originalId)?.status,'STARTED');
   assert.equal(recovery(rows)?.memberId,TARGET);
   assert.equal(recovery(rows)?.kind,'MUTE');
   assert.equal((await f.reopened().reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal((await f.reopened().reconcile(OWNER,GROUP,OTHER)).status,'BLOCKED_PENDING');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' keeps forged action kind instead of overwriting conflicting evidence',async()=>{
  const f=await fixture(engine);
  try{
   let originalId='';
   f.onSend(async store=>store.transaction(s=>{
    const item=s.moderationOperations.at(-1)!;
    originalId=item.id;item.kind='MUTE';
   }));
   assert.equal((await f.service.addManualReason(OWNER,GROUP,TARGET,'case','BAN')).status,
    'BLOCKED_UNKNOWN');
   const rows=(await f.store.snapshot()).moderationOperations;
   assert.equal(rows.length,2);
   assert.equal(preserved(rows,originalId)?.kind,'MUTE');
   assert.equal(recovery(rows)?.kind,'BAN');
   assert.equal((await f.reopened().reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
  }finally{await f.close();}
 });
 test(engine+' retains forged original ID replacement and quarantines missing receipt',async()=>{
  const f=await fixture(engine);
  try{
   f.onSend(async store=>store.transaction(s=>{
    s.moderationOperations.at(-1)!.id='substituted-operation';
   }));
   assert.equal((await f.service.addManualReason(OWNER,GROUP,TARGET,'case','BAN')).status,
    'BLOCKED_UNKNOWN');
   const rows=(await f.store.snapshot()).moderationOperations;
   assert.equal(rows.length,2);
   assert.equal(rows[0]?.id,'substituted-operation');
   assert.equal(rows[0]?.status,'STARTED');
   assert.equal(recovery(rows)?.status,'UNKNOWN_OUTCOME');
   assert.notEqual(recovery(rows)?.id,'substituted-operation');
   assert.equal((await f.reopened().reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
  }finally{await f.close();}
 });
 test(engine+' invalid unrelated restore cannot hide an altered post-send original receipt',async()=>{
  const f=await fixture(engine);
  try{
   let originalId='';
   f.onSend(async store=>store.transaction(s=>{
    const item=s.moderationOperations.at(-1)!;
    originalId=item.id;item.memberId=OTHER;
    s.moderationOperations.push({...historical('unrelated-corrupt'),
     status:'SENT' as ModerationOperation['status']});
   }));
   assert.equal((await f.service.addManualReason(OWNER,GROUP,TARGET,'case','BAN')).status,
    'BLOCKED_UNKNOWN');
   const rows=(await f.store.snapshot()).moderationOperations;
   assert.equal(rows.length,3);
   assert.equal(preserved(rows,originalId)?.memberId,OTHER);
   assert.equal(rows.find(x=>x.id==='unrelated-corrupt')?.status,'SENT');
   assert.equal(recovery(rows)?.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.reopened().reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),1);
  }finally{await f.close();}
 });
 test(engine+' prestart tampered kind keeps original evidence with no provider send',async()=>{
  const f=await fixture(engine);
  try{
   let originalId='';
   f.service.beforeDispatch=async()=>f.store.transaction(s=>{
    const item=s.moderationOperations.at(-1)!;
    originalId=item.id;item.kind='MUTE';
   });
   const answer=await f.service.addManualReason(OWNER,GROUP,TARGET,'case','BAN');
   assert.equal(answer.status,'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),0);
   const rows=(await f.store.snapshot()).moderationOperations;
   assert.equal(rows.length,2);
   assert.equal(preserved(rows,originalId)?.kind,'MUTE');
   assert.equal(preserved(rows,originalId)?.status,'INTENT');
   assert.equal(recovery(rows)?.kind,'BAN');
  }finally{await f.close();}
 });
 test(engine+' prestart substituted terminal status remains historical evidence',async()=>{
  const f=await fixture(engine);
  try{
   let originalId='';
   f.service.beforeDispatch=async()=>f.store.transaction(s=>{
    const item=s.moderationOperations.at(-1)!;
    originalId=item.id;item.status='CONFIRMED';
   });
   assert.equal((await f.service.addManualReason(OWNER,GROUP,TARGET,'case','BAN')).status,
    'BLOCKED_UNKNOWN');
   assert.equal(f.sends(),0);
   const rows=(await f.store.snapshot()).moderationOperations;
   assert.equal(rows.length,2);
   assert.equal(preserved(rows,originalId)?.status,'CONFIRMED');
   assert.equal(recovery(rows)?.status,'UNKNOWN_OUTCOME');
   assert.equal((await f.reopened().reconcile(OWNER,GROUP,TARGET)).status,'BLOCKED_UNKNOWN');
  }finally{await f.close();}
 });
}
