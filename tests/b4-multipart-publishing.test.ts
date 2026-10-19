import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planPublicationPreview } from '../src/publication-preview-plan.js';
import { MultipartPublicationService, MultipartTestStore, type MultipartGateway, type MultipartAuthorizedDraft } from '../src/multipart-publishing.js';

const PLAN = planPublicationPreview({text:'معلومات منحة معتمدة '.repeat(280)});
const base = (overrides:Partial<MultipartAuthorizedDraft>={}):MultipartAuthorizedDraft => ({
 campaignId:'campaign-1', deliveryId:'delivery-1', sourceResourceId:'resource-1', sourceRevision:'rev1',
 destination:'-100chat', approvedBy:'owner-1', approved:true, renderPlan:PLAN, ...overrides,
});
const create = async () => {
 const dir=await mkdtemp(join(tmpdir(),'manaratak-multipart-'));
 const filename=join(dir,'test-state.json');
 const store=new MultipartTestStore(filename);
 let allowed=true;
 let now=1000;
 const calls:{destination:string; index:number; attemptId:string}[]=[];
 let mode:'SENT'|'FAILED_CONFIRMED'|'UNKNOWN_OUTCOME'|'THROW'='SENT';
 let postingAllowed=true;
 let pauseSend: (()=>Promise<void>)|null=null;
 let receipts=new Map<string,string>();
 const gateway:MultipartGateway={
  async canPost(){return postingAllowed;},
  async sendPart(request){
   calls.push({destination:request.destination,index:request.index,attemptId:request.attemptId});
   if (pauseSend) await pauseSend();
   if(mode==='THROW') throw new Error('network timeout');
   if(mode==='FAILED_CONFIRMED') return {status:'FAILED_CONFIRMED'};
   if(mode==='UNKNOWN_OUTCOME') return {status:'UNKNOWN_OUTCOME'};
   const id=`msg-${calls.length}`;receipts.set(request.attemptId,id);
   return {status:'SENT',messageId:id};
  },
  async verifyReceipt(receipt){return receipts.get(receipt.attemptId)===receipt.messageId;},
 };
 const policy=async()=>allowed;
 const service=()=>new MultipartPublicationService(store,gateway,policy,()=>now);
 return {dir,filename,store,gateway,service,calls,plan:PLAN,
  allow:(v:boolean)=>{allowed=v;},post:(v:boolean)=>{postingAllowed=v;},time:(v:number)=>{now=v;},
  mode:(v:typeof mode)=>{mode=v;},pause:(v:typeof pauseSend)=>{pauseSend=v;},
  receipt:(attemptId:string,messageId:string)=>{receipts.set(attemptId,messageId);},
  dispose:()=>rm(dir,{recursive:true,force:true})};
};

test('B4 multipart: stage requires explicit campaign approval and exact immutable fingerprint',async()=>{
 const f=await create();try{
  await assert.rejects(f.service().stage(base({approved:false})),/NOT_APPROVED/);
  await assert.rejects(f.service().stage({...base(),approvedFingerprint:'bad'}),/PREVIEW_MISMATCH/);
  const p=await f.service().stage(base({approvedFingerprint:PLAN.fingerprint}));
  assert.equal(p.parts.length,PLAN.parts.length);
  assert.equal(f.calls.length,0);
 }finally{await f.dispose();}
});

test('B4 multipart: only one reservation for same item revision and destination across campaigns',async()=>{
 const f=await create();try{
  await f.service().stage(base());
  await assert.rejects(f.service().stage(base({campaignId:'campaign-2',deliveryId:'delivery-2'})),/RESERVED/);
  await assert.rejects(f.service().stage(base({campaignId:'campaign-3',deliveryId:'delivery-1',sourceRevision:'rev2'})),/DELIVERY_ID_CONFLICT/);
 }finally{await f.dispose();}
});

