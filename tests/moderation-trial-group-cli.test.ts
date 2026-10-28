import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const groupCli=fileURLToPath(new URL('../src/moderation-trial-group-cli.js',import.meta.url));
const targetCli=fileURLToPath(new URL('../src/moderation-trial-target-cli.js',import.meta.url));
const args=['--offline-only','--state','/private/secret-state.sqlite',
 '--backup','/private/secret-backup.sqlite','--safety','/private/secret-stop.flag',
 '--stale-ms','900000','--trial-chat','-100123456'];
const env={...process.env,TELEGRAM_BOT_TOKEN:TOKEN,BOT_OWNER_ID:'100'};
function assertRedacted(result:ReturnType<typeof spawnSync>,expected:string){
 assert.equal(result.status,1);
 assert.equal(result.stdout,'');
 assert.ok(String(result.stderr).startsWith(expected+'\n'));
 for(const secret of [TOKEN,'-100123456','/private/secret-','PRIVATE GROUP TITLE'])
  assert.equal(String(result.stderr).includes(secret),false);
}
test('read-only group CLI rejects missing arguments without echoing runtime secrets',()=>{
 const result=spawnSync(process.execPath,[groupCli],{env,encoding:'utf8'});
 assertRedacted(result,'MANARATAK_MODERATION_GROUP_INVALID_REQUEST');
});
test('read-only group CLI refuses malformed chat id before contacting Telegram',()=>{
 const result=spawnSync(process.execPath,[groupCli,...args.slice(0,-1),'not-a-group'],
  {env,encoding:'utf8'});
 assertRedacted(result,'MANARATAK_MODERATION_GROUP_INVALID_REQUEST');
});
test('read-only group CLI refuses a missing token without disclosing group or paths',()=>{
 const {TELEGRAM_BOT_TOKEN:_token,...withoutToken}=env;
 const result=spawnSync(process.execPath,[groupCli,...args],
  {env:withoutToken,encoding:'utf8'});
 assertRedacted(result,'MANARATAK_MODERATION_GROUP_INVALID_REQUEST');
});
test('target CLI still denies selecting the owner before new group probing is possible',()=>{
 const result=spawnSync(process.execPath,[targetCli,...args,'--trial-target','100'],
  {env,encoding:'utf8'});
 assertRedacted(result,'MANARATAK_MODERATION_TARGET_CHECK_FAILED');
});
