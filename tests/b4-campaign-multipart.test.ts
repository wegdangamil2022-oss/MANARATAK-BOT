import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore, type BotState } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { planPublicationPreview } from '../src/publication-preview-plan.js';
import { CampaignMultipartService, type CampaignPartGateway, type CampaignPartReceipt } from '../src/campaign-multipart.js';

type Compat = Omit<BotState, 'campaigns' | 'deliveries'> & { campaigns: any[]; deliveries: any[] };
const source='-100', dest='-200', owner='100',text='منحة جامعية موثقة '.repeat(300);
const hash=(s:unknown)=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
async function fixture() {
 const dir=await mkdtemp(join(tmpdir(),'b4-campaign-parts-'));
 const file=join(dir,'state.json'); const store=new BotStore(file); const policy=new Policy(store,owner,()=>1000);
 let calls: { index:number; attemptId:string; destination:string }[]=[];
 let mode:'SENT'|'UNKNOWN_OUTCOME'|'FAILED_CONFIRMED'|'THROW'='SENT';
 let canPost=true; let pause:Promise<void>|undefined;
 const receipts=new Map<string,string>();
 const gateway:CampaignPartGateway={
  canPost:async()=>canPost,
  sendPart:async req=>{calls.push({index:req.index,attemptId:req.attemptId,destination:req.destination});if(pause) await pause;
    if(mode==='THROW')throw new Error('network ambiguous');
    if(mode==='UNKNOWN_OUTCOME'||mode==='FAILED_CONFIRMED')return {status:mode};
    const messageId=`message-${calls.length}`;receipts.set(req.attemptId,messageId);return {status:'SENT',messageId};},
  verifyReceipt:async(receipt:CampaignPartReceipt)=>receipts.get(receipt.attemptId)===receipt.messageId
 };
 const categoryId='scholarships',rid='r1';
 const r={id:rid,scope:source,title:text,university:'University',cycle:'2026',degree:'Master',seats:4,categoryId,status:'PUBLISHED',sourceImportId:'i1',sourceLocator:'row:1',reviewedBy:owner};
 const revision=hash({id:r.id,title:r.title,university:r.university,cycle:r.cycle,degree:r.degree,seats:r.seats,categoryId:r.categoryId,scope:r.scope,status:r.status});
 const previewText=[r.title,`الجامعة: ${r.university}`,`الدورة: ${r.cycle}`,`الدرجة: ${r.degree}`,`المقاعد المذكورة في المصدر: ${r.seats}`].join('\n');
 const plan=planPublicationPreview({text:previewText});
 await store.transaction(s=>{s.chats.push({id:source,approved:true,present:true,scopes:['navigation'],version:1,groupAI:'OFF'});
 s.chats.push({id:dest,approved:true,present:true,scopes:['publishing'],version:1,groupAI:'OFF'});
 s.educationCategories.push({id:categoryId,scope:source,title:'منح',order:1,enabled:true,parentId:null});s.educationResources.push(r as any);
 const b=s as Compat;b.campaigns=[{id:'campaign1',sourceScope:source,destination:dest,createdBy:owner,approvedBy:owner,status:'APPROVED',scheduledAt:0,sourcePolicyVersion:1,destinationPolicyVersion:1,previews:[{resourceId:rid,revision,text:previewText}]}];
 b.deliveries=[{id:'delivery1',campaignId:'campaign1',resourceId:rid,destination:dest,revision,status:'QUEUED'}];
 });
 const service=()=>new CampaignMultipartService(store,policy,gateway,()=>1000);
 return {file,dir,store,policy,plan,service,calls,receipts,gateway,
  mode:(m:typeof mode)=>{mode=m},post:(v:boolean)=>{canPost=v},pause:(v?:Promise<void>)=>{pause=v},
  close:()=>rm(dir,{force:true,recursive:true})};
}

test('B4 integrated: stage only an approved campaign and exact deterministic text snapshot; no dispatch yet',async()=>{
 const f=await fixture();try{
   await f.store.transaction(s=>{(s as Compat).campaigns[0]!.status='DRAFT';});
   await assert.rejects(f.service().stage(owner,'campaign1','r1',f.plan),/CAMPAIGN_NOT_APPROVED/);
   await f.store.transaction(s=>{(s as Compat).campaigns[0]!.status='APPROVED';});
   const staged=await f.service().stage(owner,'campaign1','r1',f.plan);
   assert.ok(staged.parts.length>1);assert.equal(staged.status,'MULTIPART');
   assert.equal((await f.store.snapshot() as Compat).deliveries[0].status,'MULTIPART');
   assert.equal(f.calls.length,0);
   await assert.rejects(f.service().stage(owner,'campaign1','r1',f.plan),/ALREADY_STAGED/);
 }finally{await f.close()}
});

test('B4 integrated: cannot inject a changed caption or photo into an already-approved plain-text campaign',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.service().stage(owner,'campaign1','r1',planPublicationPreview({text:'other'})),/PREVIEW_MISMATCH/);
  await assert.rejects(f.service().stage(owner,'campaign1','r1',planPublicationPreview({text:'other',photo:{mediaId:'validphotoid01',caption:'other'}})),/PREVIEW_MISMATCH/);
 }finally{await f.close()}
});