test('B4 multipart: sends parts in order and confirms only after every part has its own receipt',async()=>{
 const f=await create();try{
  const draft=await f.service().stage(base());assert.ok(draft.parts.length>1);
  const first=await f.service().dispatchNext('delivery-1');
  assert.equal(first.status,'SENT');assert.equal(first.index,0);
  let snapshot=await f.service().inspect('delivery-1');
  assert.equal(snapshot.status,'IN_PROGRESS');assert.equal(snapshot.parts[0]?.messageId,'msg-1');
  assert.equal(snapshot.parts[1]?.status,'QUEUED');
  for(let i=1;i<draft.parts.length;i++)assert.equal((await f.service().dispatchNext('delivery-1')).status,'SENT');
  snapshot=await f.service().inspect('delivery-1');assert.equal(snapshot.status,'COMPLETED');
  assert.equal(f.calls.length,draft.parts.length);
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'EMPTY');
 }finally{await f.dispose();}
});

test('B4 multipart: timeout leaves UNKNOWN outcome and never retries or advances later parts',async()=>{
 const f=await create();try{
  await f.service().stage(base());f.mode('THROW');
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'UNKNOWN_OUTCOME');
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'BLOCKED');
  assert.equal(f.calls.length,1);
 }finally{await f.dispose();}
});

test('B4 multipart: orphaned SENDING on restart is UNKNOWN and cannot auto-retry',async()=>{
 const f=await create();try{
  await f.service().stage(base());
  let release!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve);
  f.pause(()=>waiting);
  const pending=f.service().dispatchNext('delivery-1');
  for(let i=0;i<40;i++){if((await f.service().inspect('delivery-1')).parts[0]?.status==='SENDING')break;await new Promise(x=>setTimeout(x,3));}
  const restarted=f.service();
  assert.equal(await restarted.recoverPending(),1);
  assert.equal((await restarted.dispatchNext('delivery-1')).status,'BLOCKED');
  release();await pending;
  assert.equal(f.calls.length,1);
 }finally{await f.dispose();}
});

test('B4 multipart: two concurrent dispatch callers claim at most one part',async()=>{
 const f=await create();try{
  await f.service().stage(base());
  const [a,b]=await Promise.all([f.service().dispatchNext('delivery-1'),f.service().dispatchNext('delivery-1')]);
  assert.equal([a.status,b.status].filter(x=>x==='SENT').length,1);
  assert.equal(f.calls.length,1);
 }finally{await f.dispose();}
});

test('B4 multipart: revoked grant or Telegram rights prevent any outbound call, even after async check',async()=>{
 const f=await create();try{
  await f.service().stage(base());f.allow(false);
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'BLOCKED');assert.equal(f.calls.length,0);
  f.allow(true);f.post(false);
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'BLOCKED');assert.equal(f.calls.length,0);
 }finally{await f.dispose();}
});

test('B4 multipart: confirmed failure only retries after explicit authorized action',async()=>{
 const f=await create();try{
  await f.service().stage(base());f.mode('FAILED_CONFIRMED');
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'FAILED_CONFIRMED');
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'BLOCKED');
  f.allow(false);await assert.rejects(f.service().retryFailed('delivery-1',0),/NOT_AUTHORIZED/);
  f.allow(true);await f.service().retryFailed('delivery-1',0);f.mode('SENT');
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'SENT');
  assert.equal(f.calls.length,2);
 }finally{await f.dispose();}
});

test('B4 multipart: fake signed receipt can reconcile only the matching attempt and destination',async()=>{
 const f=await create();try{
  await f.service().stage(base());f.mode('UNKNOWN_OUTCOME');
  await f.service().dispatchNext('delivery-1');
  const item=(await f.service().inspect('delivery-1')).parts[0]!;
  const receipt={attemptId:item.attemptId!,destination:'-100chat',messageId:'verified-msg'};
  f.receipt(receipt.attemptId,receipt.messageId);
  await assert.rejects(f.service().reconcileUnknown('delivery-1',0,{...receipt,destination:'-100other'}),/INVALID_RECEIPT/);
  await assert.rejects(f.service().reconcileUnknown('delivery-1',0,{...receipt,messageId:'forged'}),/INVALID_RECEIPT/);
  assert.equal((await f.service().reconcileUnknown('delivery-1',0,receipt)).status,'SENT');
  assert.equal((await f.service().inspect('delivery-1')).parts[0]?.messageId,'verified-msg');
 }finally{await f.dispose();}
});

