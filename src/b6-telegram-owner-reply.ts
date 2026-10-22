export type B6OwnerReplyTarget=
 |{status:'QUESTION';question:string}
 |{status:'MISSING_REPLY'|'INVALID'};
export function parseB6OwnerReplyTarget(
 _reply:unknown,_chatId:string,_currentMessageId:number|undefined,_actorId:string
):B6OwnerReplyTarget{return {status:'MISSING_REPLY'};}
