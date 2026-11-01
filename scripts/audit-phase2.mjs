import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {ownerInlineSections,ownerInlineConnection} from '../dist/src/telegram-inline-owner.js';
const root=fileURLToPath(new URL('../',import.meta.url));
// The existing inventory executes all 253 entries with both stores, retries,
// unauthorized actors and group copies. Preserve its complete assertions.
const inventory=JSON.parse(execFileSync(process.execPath,['scripts/audit-phase1.mjs'],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024}));
assert.equal(inventory.networkCalls,0);assert.equal(inventory.ownerButtons,253);
const files=['phase2-navigation-runtime','owner-inline-navigation','public-navigation-inline','staff-inline-navigation','group-library-inline','community-folder'];
const output=execFileSync(process.execPath,['--test','--test-concurrency=1',...files.map(f=>'dist/tests/'+f+'.test.js')],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
assert.match(output,/# fail 0|fail 0/u);
const report={schemaVersion:1,sourceCommit:inventory.sourceCommit,sourceDirty:inventory.sourceDirty,
 officialPlan:inventory.officialPlan,officialButtons:inventory.officialButtons,
 navigationAcceptance:'LOCAL_RUNTIME_PASS',fullPhaseClosure:'OPEN',liveTelegram:'NOT_TESTED',
 ownerSections:inventory.ownerSections,ownerButtons:inventory.ownerButtons,engines:inventory.engines,
 connectedCatalogueEntries:inventory.ownerButtons-inventory.designOnly,specificationOnlyEntries:inventory.designOnly,
 sections:ownerInlineSections.map((s,index)=>{const section=String(index+1).padStart(2,'0'),entries=s.items.map((label,i)=>{const route='mi:1:i:'+section+':'+String(i+1).padStart(2,'0');return {label,route,connection:ownerInlineConnection(route)};});return {section,title:s.title,connected:entries.filter(e=>e.connection!=='SPECIFICATION').length,specificationOnly:entries.filter(e=>e.connection==='SPECIFICATION')};}),
 runtimeChecks:['HTTP_WEBHOOK','STUDENT_HOME_AND_ALL_ROOT_ENTRIES','OWNER_AND_STAFF_INLINE','GROUP_TOPIC_BOUNDARIES','EDIT_MESSAGE','CALLBACK_FEEDBACK','AUTHORIZATION','REPLAY','EXPIRY','STOP','PRIVATE_PAYLOAD_REDACTION'],
 testFiles:files.map(f=>'tests/'+f+'.test.ts'),
 liveRequests:0,originalDatabaseWrites:0,
 limitations:['Local fake-provider runtime is not real Telegram acceptance.','Connected entry points can contain incomplete subfeatures.','Remaining specification-only features must retain their official phase and must not be described as working.','No deployment, merge or live moderation was performed.']};
if(process.argv.includes('--write'))await writeFile(new URL('../docs/PHASE2_NAVIGATION_ACCEPTANCE.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
