/**
 * A private student may explicitly request one exact, owner-approved FAQ
 * answer. The command is NOT an AI opt-in nor a request to inspect a group.
 */
export function parsePrivateFAQQuery(text:string):string|null{
 if(typeof text!=='string'||text.length>250)return null;
 const match=/^\/faq ([^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]{1,246})$/u.exec(text);
 if(!match)return null;
 const q=match[1]!.trim();
 return q&&Array.from(q).length<=240?q:null;
}
