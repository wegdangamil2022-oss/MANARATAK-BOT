import type {BotState} from './store.js';
import type {Policy} from './policy.js';
import {subscriptionChangeAlerts} from './subscription-change-alert.js';

/** Historical observations only; never returns group, channel or actor IDs. */
export function summarizeSubscriptionChannelIncidents(s:BotState,policy:Policy,now:number):{available:boolean;observations:number;pending:number;delivered:number;failed:number;unknown:number;cancelled:number}{
 const summary={available:Number.isSafeInteger(now)&&now>=0&&now<=8640000000000000,observations:0,pending:0,delivered:0,failed:0,unknown:0,cancelled:0};
 if(!summary.available)return summary;
 for(const alert of subscriptionChangeAlerts(s,now)){
  if(!alert.lostChannel||!policy.isOwner(alert.actor)||alert.at<now-86400000)continue;
  summary.observations++;
  switch(alert.delivery){case 'PENDING':summary.pending++;break;case 'CONFIRMED':summary.delivered++;break;case 'FAILED_CONFIRMED':summary.failed++;break;case 'UNKNOWN_OUTCOME':summary.unknown++;break;case 'CANCELLED':summary.cancelled++;break;}
 }
 return summary;
}
