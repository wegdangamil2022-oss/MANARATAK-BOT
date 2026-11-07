import {BotStore,type BotState} from './store.js';
import {Policy} from './policy.js';
import {emptyGameCatalogState,type GameCatalogConfig,type GameCatalogChange,
 type GameCatalogState,validGameCatalogChange,gameCatalogGroup}
 from './phase4-game-catalog-model.js';

const state=(s:BotState):GameCatalogState=>s.phase4GameCatalog??emptyGameCatalogState();
const time=(n:number)=>Number.isSafeInteger(n)&&n>=0&&
 n<=8_640_000_000_000_000-100*86_400_000;
const group=(s:BotState,p:Policy,chatId:string)=>{
 const rows=s.chats.filter(x=>x.id===chatId),chat=rows[0];
 return rows.length===1&&chat?.approved&&chat.version>=1&&
  chat.scopes.includes('navigation')&&p.canUseChat(s,chatId,'navigation')?chat:null;
};
const current=(s:BotState,chatId:string)=>{
 const rows=state(s).groups.filter(x=>x.chatId===chatId);
 return rows.length===1?rows[0]:null;
};
export const gameCatalogRevision=(s:BotState,chatId:string):string=>{
 const c=current(s,chatId);
 return c?c.chatVersion+':'+c.revision:'LEGACY';
};
const utcMinute=(now:number)=>Math.floor((now%86_400_000)/60_000);
const quiet=(c:GameCatalogConfig,now:number):boolean=>{
 if(c.quietStartUtcMinute===undefined||c.quietEndUtcMinute===undefined)return false;
 const minute=utcMinute(now),from=c.quietStartUtcMinute,to=c.quietEndUtcMinute;
 return from<to?minute>=from&&minute<to:minute>=from||minute<to;
};
/** Pure, fail-closed gate for owner-approved quiz rounds. A stale stored
 * config does not silently get inherited by a newly approved group epoch.
 * A missing config preserves existing GAME-002 behavior (no auto-publishing).
 */
export function gameCatalogAllowsQuiz(
 s:BotState,chatId:string,now:number,action:'OPEN'|'ANSWER'
):boolean{
 if(!gameCatalogGroup(chatId)||!time(now))return false;
 const c=current(s,chatId);
 if(!c)return true;
 const rows=s.chats.filter(x=>x.id===chatId);
 if(rows.length!==1||!rows[0]?.approved||
  rows[0].version!==c.chatVersion||!c.quizEnabled||quiet(c,now))return false;
 if(action==='ANSWER')return true;
 const day=Math.floor(now/86_400_000);
 const starts=(s.phase4Quizzes?.quizzes??[]).filter(x=>
  x.chatId===chatId&&x.chatVersion===c.chatVersion&&
  x.openedAt!==undefined&&Math.floor(x.openedAt/86_400_000)===day).length;
 return starts<c.dailyLimit;
}
export type GameCatalogView=GameCatalogChange&{
 chatId:string;chatVersion:number;revision:number;hasPolicy:boolean;
 games:readonly {code:string;label:string;available:boolean}[];
};
const games=[
 {code:'QUIZ',label:'🧠 أسئلة اختيار متعدد',available:true},
 {code:'TRUE_FALSE',label:'✅ صح أو خطأ',available:false},
 {code:'FLAGS',label:'🌍 الأعلام والخرائط',available:false},
 {code:'RIDDLES',label:'🧩 الألغاز والتحديات',available:false},
 {code:'WORDS',label:'🔤 كلمات مبعثرة',available:false},
 {code:'LIVE',label:'⚡ مسابقات مباشرة',available:false}
] as const;
/** Read/writes only local approved-group game policy. No group messages,
 * membership changes, reward grants, or Telegram moderation operations.
 */
export class Phase4GameCatalogService{
 constructor(private readonly store:BotStore,private readonly policy:Policy,
  private readonly clock:()=>number=Date.now){}
 private owner(s:BotState,actor:string,id:string):number|null{
  const c=group(s,this.policy,id);
  return c&&this.policy.isOwner(actor)&&
   this.policy.privateFeature(s,'owner.dashboard',actor)&&
   this.policy.has(s,actor,'chat.manage',id,this.clock())?c.version:null;
 }
 async groups(actor:string):Promise<{chatId:string;chatVersion:number}[]>{
  const s=await this.store.snapshot();
  if(!this.policy.isOwner(actor)||
   !this.policy.privateFeature(s,'owner.dashboard',actor))return [];
  return s.chats.filter(x=>gameCatalogGroup(x.id)&&
   this.owner(s,actor,x.id)===x.version)
   .map(x=>({chatId:x.id,chatVersion:x.version}))
   .sort((a,b)=>a.chatId.localeCompare(b.chatId)).slice(0,100);
 }
 async view(actor:string,id:string):Promise<GameCatalogView|null>{
  if(!gameCatalogGroup(id)||!time(this.clock()))return null;
  const s=await this.store.snapshot(),version=this.owner(s,actor,id);
  if(version===null)return null;
  const stored=current(s,id),policy=stored?.chatVersion===version?stored:null;
  return {chatId:id,chatVersion:version,
   revision:policy?.revision??0,hasPolicy:!!policy,
   quizEnabled:policy?.quizEnabled??true,dailyLimit:policy?.dailyLimit??5,
   ...(policy?.quietStartUtcMinute!==undefined?
    {quietStartUtcMinute:policy.quietStartUtcMinute,
     quietEndUtcMinute:policy.quietEndUtcMinute}:{}),
   games};
 }
 /** Revision zero creates first config; every later edit must supply the
  * current revision. Reapproving a group invalidates its old config.
  */
 async update(actor:string,id:string,expectedRevision:number,
  change:GameCatalogChange):Promise<boolean>{
  const now=this.clock();
  if(!time(now)||!gameCatalogGroup(id)||!Number.isSafeInteger(expectedRevision)||
   expectedRevision<0||!validGameCatalogChange(change))return false;
  return this.store.transaction(s=>{
   const version=this.owner(s,actor,id);
   if(version===null)return false;
   const d=state(s),stored=current(s,id);
   const currentRow=stored?.chatVersion===version?stored:null;
   if((currentRow?.revision??0)!==expectedRevision)return false;
   if(!currentRow&&d.groups.length>=500&&!stored)return false;
   if(expectedRevision>=999999999)return false;
   const row:GameCatalogConfig={chatId:id,chatVersion:version,
    revision:expectedRevision+1,quizEnabled:change.quizEnabled,
    dailyLimit:change.dailyLimit,
    ...(change.quietStartUtcMinute!==undefined?
     {quietStartUtcMinute:change.quietStartUtcMinute,
      quietEndUtcMinute:change.quietEndUtcMinute}:{}),
    updatedAt:now};
   d.groups=d.groups.filter(x=>x.chatId!==id);
   d.groups.push(row);s.phase4GameCatalog=d;
   return true;
  });
 }
}