test('B4 multipart: disputed receipts cannot be reused for another part',async()=>{
 const f=await create();try{
  await f.service().stage(base());f.mode('UNKNOWN_OUTCOME');
  await f.service().dispatchNext('delivery-1');
  const first=(await f.service().inspect('delivery-1')).parts[0]!;
  f.receipt(first.attemptId!,'receipt-1');
  await f.service().reconcileUnknown('delivery-1',0,{attemptId:first.attemptId!,destination:'-100chat',messageId:'receipt-1'});
  await f.service().dispatchNext('delivery-1');
  const second=(await f.service().inspect('delivery-1')).parts[1]!;
  f.receipt(second.attemptId!,'receipt-1');
  await assert.rejects(f.service().reconcileUnknown('delivery-1',1,{attemptId:second.attemptId!,destination:'-100chat',messageId:'receipt-1'}),/DUPLICATE_RECEIPT/);
 }finally{await f.dispose();}
});

test('B4 multipart: cancel does not erase confirmed sends or requeue an unknown attempt',async()=>{
 const f=await create();try{
  await f.service().stage(base());await f.service().dispatchNext('delivery-1');
  await f.service().cancel('delivery-1');
  const p=await f.service().inspect('delivery-1');
  assert.equal(p.status,'CANCELLED');assert.equal(p.parts[0]?.status,'SENT');
  assert.ok(p.parts.slice(1).every(x=>x.status==='CANCELLED'));
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'CANCELLED');
 }finally{await f.dispose();}
});

test('B4 multipart: cancel while sending does not mark the remote attempt as safely cancelled',async()=>{
 const f=await create();try{
  await f.service().stage(base());
  let release!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve);
  f.pause(()=>waiting);
  const pending=f.service().dispatchNext('delivery-1');
  for(let i=0;i<40;i++){if((await f.service().inspect('delivery-1')).parts[0]?.status==='SENDING')break;await new Promise(x=>setTimeout(x,3));}
  await f.service().cancel('delivery-1');
  const snap=await f.service().inspect('delivery-1');assert.equal(snap.parts[0]?.status,'UNKNOWN_OUTCOME');
  release();await pending;
 }finally{await f.dispose();}
});

test('B4 multipart: changed approved plan or resource revision invalidates dispatch',async()=>{
 const f=await create();try{
  await f.service().stage(base());
  f.allow(false);
  assert.equal((await f.service().dispatchNext('delivery-1')).status,'BLOCKED');
  assert.equal(f.calls.length,0);
 }finally{await f.dispose();}
});


test('B4 multipart: reject a validly hashed forged plan mixing TEXT and PHOTO payloads', async()=>{
  const f=await create();try{
    const forged={kind:'TEXT' as const,parts:[{kind:'PHOTO' as const,text:'hello',mediaId:'image-id_1234'}]};
    const hash=createHash('sha256').update(JSON.stringify(forged)).digest('hex');
    await assert.rejects(f.service().stage(base({renderPlan:{...forged,fingerprint:hash}})),/PREVIEW_MISMATCH|INVALID_PART/);
  }finally{await f.dispose();}
});

test('B4 multipart: revoked approval must block cancellation by unauthorized caller',async()=>{
  const f=await create();try{
    await f.service().stage(base()); f.allow(false);
    await assert.rejects(f.service().cancel('delivery-1'),/NOT_AUTHORIZED/);
    assert.equal((await f.service().inspect('delivery-1')).status,'STAGED');
  }finally{await f.dispose();}
});

test('B4 multipart: revoked approval must block reconciliation after verifier awaits',async()=>{
  const f=await create();try{
    await f.service().stage(base()); f.mode('UNKNOWN_OUTCOME');
    await f.service().dispatchNext('delivery-1');
    const attempt=(await f.service().inspect('delivery-1')).parts[0]!.attemptId!;
    const receipt={attemptId:attempt,destination:'-100chat',messageId:'verified-msg'};
    f.receipt(attempt,'verified-msg');
    // Revocation after an external verification must be honored before mutating the ledger.
    const original=f.gateway.verifyReceipt.bind(f.gateway);
    f.gateway.verifyReceipt=async (r)=>{const good=await original(r);f.allow(false);return good;};
    await assert.rejects(f.service().reconcileUnknown('delivery-1',0,receipt),/NOT_AUTHORIZED/);
    assert.equal((await f.service().inspect('delivery-1')).parts[0]!.status,'UNKNOWN_OUTCOME');
  }finally{await f.dispose();}
});
