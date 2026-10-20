import { planPublicationPreview } from './publication-preview-plan.js';
import { reconcileLegacyCatalog } from './legacy-publication-migration.js';

const display = planPublicationPreview({
  text:'منحة منارتك — جامعة تجريبية\nالدرجة: ماجستير\nالعام: 2026\nالمصدر: مثال وهمي فقط',
  linkPreviewUrl:'https://example.edu/scholarships',
});
const migration = await reconcileLegacyCatalog({
  items:[
    {id:'university-a',revision:'rev-1',destination:'-100500'},
    {id:'university-b',revision:'rev-1',destination:'-100500'},
    {id:'university-c',revision:'rev-1',destination:'-100500'},
  ],
  evidence:[{itemId:'university-c',revision:'rev-1',destination:'-100500',messageId:'mock-123',evidenceId:'mock-proof',source:'FORWARDED_POST'}],
  lastSeenOrdinal:3,
}, async evidence=>evidence.evidenceId==='mock-proof', async()=>false);
console.log(JSON.stringify({mockOnly:true,preview:{kind:display.kind,parts:display.parts.length,fingerprint:display.fingerprint},migration:migration.totals},null,2));
