import { createHash } from 'node:crypto';

export type ImportFormat = 'md' | 'txt' | 'csv' | 'json';
export interface Candidate {
  title: string; university: string; cycle: string; degree: string; seats: number | null;
  locator: string; evidence: string; status: 'READY' | 'NEEDS_REVIEW' | 'DUPLICATE' | 'APPROVED';
  approvedBy?: string; categoryId?: string;
}
export interface ImportReport {
  sections: number; universities: number; opportunities: number;
  potentialDuplicates: number; ambiguous: number; explicitSeats: number | null; partial: boolean;
}
export interface ParsedDocument { digest: string; report: ImportReport; candidates: Candidate[]; }

type Raw = Record<string, unknown>;
const formats: ReadonlySet<string> = new Set(['md', 'txt', 'csv', 'json']);
const keyAliases: Record<string,string> = {
  'title':'title', 'scholarship':'title', 'program':'title', 'منحة':'title', 'المنحة':'title', 'البرنامج':'title', 'العنوان':'title',
  'university':'university', 'institution':'university', 'الجامعة':'university', 'الجهة':'university',
  'cycle':'cycle', 'year':'cycle', 'الدورة':'cycle', 'السنة':'cycle',
  'degree':'degree', 'level':'degree', 'الدرجة':'degree', 'المرحلة':'degree',
  'seats':'seats', 'places':'seats', 'المقاعد':'seats', 'عدد المقاعد':'seats'
};
const normalize = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g,' ');
const simple = (input: unknown): string => typeof input === 'string' || typeof input === 'number' ? String(input).trim().slice(0,400) : '';
function toRecord(raw: Raw): Raw {
  const mapped: Raw = {};
  for (const [key, value] of Object.entries(raw)) {
    const canonical = keyAliases[normalize(key)];
    if (canonical && !(canonical in mapped)) mapped[canonical] = value;
  }
  return mapped;
}
function csvRows(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, afterQuote = false, atStart = true;
  for (let i=0; i<input.length; i++) {
    const ch=input[i]!;
    if (quoted) {
      if (ch==='"' && input[i+1]==='"') { cell+='"'; i++; }
      else if (ch==='"') { quoted=false; afterQuote=true; }
      else cell+=ch;
    } else if (ch==='"') {
      if (!atStart) throw new Error('INVALID_CSV'); quoted=true;
    } else if (ch===',' || ch==='\n') {
      row.push(cell.trim()); cell=''; afterQuote=false; atStart=true;
      if (ch==='\n') { if (row.some(Boolean)) rows.push(row); row=[]; }
    } else if (ch==='\r' && input[i+1]==='\n') { continue; }
    else {
      if (afterQuote && ch!==' ' && ch!=='\t') throw new Error('INVALID_CSV');
      if (!afterQuote) { cell+=ch; if (ch!==' ' && ch!=='\t') atStart=false; }
    }
  }
  if (quoted) throw new Error('INVALID_CSV');
  row.push(cell.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length===0) throw new Error('INVALID_CSV');
  return rows;
}
function parsedRows(format: ImportFormat, text: string): {raw: Raw; locator: string; evidence: string}[] {
  if (format==='csv') {
    const rows=csvRows(text); const headers=rows[0]!.map(x=>x.trim());
    if (new Set(headers.map(normalize)).size!==headers.length || !headers.some(x=>keyAliases[normalize(x)]==='title') || !headers.some(x=>keyAliases[normalize(x)]==='university')) throw new Error('INVALID_HEADERS');
    return rows.slice(1).map((r,index)=>{
      if (r.length!==headers.length) throw new Error('INVALID_CSV');
      return {raw:Object.fromEntries(headers.map((h,i)=>[h,r[i]])),locator:`row:${index+2}`,evidence:r.join(' | ').slice(0,180)};
    });
  }
  if (format==='json') {
    let decoded: unknown;
    try { decoded=JSON.parse(text); } catch { throw new Error('INVALID_JSON'); }
    const items=Array.isArray(decoded)?decoded:(decoded && typeof decoded==='object' && 'items' in decoded ? (decoded as {items:unknown}).items:null);
    if (!Array.isArray(items)) throw new Error('INVALID_JSON_STRUCTURE');
    return items.map((record,index)=>{
      if (!record || Array.isArray(record) || typeof record!=='object') throw new Error('INVALID_RECORD');
      for (const value of Object.values(record)) if (value!==null && !['string','number'].includes(typeof value)) throw new Error('INVALID_RECORD');
      const raw=record as Raw;
      return {raw,locator:`item:${index+1}`,evidence:`${simple(raw.title??raw['المنحة'])} | ${simple(raw.university??raw['الجامعة'])}`.slice(0,180)};
    });
  }
  const blocks=format==='md'
    ? text.split(/(?=^#{1,3}\s+[^\n]+)/m).filter(x=>x.trim())
    : text.split(/\n\s*\n+|\n---+\n/g).filter(x=>x.trim());
  return blocks.map((block,index)=>{
    const raw: Raw={};
    for(const line of block.split(/\n/g)){
      if (format==='md' && /^#{1,3}\s+/.test(line)) { raw.title=line.replace(/^#{1,3}\s+/,'').trim(); continue; }
      const match=line.match(/^\s*([^:：]{1,50})\s*[:：]\s*(.+)\s*$/);
      if(match) raw[match[1]!.trim()]=match[2]!.trim();
    }
    return {raw,locator:`section:${index+1}`,evidence:block.trim().slice(0,180)};
  });
}

/** A deterministic parser, not an AI extraction or official scholarship verification. */
export function parseDocument(format: string, filename: string, input: string): ParsedDocument {
  if (!formats.has(format)) throw new Error('UNSUPPORTED_FORMAT');
  if (!/^[^/\\\0]{1,120}$/.test(filename) || filename.split('.').at(-1)?.toLowerCase()!==format) throw new Error('FORMAT_MISMATCH');
  if (Buffer.byteLength(input,'utf8')>256*1024) throw new Error('FILE_TOO_LARGE');
  const clean=input.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  const rows=parsedRows(format as ImportFormat, clean);
  if (rows.length>1000) throw new Error('TOO_MANY_RECORDS');
  const candidates: Candidate[]=[];
  const names=new Set<string>(),dedupe=new Set<string>();
  let opportunities=0,duplicates=0,ambiguous=0,explicitSeats:number|null=null;
  for(const entry of rows) {
    const raw=toRecord(entry.raw);
    const title=simple(raw.title),university=simple(raw.university),cycle=simple(raw.cycle),degree=simple(raw.degree);
    const textSeats=simple(raw.seats);
    const seats=textSeats && /^\d{1,9}$/.test(textSeats)?Number(textSeats):null;
    if (university) names.add(normalize(university));
    const malformedSeats=Boolean(textSeats && seats===null);
    const key=[university,title,cycle,degree].map(normalize).join('|');
    let status: Candidate['status']='READY';
    if(!title || !university || malformedSeats) { status='NEEDS_REVIEW'; ambiguous++; }
    else if(dedupe.has(key)) {status='DUPLICATE';duplicates++;}
    else {dedupe.add(key);opportunities++;}
    if(seats!==null && status!=='DUPLICATE') explicitSeats=(explicitSeats??0)+seats;
    candidates.push({title,university,cycle,degree,seats,locator:entry.locator,evidence:entry.evidence,status});
  }
  const digest=createHash('sha256').update(format).update('\0').update(clean).digest('hex');
  return {digest, candidates, report:{sections:rows.length,universities:names.size,opportunities,potentialDuplicates:duplicates,ambiguous,explicitSeats,partial:false}};
}
