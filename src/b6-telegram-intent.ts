import {createHmac} from 'node:crypto';
import type {B6AnswerRequest} from './b6-approved-answer-preflight.js';
import type {B6DraftResult} from './b6-generation-draft.js';
import {B6GenerationDraftService} from './b6-generation-draft.js';

/** OFFLINE contract only. The Telegram ingress must supply verified update IDs,
 * NOT fields taken from a student's message. IDs or questions never enter the
 * persistent B6 budget ledger; only a deterministic keyed digest does.
 */
export interface B6VerifiedTelegramIntent {
 readonly botId:string;
 readonly updateId:number;
}
const botIdPattern=/^[A-Za-z0-9_-]{1,80}$/u;
const hexKey=/^[a-fA-F0-9]{64}$/u;
const DOMAIN='MANARATAK:B6:TG-UPDATE:v1:';
const isRecord=(v:unknown):v is Record<string,unknown>=>
 v!==null&&typeof v==='object'&&!Array.isArray(v);

/** Supply one stable high-entropy secret in trusted configuration (32 random
 * bytes, hex encoded). Never derive it from a Telegram token, owner ID, date,
 * message text or a new random value at each boot. Rotation needs migration
 * coordination: a changed secret changes replay keys.
 */
export class B6TelegramIntentKeys {
 private readonly key:Buffer;
 constructor(secretHex:string){
  if(typeof secretHex!=='string'||!hexKey.test(secretHex)||
    /^0{64}$/u.test(secretHex))
   throw Error('INVALID_B6_TELEGRAM_INTENT_SECRET');
  this.key=Buffer.from(secretHex,'hex');
 }
 derive(intent:unknown):string|null{
  try{
   if(!isRecord(intent)||Object.keys(intent).length!==2||
     !Object.prototype.hasOwnProperty.call(intent,'botId')||
     !Object.prototype.hasOwnProperty.call(intent,'updateId')||
     typeof intent.botId!=='string'||!botIdPattern.test(intent.botId)||
     typeof intent.updateId!=='number'||!Number.isSafeInteger(intent.updateId)||
     intent.updateId<0)return null;
   const digest=createHmac('sha256',this.key)
    .update(DOMAIN,'utf8')
    // An explicit pair encoding avoids accidental collisions from separators.
    .update(JSON.stringify([intent.botId,intent.updateId]),'utf8')
    .digest('base64url');
   return 'b6tg1_'+digest;
  }catch{return null;}
 }
}

/** A dedicated durable-only, fake-generation path. It cannot silently fall
 * back to in-memory admission; the normal live Telegram handler does NOT call
 * this class and AI generation remains disabled in deployment.
 */
export class B6TelegramDraftEntrypoint {
 constructor(private readonly keys:B6TelegramIntentKeys,
  private readonly service:B6GenerationDraftService){}
 async prepare(input:B6AnswerRequest,intent:unknown):Promise<B6DraftResult>{
  const requestKey=this.keys.derive(intent);
  if(!requestKey)return {status:'INVALID_REQUEST'};
  try{return await this.service.prepareDurableDraft(input,requestKey);}
  catch{return {status:'UNAVAILABLE'};}
 }
}
