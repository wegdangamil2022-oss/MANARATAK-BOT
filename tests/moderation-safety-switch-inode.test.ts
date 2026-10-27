import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,link,unlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readTelegramSafetySwitch,createTelegramSafetyGate} from '../src/telegram-safety-switch.js';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-stop-inode-'));
 const flag=join(dir,'stop.flag'),alias=join(dir,'other-hardlink.flag');
 await writeFile(flag,'STOP\n',{mode:0o600});
 return {dir,flag,alias,close:()=>rm(dir,{recursive:true,force:true})};
}

test('hard-linked RUN cannot impersonate an independently controlled safety flag',async()=>{
 const f=await fixture();try{
  await writeFile(f.flag,'RUN\n');
  await link(f.flag,f.alias);
  // Both names refer to the same mutable inode. A second path must never
  // bypass the trusted operator control of this safety-critical switch.
  await assert.rejects(readTelegramSafetySwitch(f.flag),/LIVE_TELEGRAM_SAFETY_INVALID/);
  await assert.rejects(readTelegramSafetySwitch(f.alias),/LIVE_TELEGRAM_SAFETY_INVALID/);
  assert.equal(await createTelegramSafetyGate(f.flag)(),false);
  assert.equal(await createTelegramSafetyGate(f.alias)(),false);
  await unlink(f.alias);
  assert.equal(await readTelegramSafetySwitch(f.flag),'RUN');
 }finally{await f.close();}
});

test('hard-linked STOP is invalid even for offline trial preflight',async()=>{
 const f=await fixture();try{
  await link(f.flag,f.alias);
  await assert.rejects(readTelegramSafetySwitch(f.flag),/LIVE_TELEGRAM_SAFETY_INVALID/);
  assert.equal(await createTelegramSafetyGate(f.flag)(),false);
  await unlink(f.alias);
  assert.equal(await readTelegramSafetySwitch(f.flag),'STOP');
 }finally{await f.close();}
});

test('single-link protected flags still support atomic STOP and RUN replacement',async()=>{
 const f=await fixture();try{
  assert.equal(await readTelegramSafetySwitch(f.flag),'STOP');
  const replacement=join(f.dir,'replacement.flag');
  await writeFile(replacement,'RUN\n',{mode:0o600});
  await rename(replacement,f.flag);
  assert.equal(await createTelegramSafetyGate(f.flag)(),true);
  await writeFile(replacement,'STOP\n',{mode:0o600});
  await rename(replacement,f.flag);
  assert.equal(await createTelegramSafetyGate(f.flag)(),false);
 }finally{await f.close();}
});
