import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {BotState,BotStore} from './store.js';
import type {Policy} from './policy.js';
import {MODERATION_RATE_LIMITS,validModerationRateConfig,type ModerationRateConfig} from './moderation-rate-fuse.js';
import {protectionUIEpoch,type AdminUIAccess} from './protection-ui-access.js';
import type {OwnerInlineScreen} from './telegram-inline-owner.js';

const prefix='moderation-rate:';
const fields={a:'actorChatTenMinutes',g:'groupTenMinutes',d:'actorAllChatsDay'} as const;
const labels={a:'المشرف في المجموعة خلال 10 دقائق',g:'المجموعة خلال 10 دقائق',d:'الحساب خلال 24 ساعة'} as const;
const options={a:[1,3,5,10],g:[3,6,12,20],d:[5,15,30,50]} as const;
type Key=keyof typeof fields;
const route=/^rf:1:([pc]):([agd]):([1-9][0-9]?):([a-f0-9]{16})$/u;
export function validModerationRateEditorRoute(data:string):boolean{const match=route.exec(data);return data==='rf:1:e'||!!match&&match[0]===data&&(options[match[2] as Key] as readonly number[]).includes(Number(match[3]));}
const active=(s:BotState,actor:string,now:number)=>{const rows=s.wizards.filter(w=>w.key===prefix+actor),w=rows[0];return rows.length===1&&w?.userId===actor&&w.chatId===actor&&w.status==='ACTIVE'&&typeof w.flow==='string'&&/^moderation-rate:[A-Za-z0-9_-]{24}$/u.test(w.flow)&&Number.isSafeInteger(w.expiresAt)&&w.expiresAt>now&&w.expiresAt<=now+120000?w:null;};
const current=(s:BotState)=>s.moderationRateConfig??{actorChatTenMinutes:MODERATION_RATE_LIMITS.actorChatTenMinutes,groupTenMinutes:MODERATION_RATE_LIMITS.groupTenMinutes,actorAllChatsDay:MODERATION_RATE_LIMITS.actorAllChatsDay,revision:0};
const digest=(s:BotState,actor:string,now:number)=>createHash('sha256').update(JSON.stringify([actor,current(s),active(s,actor,now),s.privateFeatures['owner.dashboard'],s.privateSettingsRevision??0])).digest('hex').slice(0,16);
type Screen=OwnerInlineScreen&{access:AdminUIAccess};
export class TelegramModerationRateEditor{
 constructor(private readonly store:BotStore,private readonly policy:Policy,private readonly clock:()=>number=Date.now){}
 async cancel(actor:string):Promise<void>{const snapshot=await this.store.snapshot();if(!snapshot.wizards.some(w=>w.key===prefix+actor&&w.status==='ACTIVE'))return;await this.store.transaction(s=>{for(const w of s.wizards)if(w.key===prefix+actor)w.status='CANCELLED';});}
 async handle(actor:string,data:string):Promise<Screen|null>{
  if(!this.policy.isOwner(actor))return null;const now=this.clock();if(!Number.isSafeInteger(now)||now<0||now>8640000000000000-120000)return null;
  const match=route.exec(data);if(data!=='rf:1:e'&&(!match||match[0]!==data))return null;
  if(data==='rf:1:e')await this.store.transaction(s=>{if(!this.policy.privateFeature(s,'owner.dashboard',actor))return;s.wizards=s.wizards.filter(w=>w.key!==prefix+actor);s.wizards.push({key:prefix+actor,userId:actor,chatId:actor,topicId:'',flow:prefix+randomBytes(18).toString('base64url'),step:0,version:1,policyVersion:0,expiresAt:now+120000,status:'ACTIVE'});});
  let state=await this.store.snapshot();if(!this.policy.privateFeature(state,'owner.dashboard',actor)||!active(state,actor,now)||state.moderationRateConfig!==undefined&&!validModerationRateConfig(state.moderationRateConfig))return null;
  const key=match?.[2] as Key|undefined,value=match?Number(match[3]):undefined;
  if(match&&(!key||value===undefined||!(options[key] as readonly number[]).includes(value)||match[4]!==digest(state,actor,now)))return null;
  const step=key&&value!==undefined?({a:100,g:200,d:300}[key]+value):0;
  if(match?.[1]==='p'){
   const claimed=await this.store.transaction(s=>{const at=this.clock(),session=active(s,actor,at);if(!Number.isSafeInteger(at)||at<now||at>=now+120000||!session||session.step!==0||!this.policy.privateFeature(s,'owner.dashboard',actor)||digest(s,actor,at)!==match[4])return false;session.step=step;session.flow=prefix+randomBytes(18).toString('base64url');return true;});if(!claimed)return null;state=await this.store.snapshot();
  }
  if(match?.[1]==='c'&&key&&value!==undefined){
   const changed=await this.store.transaction(s=>{const at=this.clock(),session=active(s,actor,at);if(!Number.isSafeInteger(at)||at<now||at>=now+120000||!session||session.step!==step||!this.policy.privateFeature(s,'owner.dashboard',actor)||digest(s,actor,at)!==match[4])return false;const config={...current(s),[fields[key]]:value,revision:current(s).revision+1};if(!validModerationRateConfig(config))return false;s.moderationRateConfig=config as ModerationRateConfig;session.status='CANCELLED';s.audit.push({updateKey:'moderation:rate:'+randomUUID(),actorId:actor,decision:'ALLOW',reason:'MODERATION_RATE_LIMIT_CHANGED',policyVersion:config.revision,at});return true;});
   if(!changed)return null;state=await this.store.snapshot();const access=protectionUIEpoch(state,this.policy,actor,this.clock());return access?{text:'✅ حُفظ حد العقوبات الجديد. يطبق على العمليات القادمة وفق السجل الحالي.',keyboard:{inline_keyboard:[[{text:'↩️ حدود العقوبات',callback_data:'mi:1:i:02:15'},{text:'🏠 لوحة المالك',callback_data:'mi:1:h'}]]},access:{actorId:actor,epoch:access,expiresAt:now+120000}}:null;
  }
  const access=protectionUIEpoch(state,this.policy,actor,now);if(!access)return null;const proof=digest(state,actor,now),cfg=current(state);
  if(key&&value!==undefined)return {text:'<b>معاينة حد العقوبات</b>\n'+labels[key]+'\nالحالي: '+cfg[fields[key]]+'\nالمقترح: '+value+'\nينطبق بعد التأكيد على العمليات الجديدة، وتبقى المحاولات السابقة محسوبة.',keyboard:{inline_keyboard:[[{text:'✅ تأكيد التغيير',callback_data:'rf:1:c:'+key+':'+value+':'+proof}],[{text:'↩️ تغيير الاختيار',callback_data:'rf:1:e'},{text:'إلغاء',callback_data:'mi:1:i:02:15'}]]},access:{actorId:actor,epoch:access,expiresAt:now+120000}};
  const rows=(Object.keys(fields) as Key[]).map(k=>options[k].map(n=>({text:labels[k].split(' خلال')[0]+' '+n,callback_data:'rf:1:p:'+k+':'+n+':'+proof})));
  rows.push([{text:'↩️ حدود العقوبات',callback_data:'mi:1:i:02:15'}]);return {text:'<b>تعديل حدود العقوبات</b>\nاختر قيمة لمعاينتها؛ لا يُحفظ تغيير قبل التأكيد. الحدود الأخرى تبقى كما هي.',keyboard:{inline_keyboard:rows},access:{actorId:actor,epoch:access,expiresAt:now+120000}};
 }
}
