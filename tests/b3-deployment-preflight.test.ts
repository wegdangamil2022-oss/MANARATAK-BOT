import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm,symlink,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {BotStore} from '../src/store.js';
import {loadLiveTelegramConfig,preflightLiveTelegram,createLiveTelegramServer} from '../src/telegram-live-server.js';

const TOKEN='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcde';
const SECRET='valid_secret_value_abcdefghijklmnopqrstuvwxyz123';
const URL='https://webhook.manaratak-ops.net/telegram/webhook';
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'manaratak-deploy-preflight-'));
 const stateFile=join(dir,'store.sqlite'),store=new BotStore(stateFile,{engine:'sqlite'});
 await store.transaction(()=>undefined);
 await chmod(stateFile,0o600);
 const safetyFile=join(dir,'safety.flag');await writeFile(safetyFile,'RUN\n',{mode:0o600});
 const env={BOT_ENV:'production',TELEGRAM_ENABLED:'true',
  TELEGRAM_REPLY_DELIVERY_ENABLED:'true',BOT_OWNER_ID:'100',BOT_ID:'bot-main',
  BOT_USERNAME:'ManaratakBot',BOT_STATE_FILE:stateFile,TELEGRAM_BOT_TOKEN:TOKEN,
  TELEGRAM_WEBHOOK_SECRET:SECRET,TELEGRAM_LISTEN_PORT:'8787',
  TELEGRAM_WEBHOOK_PUBLIC_URL:URL,TELEGRAM_SAFETY_FILE:safetyFile};
 return {dir,stateFile,env,store,close:()=>rm(dir,{recursive:true,force:true})};
}
test('preflight validates private existing SQLite and HTTPS deployment without listening or network',async()=>{
 const x=await setup();
 try{
  const cfg=loadLiveTelegramConfig(x.env);
  assert.equal(cfg.publicWebhookUrl,URL);
  const report=await preflightLiveTelegram(x.env);
  assert.deepEqual(report,{ready:true,httpsWebhook:true,privateSqlite:true,listener:'LOOPBACK_ONLY',telegramNetworkCalls:0,safetySwitch:'RUN'});
  const server=await createLiveTelegramServer(cfg, (async()=>{throw Error('NETWORK_FORBIDDEN');}) as typeof fetch);
  assert.equal(server.listening,false);server.close();
 }finally{await x.close();}
});
test('production start blocks missing public webhook URL, even when other enabling flags are set',async()=>{
 const x=await setup();try{
  assert.throws(()=>loadLiveTelegramConfig({...x.env,TELEGRAM_WEBHOOK_PUBLIC_URL:undefined}),/LIVE_TELEGRAM_CONFIG_INVALID/);
  await assert.rejects(preflightLiveTelegram({...x.env,TELEGRAM_WEBHOOK_PUBLIC_URL:undefined}),/LIVE_TELEGRAM_CONFIG_INVALID/);
 }finally{await x.close();}
});
test('URL rejects insecure, local, userinfo, unexpected path, query, fragments, ports and normalization',async()=>{
 const x=await setup();try{
  const bad=[
   'http://webhook.manaratak-ops.net/telegram/webhook',
   'https://localhost/telegram/webhook','https://localhost.localdomain/telegram/webhook',
   'https://127.0.0.1/telegram/webhook','https://[::1]/telegram/webhook',
   'https://192.168.1.10/telegram/webhook',
   'https://webhook.local/telegram/webhook','https://webhook.internal/telegram/webhook',
   'https://webhook.test/telegram/webhook','https://webhook.invalid/telegram/webhook',
   'https://webhook.manaratak-ops.net:8443/telegram/webhook',
   'https://user:pass@webhook.manaratak-ops.net/telegram/webhook',
   'https://webhook.manaratak-ops.net/telegram/webhook?token=abc',
   'https://webhook.manaratak-ops.net/telegram/webhook#frag',
   'https://webhook.manaratak-ops.net/telegram/webhook/',
   'https://webhook.manaratak-ops.net/telegram/other',
   'https://WEBHOOK.manaratak-ops.net/telegram/webhook',
   'https://webhook.manaratak-ops.net:443/telegram/webhook',
   'https://webhook.manaratak-ops.net./telegram/webhook',
   ' https://webhook.manaratak-ops.net/telegram/webhook',
   'https://webhook.manaratak-ops.net/telegram/webhook\n'
  ];
  for(const url of bad){
   assert.throws(()=>loadLiveTelegramConfig({...x.env,TELEGRAM_WEBHOOK_PUBLIC_URL:url}),
    /LIVE_TELEGRAM_CONFIG_INVALID/,url);
  }
  assert.equal(loadLiveTelegramConfig(x.env).publicWebhookUrl,URL);
 }finally{await x.close();}
});
test('owner ID and public URL cannot be forged through a malformed runtime config',async()=>{
 const x=await setup();try{
  for(const id of ['01','0','9007199254740992','99999999999999999999','-3','abc']){
   assert.throws(()=>loadLiveTelegramConfig({...x.env,BOT_OWNER_ID:id}),
    /LIVE_TELEGRAM_CONFIG_INVALID/);
  }
  const cfg=loadLiveTelegramConfig(x.env);
  await assert.rejects(createLiveTelegramServer({...cfg,publicWebhookUrl:'http://evil.test/telegram/webhook'}),
   /LIVE_TELEGRAM_CONFIG_INVALID/);
 }finally{await x.close();}
});
test('preflight fails closed on missing, world-readable, forged, and symlinked state',async()=>{
 const x=await setup();try{
  await assert.rejects(preflightLiveTelegram({...x.env,BOT_STATE_FILE:join(x.dir,'nonexistent.sqlite')}),
   /LIVE_TELEGRAM_STATE_INVALID/);
  await access(x.stateFile);
  await chmod(x.stateFile,0o644);
  await assert.rejects(preflightLiveTelegram(x.env),/LIVE_TELEGRAM_STATE_INVALID/);
  await chmod(x.stateFile,0o600);
  const bogus=join(x.dir,'bogus.sqlite');await writeFile(bogus,'fake database');
  await chmod(bogus,0o600);
  await assert.rejects(preflightLiveTelegram({...x.env,BOT_STATE_FILE:bogus}),/LIVE_TELEGRAM_STATE_INVALID/);
  const alias=join(x.dir,'alias.sqlite');await symlink(x.stateFile,alias);
  await assert.rejects(preflightLiveTelegram({...x.env,BOT_STATE_FILE:alias}),/LIVE_TELEGRAM_STATE_INVALID/);
 }finally{await x.close();}
});
test('invalid config and invalid state errors never contain credentials or paths',async()=>{
 const x=await setup();try{
  let error:unknown;
  try{await preflightLiveTelegram({...x.env,TELEGRAM_WEBHOOK_PUBLIC_URL:'https://invalid.local/telegram/webhook'});}catch(e){error=e;}
  assert.equal((error as Error).message,'LIVE_TELEGRAM_CONFIG_INVALID');
  try{await preflightLiveTelegram({...x.env,BOT_STATE_FILE:join(x.dir,'absent.sqlite')});}catch(e){error=e;}
  assert.equal((error as Error).message,'LIVE_TELEGRAM_STATE_INVALID');
  assert.equal(JSON.stringify(error).includes(TOKEN),false);
  assert.equal(JSON.stringify(error).includes(x.dir),false);
 }finally{await x.close();}
});
test('preflight CLI outputs minimal status without public webhook URL, token or IDs',async()=>{
 const x=await setup();try{
  const r=spawnSync(process.execPath,['dist/src/telegram-readiness-cli.js'],{
   cwd:process.cwd(),env:{...process.env,...x.env},encoding:'utf8',timeout:15_000});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout.trim(),'MANARATAK_TELEGRAM_PREFLIGHT_OK');
  const output=r.stdout+r.stderr;
  for(const privateText of [TOKEN,SECRET,x.stateFile,URL,'100'])assert.equal(output.includes(privateText),false);
  const wrong=spawnSync(process.execPath,['dist/src/telegram-readiness-cli.js'],{
   cwd:process.cwd(),env:{...process.env,...x.env,TELEGRAM_ENABLED:'false'},
   encoding:'utf8',timeout:15_000});
  assert.equal(wrong.status,1);
  assert.match(wrong.stderr,/MANARATAK_TELEGRAM_PREFLIGHT_CONFIG_REJECTED/);
  assert.equal(wrong.stdout,'');
 }finally{await x.close();}
});
test('preflight failure never creates missing state file or starts runtime',async()=>{
 const x=await setup();try{
  const absent=join(x.dir,'uninitialized.sqlite');
  const r=spawnSync(process.execPath,['dist/src/telegram-readiness-cli.js'],{
   cwd:process.cwd(),env:{...process.env,...x.env,BOT_STATE_FILE:absent},
   encoding:'utf8',timeout:15_000});
  assert.equal(r.status,1);
  assert.match(r.stderr,/MANARATAK_TELEGRAM_PREFLIGHT_STATE_REJECTED/);
  await assert.rejects(access(absent),{code:'ENOENT'});
 }finally{await x.close();}
});
