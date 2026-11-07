/** Phase 4 / 09:13 — private reactions to owner-catalogued posts.
 * This is not Telegram-native reactions, a contest ballot, or proof that
 * the bot authored a Telegram message. The owner manually reviews source.
 */
export type ReactionKind='BOT_POST'|'COMMUNITY_QUESTION'|'STUDY_EXPERIENCE';
export type ReactionTargetStatus='DRAFT'|'OPEN'|'CLOSED';
export interface ReactionTarget{
 id:string;chatId:string;chatVersion:number;ownerId:string;
 kind:ReactionKind;messageId:number;description:string;
 /** Always false: no Telegram message-origin verification in this module. */
 sourceVerified:false;
 status:ReactionTargetStatus;revision:1|2|3;
 createdAt:number;expiresAt:number;openedAt?:number;closedAt?:number;
}
export interface Reaction{
 id:string;targetId:string;memberId:string;
 status:'ACTIVE'|'WITHDRAWN';revision:1|2;createdAt:number;
 withdrawnAt?:number;
}
export interface ReactionState{targets:ReactionTarget[];reactions:Reaction[];}
export const emptyReactionState=():ReactionState=>({targets:[],reactions:[]});
const object=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]) =>
 required.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>required.includes(k)||optional.includes(k));
const stamp=(v:unknown):v is number=>typeof v==='number'&&
 Number.isSafeInteger(v)&&v>=0&&v<=8_640_000_000_000_000-40*86_400_000;
const rev=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1&&v<=9_999_999_999;
export const reactionId=(v:unknown):v is string=>
 typeof v==='string'&&/^[a-f0-9]{24}$/u.test(v);
export const reactionUser=(v:unknown):v is string=>
 typeof v==='string'&&/^[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
export const reactionGroup=(v:unknown):v is string=>
 typeof v==='string'&&/^-[1-9][0-9]{0,15}$/u.test(v)&&Number.isSafeInteger(Number(v));
export const validReactionDescription=(v:unknown):v is string=>
 typeof v==='string'&&v===v.trim()&&v.length>=8&&v.length<=120&&
 !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v)&&
 !/(?:https?:\/\/|www\.|t\.me\/|@[\w]{3,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\d[\d\s+()-]{7,}\d)/iu.test(v);
export function validReactionInput(input:unknown):input is {
 kind:ReactionKind;messageId:number;description:string;durationMinutes:number
}{
 if(!object(input)||!exact(input,['kind','messageId','description','durationMinutes']))return false;
 return ['BOT_POST','COMMUNITY_QUESTION','STUDY_EXPERIENCE'].includes(String(input.kind))&&
  Number.isSafeInteger(input.messageId)&&Number(input.messageId)>=1&&
  Number(input.messageId)<=2_147_483_647&&validReactionDescription(input.description)&&
  Number.isSafeInteger(input.durationMinutes)&&
  Number(input.durationMinutes)>=10&&Number(input.durationMinutes)<=1440;
}
export function validReactionTarget(v:unknown):v is ReactionTarget{
 if(!object(v)||!exact(v,['id','chatId','chatVersion','ownerId','kind','messageId',
  'description','sourceVerified','status','revision','createdAt','expiresAt'],
  ['openedAt','closedAt'])||!reactionId(v.id)||!reactionGroup(v.chatId)||
  !reactionUser(v.ownerId)||!rev(v.chatVersion)||v.sourceVerified!==false||
  !stamp(v.createdAt)||!stamp(v.expiresAt)||!validReactionInput({
   kind:v.kind,messageId:v.messageId,description:v.description,
   durationMinutes:(Number(v.expiresAt)-Number(v.createdAt))/60_000
  }))return false;
 if(v.status==='DRAFT')return v.revision===1&&
  v.openedAt===undefined&&v.closedAt===undefined;
 if(v.status==='OPEN')return v.revision===2&&stamp(v.openedAt)&&
  Number(v.openedAt)>=v.createdAt&&Number(v.openedAt)<v.expiresAt&&
  v.closedAt===undefined;
 if(v.status==='CLOSED')return stamp(v.closedAt)&&Number(v.closedAt)>=v.createdAt&&
  (v.openedAt===undefined?v.revision===2:
   v.revision===3&&stamp(v.openedAt)&&
   Number(v.openedAt)>=v.createdAt&&Number(v.openedAt)<v.expiresAt&&
   Number(v.closedAt)>=v.openedAt);
 return false;
}
function validReaction(v:unknown):v is Reaction{
 if(!object(v)||!exact(v,['id','targetId','memberId','status','revision','createdAt'],
  ['withdrawnAt'])||!reactionId(v.id)||!reactionId(v.targetId)||
  !reactionUser(v.memberId)||!stamp(v.createdAt))return false;
 if(v.status==='ACTIVE')return v.revision===1&&v.withdrawnAt===undefined;
 return v.status==='WITHDRAWN'&&v.revision===2&&stamp(v.withdrawnAt)&&
  Number(v.withdrawnAt)>=v.createdAt;
}
export function validReactionState(raw:unknown):raw is ReactionState{
 if(!object(raw)||!exact(raw,['targets','reactions'])||
  !Array.isArray(raw.targets)||raw.targets.length>200||
  !Array.isArray(raw.reactions)||raw.reactions.length>5000||
  raw.targets.some(x=>!validReactionTarget(x))||
  raw.reactions.some(x=>!validReaction(x)))return false;
 const targets=raw.targets as ReactionTarget[],reactions=raw.reactions as Reaction[];
 if(new Set(targets.map(x=>x.id)).size!==targets.length||
  new Set(targets.map(x=>x.chatId+':'+x.messageId)).size!==targets.length||
  new Set(reactions.map(x=>x.id)).size!==reactions.length||
  new Set(reactions.map(x=>x.targetId+':'+x.memberId)).size!==reactions.length)
  return false;
 const byId=new Map(targets.map(x=>[x.id,x]));
 for(const row of reactions){
  const target=byId.get(row.targetId);
  if(!target||target.openedAt===undefined||row.memberId===target.ownerId||
   row.createdAt<target.openedAt||row.createdAt>=target.expiresAt||
   target.closedAt!==undefined&&row.createdAt>target.closedAt)return false;
 }
 return true;
}
