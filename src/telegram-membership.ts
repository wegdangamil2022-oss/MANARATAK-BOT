import type {MembershipGateway,Membership} from './subscription.js';
import type {MembershipStatus} from './education-interactions.js';

const id=(text:string):boolean=>{
 if(!/^[1-9][0-9]*$/.test(text))return false;
 const numeric=Number(text);
 return Number.isSafeInteger(numeric)&&numeric>0;
};
const channel=(text:string):boolean=>
 typeof text==='string'&&text.startsWith('-')&&id(text.slice(1));
interface MemberRecord{status:string;user:Record<string,unknown>;is_member?:boolean}
const validRecord=(value:unknown,expectedId:number):value is MemberRecord=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const record=value as Record<string,unknown>;
 const user=record.user;
 return typeof record.status==='string'&&user!==null&&
  typeof user==='object'&&!Array.isArray(user)&&
  (user as Record<string,unknown>).id===expectedId;
};
/** A bounded read-only official getChatMember adapter. No cached group proof and
 * no user-supplied membership flags. The bot must be administrator to rely on
 * this API for membership of other Telegram users.
 */
export class TelegramBotApiMembershipGateway implements MembershipGateway {
 private readonly botId:number;
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch){
  if(!/^[1-9]\d{4,12}:[A-Za-z0-9_-]{30,90}$/.test(token))
   throw Error('INVALID_TELEGRAM_TOKEN');
  this.botId=Number(token.slice(0,token.indexOf(':')));
  if(!Number.isSafeInteger(this.botId))throw Error('INVALID_TELEGRAM_TOKEN');
 }
 private async query(chatId:string,userId:string):Promise<MemberRecord|null>{
  if(!channel(chatId)||!id(userId))return null;
  let response:Response;
  try{
   response=await this.request('https://api.telegram.org/bot'+this.token+'/getChatMember',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:chatId,user_id:Number(userId)}),
    redirect:'error',signal:AbortSignal.timeout(8000)
   });
  }catch{return null;}
  if(!response.ok||response.status!==200)return null;
  const type=response.headers.get('content-type');
  if(type!==null&&!/^application\/json(?:\s*;.*)?$/i.test(type))return null;
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>16_384))return null;
  let value:unknown;
  try{
   const body=await response.text();
   if(body.length>16_384)return null;
   value=JSON.parse(body);
  }catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const envelope=value as Record<string,unknown>;
  if(envelope.ok!==true||!validRecord(envelope.result,Number(userId)))return null;
  return envelope.result;
 }
 /** A successful bot administrator check is required before a student lookup. */
 async canVerifyChannel(channelId:string):Promise<boolean>{
  const record=await this.query(channelId,String(this.botId));
  return record!==null&&['administrator','creator'].includes(record.status);
 }
 async getMember(channelId:string,userId:string):Promise<Membership>{
  const record=await this.query(channelId,userId);
  if(!record)return 'UNKNOWN';
  if(record.user.is_bot===true)return 'UNKNOWN';
  switch(record.status){
   case 'administrator':case 'creator':case 'member':return 'MEMBER';
   case 'restricted':
    return record.is_member===true?'MEMBER':record.is_member===false?'NOT_MEMBER':'UNKNOWN';
   case 'left':case 'kicked':return 'NOT_MEMBER';
   default:return 'UNKNOWN';
  }
 }
 /** For private conversations referencing protected group-scoped resources:
  * do not infer membership from a chat ID, bot username or API error.
  */
 async verifyMembership(chatId:string,userId:string):Promise<MembershipStatus>{
  if(!channel(chatId)||!id(userId))return 'UNKNOWN';
  if(!await this.canVerifyChannel(chatId))return 'UNKNOWN';
  const result=await this.getMember(chatId,userId);
  return result==='MEMBER'?'VERIFIED':result==='NOT_MEMBER'?'NOT_MEMBER':'UNKNOWN';
 }
}
