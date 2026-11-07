import {createHash} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';
import {renderOwnerInlineGroups} from './telegram-inline-groups.js';
import {TelegramBotApiModerationGateway} from './telegram-moderation-gateway.js';

/** Verified, owner-private, on-demand getChat inspection.
 * Never persist a Telegram title or use an observation as permission to mutate.
 * Caller must have already verified that the callback originated in the
 * requesting bot owner's own private conversation.
 */
const LIVE=/^mi:1:g:l:(-[1-9][0-9]{0,15}):([1-9][0-9]{0,9}):(0|[1-9][0-9]{0,2})$/u;
const safeTime=(n:number):boolean=>Number.isSafeInteger(n)&&n>=0&&n<=8_640_000_000_000_000-120_000;
const digest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function epoch(s:BotState,policy:Policy,actor:string,chatId:string,version:number,now:number):string|null{
 if(!safeTime(now)||!policy.isOwner(actor)||
    !policy.privateFeature(s,'owner.dashboard',actor))return null;
 const matches=s.chats.filter(c=>c.id===chatId),chat=matches[0];
 if(matches.length!==1||!chat||!chat.approved||chat.version!==version||
    !policy.has(s,actor,'chat.manage',chatId,now))return null;
 return digest([
  chat,s.chats.map(c=>[c.id,c.version,c.approved]),
  s.grants.filter(g=>g.chatId===chatId||g.actor===actor),
  s.privateFeatures['owner.dashboard'],s.privateSettingsRevision??0
 ]);
}
const withMessage=(screen:OwnerInlineScreen,reason:string):OwnerInlineScreen=>({
 text:screen.text+'\n'+reason,keyboard:screen.keyboard
});
export async function renderOwnerGroupLiveProfile(
 store:BotStore,policy:Policy,actor:string,data:string,
 gateway:TelegramBotApiModerationGateway|undefined,
 safety:()=>Promise<boolean>,clock:()=>number=Date.now
):Promise<OwnerInlineScreen|null>{
 if(typeof data!=='string'||Buffer.byteLength(data,'utf8')>64)return null;
 const m=LIVE.exec(data);if(!m||m[0]!==data)return null;
 const chatId=m[1]!,version=Number(m[2]),page=Number(m[3]);
 const info='mi:1:g:i:'+chatId+':'+version+':'+page;
 const local=await renderOwnerInlineGroups(store,policy,actor,info);
 if(!local)return null;
 const begin=clock(),before=await store.snapshot();
 const expected=epoch(before,policy,actor,chatId,version,begin);
 if(!expected)return null;
 // Never accept an injected adapter reporting a fabricated remote name.
 if(!gateway||!TelegramBotApiModerationGateway.usesOfficialGroupProfileRead(gateway))
  return withMessage(local,'الاستعلام الحي غير مهيأ في هذا التشغيل.');
 let allowed=false;
 try{allowed=await safety()===true;}catch{/* fail closed */}
 if(!allowed)return withMessage(local,'بوابة السلامة لا تسمح بالاستعلام الحالي.');
 const prior=await store.snapshot();
 if(epoch(prior,policy,actor,chatId,version,clock())!==expected)return null;
 let observed:Awaited<ReturnType<TelegramBotApiModerationGateway['inspectGroupProfile']>>=null;
 try{observed=await gateway.inspectGroupProfile(chatId);}catch{/* preserve unknown */}
 let allowedAfter=false;
 try{allowedAfter=await safety()===true;}catch{/* fail closed */}
 const now=clock(),after=await store.snapshot();
 if(!safeTime(now)||now<begin||now>=begin+120_000||
    epoch(after,policy,actor,chatId,version,now)!==expected||
    !TelegramBotApiModerationGateway.usesOfficialGroupProfileRead(gateway))return null;
 if(!allowedAfter||!observed)
  return withMessage(local,'لم يمكن تأكيد اسم المجموعة ونوعها من Telegram. لا يُعد ذلك إثباتًا لحالة الاتصال.');
 const screen=await renderOwnerInlineGroups(store,policy,actor,info,observed);
 if(!screen)return null;
 const final=await store.snapshot(),at=clock();
 if(!safeTime(at)||at<begin||at>=begin+120_000||
    epoch(final,policy,actor,chatId,version,at)!==expected)return null;
 return screen;
}
