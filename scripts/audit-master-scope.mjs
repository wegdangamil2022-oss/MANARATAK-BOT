import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ownerInlineSections} from '../dist/src/telegram-inline-owner.js';
const source='docs/MANARATAK_BOT_MASTER_v1.2.1_AR.md';
const raw=await readFile(new URL('../'+source,import.meta.url),'utf8'),lines=raw.split('\n');
// Explicit engineering allocation under the current phase-order introduction.
// These are parent screens, never an assertion that a feature is implemented.
const owners={1:[1,16],2:[3],3:[2],4:[2],5:[4],6:[4],7:[9],8:[9],9:[1],10:[5,6],11:[10],12:[11],13:[12],14:[9],15:[13],16:[15],17:[16],18:[16],19:[6],20:[2],21:[2],22:[8],23:[8],24:[8],25:[9],26:[8,9],27:[10],28:[9,11],29:[4],30:[2],31:[7,15],32:[14],33:[16],34:[5],35:[5,12],36:[16],37:[9],38:[8],39:[5],40:[1],41:[4],42:[12,16],43:[16],44:[3],45:[5,10],46:[10],47:[9,12],48:[10],49:[10],50:[10],51:[9],52:[10],53:[10],54:[3],55:[8],56:[9],57:[12],58:[1],59:[2],60:[2],61:[7],62:[9],63:[9],64:[2],65:[2],66:[2],67:[15],68:[15],69:[4,9],70:[2],71:[6,9],72:[16],73:[9,10]};
const stageByModule=new Map();
for(const [stage,ids] of [[1,[1,17,18,32,33,36,43,72]],[2,[31,61]],[3,[2,3,4,5,6,9,20,21,29,30,40,41,42,44,54,58,59,60,64,65,66,67,69,70]],[4,[7,8,10,11,13,14,15,16,19,22,23,24,25,26,27,28,34,35,37,38,39,45,46,47,48,49,50,51,52,53,55,56,57,62,63,68,71,73]],[6,[12]]])
 for(const id of ids){assert.ok(!stageByModule.has(id));stageByModule.set(id,stage);}
