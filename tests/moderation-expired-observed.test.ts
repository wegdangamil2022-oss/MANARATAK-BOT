import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
const NOW=1700000000000,TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
for(const engine of ['json','sqlite'] as const)for(const variant of ['clear','restricted','independent','stop','changed'] as const)test(engine+' expired ban '+variant+' preserves independent restrictions and acknowledges clear state without mutations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'expiry-observed-'));try{
  let now=NOW,expired=false,writes=0,running=true;const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>now);await policy.approveChat('100','-100',['moderation']);
  const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,body=JSON.parse(String(init.body));if(method==='getChat')return Response.json({ok:true,result:{id:-100,type:'supergroup'}});if(method==='getChatMember'){
   if(body.user_id===123456789)return Response.json({ok:true,result:{status:'administrator',user:{id:123456789,is_bot:true},can_restrict_members:true}});
   if(expired&&variant==='changed')await store.transaction(s=>{if(!s.moderationReasons.some(r=>r.reference==='other'))s.moderationReasons.push({chatId:'-100',memberId:'500',source:'MANUAL',reference:'other',kind:'MUTE',active:true,createdBy:'100'});});
   return Response.json({ok:true,result:{status:!expired?'member':variant==='restricted'||variant==='independent'?'kicked':'left',user:{id:500,is_bot:false},...(expired?{until_date:NOW/1000+60}:{})}});
  }writes++;assert.equal(method,'banChatMember');return Response.json({ok:true,result:true});}) as typeof fetch;
  const service=new ModerationService(store,policy,new TelegramBotApiModerationGateway(TOKEN,request,async()=>running,()=>now),()=>now);assert.equal((await service.addManualReason('100','-100','500','timed','BAN',undefined,60)).status,'APPLIED');expired=true;now+=60000;
  if(variant==='independent')await store.transaction(s=>{s.moderationReasons.push({chatId:'-100',memberId:'500',source:'MANUAL',reference:'other',kind:'BAN',active:true,createdBy:'100'});});if(variant==='stop')running=false;
  const result=await service.expireManualReasons('100','-100','500');assert.equal(result.status==='APPLIED',variant==='clear');assert.equal(writes,1);const state=await store.snapshot();assert.equal(state.moderationReasons.find(r=>r.reference==='timed')!.active,variant!=='clear');if(variant==='clear'){assert.equal(state.moderationOperations.at(-1)!.kind,'NONE');assert.equal((await service.expireManualReasons('100','-100','500')).status,'DENIED');}if(variant==='independent'||variant==='changed')assert.equal(state.moderationReasons.find(r=>r.reference==='other')!.active,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
