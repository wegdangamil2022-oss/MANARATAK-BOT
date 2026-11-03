import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),logPath=process.argv[2]??'artifacts/section-closure/full-review-final-tests.log';
const registry=JSON.parse(await readFile(resolve(root,'docs/MASTER_REQUIREMENTS_1_4.json'),'utf8'));
const canonical=(await readFile(resolve(root,registry.source),'utf8')).replace(/\r\n/gu,'\n');
const sha=text=>createHash('sha256').update(text).digest('hex');
assert.equal(sha(canonical),registry.sourceSha256,'Official plan changed; regenerate and review the registry');
assert.equal(registry.requirements.length,703);assert.equal(new Set(registry.requirements.map(r=>r.id)).size,703);
const log=await readFile(resolve(root,logPath),'utf8');
const number=name=>{const m=new RegExp('^ℹ '+name+' (\\d+)','mu').exec(log);assert.ok(m,'Test log is incomplete: '+name);return Number(m[1]);};
const tests={total:number('tests'),pass:number('pass'),fail:number('fail'),cancelled:number('cancelled'),skipped:number('skipped')};
const additionalChecks=[];
for(const path of ['artifacts/section-closure/rule-warning-policy-tests.log','artifacts/section-closure/rule-review-tests.log','artifacts/section-closure/rule-actions-tests.log','artifacts/section-closure/notice-receipt-after.log','artifacts/section-closure/rule-disable-tests.log','artifacts/section-closure/rule-languages-tests.log','artifacts/section-closure/rule-explanation-tests.log','artifacts/section-closure/rule-warning-presentation-tests.log','artifacts/section-closure/subscription-health-tests.log','artifacts/section-closure/subscription-health-targeted.log','artifacts/section-closure/subscription-change-alert-tests.log','artifacts/section-closure/rights-monitor-focused-tests.log','artifacts/section-closure/rights-monitor-fairness-tests.log','artifacts/section-closure/rights-monitor-guards-tests.log','artifacts/section-closure/membership-bot-identity-tests.log','artifacts/section-closure/membership-identity-subscription-tests.log','artifacts/section-closure/subscription-activity-targeted-tests.log','artifacts/section-closure/subscription-delivery-metrics-tests.log','artifacts/section-closure/subscription-channel-incidents-tests.log','artifacts/section-closure/subscription-channel-unavailable-tests.log','artifacts/section-closure/manual-channel-unavailable-tests.log']){
 try{const raw=await readFile(resolve(root,path),'utf8'),counts={};for(const name of ['tests','pass','fail','cancelled','skipped']){const m=new RegExp('^ℹ '+name+' (\\d+)','mu').exec(raw);assert.ok(m,'Incomplete related test log');counts[name]=Number(m[1]);}additionalChecks.push({path,sha256:sha(raw),counts});}
 catch(error){if(error?.code!=='ENOENT')throw error;}
}
assert.equal(tests.total,tests.pass+tests.fail+tests.cancelled+tests.skipped);
const details=log.split('✖ failing tests:')[1]??'';
const failures=details.split(/\r?\n(?=test at )/u).filter(b=>/^test at /u.test(b.trim())).map(block=>{
 const lines=block.trim().split(/\r?\n/u),file=lines[0].replace(/^test at /u,''),name=lines[1]?.replace(/^✖ /u,'')??'',error=lines.find(l=>/^\s+(?:Error|AssertionError|TypeError|RangeError)/u.test(l))?.trim()??'UNCLASSIFIED';
 let category='REQUIRES_INVESTIGATION';
 if(/Cannot find module 'C:\\C:/u.test(block))category='WINDOWS_URL_PATH';
 else if(/EPERM[^\n]*symlink/u.test(block))category='HOST_SYMLINK_CAPABILITY';
 else if(/INSECURE_PERMISSIONS|INSECURE_MODE|INSECURE_FILE_MODE/u.test(error)||/\[cause\]: Error: SQLITE_READONLY_PRIVATE_MODE_REQUIRED/u.test(block))category='HOST_PRIVATE_FILE_MODE';
 // Other errors can be downstream of readiness failures. Do not assume that
 // without inspecting each failure, and never convert a failed check to PASS.
 const readonlyCause=/\[cause\]: Error: (SQLITE_READONLY_[A-Z_]+)/u.exec(block)?.[1];
 return {file,name,error,category,...(readonlyCause?{readonlyCause}:{})};
});
assert.equal(failures.length,tests.fail,'Failure inventory must cover every failed test');
const evidence={
 GATE:{code:['src/subscription-channel-unavailable.ts','src/subscription-channel-incidents.ts','src/subscription-activity-summary.ts','src/store.ts','src/subscription-rights-monitor.ts','src/subscription-change-alert.ts','src/policy.ts','src/telegram-membership.ts','src/subscription.ts','src/subscription-observed-members.ts','src/subscription-leave-grace.ts','src/subscription-cleanup-attempt.ts','src/telegram-replies.ts','src/telegram-live-server.ts'],ui:['src/telegram-owner-menu.ts','src/telegram-inline-subscription-config.ts','src/telegram-transport.ts'],tests:['tests/subscription-channel-unavailable.test.ts','tests/b3-owner-subscription-health.test.ts','tests/owner-inline-navigation.test.ts','tests/subscription-rights-monitor.test.ts','tests/subscription-change-alerts.test.ts','tests/telegram-live-membership.test.ts','tests/owner-inline-subscription-config.test.ts','tests/subscription-owned-restoration.test.ts','tests/subscription-cleanup-attempt.test.ts']},
 RULELAW:{code:['src/telegram-group-rules.ts','src/moderation.ts','src/group-rule-exemption-model.ts','src/group-rule-restriction-report.ts','src/group-rule-warning-policy.ts','src/moderation-report-model.ts','src/group-rules-model.ts','src/group-rule-notices.ts','src/telegram-live-server.ts','src/moderation-command-review-epoch.ts','src/protection-ui-access.ts','src/telegram-inline-owner.ts','src/telegram-moderation-commands.ts'],ui:['src/telegram-moderation-appeals.ts','src/telegram-moderation-cases.ts','src/telegram-moderation-command-review.ts','src/telegram-rule-exemptions.ts','src/telegram-rule-warning-policy.ts','src/telegram-moderation-reports.ts','src/telegram-transport.ts','src/telegram-rule-actions.ts'],tests:['tests/telegram-moderation-appeals.test.ts','tests/telegram-moderation-cases.test.ts','tests/group-rules.test.ts','tests/group-rule-exemptions.test.ts','tests/group-rule-warning-policy.test.ts','tests/group-rule-review.test.ts','tests/group-rule-actions.test.ts']}
};
const gaps={
 'GATE-003':'Human messages and observed joins enroll bounded candidates; no claim to enumerate unobserved historical Telegram members or complete join-request workflow.',
 'GATE-004':'Reviewed official restriction path exists; unverified delete metadata does not authorize deletion.',
 'GATE-005':'Ephemeral and temporary fallbacks plus cleanup exist; configurable fallback delay and complete capability acceptance remain open.',
 'GATE-007':'Observed candidates, active restrictions and verified grace records rotate; 1000 candidate capacity and 30-day retention are explicit limits.',
 'GATE-008':'No grace/hour/day reviewed policies and fresh expiry checks exist; no permanent automatic ban.',
 'GATE-010':'Manual and periodic rights checks distinguish explicit loss from unknown. Rights loss, channel list changes and verified primary public username changes on the same numeric channel queue guarded owner alerts. Numeric-ID migration and alternate-username coverage are not implemented. Real Telegram acceptance is deferred.',
 'GATE-012':'Owner-only aggregate verification outcomes, witnessed delivery confirmations, historical rights-loss notice states and separate anonymous bounded unavailable automatic/manual rights-check counts exist locally. Delivery does not prove page opening; other channel/API errors are not covered. The complete funnel remains open.',
 'RULELAW-001':'Local immutable numbered versions, approval dates, edits, disabling/reactivation and up to three manually reviewed optional languages preserve original violation history. Translation addition/removal requires private confirmation; published language replies reject stale source epochs. Real Telegram acceptance remains deferred; no full-stage closure.',
 'RULELAW-002':'Local reply warning accepts Arabic and /warnrule syntax; private confirmation displays original paragraph, verified executor name or ID, and an authorized link to the exact historical law version. Real Telegram acceptance remains deferred.',
 'RULELAW-003':'Local implementation: first private notice with durable attempt and bound receipt, warnings, timed restrictions, review, ordered configurable manual choices, warning ceilings and immutable expiry. Each action requires its own confirmation; no automatic escalation. Real Telegram acceptance is deferred by user; full-stage acceptance remains open.',
 'RULELAW-005':'Local private source-bound historical law explanation button and separately confirmed appeal window exist for the case owner. Warnings and manual paragraph mutes retain their original law text in owner and reviewer views; no automatic sanction reversal. Real Telegram acceptance is deferred.',
 'RULELAW-006':'Timed version/paragraph exemptions protect warnings and new mutes; existing sanctions are not automatically released.',
 'RULELAW-007':'Weekly warnings, linked restriction receipt aggregates and witnessed warning appeal revocations exist; restriction appeal reversals need acceptance.'
};
const hashed=new Map();
for(const path of ['src/telegram-trial-acceptance.ts','tests/sqlite-readonly-rejection.test.ts'])hashed.set(path,sha(await readFile(resolve(root,path))));
for(const path of ['src/subscription-channel-identity.ts','tests/subscription-channel-identity.test.ts'])hashed.set(path,sha(await readFile(resolve(root,path))));
for(const entry of Object.values(evidence))for(const path of [...entry.code,...entry.ui,...entry.tests])hashed.set(path,sha(await readFile(resolve(root,path))));
const requirements=registry.requirements.map(r=>{
 const family=r.id.startsWith('GATE-')?'GATE':r.id.startsWith('RULELAW-')?'RULELAW':null;
 const actionsCheck=additionalChecks.find(c=>c.path==='artifacts/section-closure/rule-actions-tests.log'),languageCheck=additionalChecks.find(c=>c.path==='artifacts/section-closure/rule-languages-tests.log'),explanationCheck=additionalChecks.find(c=>c.path==='artifacts/section-closure/rule-explanation-tests.log'),warningPresentationCheck=additionalChecks.find(c=>c.path==='artifacts/section-closure/rule-warning-presentation-tests.log');
 const passing=(check,min)=>check?.counts.tests>=min&&check.counts.fail===0&&check.counts.cancelled===0&&check.counts.skipped===0;
 const implemented=r.id==='RULELAW-003'&&passing(actionsCheck,173)||r.id==='RULELAW-001'&&passing(languageCheck,185)||r.id==='RULELAW-005'&&passing(explanationCheck,213)||r.id==='RULELAW-002'&&passing(warningPresentationCheck,217);
 return {id:r.id,source:r.source,line:r.line,text:r.text,stages:r.stages,scope:r.scope,status:implemented?'IMPLEMENTED_LOCAL_TELEGRAM_DEFERRED':family?'PARTIAL_LOCAL_REVIEW':'NOT_REVIEWED_IN_THIS_PASS',evidence:family?evidence[family]:null,gap:family?(gaps[r.id]??'Related local code and tests identified; full official requirement has not been independently accepted.'):null};
});
const phase3=requirements.filter(r=>r.stages.includes(3)),categoryCounts={};for(const f of failures)categoryCounts[f.category]=(categoryCounts[f.category]??0)+1;
const git={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),workingTree:'LOCAL_UNCOMMITTED_CHANGES_PRESENT',testSnapshot:'HISTORICAL_FULL_LOG_NOT_LATEST_CODE_ACCEPTANCE'};
const report={schemaVersion:1,generatedAt:new Date().toISOString(),git,sourceSha256:registry.sourceSha256,log:{path:logPath,sha256:sha(log)},tests,additionalChecks,categoryCounts,closed:false,telegramAcceptance:'DEFERRED_BY_USER',requirementsTotal:requirements.length,phase3Total:phase3.length,fullyAccepted:0,codeHashesAtReview:Object.fromEntries(hashed),requirements,failures};
await mkdir(resolve(root,'artifacts/section-closure'),{recursive:true});
await writeFile(resolve(root,'artifacts/section-closure/requirements-review.json'),JSON.stringify(report,null,2)+'\n');
const md=['# مراجعة متطلبات المرحلة الثالثة','',
 'الحالة: مفتوحة. وجود ملف أو زر أو اختبار لا يثبت إغلاق المطلب الرسمي كاملًا. لا يعد تأجيل Telegram قبولًا للتشغيل.',
 '',`السجل يحفظ جميع المتطلبات الـ${requirements.length} دون إسقاط، ومنها ${phase3.length} مرتبطة بالمرحلة الثالثة. بصمة الخطة: \`${registry.sourceSha256}\`.`,
 '',`الفحص الشامل: ${tests.total} حالة؛ ${tests.pass} ناجحة، ${tests.fail} فاشلة، ${tests.cancelled} ملغاة، ${tests.skipped} متجاوزة. السجل: \`${logPath}\`.`,
 '', 'نتيجة الفحص الشامل تخص الجولة المسجلة؛ يلزم تكراره عند تغيّر الشفرة، ولا يمثل قبولًا للتشغيل الفعلي. الفحوص المرتبطة أدناه لا تلغي إخفاقاته ولا تجمع أعدادها كاختبارات فريدة.',
 ...additionalChecks.map(c=>`- ${c.path}: ${c.counts.tests} حالة، ${c.counts.pass} ناجحة و${c.counts.fail} فاشلة.`),
 '', 'تفاصيل سقف إنذارات الفقرات وانتهاء مددها في [PHASE3_RULE_WARNING_POLICY_AR.md](PHASE3_RULE_WARNING_POLICY_AR.md).',
 '', 'تفاصيل إحالة فقرات القوانين للمراجعة وإغلاقها في [PHASE3_RULE_REVIEW_AR.md](PHASE3_RULE_REVIEW_AR.md).',
 '', 'استكمال التنبيه الأول وقائمة إجراءات الفقرة وترتيب الخيارات اليدوية في [PHASE3_RULE_ACTIONS_AR.md](PHASE3_RULE_ACTIONS_AR.md). حالة التنفيذ المحلي لا تعني قبول Telegram أو إغلاق بقية المرحلة.',
 '', 'توضيح القانون والاعتراض الخاص في [PHASE3_RULE_EXPLANATION_AR.md](PHASE3_RULE_EXPLANATION_AR.md).',
 '', 'فحص صلاحية قنوات الاشتراك وتنبيه تعديل القائمة في [PHASE3_SUBSCRIPTION_CHANNEL_HEALTH_AR.md](PHASE3_SUBSCRIPTION_CHANNEL_HEALTH_AR.md).',
 '', 'معاينة إنذار الفقرة ورابط الإصدار في [PHASE3_RULE_WARNING_PRESENTATION_AR.md](PHASE3_RULE_WARNING_PRESENTATION_AR.md).',
 '', 'لغات القوانين الاختيارية والإصدارات والتعطيل في [PHASE3_RULE_LANGUAGES_AR.md](PHASE3_RULE_LANGUAGES_AR.md).',
 '', 'تفاصيل الإخفاقات وبصمات الملفات ومراجع الشفرة والواجهة والاختبارات في `artifacts/section-closure/requirements-review.json`؛ تصنيف «يحتاج فحصًا» لا ينسب الفشل تلقائيًا إلى Windows.',
 '', 'أسباب رفض القراءة الآمنة موثقة في [PHASE3_READONLY_FAILURE_CAUSES_AR.md](PHASE3_READONLY_FAILURE_CAUSES_AR.md). سبب الرفض المثبت لا يحول الاختبار الفاشل إلى ناجح.',
 '', '| المطلب | سطر الخطة | الحالة | النقص أو حد القبول |','|---|---:|---|---|',
 ...phase3.map(r=>`| ${r.id} | ${r.line} | ${r.status} | ${(r.gap??'لم تكتمل مطابقته في هذه المراجعة.').replaceAll('|','/')} |`),
 '', 'لا تُغلق المرحلة الثالثة أو هذه الحزم من هذا التقرير؛ يلزم تنفيذ النواقص الصريحة ومعالجة الإخفاقات وفحص الضوابط التفصيلية المرتبطة بالخطة.'];
await writeFile(resolve(root,'docs/PHASE3_FINAL_REVIEW_AR.md'),md.join('\n')+'\n');
process.stdout.write(JSON.stringify({requirements:requirements.length,phase3:phase3.length,tests,categoryCounts,closed:false})+'\n');
