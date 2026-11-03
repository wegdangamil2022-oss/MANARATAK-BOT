import type {BotStore,RollingMessageMeta} from './store.js';
import type {Policy} from './policy.js';

type Observation={chatId:string;senderId:string;messageId:number;sentAt:number;updateId:number;contentType:'TEXT'|'MEDIA'|'COMMAND';hasLinks:boolean};
const windowMs=48*60*60*1000,capacity=10000;
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=8640000000000000;
const group=(v:string)=>/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
const user=(v:string)=>/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));

export class TelegramMessageMetadataCollector{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now){}
 async observe(input:Observation):Promise<'STORED'|'IGNORED'|'CONFLICT'|'FULL'>{
  try{input=structuredClone(input);}catch{return 'IGNORED';}
  const now=this.clock();
  if(!input||Object.keys(input).sort().join(',')!=='chatId,contentType,hasLinks,messageId,senderId,sentAt,updateId'||!integer(now)||typeof input.chatId!=='string'||!group(input.chatId)||typeof input.senderId!=='string'||!user(input.senderId)||!integer(input.messageId)||input.messageId===0||!integer(input.sentAt)||!integer(input.updateId)||!['TEXT','MEDIA','COMMAND'].includes(input.contentType)||typeof input.hasLinks!=='boolean'||input.sentAt>now||input.sentAt<=now-windowMs)return 'IGNORED';
  return this.store.transaction(s=>{
   if(!this.policy.canUseChat(s,input.chatId,'moderation'))return 'IGNORED' as const;
   const at=this.clock();if(!integer(at)||at<now||input.sentAt>at||input.sentAt<=at-windowMs)return 'IGNORED' as const;
   s.rollingMessageMeta=s.rollingMessageMeta.filter(m=>!integer(m.sentAt)||m.sentAt>at-windowMs);
   const rows=s.rollingMessageMeta.filter(m=>m.chatId===input.chatId&&m.messageId===input.messageId),old=rows[0];
   if(rows.length>1)return 'CONFLICT' as const;
   if(old){
    if(old.senderKind!=='USER'||old.senderId!==input.senderId||old.sentAt!==input.sentAt)return 'CONFLICT' as const;
    if(old.protectionUnverified!==true||!integer(old.sourceUpdateId))return 'IGNORED' as const;
    if(input.updateId<=old.sourceUpdateId!)return 'IGNORED' as const;
    old.sourceUpdateId=input.updateId;old.observedAt=at;old.contentType=input.contentType;old.hasLinks=input.hasLinks;
   }else{
    if(s.rollingMessageMeta.length>=capacity)return 'FULL' as const;
    const row:RollingMessageMeta={chatId:input.chatId,messageId:input.messageId,senderKind:'USER',senderId:input.senderId,sentAt:input.sentAt,observedAt:at,contentType:input.contentType,hasLinks:input.hasLinks,pinned:false,linkedChannel:false,adminLog:false,approvedAnnouncement:false,protectionUnverified:true,sourceUpdateId:input.updateId};
    s.rollingMessageMeta.push(row);
   }
   return 'STORED' as const;
  });
 }
 async prune():Promise<number>{
  const now=this.clock();if(!integer(now))throw Error('MESSAGE_METADATA_CLOCK_INVALID');
  return this.store.transaction(s=>{const before=s.rollingMessageMeta.length;s.rollingMessageMeta=s.rollingMessageMeta.filter(m=>!integer(m.sentAt)||m.sentAt>now-windowMs);return before-s.rollingMessageMeta.length;});
 }
 async observePinned(chatId:string,messageId:number):Promise<'PROTECTED'|'IGNORED'>{
  if(typeof chatId!=='string'||!group(chatId)||!integer(messageId)||messageId===0||!integer(this.clock()))return 'IGNORED';
  return this.store.transaction(s=>{
   if(!this.policy.canUseChat(s,chatId,'moderation')||!integer(this.clock()))return 'IGNORED' as const;
   const rows=s.rollingMessageMeta.filter(m=>m.chatId===chatId&&m.messageId===messageId);
   if(!rows.length)return 'IGNORED' as const;
   for(const row of rows)row.pinned=true;
   return 'PROTECTED' as const;
  });
 }
}