test('B4 integrated: all parts have distinct receipts, restart preserves progress, and campaign completes once',async()=>{
 const f=await fixture();try{
  const d=await f.service().stage(owner,'campaign1','r1',f.plan);
  assert.ok(d.parts.length>1);
  for(let i=0;i<d.parts.length;i++) assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'SENT');
  const snapshot=await f.store.snapshot() as Compat;assert.equal(snapshot.deliveries[0].status,'SENT');
  assert.equal(snapshot.campaigns[0].status,'COMPLETED');
  assert.equal(snapshot.deliveries[0].multipart.parts.length,d.parts.length);
  assert.equal(new Set(snapshot.deliveries[0].multipart.parts.map((p:any)=>p.messageId)).size,d.parts.length);
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'EMPTY');
  assert.equal(f.calls.length,d.parts.length);
 }finally{await f.close()}
});

test('B4 integrated: timeout prevents retry or sending later parts, including after restart',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);f.mode('THROW');
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'UNKNOWN_OUTCOME');
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'BLOCKED');
  assert.equal(f.calls.length,1);
  assert.equal((await f.service().recoverPending()).valueOf(),0);
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'BLOCKED');
 }finally{await f.close()}
});

test('B4 integrated: stale authorization and lost bot rights block outgoing parts',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);f.post(false);
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'BLOCKED');assert.equal(f.calls.length,0);
  f.post(true);await f.policy.revokeChat(owner,dest);
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'BLOCKED');assert.equal(f.calls.length,0);
 }finally{await f.close()}
});

test('B4 integrated: two concurrent dispatches claim exactly one part',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);
  const r=await Promise.all([f.service().dispatchNext('campaign1','r1'),f.service().dispatchNext('campaign1','r1')]);
  assert.equal(r.filter(x=>x.status==='SENT').length,1);assert.equal(f.calls.length,1);
 }finally{await f.close()}
});

test('B4 integrated: recover in-flight attempt as UNKNOWN and reconcile only a matching unique verified receipt',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);
  let release!:()=>void;const pending=new Promise<void>(resolve=>release=resolve);
  f.pause(pending);
  const running=f.service().dispatchNext('campaign1','r1');
  for(let i=0;i<100;i++){if((await f.store.snapshot() as Compat).deliveries[0].multipart.parts[0].status==='SENDING')break;await new Promise(x=>setTimeout(x,3));}
  assert.equal(await f.service().recoverPending(),1);
  release();await running;f.pause();
  const p=(await f.store.snapshot() as Compat).deliveries[0].multipart.parts[0];
  const receipt={destination:dest,attemptId:p.attemptId,messageId:'recovered1'};
  f.receipts.set(p.attemptId,receipt.messageId);
  await assert.rejects(f.service().reconcileUnknown(owner,'campaign1','r1',0,{...receipt,destination:'-wrong'}),/RECEIPT_INVALID/);
  assert.equal((await f.service().reconcileUnknown(owner,'campaign1','r1',0,receipt)).status,'SENT');
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'SENT');
 }finally{await f.close()}
});

test('B4 integrated: confirmed failure requires authorized explicit retry, no retry for unknown or sent',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);f.mode('FAILED_CONFIRMED');
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'FAILED_CONFIRMED');
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'BLOCKED');
  await f.service().retryFailed(owner,'campaign1','r1',0);
  f.mode('SENT');assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'SENT');
  await assert.rejects(f.service().retryFailed(owner,'campaign1','r1',0),/NOT_CONFIRMED_FAILED/);
 }finally{await f.close()}
});

test('B4 integrated: cancelled campaign preserves sent history and prevents later parts',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'SENT');
  await f.store.transaction(s=>{(s as Compat).campaigns[0].status='CANCELLED';});
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'CANCELLED');
  const snap=await f.store.snapshot() as Compat;
  assert.equal(snap.deliveries[0].multipart.parts[0].status,'SENT');
  assert.equal(snap.deliveries[0].multipart.parts[1].status,'QUEUED');
 }finally{await f.close()}
});

test('B4 integrated: archiving the source after approval blocks staging and later queued parts',async()=>{
 const f=await fixture();try{
  await f.store.transaction(s=>{s.educationResources[0]!.status='ARCHIVED';});
  await assert.rejects(f.service().stage(owner,'campaign1','r1',f.plan),/PUBLISH_DENIED/);
  await f.store.transaction(s=>{s.educationResources[0]!.status='PUBLISHED';});
  await f.service().stage(owner,'campaign1','r1',f.plan);
  await f.store.transaction(s=>{s.educationResources[0]!.status='ARCHIVED';});
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'BLOCKED');
  assert.equal(f.calls.length,0);
 }finally{await f.close()}
});

test('B4 integrated: policy revocation DURING canPost rechecks current state and prevents send',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);
  f.gateway.canPost=async()=>{await f.policy.revokeChat(owner,dest);return true;};
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'BLOCKED');
  assert.equal(f.calls.length,0);
  const p=(await f.store.snapshot() as Compat).deliveries[0].multipart.parts[0];
  assert.equal(p.status,'QUEUED');
 }finally{await f.close()}
});

test('B4 integrated: rejects duplicate confirmed message IDs from two parts',async()=>{
 const f=await fixture();try{
  await f.service().stage(owner,'campaign1','r1',f.plan);
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'SENT');
  f.gateway.sendPart=async()=>({status:'SENT',messageId:'message-1'});
  assert.equal((await f.service().dispatchNext('campaign1','r1')).status,'UNKNOWN_OUTCOME');
  const d=(await f.store.snapshot() as Compat).deliveries[0];
  assert.equal(d.status,'MULTIPART');assert.equal(d.multipart.parts[1].status,'UNKNOWN_OUTCOME');
 }finally{await f.close()}
});
