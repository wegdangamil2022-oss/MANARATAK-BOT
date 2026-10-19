import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {EducationService} from '../src/education.js';
import {PublicationService, FakePublicationGateway} from '../src/publishing.js';
import {CampaignMultipartService} from '../src/campaign-multipart.js';

const OWNER='100',SOURCE='-100',DEST='-200';
const LONG='منحة طبية موثقة مع شروط التقديم والمراجعة. '.repeat(200);
async function fixture(engine:'json'|'sqlite'='json') {
  const dir=await mkdtemp(join(tmpdir(),'manaratak-b4-cancel-'));
  const file=join(dir,engine==='json'?'bot.json':'bot.sqlite');
  const store=new BotStore(file,{engine}),clock=()=>1000,policy=new Policy(store,OWNER,clock);
  const edu=new EducationService(store,policy,clock),gateway=new FakePublicationGateway();
  const pub=()=>new PublicationService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),gateway,clock);
  const parts=()=>new CampaignMultipartService(new BotStore(file,{engine}),new Policy(new BotStore(file,{engine}),OWNER,clock),{
    canPost:dest=>gateway.canPost(dest),
    sendPart:req=>gateway.send(req.destination,req.part.text,req.attemptId),
    verifyReceipt:r=>gateway.verifyReceipt(r)
  },clock);
  await policy.approveChat(OWNER,SOURCE,['navigation']);
  await policy.approveChat(OWNER,DEST,['publishing']);
  await edu.createCategory(OWNER,{id:'grant',scope:SOURCE,title:'المنح',order:1});
  const imp=await edu.submitText(OWNER,SOURCE,'ADMIN_WEB','csv','grants.csv',
    'title,university\nGrant One,University A\nGrant Two,University B\n');
  const resources: Array<{id:string}> = [];
  for(let i=0;i<2;i++){await edu.approveCandidate(OWNER,imp.id,i,'grant');resources.push(await edu.publishCandidate(OWNER,imp.id,i,'grant'));}
  const draft=async (multipart:boolean, ids=[resources[0]!.id])=>{
    if(multipart)await edu.setPublicationText(OWNER,resources[0]!.id,LONG);
    const campaign=await pub().draft(OWNER,SOURCE,DEST,ids);
    await pub().approve(OWNER,campaign.id);
    return campaign;
  };
  return {dir,file,store,edu,pub,parts,gateway,resources,draft,close:()=>rm(dir,{recursive:true,force:true})};
}
function latch(){
  let entered!:()=>void,release!:()=>void;
  return {arrived:new Promise<void>(resolve=>entered=resolve),
    blocked:new Promise<void>(resolve=>release=resolve),enter:()=>entered(),release:()=>release()};
}

