import {Phase4QuizService} from './phase4-quizzes.js';
import {validQuizInput,type QuizInput} from './phase4-quiz-model.js';
import type {OwnerInlineScreen,TelegramInlineKeyboard} from './telegram-inline-owner.js';
const HEX='[a-f0-9]{24}';
const ROUTE=new RegExp('^qz:1:(?:h|p:[0-3]|[vr]:'+HEX+'|[okc]:'+HEX+':[123])$','u');
const safeRoute=(s:unknown):s is string=>typeof s==='string'&&
 Buffer.byteLength(s,'utf8')<=64&&ROUTE.test(s);
export {safeRoute as validQuizOwnerRoute};
const esc=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;')
 .replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
const btn=(text:string,callback_data:string)=>({text,callback_data});
const screen=(text:string,rows:{text:string;callback_data:string}[][]):OwnerInlineScreen=>({
 text,keyboard:{inline_keyboard:rows} as TelegramInlineKeyboard
});
const home=btn('🧠 مسابقات الأسئلة','qz:1:h');
const back=btn('↩️ الألعاب والمسابقات','mi:1:s:08:1');
export type QuizOwnerCommand={kind:'LIST'}|
 {kind:'CREATE';chatId:string;input:QuizInput};
export function parseQuizOwnerCommand(input:string):QuizOwnerCommand|null{
 if(input==='/quizzes')return {kind:'LIST'};
 if(typeof input!=='string'||input.length>1500||/[\r\n]/u.test(input))return null;
 const m=/^\/quiznew (-[1-9][0-9]{0,15}) (SCHOLARSHIPS|LANGUAGES|UNIVERSITIES|GENERAL) ([0-9]{2,3}) (https:\/\/[^\s|]+) \| (.+)$/u.exec(input);
 if(!m||!Number.isSafeInteger(Number(m[1])))return null;
 const parts=m[5]!.split(' | ');
 if(parts.length!==8||!/^\d$/u.test(parts[6]!))return null;
 const fields={
  category:m[2] as QuizInput['category'],durationMinutes:Number(m[3]),
  title:parts[0]!,question:parts[1]!,
  options:parts.slice(2,6) as QuizInput['options'],
  correctIndex:Number(parts[6])-1,explanation:parts[7]!,sourceUrl:m[4]!
 };
 if(!validQuizInput(fields))return null;
 return {kind:'CREATE',chatId:m[1]!,input:fields};
}
async function detail(svc:Phase4QuizService,owner:string,id:string):Promise<OwnerInlineScreen|null>{
 const q=await svc.view(owner,id);if(!q)return null;
 const rows:{text:string;callback_data:string}[][]=[];
 if(q.status==='DRAFT')rows.push([btn('✅ تأكيد فتح السؤال','qz:1:o:'+id+':1')]);
 if(q.status==='OPEN')rows.push([btn('🔒 مراجعة إغلاق السؤال','qz:1:k:'+id+':2')]);
 if(q.status==='CLOSED')rows.push([btn('📊 النتيجة المجمعة','qz:1:r:'+id)]);
 rows.push([home],[back]);
 return screen('<b>🧠 مسابقات الأسئلة — 08:03</b>\n'+
  'المجموعة: <code>'+q.chatId+'</code>\n'+
  'العنوان: '+esc(q.title)+'\n'+
  'السؤال: '+esc(q.question)+'\n'+
  q.options.map((x,i)=>(i+1)+'. '+esc(x)).join('\n')+'\n'+
  '✅ الإجابة الصحيحة (للمالك فقط): '+(q.correctIndex+1)+'\n'+
  'الشرح المعتمد: '+esc(q.explanation)+'\n'+
  'المصدر الذي أدخله المالك: '+esc(q.sourceUrl)+'\n'+
  'هذا الرابط لم يتحقق البوت منه آليًا؛ راجعه قبل الفتح.\n'+
  'الحالة: '+q.status+' · مدة السؤال: '+q.durationMinutes+' دقيقة\n'+
  'المعرف: <code>'+q.id+'</code>\n'+
  'تأكيد فتح السؤال إجراء مستقل، ولا يُرسل إعلانًا تلقائيًا للمجموعة.\n'+
  'للطالب المتحقق منه في خاص البوت: <code>/quizinfo '+q.id+'</code>\n'+
  'لا كشف للجواب للطلاب قبل الإغلاق. ليست النقاط أهلية منحة أو صلاحية إشراف.',
  rows);
}
async function list(svc:Phase4QuizService,owner:string,page:number):Promise<OwnerInlineScreen|null>{
 const quizzes=await svc.list(owner),pages=Math.max(1,Math.ceil(quizzes.length/10));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)return null;
 const rows=quizzes.slice(page*10,page*10+10).map(q=>[
  btn((q.status==='DRAFT'?'📝 ':q.status==='OPEN'?'🧠 ':'🔒 ')+
   q.title.slice(0,25),'qz:1:v:'+q.id)]);
 if(pages>1){
  const n:{text:string;callback_data:string}[]=[];
  if(page>0)n.push(btn('⬅️ السابق','qz:1:p:'+(page-1)));
  if(page+1<pages)n.push(btn('التالي ➡️','qz:1:p:'+(page+1)));
  if(n.length)rows.push(n);
 }
 rows.push([back]);
 return screen('<b>🎮 الألعاب والمسابقات ← 🧠 مسابقات الأسئلة</b>\n'+
  'بداية برمجة 08:03 / GAME-002: أسئلة متعددة الاختيارات بمصدر معتمد بشريًا.\n'+
  'أنشئ سؤالًا للمالك من الخاص:\n'+
  '<code>/quiznew -1001234 SCHOLARSHIPS 60 https://example.org/source | عنوان المسابقة | أي وثيقة تقدم عند التقديم للمنحة؟ | جواز السفر | طلب المنحة | تأشيرة السفر | بطاقة البنك | 2 | طلب المنحة وثيقة مهمة لتقديم الطلب</code>\n'+
  'الأقسام: SCHOLARSHIPS / LANGUAGES / UNIVERSITIES / GENERAL.\n'+
  'المدة: 10–240 دقيقة؛ الإجابة الصحيحة رقم 1–4.\n'+
  'بعد الإنشاء راجع المعاينة ثم اضغط تأكيد؛ لا نشر جماعي تلقائي.\n'+
  'لا جوائز أو نقاط تصنيف أو تصويت مسابقات في هذا المسار.\n'+
  'صفحة '+(page+1)+' من '+pages+' · عدد الأسئلة '+quizzes.length,rows);
}
export async function quizOwnerScreen(svc:Phase4QuizService,owner:string,input:string):
 Promise<OwnerInlineScreen|null>{
 try{
  await svc.expire();
  const command=parseQuizOwnerCommand(input);
  if(command?.kind==='CREATE'){
   const q=await svc.draft(owner,command.chatId,command.input);
   return detail(svc,owner,q.id);
  }
  if(command?.kind==='LIST'||input==='mi:1:i:08:03'||input==='qz:1:h')
   return list(svc,owner,0);
  if(!safeRoute(input))return null;
  const page=/^qz:1:p:([0-3])$/u.exec(input);
  if(page)return list(svc,owner,Number(page[1]));
  const view=/^qz:1:v:([a-f0-9]{24})$/u.exec(input);
  if(view)return detail(svc,owner,view[1]!);
  const results=/^qz:1:r:([a-f0-9]{24})$/u.exec(input);
  if(results){
   const q=await svc.view(owner,results[1]!);
   if(!q||q.status!=='CLOSED')return null;
   const res=await svc.results(owner,q.id);
   return screen('<b>📊 نتيجة السؤال — ملخص محلي</b>\n'+
    esc(q.title)+'\n'+(res?
     'إجمالي الإجابات النشطة: '+res.total+
     '\nالإجابات الصحيحة: '+res.correct+
     '\nالخيارات: '+res.counts.join(' / '):
     '🔒 محجوب حتى يصل عدد المشاركين النشطين إلى 5 حسابات.')+
    '\nلا أسماء أو معرّفات طلاب أو ضمان تفرد بشري، ولا تصويت جوائز.',
    [[btn('↩️ السؤال','qz:1:v:'+q.id)],[home]]);
  }
  const open=/^qz:1:o:([a-f0-9]{24}):([123])$/u.exec(input);
  if(open)return await svc.open(owner,open[1]!,Number(open[2]))?
   detail(svc,owner,open[1]!):null;
  const review=/^qz:1:k:([a-f0-9]{24}):([123])$/u.exec(input);
  if(review){
   const q=await svc.view(owner,review[1]!);
   if(!q||q.status!=='OPEN'||q.revision!==Number(review[2]))return null;
   return screen('<b>⚠️ مراجعة إغلاق السؤال</b>\n'+esc(q.title)+
    '\nبعد الإغلاق لن تُقبل إجابات جديدة ويظهر الحل للطلاب المصرح لهم.\n'+
    'يرجى التأكيد صراحةً بعد مراجعة السؤال.',
    [[btn('✅ نعم، أغلق السؤال','qz:1:c:'+q.id+':'+q.revision)],
     [btn('↩️ إلغاء','qz:1:v:'+q.id)]]);
  }
  const close=/^qz:1:c:([a-f0-9]{24}):([123])$/u.exec(input);
  if(close)return await svc.close(owner,close[1]!,Number(close[2]))?
   detail(svc,owner,close[1]!):null;
  return null;
 }catch{return null;}
}
