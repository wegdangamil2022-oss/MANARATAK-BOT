import {Phase4ContestService} from './phase4-contests.js';
import {validQuizInput,type QuizInput} from './phase4-quiz-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
const HEX='[a-f0-9]{24}',REV='[1-9][0-9]{0,8}',ACT='(?:r10|r30|r60|s|n|x)';
const ROUTE=new RegExp('^ct:1:(?:h|v:'+HEX+'|[pc]:'+HEX+':'+REV+':'+ACT+')$','u');
export const validContestOwnerRoute=(v:unknown):v is string=>
 typeof v==='string'&&Buffer.byteLength(v,'utf8')<=64&&ROUTE.test(v);
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>
 ({text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard});
const home=btn('➕ مسابقاتي','ct:1:h');
const back=btn('↩️ قسم الألعاب','mi:1:s:08:0');
type Command={type:'HOME'}|{type:'CREATE';chatId:string;title:string;description:string}|
 {type:'ADD';id:string;input:QuizInput};
export function parseContestOwnerCommand(text:string):Command|null{
 if(text==='/contests'||text==='ct:1:h'||text==='mi:1:i:08:02')return {type:'HOME'};
 if(typeof text!=='string'||text.length>1650||/[\r\n]/u.test(text))return null;
 const create=/^\/contestnew (-[1-9][0-9]{0,15}) \| (.+)$/u.exec(text);
 if(create&&Number.isSafeInteger(Number(create[1]))){
  const chunks=create[2]!.split(' | ');
  return chunks.length===2?{type:'CREATE',chatId:create[1]!,
   title:chunks[0]!,description:chunks[1]!}:null;
 }
 const add=/^\/contestadd ([a-f0-9]{24}) (SCHOLARSHIPS|LANGUAGES|UNIVERSITIES|GENERAL) ([0-9]{2,3}) (https:\/\/[^\s|]+) \| (.+)$/u.exec(text);
 if(!add)return null;
 const parts=add[5]!.split(' | ');
 if(parts.length!==8||!/^\d$/u.test(parts[6]!))return null;
 const input={category:add[2] as QuizInput['category'],
  durationMinutes:Number(add[3]),title:parts[0]!,question:parts[1]!,
  options:parts.slice(2,6) as QuizInput['options'],
  correctIndex:Number(parts[6])-1,explanation:parts[7]!,sourceUrl:add[4]!};
 if(!validQuizInput(input))return null;
 return {type:'ADD',id:add[1]!,input};
}
async function list(svc:Phase4ContestService,owner:string):Promise<OwnerInlineScreen>{
 const all=await svc.list(owner);
 const rows=all.slice(0,25).map(c=>[btn(
  (c.status==='DRAFT'?'📝 ':c.status==='REGISTRATION'?'✍️ ':
   c.status==='RUNNING'?'🧠 ':'🔒 ')+c.title.slice(0,26),'ct:1:v:'+c.id)]);
 rows.push([back]);
 return screen('<b>➕ إنشاء مسابقة — 08:02</b>\n'+
  'إنشاء مسابقة تعليمية من 2 إلى 5 جولات، مع تسجيل الطالب في الخاص، ثم بدء كل جولة يدويًا.\n'+
  'إنشاء مسابقة جديدة في خاص المالك:\n'+
  '<code>/contestnew -1001234 | مسابقة المنح الدراسية | جولات تدريبية في المنح الدولية للطلاب</code>\n'+
  'بعد الإنشاء أضف الأسئلة بالأمر المعروض في تفاصيل المسابقة.\n'+
  'لا نشر تلقائي ولا ترتيب جوائز أو قرعة أو منح صلاحيات إدارية.\n'+
  'المسابقات التي يمكنك إدارتها: '+all.length,rows);
}
async function detail(svc:Phase4ContestService,owner:string,id:string):
 Promise<OwnerInlineScreen|null>{
 const c=await svc.view(owner,id);if(!c)return null;
 const a=(action:string)=>'ct:1:p:'+id+':'+c.revision+':'+action;
 const rows:{text:string;callback_data:string}[][]=[];
 if(c.status==='DRAFT'&&c.rounds.length>=2){
  rows.push([btn('✍️ التسجيل 10 دقائق',a('r10')),
   btn('✍️ التسجيل 30 دقيقة',a('r30'))]);
  rows.push([btn('✍️ التسجيل ساعة',a('r60'))]);
 }
 if(c.status==='REGISTRATION')rows.push([btn('🚀 مراجعة بدء المسابقة',a('s'))]);
 if(c.status==='RUNNING')rows.push([btn('⏭️ مراجعة الجولة التالية/الإغلاق',a('n'))]);
 if(['DRAFT','REGISTRATION','RUNNING'].includes(c.status))
  rows.push([btn('⛔ مراجعة إلغاء المسابقة',a('x'))]);
 rows.push([home],[back]);
 const rounds=c.rounds.map((r,i)=>(
  (i+1)+'. '+esc(r.title.slice(0,75))+' — '+esc(r.question.slice(0,100))+
  '\n   ✅ للمالك: '+(r.correctIndex+1)+' ('+esc(r.options[r.correctIndex]!.slice(0,55))+')'
 )).join('\n');
 const addHelp='<code>/contestadd '+c.id+
  ' SCHOLARSHIPS 10 https://example.org/info | سؤال المنح الجديد | ما المستند الأساسي عند التقديم؟ | الطلب الرسمي | بطاقة البنك | تذكرة سفر | كتاب دراسي | 1 | نموذج التقديم المعتمد هو مرجع البيانات للطلب</code>';
 return screen('<b>➕ المسابقة التعليمية — 08:02</b>\n'+
  'المجموعة: <code>'+c.chatId+'</code>\n'+
  'العنوان: '+esc(c.title)+'\nالوصف: '+esc(c.description.slice(0,150))+
  '\nالحالة: '+c.status+' · المراجعة: '+c.revision+
  '\nالجولات: '+c.rounds.length+'/5\n'+rounds+
  (c.status==='DRAFT'&&c.rounds.length<5?
   '\nلإضافة جولة جديدة (الإجابة تظهر هنا للمالك فقط):\n'+addHelp:'')+
  (c.registrationEndsAt!==undefined?
   '\nنهاية تسجيل المشاركين UTC: '+new Date(c.registrationEndsAt).toISOString():'')+
  (c.status==='RUNNING'&&c.quizIds.length?
   '\nالسؤال الجاري للطلاب المسجلين في الخاص: <code>/quizinfo '+
    c.quizIds[c.quizIds.length-1]+'</code>':'')+
  '\nالمعرّف: <code>'+id+'</code>'+
  '\n⚠️ لا تنشر الشاشة الإدارية؛ تحتوي الإجابات الصحيحة.'+
  '\nبدء الجولات محلي؛ لا ينشر البوت إعلانًا في المجموعة تلقائيًا.',
  rows);
}
export async function contestOwnerScreen(svc:Phase4ContestService,actor:string,input:string):
 Promise<OwnerInlineScreen|null>{
 try{
  await svc.expire();
  const cmd=parseContestOwnerCommand(input);
  if(cmd?.type==='HOME')return list(svc,actor);
  if(cmd?.type==='CREATE'){
   const c=await svc.draft(actor,cmd.chatId,cmd.title,cmd.description);
   return detail(svc,actor,c.id);
  }
  if(cmd?.type==='ADD'){
   const c=await svc.view(actor,cmd.id);if(!c)return null;
   if(!await svc.addRound(actor,cmd.id,c.revision,cmd.input))return null;
   return detail(svc,actor,cmd.id);
  }
  if(input.startsWith('ct:1:v:')&&validContestOwnerRoute(input))
   return detail(svc,actor,input.slice(7));
  if(!validContestOwnerRoute(input))return null;
  const m=new RegExp('^ct:1:([pc]):('+HEX+'):('+REV+'):('+ACT+')$','u').exec(input);
  if(!m)return null;
  const op=m[1],id=m[2]!,rev=Number(m[3]),action=m[4]!;
  const c=await svc.view(actor,id);
  if(!c||c.revision!==rev)return null;
  if(op==='p'){
   return screen('<b>⚠️ مراجعة مسابقة قبل التنفيذ</b>\n'+
    esc(c.title)+'\nالحالة: '+c.status+'\n'+
    (action.startsWith('r')?'فتح تسجيل خاص لمدة '+action.slice(1)+' دقيقة.':
     action==='s'?'بدء المسابقة وإنشاء الجولة الأولى محليًا.':
     action==='n'?'إغلاق الجولة السابقة المنتهية وفتح التالية، أو إنهاء المسابقة.':
     'إلغاء المسابقة وإغلاق الجولة الجارية.')+
    '\nلن تُرسل رسائل إلى المجموعات. كل إجراء يُفحص مرة ثانية عند التأكيد.',
    [[btn('✅ تأكيد','ct:1:c:'+id+':'+rev+':'+action)],
     [btn('↩️ إلغاء','ct:1:v:'+id)]]);
  }
  if(action.startsWith('r')){
   if(!await svc.openRegistration(actor,id,rev,Number(action.slice(1))))return null;
  }else if(action==='s'){
   if((await svc.start(actor,id,rev)).status!=='STARTED')return null;
  }else if(action==='n'){
   const result=await svc.advance(actor,id,rev);
   if(result.status!=='NEXT'&&result.status!=='FINISHED')return null;
  }else if(action==='x'){
   if(!await svc.cancel(actor,id,rev))return null;
  }else return null;
  return detail(svc,actor,id);
 }catch{return null;}
}
