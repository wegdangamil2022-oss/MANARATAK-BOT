import {createHash} from 'node:crypto';
import type {EducationResource} from './store.js';

/** Deterministic opaque proof of the exact reviewed local resource snapshot.
 * Button text is not authority; this fingerprint is compared in the same
 * transaction as archival under the current trusted owner and group policy.
 */
export function resourceArchiveFingerprint(r:EducationResource):string{
 const exact=[r.id,r.categoryId,r.scope,r.title,r.university,r.cycle,
  r.degree,r.seats,r.sourceImportId,r.sourceLocator,r.reviewedBy,r.status,
  r.publicationText??null,r.publicationTextReviewedBy??null];
 return '~'+createHash('sha256').update(JSON.stringify(exact),'utf8')
  .digest('hex').slice(0,16);
}
