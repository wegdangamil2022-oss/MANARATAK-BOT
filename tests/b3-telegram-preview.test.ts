import {test} from 'node:test';
import assert from 'node:assert/strict';
import {escapeTelegramListPreview} from '../src/telegram-preview.js';

test('Telegram list preview counts escaped HTML bytes and never splits an entity',()=>{
 const original='&<>"\'' .repeat(250);
 const bounded=escapeTelegramListPreview(original,220);
 assert.ok(Buffer.byteLength(bounded,'utf8')<=220);
 assert.ok(bounded.endsWith('…'));
 assert.ok(!bounded.includes('&am…')&&!bounded.includes('&lt…')&&!bounded.includes('&#3…'));
 assert.ok(/^(?:&amp;|&lt;|&gt;|&quot;|&#39;)*…$/u.test(bounded));
});
test('Telegram list preview keeps ordinary reviewed Arabic text unchanged and clips by UTF-8 bytes',()=>{
 const short='المنحة الصينية ٢٠٢٧';
 assert.equal(escapeTelegramListPreview(short),short);
 const truncated=escapeTelegramListPreview('🎓'.repeat(150),220);
 assert.ok(Buffer.byteLength(truncated,'utf8')<=220);
 assert.ok(truncated.endsWith('…'));
 assert.equal(truncated.includes('�'),false);
});
test('Telegram list preview replaces controls and bidi overrides before display',()=>{
 const rendered=escapeTelegramListPreview('  عنوان\u202e\n<تجربة>& \u2066',220);
 assert.equal(rendered,'عنوان  &lt;تجربة&gt;&amp;');
 assert.equal(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(rendered),false);
});
test('Telegram list preview rejects malformed budgets rather than silently exceeding provider limits',()=>{
 for(const budget of [-1,0,7,1025,NaN,Infinity,1.5])
  assert.throws(()=>escapeTelegramListPreview('test',budget),/INVALID_TELEGRAM_PREVIEW/);
});
