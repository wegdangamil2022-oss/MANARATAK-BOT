import {isValidProtectionPolicy,type ProtectionPolicy} from './protection-rules.js';

/** A network's source group may contain trusted usernames, protected members
 * or fraud claims that are ONLY meaningful for that group. Never transfer
 * these to another group, including during background synchronization.
 *
 * Validation is intentionally independent of whether a rule is enabled:
 * copying disabled sensitive rules would arm them if someone later enabled
 * enforcement or toggled an inherited draft.
 */
const portableKinds=new Set([
 'WORD','PHRASE','LOOKALIKE','TYPE','LINK','FORWARD','HIDDEN',
 'PHONE','LIMIT'
]);
export function portableNetworkProtectionRules(policy:ProtectionPolicy):boolean{
 return isValidProtectionPolicy(policy)&&
  policy.rules.every(rule=>portableKinds.has(rule.kind));
}
