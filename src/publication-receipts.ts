/**
 * B4 fake/adapter receipt boundary: Telegram message_id is a positive integer;
 * test gateways use deterministic opaque printable IDs. Never persist controls,
 * bidi overrides, unbounded strings or ambiguous leading/trailing whitespace as proof.
 * This check is necessary but NEVER sufficient evidence of delivery.
 */
export function validPublicationMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
