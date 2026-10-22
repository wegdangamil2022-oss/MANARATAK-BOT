/** Strict, offline Telegram explicit mention parser. */
export type B6ExplicitMention = {status:'MATCH';question:string}|
 {status:'NO_MATCH'|'INVALID'};
export function parseB6ExplicitMention(
 _text:string,_entities:unknown,_botUsername:string):B6ExplicitMention{
 return {status:'NO_MATCH'};
}
