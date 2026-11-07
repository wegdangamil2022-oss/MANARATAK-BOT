import {createHash} from 'node:crypto';

/** Explicit allowlist from https://core.telegram.org/bots/api#promotechatmember.
 * This adapter only grants DELETE or RESTRICT; it never grants promotion rights. */
export const ADMIN_ROLE_FLAGS=Object.freeze(['is_anonymous','can_manage_chat','can_delete_messages','can_manage_video_chats','can_restrict_members','can_promote_members','can_change_info','can_invite_users','can_post_stories','can_edit_stories','can_delete_stories','can_post_messages','can_edit_messages','can_pin_messages','can_manage_topics','can_manage_direct_messages','can_manage_tags','can_send_welcome_messages'] as const);
export type AdminRole='DELETE'|'RESTRICT'|'DEMOTE';
export type AdminRolePlan=Readonly<{group:string;target:string;role:AdminRole;baseline:string}>;
type ObjectValue=Record<string,unknown>;
const object=(v:unknown):v is ObjectValue=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const user=(v:string)=>/^[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const group=(v:string)=>/^-[1-9][0-9]{0,15}$/u.exec(v)?.[0]===v&&Number.isSafeInteger(Number(v));
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rights=(role:AdminRole)=>Object.fromEntries(ADMIN_ROLE_FLAGS.map(k=>[k,role!=='DEMOTE'&&(k==='can_manage_chat'||k===(role==='DELETE'?'can_delete_messages':'can_restrict_members'))]));

/** Unwired adapters make no requests. Plans are instance-bound and single-use;
 * caller must durably claim a confirmed user intent before execute(). */
export class TelegramAdminRoleGateway{
 readonly #plans=new WeakSet<AdminRolePlan>();
 readonly #bot:string;
 isBot(target:string):boolean{return target===this.#bot;}
 static trusted(v:unknown):v is TelegramAdminRoleGateway{return typeof v==='object'&&v!==null&&#plans in v&&Object.getPrototypeOf(v)===TelegramAdminRoleGateway.prototype&&Object.isFrozen(v);}
 constructor(private readonly token:string,private readonly request:typeof fetch=fetch,private readonly safety:()=>Promise<boolean>=async()=>false){this.#bot=token.split(':')[0]??'';Object.freeze(this);}
 async #allowed(authority:()=>Promise<boolean>):Promise<boolean>{try{return await this.safety()===true&&await authority()===true;}catch{return false;}}
 async #call(method:'getChat'|'getChatMember'|'promoteChatMember',body:ObjectValue,authority:()=>Promise<boolean>):Promise<unknown>{
  if(!/^[1-9][0-9]{4,12}:[A-Za-z0-9_-]{30,90}$/u.test(this.token)||!await this.#allowed(authority))return null;
  try{
   const response=await this.request('https://api.telegram.org/bot'+this.token+'/'+method,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
   if(!response.ok||!/^application\/json(?:\s*;.*)?$/iu.test(response.headers.get('content-type')??''))return null;
   const text=await response.text();if(Buffer.byteLength(text)>16384)return null;const value:unknown=JSON.parse(text);
   return object(value)&&value.ok===true?value.result:null;
  }catch{return null;}
 }
 async #inspect(chat:string,target:string,role:AdminRole,authority:()=>Promise<boolean>):Promise<string|null>{
  if(!group(chat)||!user(target)||target===this.#bot||!['DELETE','RESTRICT','DEMOTE'].includes(role))return null;
  const chatInfo=await this.#call('getChat',{chat_id:chat},authority);if(!object(chatInfo)||chatInfo.id!==Number(chat)||chatInfo.type!=='supergroup')return null;
  const bot=await this.#call('getChatMember',{chat_id:chat,user_id:Number(this.#bot)},authority);
  if(!object(bot)||!object(bot.user)||bot.user.id!==Number(this.#bot)||bot.user.is_bot!==true||bot.status!=='administrator'||bot.can_manage_chat!==true||bot.can_promote_members!==true||role==='DELETE'&&bot.can_delete_messages!==true||role==='RESTRICT'&&bot.can_restrict_members!==true)return null;
  const member=await this.#call('getChatMember',{chat_id:chat,user_id:Number(target)},authority);
  if(!object(member)||!object(member.user)||member.user.id!==Number(target)||member.user.is_bot!==false)return null;
  if(role==='DEMOTE'?member.status!=='administrator'||member.can_be_edited!==true:member.status!=='member')return null;
  if(!await this.#allowed(authority))return null;
  return digest([chat,target,role,member.status,member.can_be_edited??null,ADMIN_ROLE_FLAGS.map(k=>member[k]??null),ADMIN_ROLE_FLAGS.map(k=>bot[k]??null)]);
 }
 async prepare(chat:string,target:string,role:AdminRole,authority:()=>Promise<boolean>):Promise<AdminRolePlan|null>{
  const baseline=await this.#inspect(chat,target,role,authority);if(!baseline)return null;
  const plan=Object.freeze({group:chat,target,role,baseline});this.#plans.add(plan);return plan;
 }
 /** Current observation is never evidence of who caused a past change. */
 async observe(chat:string,target:string,authority:()=>Promise<boolean>):Promise<{status:string;digest:string}|null>{
  if(!group(chat)||!user(target)||target===this.#bot)return null;
  const value=await this.#call('getChatMember',{chat_id:chat,user_id:Number(target)},authority);
  if(!await this.#allowed(authority)||!object(value)||!object(value.user)||value.user.id!==Number(target)||value.user.is_bot!==false||!['member','administrator','creator','restricted','left','kicked'].includes(String(value.status)))return null;
  if(ADMIN_ROLE_FLAGS.some(k=>value[k]!==undefined&&typeof value[k]!=='boolean'))return null;
  return {status:String(value.status),digest:digest([chat,target,value.status,value.can_be_edited??null,ADMIN_ROLE_FLAGS.map(k=>value[k]??null)])};
 }
 async execute(plan:AdminRolePlan,authority:()=>Promise<boolean>):Promise<'DENIED'|'CONFIRMED'|'UNKNOWN_OUTCOME'>{
  if(!this.#plans.has(plan))return 'DENIED';this.#plans.delete(plan);
  const baseline=await this.#inspect(plan.group,plan.target,plan.role,authority);if(baseline!==plan.baseline||!await this.#allowed(authority))return 'DENIED';
  const intended=rights(plan.role),ack=await this.#call('promoteChatMember',{chat_id:plan.group,user_id:Number(plan.target),...intended},authority);
  if(ack!==true)return 'UNKNOWN_OUTCOME';
  const member=await this.#call('getChatMember',{chat_id:plan.group,user_id:Number(plan.target)},authority);
  if(!await this.#allowed(authority)||!object(member)||!object(member.user)||member.user.id!==Number(plan.target)||member.user.is_bot!==false)return 'UNKNOWN_OUTCOME';
  if(plan.role==='DEMOTE')return member.status==='member'&&!ADMIN_ROLE_FLAGS.some(k=>member[k]!==undefined&&member[k]!==false)?'CONFIRMED':'UNKNOWN_OUTCOME';
  if(member.status!=='administrator'||member.can_be_edited!==true)return 'UNKNOWN_OUTCOME';
  // Missing requested true flags and any unexpected privilege fail closed.
  if(ADMIN_ROLE_FLAGS.some(k=>intended[k]?member[k]!==true:member[k]!==undefined&&member[k]!==false)||Object.entries(member).some(([k,v])=>k.startsWith('can_')&&k!=='can_be_edited'&&v===true&&!(k in intended)))return 'UNKNOWN_OUTCOME';
  return 'CONFIRMED';
 }
}
Object.freeze(TelegramAdminRoleGateway.prototype);
Object.freeze(TelegramAdminRoleGateway);
