import type {B6AnswerRequest} from './b6-approved-answer-preflight.js';
import type {B6DraftResult} from './b6-generation-draft.js';
import {B6GenerationDraftService} from './b6-generation-draft.js';

/** OFFLINE contract only: the caller must supply Telegram-verified update identifiers,
 * never user-supplied text or an arbitrary retry nonce.
 */
export interface B6VerifiedTelegramIntent {
 readonly botId:string;
 readonly updateId:number;
}
export class B6TelegramIntentKeys {
 constructor(_secretHex:string){}
 derive(_intent:unknown):string|null{return null;}
}
export class B6TelegramDraftEntrypoint {
 constructor(_keys:B6TelegramIntentKeys,_service:B6GenerationDraftService){}
 async prepare(_input:B6AnswerRequest,_intent:unknown):Promise<B6DraftResult>{
  return {status:'INVALID_REQUEST'};
 }
}
