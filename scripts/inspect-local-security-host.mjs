import {mkdtemp,writeFile,readFile,copyFile,chmod,lstat,realpath,symlink,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BotStore} from '../dist/src/store.js';
import {inspectTelegramTrialAcceptanceReadOnly} from '../dist/src/telegram-trial-acceptance.js';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
// Isolated host-capability probe: no original DB, network, token or RUN flag.
const directory=await mkdtemp(join(tmpdir(),'manaratak-host-probe-'));
try{
 const file=join(directory,'probe.flag');await writeFile(file,'STOP\n',{mode:0o600});await chmod(file,0o600);const stat=await lstat(file);
 let symlinkResult='AVAILABLE';try{await symlink(file,join(directory,'probe-link'));}catch(error){symlinkResult=String(error.code??'UNAVAILABLE');}
 const database=join(directory,'probe.sqlite'),backup=join(directory,'backup.sqlite'),store=new BotStore(database,{engine:'sqlite'});
 await store.transaction(()=>{});await chmod(database,0o600);await copyFile(database,backup);await chmod(backup,0o600);
 const digest=async()=>createHash('sha256').update(await readFile(database)).digest('hex'),before=await digest(),dbMeta=await lstat(database);
 const inspect=async f=>{try{await f();return 'ACCEPTED';}catch(error){return String(error.message??'REJECTED');}};
 const sqliteReadOnly=await inspect(()=>BotStore.snapshotSqliteReadOnly(database));
 const trialAcceptance=await inspect(()=>inspectTelegramTrialAcceptanceReadOnly({stateFile:database,backupFile:backup,safetyFile:file,now:Date.now(),staleAfterMs:60000}));
 process.stdout.write(JSON.stringify({platform:process.platform,node:process.version,requestedMode:'0600',observedMode:(stat.mode&0o777).toString(8),passesPosixPrivateMode:(stat.mode&0o077)===0,canonicalPath:await realpath(file)===file,symlinkResult,isolatedDatabase:{observedMode:(dbMeta.mode&0o777).toString(8),sqliteReadOnly,trialAcceptance,unchanged:before===await digest()},conclusion:(stat.mode&0o077)===0?'POSIX_MODE_SUPPORTED':'POSIX_MODE_NOT_ENFORCEABLE_BY_CHMOD'},null,2)+'\n');
}finally{if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('manaratak-host-probe-'))throw Error('HOST_PROBE_CLEANUP_PATH_INVALID');await rm(directory,{recursive:true,force:true});}
