import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPublicationPreview, type PublicationRenderPlan } from '../src/publication-preview-plan.js';
import { reconcileLegacyCatalog, type LegacyEvidence, type LegacyItem } from '../src/legacy-publication-migration.js';

const item = (id: string, revision = 'r1', destination = '-100'): LegacyItem => ({ id, revision, destination });
const evidence = (id: string, messageId: string, overrides: Partial<LegacyEvidence> = {}): LegacyEvidence => ({
  itemId: id, revision: 'r1', destination: '-100', messageId, evidenceId: `ev-${id}-${messageId}`,
  source: 'TRUSTED_RECEIPT', ...overrides,
});
const verify = async (v: LegacyEvidence) => v.evidenceId.startsWith('ev-');
const reviewer = async (actor: string) => actor === 'owner';

// RED first: implement small, explicit Telegram-approved display plans.
test('B4 display: text at the Telegram limit remains a single message with a stable fingerprint', () => {
  const plan = planPublicationPreview({ text: 'س'.repeat(4096) });
  assert.equal(plan.kind, 'TEXT');
  assert.equal(plan.parts.length, 1);
  assert.equal(plan.parts[0]?.text, 'س'.repeat(4096));
  assert.equal(plan.fingerprint, planPublicationPreview({text: 'س'.repeat(4096)}).fingerprint);
});

test('B4 display: splits long Arabic text at word boundaries and preserves all non-whitespace words', () => {
  const input = ('منحة طبية متاحة للطلاب في 2026. ').repeat(180);
  const plan = planPublicationPreview({ text: input });
  assert.ok(plan.parts.length >= 2 && plan.parts.length <= 10);
  assert.ok(plan.parts.every(p => p.kind === 'TEXT' && p.text.length <= 4096));
  assert.equal(plan.parts.map(p => p.text).join('').replace(/\s+/g,''), input.replace(/\s+/g,''));
});

test('B4 display: never truncates or invents information when a text exceeds the hard total cap', () => {
  assert.throws(() => planPublicationPreview({ text: 'ب '.repeat(22000) }), /TOO_LONG/);
});

test('B4 display: lone overlong URL cannot be silently split across messages', () => {
  assert.throws(() => planPublicationPreview({ text: 'https://example.org/' + 'x'.repeat(5000) }), /UNBREAKABLE_URL/);
});

test('B4 display: cuts unspaced Arabic graphemes safely, never emitting malformed surrogate pairs', () => {
  const text = '👨‍👩‍👧‍👦'.repeat(750);
  const plan = planPublicationPreview({ text });
  assert.equal(plan.parts.map(p => p.text).join(''), text);
  assert.ok(plan.parts.every(p => p.text.length <= 4096));
  for (const p of plan.parts) assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p.text), false);
});

test('B4 display: rejects control bytes/empty message before draft approval', () => {
  assert.throws(() => planPublicationPreview({ text: ' ' }), /EMPTY_TEXT/);
  assert.throws(() => planPublicationPreview({ text: 'hello\u0000secret' }), /INVALID_TEXT/);
});

test('B4 display: photo caption may contain 1024 characters exactly and requires an internal media reference', () => {
  const p = planPublicationPreview({ text: 'مرحبا', photo: { mediaId: 'approvedMedia_2026', caption: 'م'.repeat(1024) } });
  assert.equal(p.kind, 'PHOTO');
  assert.equal(p.parts[0]?.kind, 'PHOTO');
  assert.equal(p.parts[0]?.text, 'م'.repeat(1024));
});

test('B4 display: rejects photo caption overflow without explicit fallback approval', () => {
  assert.throws(() => planPublicationPreview({ text:'منحة', photo:{mediaId:'media2026',caption:'a'.repeat(1025)} }), /CAPTION_TOO_LONG/);
  const p = planPublicationPreview({text:'منحة',photo:{mediaId:'media2026',caption:'a'.repeat(1025)},approvedTextFallback:true});
  assert.equal(p.kind, 'TEXT');
  assert.equal(p.parts[0]?.text, 'منحة');
});

test('B4 display: image reference cannot smuggle arbitrary URLs, local paths or Telegram secrets', () => {
  for (const ref of ['https://example.com/a.jpg','/etc/passwd','abc','telegram:token','a b']) {
    assert.throws(() => planPublicationPreview({text:'X',photo:{mediaId:ref,caption:'X'}}), /INVALID_MEDIA_REF/);
  }
});

test('B4 display: URL preview is explicit HTTPS only and never claims rendering was successful', () => {
  const p = planPublicationPreview({text:'منحة',linkPreviewUrl:'https://scholarship.example.edu/apply'});
  assert.equal(p.kind,'TEXT');assert.equal(p.linkPreview?.url,'https://scholarship.example.edu/apply');
  for (const url of ['javascript:alert(1)','http://127.0.0.1/','https://localhost/','https://me:pass@example.com/']) {
    assert.throws(() => planPublicationPreview({text:'test',linkPreviewUrl:url}), /INVALID_PREVIEW_URL/);
  }
});

