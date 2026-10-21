import {createHash} from 'node:crypto';
import {BotStore} from './store.js';
import {Policy} from './policy.js';

/** B5's proposed read-only adapter boundary. An independently reviewed
 * adapter may later map a real platform API into this contract. It MUST be
 * configured and authenticated separately: this package does not invent
 * routes, credentials, tokens, or a production endpoint.
 */
export interface PlatformCatalogReader{
 fetchPage(query:Readonly<{scope:'private';limit:number;cursor:string|null}>):Promise<unknown>;
}
export interface PlatformReviewCandidate{
 id:string;revision:number;title:string;university:string;cycle:string;
 degree:string;reviewState:'UNVERIFIED_EXTERNAL';
}
export type PlatformCatalogPreviewResult=
 |{status:'DENIED'|'UNAVAILABLE'}
 |{status:'PREVIEW';records:PlatformReviewCandidate[];nextCursor:string|null;fingerprint:string};

const validId=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const validCursor=/^[A-Za-z0-9_-]{1,64}$/u;
const controls=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const isObject=(value:unknown):value is Record<string,unknown>=>
 Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function exactKeys(value:Record<string,unknown>,expected:readonly string[]):boolean{
 return Object.keys(value).length===expected.length&&
  expected.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}
const boundedText=(value:unknown,max:number):value is string=>
 typeof value==='string'&&value.length>=1&&value.length<=max&&
 value.trim()===value&&value.length>0&&!controls.test(value);
function parsePage(raw:unknown,limit:number,cursor:string|null):
 {records:PlatformReviewCandidate[];nextCursor:string|null}|null{
 if(!isObject(raw)||!exactKeys(raw,['schema','records','nextCursor'])||
   raw.schema!=='manaratak-readonly-catalog-v1'||
   !Array.isArray(raw.records)||raw.records.length>limit||
   !(raw.nextCursor===null||typeof raw.nextCursor==='string'&&
     validCursor.test(raw.nextCursor)&&raw.nextCursor!==cursor))return null;
 const result:PlatformReviewCandidate[]=[];
 const seen=new Set<string>();
 for(const item of raw.records){
  if(!isObject(item)||
    !exactKeys(item,['id','revision','scope','publication','title','university','cycle','degree'])||
    typeof item.id!=='string'||!validId.test(item.id)||
    seen.has(item.id)||typeof item.revision!=='number'||
    !Number.isSafeInteger(item.revision)||item.revision<1||
    item.scope!=='private'||item.publication!=='PUBLISHED'||
    !boundedText(item.title,160)||!boundedText(item.university,120)||
    !boundedText(item.cycle,32)||!boundedText(item.degree,64))return null;
  seen.add(item.id);
  result.push({
   id:item.id,revision:item.revision as number,title:item.title,
   university:item.university,cycle:item.cycle,degree:item.degree,
   reviewState:'UNVERIFIED_EXTERNAL'
  });
 }
 return {records:result,nextCursor:raw.nextCursor as string|null};
}

/** Owner-only, ephemeral external candidate preview. Never writes BotStore,
 * never publishes locally, never changes Telegram buttons, never sends to
 * channels or makes network requests by itself. Platform self-reported
 * 'PUBLISHED' is still NOT a locally reviewed publication approval.
 */
export class PlatformCatalogPreviewService{
 constructor(
  private readonly store:BotStore,
  private readonly policy:Policy,
  private readonly reader:PlatformCatalogReader
 ){}
 async preview(actor:string,request:Readonly<{limit?:number;cursor?:string|null}>={}):
  Promise<PlatformCatalogPreviewResult>{
  if(!this.policy.isOwner(actor))return {status:'DENIED'};
  if(!isObject(request)||Object.keys(request).some(k=>k!=='limit'&&k!=='cursor'))
   return {status:'UNAVAILABLE'};
  const limit=request.limit??10,cursor=request.cursor??null;
  if(!Number.isSafeInteger(limit)||limit<1||limit>10||
    cursor!==null&&(typeof cursor!=='string'||!validCursor.test(cursor)))
   return {status:'UNAVAILABLE'};
  const ownerDashboardActive=async():Promise<boolean>=>{
   const state=await this.store.snapshot();
   return this.policy.privateFeature(state,'owner.dashboard',actor);
  };
  try{
   if(!await ownerDashboardActive())return {status:'DENIED'};
  }catch{return {status:'UNAVAILABLE'};}
  let raw:unknown;
  try{raw=await this.reader.fetchPage({scope:'private',limit,cursor});}
  catch{return {status:'UNAVAILABLE'};}
  // Re-check after external work; a disabled owner dashboard must invalidate
  // the stale response rather than exposing third-party candidate content.
  try{
   if(!await ownerDashboardActive())return {status:'DENIED'};
  }catch{return {status:'UNAVAILABLE'};}
  let parsed:ReturnType<typeof parsePage>=null;
  try{parsed=parsePage(raw,limit,cursor);}
  catch{return {status:'UNAVAILABLE'};}
  if(!parsed)return {status:'UNAVAILABLE'};
  const fingerprint=createHash('sha256').update(JSON.stringify({
   schema:'manaratak-readonly-catalog-v1',scope:'private',limit,cursor,
   records:parsed.records,nextCursor:parsed.nextCursor
  }),'utf8').digest('hex');
  return {status:'PREVIEW',records:parsed.records,
   nextCursor:parsed.nextCursor,fingerprint};
 }
}