assert.equal(stageByModule.size,73);
const later={
 'EDU-012':[5,'ربط API منارتك لاحقًا صراحةً في نص المتطلب؛ البيانات المحلية لا تبرر تنفيذ هذا الربط الآن.'],
 'DATA-004':[5,'دمج المنصة بالقراءة أولًا؛ المرحلة الخامسة مستثناة.'],
 'SEC-003':[8,'مصادقة Mini App تخص واجهتها المؤجلة؛ تبقى صلاحيات الخادم الأساسية في النطاق الحالي.'],
 'LABS-010':[8,'استوديو Mini App اختياري ومؤجل إلى المرحلة الثامنة في المقدمة.'],
 'UX-009':[6,'اقتراحات مساعد ذكي للإعدادات؛ لا تفعّل ضمن القواعد الأساسية.'],
 'UTIL-007':[6,'خدمات الذكاء الاصطناعي الخاصة؛ المساعد التوليدي مؤجل.'],
 'CORE-007':[null,'نقل بين هويات بوتات متعددة في المستقبل وفق نص المتطلب.'],
 'MBOT-001':[null,'دراسة Managed Bots خيار مستقبلي لا شرط للبوت الأساسي.']
};
// AI isolation/security remains a prerequisite to the first four phases.
const securityAI=new Set(['AI-004','AI-006','AI-008','ASKCFG-001','ASKCFG-002','ASKCFG-004']);
const partial={
 'MOD-001':['src/telegram-reply-delete.ts','tests/telegram-reply-delete.test.ts','حذف رسالة ملاحظة بعد معاينة خاصة؛ لا جمع metadata حي أو إطلاق تلقائي.'],
 'MOD-002':['src/moderation-purge.ts','tests/b2-advanced-purge.test.ts','نواة معاينة جماعية محلية؛ الواجهة الحالية تؤكد رسالة واحدة فقط.'],
 'MOD-003':['src/moderation.ts','tests/telegram-moderation-commands.test.ts','تحذير وإلغاء وعد؛ الاعتراضات والأسباب المصممة كاملة لم تستكمل.'],
 'MOD-004':['src/moderation.ts','tests/telegram-moderation-commands.test.ts','كتم محلي عبر بوابة محقونة؛ المدّة وإرجاع الأذونات لم يستكملا.'],
 'MOD-005':['src/telegram-moderation-commands.ts','tests/telegram-moderation-commands.test.ts','حظر بالرد محليًا؛ الطرد وفك الحظر والمدد ناقصة.'],
 'MOD-010':['src/moderation-rate-fuse.ts','tests/moderation-rate-fuse.test.ts','حدود محلية ثابتة؛ لا إغلاق لكل سياسة إدارة في الخطة.'],
 'UX-004':['src/telegram-inline-student.ts','tests/student-inline-education.test.ts','صفحات ورجوع ومعاينات لشرائح منفذة؛ ليست كل المسارات الرسمية مكتملة.'],
 'SEC-004':['src/policy.ts','tests/owner-inline-navigation.test.ts','تتحقق الشرائح الحالية خادميًا؛ الخدمات غير المبرمجة لا تكتسب تغطية تلقائيًا.'],
 'SPAM-001':['src/telegram-protection-editor.ts','tests/telegram-protection-editor.test.ts','قواعد روابط عامة ونطاق محدد بواجهة خاصة ومراقبة النص دون شبكة؛ لا حل اختصارات أو جلب أو تنفيذ عقوبات.'],
 'SPAM-006':['src/telegram-protection-media.ts','tests/telegram-protection-editor.test.ts','مراقبة 11 نوع وسيط وشرح وروابط كيانات دون تنزيل؛ التوجيه والرسائل الطويلة والإعلانات والتنفيذ غير مكتملة.'],
 'LEX-001':['src/telegram-protection-editor.ts','tests/telegram-protection-editor.test.ts','تخزين مرقم وواجهة كلمات وعبارات لكل مجموعة؛ القوالب المركزية وحوكمة الشبكات غير مكتملة.'],
 'SPAM-011':['src/group-protection-policy.ts','tests/telegram-protection-editor.test.ts','مراقبة النص والوسائط وتعديلاتها وتدقيق بلا محتوى أو عقوبة؛ القياس الشامل غير مكتمل.'],
 'TYPELOCK-001':['src/protection-rules.ts','tests/protection-rules.test.ts','تقييم أنواع رسائل محددة محليًا؛ السياسات المنفصلة لإشارات الأشخاص والقنوات غير مكتملة.'],
 'TYPELOCK-004':['src/telegram-protection-editor.ts','tests/telegram-protection-editor.test.ts','اختيار 12 نوع رسالة بواجهة مقسمة ومراقبة الوسائط الواردة؛ الرسائل الطويلة والتنفيذ غير مكتملين.'],
 'LEX-002':['src/protection-rules.ts','tests/protection-rules.test.ts','كلمة كاملة وعبارة متجاورة فقط؛ لا اشتقاق أو تحليل لغوي شامل.'],
 'LEX-003':['src/protection-rules.ts','tests/protection-rules.test.ts','تطبيع Unicode والعربية مع حدود؛ لا ادعاء كشف كل التحايل.'],
 'LEX-006':['src/telegram-protection-editor.ts','tests/telegram-protection-editor.test.ts','إضافة السماح بالنطاق الدقيق والعبارة في موضعها وحذف مؤكد عبر الواجهة؛ الحوكمة المركزية والاستثناءات المؤقتة ناقصة.'],
 'LEX-007':['src/telegram-protection-editor.ts','tests/telegram-protection-editor.test.ts','واجهة تعديل واختبار قواعد المجموعة دون تخزين العينة؛ السماح المركزي والاستثناءات الشخصية المؤقتة غير مكتملة.'],
 'TYPELOCK-009':['src/group-protection-policy.ts','tests/telegram-protection-editor.test.ts','مراقبة النوع والروابط والكلمات بقرار مقترح واحد؛ المنشن والتنفيذ غير مكتملين.'],
 'LEX-009':['src/telegram-protection-media.ts','tests/telegram-protection-editor.test.ts','فحص الشرح وروابط كيانات الوسائط دون حفظ أو تنزيل؛ ملصقات النص وOCR غير موصولين.'],
 'OPS-003':['src/store.ts','tests/telegram-moderation-commands.test.ts','سجل تحديث ومحاولة ونتيجة ومنع تكرار؛ الوظائف القادمة تحتاج الربط به.']
};
const modules=[],requirements=[];let module=null;
function append(id,text,line,kind,moduleId){
 assert.ok(!requirements.some(r=>r.id===id),'duplicate requirement '+id);
 const number=Number(moduleId.slice(4));assert.ok(owners[number]);
 let stages=[stageByModule.get(number)],deferredReason=null,laterPhase=null;
 if(stages[0]===6&&!securityAI.has(id)){deferredReason='خدمات المساعد التوليدي — المرحلة السادسة.';laterPhase=6;stages=[];}
 if(securityAI.has(id))stages=[1,3];
 if(later[id]){[laterPhase,deferredReason]=later[id];stages=[];}
 const evidence=partial[id];
 requirements.push({id,kind,module:moduleId,text,source,line,scope:stages.length?'STAGES_1_4':'DEFERRED',stages,laterPhase,deferredReason,
  ownerSections:owners[number].map(n=>({number:n,title:ownerInlineSections[n-1].title})),
  implementation:evidence?'PARTIAL_LOCAL':'NOT_ASSESSED',evidence:evidence?{code:evidence[0],tests:evidence[1],limit:evidence[2]}:null});
}
for(let i=0;i<lines.length;i++){
 const heading=/^### (MOD-\d{2}) — (.+)$/u.exec(lines[i]);
 if(heading){module={id:heading[1],title:heading[2],line:i+1,declaredCount:null,count:0};modules.push(module);}
 if(module){
  const declared=/^\*\*العدد المرجعي:\*\* (\d+)\./u.exec(lines[i]);if(declared)module.declaredCount=Number(declared[1]);
  const row=/^- `([A-Z][A-Z0-9]*-\d{3})` (.+)$/u.exec(lines[i]);
  if(row){append(row[1],row[2],i+1,'REFERENCE',module.id);module.count++;}
 }
 const extension=/^\| `((?:ASKCFG|DOCFLOW|HUBCFG)-\d{3})` \| `(MOD-\d{2})` \| (.*?) \|/u.exec(lines[i]);
 if(extension)append(extension[1],extension[3],i+1,'EXTENSION',extension[2]);
}
assert.equal(modules.length,73);for(const m of modules)assert.equal(m.count,m.declaredCount,m.id+' count');
assert.equal(requirements.filter(r=>r.kind==='REFERENCE').length,691);assert.equal(requirements.filter(r=>r.kind==='EXTENSION').length,12);assert.equal(requirements.length,703);
const details=[];
for(let i=0;i<lines.length;i++){
 const match=/^(S12-\d{2}):|^\*\*(S121-\d{2}) —/u.exec(lines[i]);
 if(!match)continue;
 let end=i+1;
 while(end<lines.length&&!/^(?:#{2,3} |S12-\d{2}:|\*\*S121-\d{2} —)/u.test(lines[end]))end++;
 details.push({id:match[1]??match[2],source,line:i+1,text:lines.slice(i,end).join('\n').trim()});
}
assert.equal(details.length,50);assert.equal(new Set(details.map(d=>d.id)).size,50);
for(const r of requirements){assert.ok(r.stages.every(n=>n>=1&&n<=4));if(!r.stages.length)assert.ok(r.deferredReason);assert.ok(r.ownerSections.length);}
for(const value of Object.values(partial)){await readFile(new URL('../'+value[0],import.meta.url));await readFile(new URL('../'+value[1],import.meta.url));}
const acceptanceCases=[],narrativeSections=[];
for(let i=0;i<lines.length;i++){
 const test=/^\| (T12-\d{2}|T121-\d{2}) \| (.+) \| ([^|]+) \|$/u.exec(lines[i]);
 if(test)acceptanceCases.push({id:test[1],text:test[2],historicalBatch:test[3],source,line:i+1,status:'NOT_ASSESSED'});
 const heading=/^#{2,3} (\d+(?:\.\d+)?)[. ]+(.+)$/u.exec(lines[i]);
 if(heading)narrativeSections.push({number:heading[1],title:heading[2],source,line:i+1});
}
assert.equal(acceptanceCases.length,48);assert.equal(new Set(acceptanceCases.map(t=>t.id)).size,48);
const summary={requirements:703,referenceRequirements:691,extensions:12,modules:73,details:50,acceptanceCases:48,inStages1to4:requirements.filter(r=>r.scope==='STAGES_1_4').length,deferred:requirements.filter(r=>r.scope==='DEFERRED').length,fullyImplementedVerified:0,inScopeNotAssessed:requirements.filter(r=>r.scope==='STAGES_1_4'&&r.implementation==='NOT_ASSESSED').length,localPartial:requirements.filter(r=>r.implementation==='PARTIAL_LOCAL').length};
const report={schemaVersion:1,source,sourceSha256:createHash('sha256').update(raw).digest('hex'),allocation:'ENGINEERING_MAPPING_FROM_ACTIVE_PLAN_NOT_OFFICIAL_PER_ID_PHASE_NUMBERING',summary,modules,requirements,details,acceptanceCases,narrativeSections};
if(process.argv.includes('--write')){
 await writeFile(new URL('../docs/MASTER_REQUIREMENTS_1_4.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 const sectionText=['# توزيع متطلبات MASTER على أقسام لوحة المالك','',
  'هذه خريطة نطاق ومراجعة؛ ليست إعلانًا عن وجود كل الأزرار أو تنفيذ الوظائف. القسم هو الحاوية الحالية، وتحتاج الوظائف المعتمدة شاشاتها وأزرارها الفرعية، بينما الضوابط الخلفية تحتاج أدلة تنفيذ واختبارات. لا يصح إنشاء زر وصفي لكل سطر ثم اعتباره منجزًا.',''];
 for(let n=1;n<=16;n++){
  const matching=requirements.filter(r=>r.ownerSections.some(s=>s.number===n));
  assert.ok(matching.length,'unmapped owner section '+n);
  sectionText.push('## '+String(n).padStart(2,'0')+' — '+ownerInlineSections[n-1].title,'');
  for(const r of matching)sectionText.push('- [ ] **'+r.id+'** ('+r.module+'؛ '+r.implementation+'؛ '+(r.stages.length?'المراحل '+r.stages.join('، '):'مؤجل')+') — '+r.text);
  sectionText.push('');
 }
 await writeFile(new URL('../docs/MASTER_SECTIONS_1_4_AR.md',import.meta.url),sectionText.join('\n')+'\n');
 const text=['# متطلبات الخطة الرسمية وتوزيع العمل للمراحل 1–4','',
 'المصدر هو MASTER الكامل، وليس ملف الأزرار المختصر. توزيع الأقسام والمراحل أدناه قرار تنفيذ هندسي وفق المقدمة الحالية؛ لا يغير نص المصدر ولا يعد إثبات تنفيذ. تبقى المتطلبات المؤجلة مسجلة دون حذف. NOT_ASSESSED تعني لم تُقيّم تغطيته بعد، وPARTIAL_LOCAL تعني جزءًا محليًا موثقًا. لا يوجد متطلب موسوم مكتملًا بهذا الجرد.',
 '',JSON.stringify(summary),'',
 ...modules.flatMap(m=>['## '+m.id+' — '+m.title,'',...requirements.filter(r=>r.module===m.id).map(r=>'- [ ] **'+r.id+'** — '+r.text+'\n  - المصدر: '+source+':'+r.line+'؛ الأقسام: '+r.ownerSections.map(s=>s.number).join('، ')+'؛ النطاق: '+(r.stages.length?r.stages.join('، '):r.deferredReason)+'؛ الحالة: '+r.implementation+'.'+(r.evidence?'\n  - دليل جزئي: '+r.evidence.code+'؛ '+r.evidence.tests+'؛ '+r.evidence.limit:'')),''])];
 await writeFile(new URL('../docs/MASTER_REQUIREMENTS_1_4_AR.md',import.meta.url),text.join('\n')+'\n');
}
if(!process.argv.includes('--write')){
 const saved=JSON.parse(await readFile(new URL('../docs/MASTER_REQUIREMENTS_1_4.json',import.meta.url),'utf8'));
 assert.deepEqual(saved,report,'MASTER registry stale; regenerate and review it explicitly');
}
console.log(JSON.stringify(summary,null,2));