for(const engine of ['json','sqlite'] as const){
  test(`B4 cancellation ${engine}: unstarted multipart parts and the delivery close without pretending to send`,async()=>{
    const f=await fixture(engine);try{
      const c=await f.draft(true);
      const before=(await f.store.snapshot()).deliveries[0]!;
      assert.equal(before.status,'MULTIPART');
      assert.ok(before.multipart!.parts.length>1);
      await f.pub().cancel(OWNER,c.id);
      const s=await f.store.snapshot(),d=s.deliveries[0]!;
      assert.equal(s.campaigns[0]!.status,'CANCELLED');
      assert.equal(d.status,'CANCELLED');
      assert.ok(d.multipart!.parts.every(x=>x.status==='CANCELLED'&&x.messageId===undefined));
      assert.equal(f.gateway.calls.length,0);
      assert.equal((await f.pub().dispatchNext(c.id)).status,'CANCELLED');
      assert.equal(s.audit.filter(x=>x.reason==='CAMPAIGN_CANCELLED').length,1);
      assert.equal(s.audit.find(x=>x.reason==='CAMPAIGN_CANCELLED')?.actorId,OWNER);
    }finally{await f.close()}
  });

  test(`B4 cancellation ${engine}: preserve confirmed part receipt, cancel unsent tail and next resource`,async()=>{
    const f=await fixture(engine);try{
      const c=await f.draft(true,[f.resources[0]!.id,f.resources[1]!.id]);
      assert.equal((await f.pub().dispatchNext(c.id)).status,'SENT');
      const d=(await f.store.snapshot()).deliveries[0]!;
      const proof=d.multipart!.parts[0]!.messageId;
      await f.pub().cancel(OWNER,c.id);
      const state=await f.store.snapshot(),parts=state.deliveries[0]!.multipart!.parts;
      assert.equal(state.deliveries[0]!.status,'CANCELLED');
      assert.equal(parts[0]!.status,'SENT');
      assert.equal(parts[0]!.messageId,proof);
      assert.ok(parts.slice(1).every(x=>x.status==='CANCELLED'));
      assert.equal(state.deliveries[1]!.status,'CANCELLED');
      assert.equal(state.campaigns[0]!.status,'CANCELLED');
      assert.equal((await f.pub().dispatchNext(c.id)).status,'CANCELLED');
      assert.equal(f.gateway.calls.length,1);
    }finally{await f.close()}
  });

  test(`B4 cancellation ${engine}: ambiguous part remains UNKNOWN until verified, then campaign stays cancelled`,async()=>{
    const f=await fixture(engine);try{
      const c=await f.draft(true);
      f.gateway.throwAfterSend=true;
      assert.equal((await f.pub().dispatchNext(c.id)).status,'UNKNOWN_OUTCOME');
      await f.pub().cancel(OWNER,c.id);
      let d=(await f.store.snapshot()).deliveries[0]!;
      assert.equal(d.status,'MULTIPART'); // unresolved evidence is never silently erased
      assert.equal(d.multipart!.parts[0]!.status,'UNKNOWN_OUTCOME');
      assert.ok(d.multipart!.parts.slice(1).every(x=>x.status==='CANCELLED'));
      const proof=f.gateway.getReceipt(d.multipart!.parts[0]!.attemptId!)!;
      const verified=await f.parts().reconcileUnknown(OWNER,c.id,f.resources[0]!.id,0,proof);
      assert.equal(verified.status,'SENT');
      d=(await f.store.snapshot()).deliveries[0]!;
      assert.equal(d.status,'CANCELLED');
      assert.equal(d.multipart!.parts[0]!.messageId,proof.messageId);
      assert.equal((await f.pub().dispatchNext(c.id)).status,'CANCELLED');
      assert.equal(f.gateway.calls.length,1);
    }finally{await f.close()}
  });

  test(`B4 cancellation ${engine}: cancel during preflight prevents multipart sender and cleans intent`,async()=>{
    const f=await fixture(engine);try{
      const c=await f.draft(true),hold=latch();
      f.gateway.canPost=async()=>{hold.enter();await hold.blocked;return true};
      const pending=f.pub().dispatchNext(c.id);
      await hold.arrived;
      try {
        const d=(await f.store.snapshot()).deliveries[0]!;
        assert.equal(d.multipart!.parts[0]!.status,'SENDING');
        await f.pub().cancel(OWNER,c.id);
      }finally{hold.release()}
      assert.equal((await pending).status,'BLOCKED');
      const d=(await f.store.snapshot()).deliveries[0]!;
      assert.equal(d.status,'CANCELLED');
      assert.ok(d.multipart!.parts.every(x=>x.status==='CANCELLED'));
      assert.equal(f.gateway.calls.length,0);
    }finally{await f.close()}
  });

  test(`B4 cancellation ${engine}: in-flight send result records its real proof but cannot continue the tail`,async()=>{
    const f=await fixture(engine);try{
      const c=await f.draft(true),hold=latch();
      const send=f.gateway.send.bind(f.gateway);
      f.gateway.send=async(destination,text,attemptId)=>{hold.enter();await hold.blocked;return send(destination,text,attemptId)};
      const pending=f.pub().dispatchNext(c.id);
      await hold.arrived;
      try {
        const p=(await f.store.snapshot()).deliveries[0]!.multipart!.parts[0]!;
        assert.equal(p.status,'SENDING');
        await f.pub().cancel(OWNER,c.id);
      }finally{hold.release()}
      assert.equal((await pending).status,'SENT');
      const d=(await f.store.snapshot()).deliveries[0]!;
      assert.equal(d.status,'CANCELLED');
      assert.equal(d.multipart!.parts[0]!.status,'SENT');
      assert.ok(d.multipart!.parts[0]!.messageId);
      assert.ok(d.multipart!.parts.slice(1).every(x=>x.status==='CANCELLED'));
      assert.equal(f.gateway.calls.length,1);
      assert.equal((await f.pub().dispatchNext(c.id)).status,'CANCELLED');
    }finally{await f.close()}
  });

  test(`B4 cancellation ${engine}: single-part cancel during canPost cannot restore a queued ghost`,async()=>{
    const f=await fixture(engine);try{
      const c=await f.draft(false),hold=latch();
      f.gateway.canPost=async()=>{hold.enter();await hold.blocked;return true;};
      const pending=f.pub().dispatchNext(c.id);
      await hold.arrived;
      try{await f.pub().cancel(OWNER,c.id);}finally{hold.release()}
      assert.equal((await pending).status,'BLOCKED');
      const d=(await f.store.snapshot()).deliveries[0]!;
      assert.equal(d.status,'CANCELLED');
      assert.equal(d.messageId,undefined);
      assert.equal(f.gateway.calls.length,0);
    }finally{await f.close()}
  });
}
