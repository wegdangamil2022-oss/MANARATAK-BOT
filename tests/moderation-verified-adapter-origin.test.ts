import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore,type RestrictionKind} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService,type ModerationGateway,type RestrictionOutcome} from '../src/moderation.js';
import {ModerationReversalPreflight} from '../src/moderation-reversal-preflight.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';

const OWNER='100',CHAT='-100123',TARGET='300',NOW=1_700_000_000_000;
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';

async function withStore(engine:'json'|'sqlite',run:(store:BotStore,policy:Policy)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-adapter-origin-'));
 try{
  const store=new BotStore(join(dir,engine==='sqlite'?'state.sqlite':'state.json'),{engine});
  const policy=new Policy(store,OWNER,()=>NOW);
  await policy.approveChat(OWNER,CHAT,['moderation']);
  await run(store,policy);
 }finally{await rm(dir,{recursive:true,force:true});}
}
const observation=()=>{
 let calls=0;
 return {observeRestriction:async()=>{calls++;return 'BAN_PRESENT' as const;},
  count:()=>calls};
};
for(const engine of ['json','sqlite'] as const){
 test('a third-party gateway cannot forge TELEGRAM_API dispatch provenance ('+engine+')',async()=>{
  await withStore(engine,async(store,policy)=>{
   const impostor:ModerationGateway={
    attemptGateway:'TELEGRAM_API',
    canRestrict:async()=>true,
    isProtected:async()=>false,
    setRestriction:async()=> 'CONFIRMED'
   };
   const service=new ModerationService(store,policy,impostor,()=>NOW);
   assert.equal((await service.addManualReason(OWNER,CHAT,TARGET,'claim-real','BAN')).status,'APPLIED');
   assert.equal((await store.snapshot()).moderationOperations[0]!.attemptGateway,'UNSPECIFIED');
   await store.transaction(s=>{s.moderationReasons[0]!.active=false;});
   const probe=observation();
   assert.equal((await new ModerationReversalPreflight(store,policy,probe)
    .assess(OWNER,CHAT,TARGET)).status,'BLOCKED_UNPROVEN');
   assert.equal(probe.count(),0);
  });
 });
 test('overridden Telegram adapter mutation cannot claim official gateway provenance ('+engine+')',async()=>{
  await withStore(engine,async(store,policy)=>{
   // This subclass never contacts Telegram, despite inheriting the marker.
   class OverriddenTelegramGateway extends TelegramBotApiModerationGateway {
    override async canRestrict(_chat:string,_member:string){return true;}
    override async isProtected(_chat:string,_member:string){return false;}
    override async setRestriction(_chat:string,_member:string,_kind:RestrictionKind):Promise<RestrictionOutcome>{
     return 'CONFIRMED';
    }
   }
   let networkCalls=0;
   const request=(async()=>{networkCalls++;throw Error('unexpected network');}) as typeof fetch;
   const impostor=new OverriddenTelegramGateway(TOKEN,request);
   assert.equal((await new ModerationService(store,policy,impostor,()=>NOW)
    .addManualReason(OWNER,CHAT,TARGET,'overridden','BAN')).status,'APPLIED');
   assert.equal(networkCalls,0);
   assert.equal((await store.snapshot()).moderationOperations[0]!.attemptGateway,'UNSPECIFIED');
  });
 });
}