test('B4 display: changing source text or approved fallback changes the approved plan fingerprint', () => {
  const a = planPublicationPreview({text:'دليل 2026'});
  const b = planPublicationPreview({text:'دليل 2027'});
  assert.notEqual(a.fingerprint, b.fingerprint);
  const image = planPublicationPreview({text:'دليل 2026',photo:{mediaId:'media2026',caption:'دليل'}});
  assert.notEqual(image.fingerprint, a.fingerprint);
});

// RED first: legacy migration never equates a forward or an ordinal checkpoint to all earlier postings.
test('B4 migration: a forwarded last announcement cannot prove earlier catalog items', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a'),item('b'),item('c')],evidence:[evidence('c','999',{source:'FORWARDED_POST'})],lastSeenOrdinal:3},verify,reviewer);
  assert.equal(x.records[0]?.status,'UNVERIFIED');
  assert.equal(x.records[1]?.status,'UNVERIFIED');
  assert.equal(x.records[2]?.status,'PUBLISHED_VERIFIED');
  assert.equal(x.totals.PUBLISHED_VERIFIED,1);
});

test('B4 migration: unverified or mismatched receipt never confirms a publication', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a')],evidence:[evidence('a','1')]},async()=>false,reviewer);
  assert.equal(x.records[0]?.status,'UNVERIFIED');
  const mismatch=await reconcileLegacyCatalog({items:[item('a')],evidence:[evidence('a','1',{revision:'r2'})]},verify,reviewer);
  assert.equal(mismatch.records[0]?.status,'REVIEW_REQUIRED');
});

test('B4 migration: one Telegram message ID claimed by two items is ambiguous for BOTH', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a'),item('b')], evidence:[evidence('a','8'), evidence('b','8')]},verify,reviewer);
  assert.deepEqual(x.records.map(r=>r.status),['REVIEW_REQUIRED','REVIEW_REQUIRED']);
});

test('B4 migration: two distinct verified messages for one item require explicit review', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a')],evidence:[evidence('a','8'), evidence('a','9')]},verify,reviewer);
  assert.equal(x.records[0]?.status,'REVIEW_REQUIRED');
});

test('B4 migration: exact approved skip is not a verified publication', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a'),item('b')],evidence:[],manualSkips:[{itemId:'a',actor:'owner',reason:'تم تجاوزه بموافقتي'}]},verify,reviewer);
  assert.equal(x.records[0]?.status,'MANUALLY_SKIPPED');
  assert.equal(x.records[1]?.status,'UNVERIFIED');
  assert.equal(x.totals.PUBLISHED_VERIFIED,0);
});

test('B4 migration: rejects skip by unauthorized reviewer rather than creating an approved record', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a')],evidence:[],manualSkips:[{itemId:'a',actor:'stranger',reason:'تجاوز'}]},verify,reviewer);
  assert.equal(x.records[0]?.status,'REVIEW_REQUIRED');
});

test('B4 migration: skip conflicts with trusted receipt and remains review-required', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a')],evidence:[evidence('a','5')],manualSkips:[{itemId:'a',actor:'owner',reason:'تجاوز'}]},verify,reviewer);
  assert.equal(x.records[0]?.status,'REVIEW_REQUIRED');
});

test('B4 migration: duplicate immutable item keys cannot enter the planning scope', async () => {
  await assert.rejects(reconcileLegacyCatalog({items:[item('a'),item('a')],evidence:[]},verify,reviewer),/DUPLICATE_ITEM/);
});

test('B4 migration: evidence for wrong destination cannot be verified for this item', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a')],evidence:[evidence('a','5',{destination:'-999'})]},verify,reviewer);
  assert.equal(x.records[0]?.status,'REVIEW_REQUIRED');
});

test('B4 migration: same message ID in two different channels is not ambiguous', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a'),item('b','r1','-200')],evidence:[evidence('a','5'),evidence('b','5',{destination:'-200'})]},verify,reviewer);
  assert.deepEqual(x.records.map(r=>r.status),['PUBLISHED_VERIFIED','PUBLISHED_VERIFIED']);
});

test('B4 migration: failed verification makes evidence unverified, never a confirmed failure', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a')],evidence:[evidence('a','5')]},async()=>{throw new Error('telegram unavailable');},reviewer);
  assert.equal(x.records[0]?.status,'UNVERIFIED');
});

test('B4 migration: a forged bulk skip/cutoff never fills in individual receipts', async () => {
  const x=await reconcileLegacyCatalog({items:[item('a'),item('b'),item('c')],evidence:[],lastSeenOrdinal:3},verify,reviewer);
  assert.equal(x.totals.PUBLISHED_VERIFIED,0);
  assert.equal(x.totals.MANUALLY_SKIPPED,0);
});

test('B4 display: exactly full message plus whitespace does not emit a blank Telegram message', () => {
  const p=planPublicationPreview({text:'x'.repeat(4096)+'  '});
  assert.equal(p.parts.length,1);assert.equal(p.parts[0]?.text,'x'.repeat(4096));
});

test('B4 migration: a catalogue item ID must not repeat under two destinations', async () => {
  await assert.rejects(reconcileLegacyCatalog({items:[item('same','r1','-100'),item('same','r1','-200')],evidence:[]},verify,reviewer),/DUPLICATE_ITEM/);
});
