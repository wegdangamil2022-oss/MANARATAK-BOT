import { createHash } from 'node:crypto';

/**
 * B4 S121-07 preflight only: deterministic human-review plan. No Telegram SDK calls or media download.
 * Message-length checks use UTF-16 code units (a conservative bound for Telegram's character limits).
 * A plan is not a promise that Telegram actually renders a preview/photo.
 */
export type PublicationRenderPart =
  | { kind: 'TEXT'; text: string }
  | { kind: 'PHOTO'; text: string; mediaId: string };

export interface PublicationRenderPlan {
  kind: 'TEXT' | 'PHOTO';
  parts: PublicationRenderPart[];
  fingerprint: string;
  linkPreview?: { url: string; preferLargeMedia: boolean };
}
export interface PublicationRenderInput {
  text: string;
  photo?: { mediaId: string; caption: string };
  /** Explicit reviewer approval for a TEXT-ONLY fallback when photo caption cannot be sent. */
  approvedTextFallback?: boolean;
  linkPreviewUrl?: string;
  preferLargeMedia?: boolean;
}

const MESSAGE_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const MAX_PARTS = 10;
const invalidText = /[\u0000-\u0008\u000B-\u001F\u007F]/u;

function validateText(text: string): void {
  if (typeof text !== 'string' || !text.trim()) throw new Error('EMPTY_TEXT');
  if (invalidText.test(text) || /\r/u.test(text)) throw new Error('INVALID_TEXT');
  if (text.length > MAX_PARTS * MESSAGE_LIMIT) throw new Error('PREVIEW_TOO_LONG');
}

function splitLongToken(token: string): string[] {
  // A URL must remain an atomic token; splitting a link could silently change its target.
  if (/^(https?:\/\/|www\.)/iu.test(token)) throw new Error('UNBREAKABLE_URL');
  const parts: string[] = [];
  const segmenter = new Intl.Segmenter('ar', { granularity: 'grapheme' });
  let current = '';
  for (const { segment } of segmenter.segment(token)) {
    if (segment.length > MESSAGE_LIMIT) throw new Error('UNBREAKABLE_GRAPHEME');
    if (current.length + segment.length > MESSAGE_LIMIT) { parts.push(current); current = ''; }
    current += segment;
  }
  if (current) parts.push(current);
  return parts;
}

function splitText(text: string): PublicationRenderPart[] {
  const result: PublicationRenderPart[] = [];
  const tokens = text.match(/\s+|\S+/gu) ?? [];
  let buffer = '';
  const flush = () => { if (buffer) { result.push({ kind:'TEXT', text:buffer }); buffer=''; } };
  for (const token of tokens) {
    if (token.length > MESSAGE_LIMIT) {
      flush();
      for (const part of splitLongToken(token)) result.push({kind:'TEXT', text:part});
      continue;
    }
    if (buffer.length + token.length > MESSAGE_LIMIT) flush();
    buffer += token;
  }
  flush();
  if (result.length > MAX_PARTS) throw new Error('PREVIEW_TOO_LONG');
  if (result.some(part => part.text.length > MESSAGE_LIMIT)) throw new Error('PREVIEW_TOO_LONG');
  return result;
}

function validateLink(url: string): string {
  if (typeof url !== 'string' || url.length > 2048 || /[\s\u0000-\u001F]/u.test(url)) throw new Error('INVALID_PREVIEW_URL');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('INVALID_PREVIEW_URL'); }
  const hostname = parsed.hostname.toLowerCase();
  const octets = hostname.split('.').map(x => Number(x));
  const ipv4 = octets.length === 4 && octets.every(x => Number.isInteger(x) && x >= 0 && x <= 255);
  const isPrivateIPv4 = ipv4 && (octets[0]===10 || octets[0]===127 || octets[0]===0 || octets[0]===169 && octets[1]===254 ||
    octets[0]===192 && octets[1]===168 || octets[0]===172 && (octets[1]??0)>=16 && (octets[1]??0)<=31);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !hostname.includes('.') ||
    hostname==='localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    hostname.startsWith('[') || isPrivateIPv4) throw new Error('INVALID_PREVIEW_URL');
  return parsed.href;
}

export function planPublicationPreview(input: PublicationRenderInput): PublicationRenderPlan {
  validateText(input.text);
  // Whitespace cannot become a separate outbound Telegram message at a chunk boundary.
  const normalizedText = input.text.trim();
  let linkPreview: PublicationRenderPlan['linkPreview'];
  if (input.linkPreviewUrl !== undefined) {
    linkPreview = { url: validateLink(input.linkPreviewUrl), preferLargeMedia: input.preferLargeMedia === true };
  }
  let kind: PublicationRenderPlan['kind'] = 'TEXT';
  let parts: PublicationRenderPart[];
  if (input.photo) {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(input.photo.mediaId)) throw new Error('INVALID_MEDIA_REF');
    validateText(input.photo.caption);
    if (input.photo.caption.length <= CAPTION_LIMIT) {
      if (linkPreview) throw new Error('PHOTO_LINK_PREVIEW_CONFLICT');
      kind = 'PHOTO';
      parts = [{kind:'PHOTO', text:input.photo.caption, mediaId:input.photo.mediaId}];
    } else if (input.approvedTextFallback === true) {
      parts = splitText(normalizedText);
    } else throw new Error('CAPTION_TOO_LONG');
  } else {
    parts = splitText(normalizedText);
  }
  const canonical = {kind, parts, ...(linkPreview ? {linkPreview} : {})};
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return { ...canonical, fingerprint };
}
