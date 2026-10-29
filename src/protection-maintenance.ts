export const PROTECTION_MAINTENANCE_INTERVAL_MS=15000;
type Schedule=(tick:()=>void)=>()=>void;
const scheduleInterval:Schedule=tick=>{
 const timer=setInterval(tick,PROTECTION_MAINTENANCE_INTERVAL_MS);timer.unref();
 return ()=>clearInterval(timer);
};
/** Local data cleanup only. No overlapping transactions, outbound requests,
 * secret-bearing error messages or new work after shutdown begins. */
export function startProtectionMaintenance(cleanup:()=>Promise<void>,schedule:Schedule=scheduleInterval,onFailure:()=>void=()=>{}):{stop:()=>Promise<void>}{
 let stopped=false,pending:Promise<void>|undefined;
 const tick=()=>{
  if(stopped||pending)return;
  const task=(async()=>{try{await cleanup();}catch{try{onFailure();}catch{/* reporting cannot break cleanup lifecycle */}}})();
  pending=task;void task.then(()=>{if(pending===task)pending=undefined;});
 };
 const cancel=schedule(tick);tick();
 return {stop:async()=>{if(!stopped){stopped=true;cancel();}await pending;}};
}
