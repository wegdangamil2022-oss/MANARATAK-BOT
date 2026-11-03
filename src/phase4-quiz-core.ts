/** Phase 4 multiple-choice quiz rules. Pure and side-effect free: does not send Telegram
 * messages, grant group access, store answers, or execute moderation actions.
 * The Telegram adapter must verify group authorization and voter identity before calling.
 */
export interface QuizRound {
 readonly id:string;
 readonly chatId:string;
 readonly prompt:string;
 readonly options:readonly string[];
 /** Confidential to trusted server-side storage; never serialize in a public view. */
 readonly correctOption:number;
 readonly explanation?:string;
 readonly opensAt:number;
 readonly closesAt:number;
 readonly status:'OPEN'|'CLOSED';
 readonly answers:readonly QuizAnswer[];
}
export interface QuizAnswer {readonly userId:string;readonly optionIndex:number;readonly answeredAt:number;}
export interface CreateQuizInput {
 id:string;chatId:string;prompt:string;options:readonly string[];correctOption:number;
 opensAt:number;closesAt:number;explanation?:string;
}
export interface QuizSummary {readonly total:number;readonly correct:number;readonly incorrect:number;readonly correctOption:number;}
export type QuizVoteStatus='RECORDED'|'DUPLICATE'|'NOT_OPEN'|'CLOSED'|'DENIED'|'FULL';
export type QuizVoteResult={readonly status:QuizVoteStatus;readonly round:QuizRound};
export type QuizCloseResult={readonly status:'CLOSED'|'NOT_READY';readonly round:QuizRound;readonly summary:QuizSummary|null};

const idPattern=/^[A-Za-z0-9_-]{1,32}$/u;
const groupPattern=/^-[1-9][0-9]{0,15}$/u;
const userPattern=/^[1-9][0-9]{0,15}$/u;
const unsafeText=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const goodText=(s:unknown,max:number):s is string=>typeof s==='string'&&
 s.trim().length>0&&Array.from(s).length<=max&&!unsafeText.test(s);
const ms=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const goodGroup=(id:unknown):id is string=>typeof id==='string'&&groupPattern.test(id)&&Number.isSafeInteger(Number(id));
const goodUser=(id:unknown):id is string=>typeof id==='string'&&userPattern.test(id)&&Number.isSafeInteger(Number(id));
const esc=(s:string):string=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');

export function createQuizRound(input:CreateQuizInput):QuizRound {
 if(typeof input.id!=='string'||!idPattern.test(input.id))throw Error('INVALID_QUIZ_ID');
 if(!goodGroup(input.chatId))throw Error('INVALID_QUIZ_CHAT');
 if(!goodText(input.prompt,400))throw Error('INVALID_QUIZ_PROMPT');
 if(!Array.isArray(input.options)||input.options.length<2||input.options.length>6||
  !input.options.every(x=>goodText(x,80))||
  new Set(input.options.map(x=>x.trim().toLocaleLowerCase())).size!==input.options.length)
  throw Error('INVALID_QUIZ_OPTIONS');
 if(!Number.isInteger(input.correctOption)||input.correctOption<0||input.correctOption>=input.options.length)
  throw Error('INVALID_QUIZ_ANSWER');
 if(!ms(input.opensAt)||!ms(input.closesAt)||input.closesAt<=input.opensAt||
    input.closesAt-input.opensAt>86_400_000)throw Error('INVALID_QUIZ_TIME');
 if(input.explanation!==undefined&&!goodText(input.explanation,600))throw Error('INVALID_QUIZ_EXPLANATION');
 return {id:input.id,chatId:input.chatId,prompt:input.prompt.trim(),
  options:input.options.map(x=>x.trim()),correctOption:input.correctOption,
  ...(input.explanation!==undefined?{explanation:input.explanation.trim()}:{}),
  opensAt:input.opensAt,closesAt:input.closesAt,status:'OPEN',answers:[]};
}

/** Displays only public material. Correct answer is deliberately not in this DTO. */
export function quizPublicView(round:QuizRound):{text:string;buttons:{label:string;callbackData:string}[]} {
 if(!idPattern.test(round.id))throw Error('INVALID_QUIZ_ID');
 const text='<b>🧠 سؤال المسابقة</b>\n'+esc(round.prompt)+'\n'+
  round.options.map((opt,i)=>String(i+1)+'. '+esc(opt)).join('\n');
 return {text,buttons:round.options.map((option,i)=>({label:String(i+1)+'. '+option,
  callbackData:'p4q:1:'+round.id+':'+i}))};
}

/** A callback token requests an answer but is never proof of group membership. */
export function parseQuizAnswerCallback(input:unknown):{roundId:string;optionIndex:number}|null {
 if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>64)return null;
 const m=/^p4q:1:([A-Za-z0-9_-]{1,32}):([0-5])$/u.exec(input);
 if(!m||m[0]!==input)return null;
 return {roundId:m[1]!,optionIndex:Number(m[2]!)};
}

/** Immutable, one-account/one-answer vote acceptance. No edit or overwrite on retry. */
export function recordQuizAnswer(round:QuizRound,userId:string,optionIndex:number,now:number):QuizVoteResult {
 const outcome=(status:QuizVoteStatus):QuizVoteResult=>({status,round});
 if(!goodUser(userId)||!ms(now)||!Number.isInteger(optionIndex)||
   optionIndex<0||optionIndex>=round.options.length)return outcome('DENIED');
 if(round.status!=='OPEN'||now>=round.closesAt)return outcome('CLOSED');
 if(now<round.opensAt)return outcome('NOT_OPEN');
 if(round.answers.some(a=>a.userId===userId))return outcome('DUPLICATE');
 if(round.answers.length>=10_000)return outcome('FULL');
 return {status:'RECORDED',round:{...round,answers:[...round.answers,
   {userId,optionIndex,answeredAt:now}]}};
}

/** Closing is deterministic and retry-safe. Output is aggregate, without voter IDs. */
export function closeQuizRound(round:QuizRound,now:number):QuizCloseResult {
 if(round.status==='OPEN'&&(!ms(now)||now<round.closesAt))
  return {status:'NOT_READY',round,summary:null};
 const correct=round.answers.filter(a=>a.optionIndex===round.correctOption).length;
 const summary={total:round.answers.length,correct,incorrect:round.answers.length-correct,
  correctOption:round.correctOption};
 return {status:'CLOSED',round:round.status==='CLOSED'?round:{...round,status:'CLOSED'},summary};
}
