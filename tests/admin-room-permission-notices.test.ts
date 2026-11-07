import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BotStore} from '../src/store.js';
import {Policy} from '../src/policy.js';
import {AdminRoomLinks} from '../src/admin-room-links.js';
import {GroupPermissionLockService} from '../src/group-permission-lock.js';
import {telegramGroupPermissionGateway} from '../src/telegram-group-permission-gateway.js';
import {GROUP_PERMISSION_KEYS,type GroupPermissions} from '../src/group-permission-model.js';
import {ModerationService} from '../src/moderation.js';
import {TelegramBotApiModerationGateway} from '../src/telegram-moderation-gateway.js';
import {AdminRoomNoticeDispatcher,TelegramAdminRoomNoticeSender} from '../src/admin-room-notices.js';
const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',NOW=1700000000000;
for(const engine of ['json','sqlite'] as const)for(const variant of ['change','rights','control'] as const)test(engine+' room '+variant+' notice is source-bound and appears in its aggregate summary',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'room-permission-notice-'));try{
  const store=new BotStore(join(dir,'state.'+engine),{engine}),policy=new Policy(store,'100',()=>NOW);for(const c of ['-100','-200'])await policy.approveChat('100',c,['moderation']);const links=new AdminRoomLinks(store,policy,()=>NOW),id=await links.propose('100','-100','-200','NOTIFICATIONS');assert.ok(id);await links.approve('100',id,'GROUP');await links.approve('100',id,'ROOM');if(variant==='control'){const control=await links.propose('100','-100','-200','CONTROL');assert.ok(control);await links.approve('100',control,'GROUP');await links.approve('100',control,'ROOM');}
  let permissions=Object.fromEntries(GROUP_PERMISSION_KEYS.map(k=>[k,true])) as GroupPermissions,posts=0,writes=0;let body:Record<string,unknown>={};
  const request=(async(url:unknown,init:RequestInit)=>{const method=String(url).split('/').at(-1)!,input=JSON.parse(String(init.body));if(method==='getChat')return Response.json({ok:true,result:{id:Number(input.chat_id),type:'supergroup',...(input.chat_id==='-100'?{permissions}:{})}});if(method==='getChatMember')return Response.json({ok:true,result:{status:input.user_id===123456789?'administrator':'member',user:{id:input.user_id,is_bot:input.user_id===123456789},can_restrict_members:variant!=='rights'}});if(method==='setChatPermissions'){writes++;permissions=input.permissions;return Response.json({ok:true,result:true});}assert.equal(method,'sendMessage');posts++;body=input;return Response.json({ok:true,result:{message_id:1,chat:{id:-200},from:{id:123456789,is_bot:true}}});}) as typeof fetch;
  const gateway=new TelegramBotApiModerationGateway(TOKEN,request,async()=>true,()=>NOW);
  if(variant==='change'){const service=new GroupPermissionLockService(store,policy,telegramGroupPermissionGateway(TOKEN,request,async()=>true),()=>NOW),preview=await service.preview('100','-100','LOCK','PHOTOS');assert.ok(preview);assert.equal(await service.confirm('100',preview.id),'CONFIRMED');assert.equal(writes,1);assert.equal((await links.summary('100',id))!.changes,1);}
  else if(variant==='rights'){const service=new ModerationService(store,policy,gateway,()=>NOW);assert.equal((await service.addManualReason('100','-100','500','case','BAN')).status,'DENIED');assert.equal(writes,0);assert.equal((await links.summary('100',id))!.failures,1);}
  else{const {TelegramModerationReports}=await import('../src/telegram-moderation-reports.js');assert.equal(await new TelegramModerationReports(store,policy,()=>NOW).submit('400','-100',101,{message_id:1,chat:{id:-100,type:'supergroup'},from:{id:500,is_bot:false}}),'RECORDED');}
  const worker=new AdminRoomNoticeDispatcher(store,policy,gateway,new TelegramAdminRoomNoticeSender(TOKEN,request),()=>NOW,async()=>true);assert.equal(await worker.drain(),1);assert.equal(await worker.drain(),0);assert.equal(posts,1);assert.equal(body.chat_id,'-200');
  if(variant==='control'){const keyboard=body.reply_markup as {inline_keyboard:{callback_data:string}[][]};assert.equal(keyboard.inline_keyboard.flat().length,3);assert.ok(keyboard.inline_keyboard.flat().every(b=>/^rc:1:[pwm]:[A-Za-z0-9_-]{24}$/u.test(b.callback_data)));}else assert.equal(Object.hasOwn(body,'reply_markup'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
