import {preflightLiveTelegram} from './telegram-live-server.js';

// This command is intentionally one-shot, synchronous in lifecycle and NEVER
// opens a listening socket, queries Telegram, or writes to a state database.
// Only fixed error codes are exposed; never echo env, URLs or state file paths.
void (async()=>{
 try{
  const ready=await preflightLiveTelegram(process.env);
  process.stdout.write(ready.safetySwitch==='STOP'?
   'MANARATAK_TELEGRAM_PREFLIGHT_PAUSED\n':
   'MANARATAK_TELEGRAM_PREFLIGHT_OK\n');
 }catch(err){
  const state=err instanceof Error&&err.message==='LIVE_TELEGRAM_STATE_INVALID';
  const safety=err instanceof Error&&err.message==='LIVE_TELEGRAM_SAFETY_INVALID';
  process.stderr.write(state?
    'MANARATAK_TELEGRAM_PREFLIGHT_STATE_REJECTED\n':safety?
    'MANARATAK_TELEGRAM_PREFLIGHT_SAFETY_REJECTED\n':
    'MANARATAK_TELEGRAM_PREFLIGHT_CONFIG_REJECTED\n');
  process.exitCode=1;
 }
})();
