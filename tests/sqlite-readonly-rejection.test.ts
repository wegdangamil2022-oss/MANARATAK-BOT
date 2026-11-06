import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,chmod,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BotStore} from '../src/store.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../src/telegram-trial-acceptance.js';

test('read-only SQLite rejection retains a safe specific cause without exposing a path',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sqlite-rejection-'));try{
  const file=join(dir,'sensitive-source.sqlite');await writeFile(file,'not sqlite',{mode:0o600});await chmod(file,0o600);
  const expected=((await lstat(file)).mode&0o077)!==0?'SQLITE_READONLY_PRIVATE_MODE_REQUIRED':'SQLITE_READONLY_CONTENT_INVALID';
  await assert.rejects(BotStore.snapshotSqliteReadOnly(file),(error:unknown)=>{assert.ok(error instanceof Error);assert.equal(error.message,'TELEGRAM_OUTBOX_STATE_INVALID');assert.ok(error.cause instanceof Error);assert.equal(error.cause.message,expected);assert.ok(!error.cause.message.includes(dir));return true;});
  await assert.rejects(inspectTelegramTrialAcceptanceReadOnly({stateFile:file,backupFile:join(dir,'backup.sqlite'),safetyFile:join(dir,'safety.flag'),now:1700000000000,staleAfterMs:60000}),(error:unknown)=>{assert.ok(error instanceof Error);assert.equal(error.message,'TRIAL_ACCEPTANCE_INVALID_STATE');assert.ok(error.cause instanceof Error);assert.equal(error.cause.message,'TELEGRAM_OUTBOX_STATE_INVALID');assert.ok(error.cause.cause instanceof Error);assert.equal(error.cause.cause.message,expected);return true;});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('invalid relative SQLite paths have a distinct redacted rejection',async()=>{
 await assert.rejects(BotStore.snapshotSqliteReadOnly('private.sqlite'),(error:unknown)=>{assert.ok(error instanceof Error);assert.equal(error.message,'TELEGRAM_OUTBOX_STATE_INVALID');assert.ok(error.cause instanceof Error);assert.equal(error.cause.message,'SQLITE_READONLY_PATH_INVALID');return true;});
});
