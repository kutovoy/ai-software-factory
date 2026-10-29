const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(timeMs: number): string {
  let value = Math.max(0, Math.floor(timeMs));
  let out = '';
  for (let index = 0; index < 10; index += 1) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (!source) throw new Error('crypto.getRandomValues is required to mint work item ids');
  source.getRandomValues(bytes);
  return bytes;
}

/** A Crockford base32 ULID: 48-bit timestamp + 80-bit randomness. */
export function newUlid(nowMs: number = Date.now(), bytes: Uint8Array = randomBytes(10)): string {
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let random = '';
  for (let index = 0; index < 16; index += 1) {
    random = CROCKFORD[Number(bits & 31n)] + random;
    bits >>= 5n;
  }
  return `${encodeTime(nowMs)}${random}`;
}

/** Stable work item id: `wi_<ulid>` (design decision 1). */
export function newWorkItemId(nowMs: number = Date.now()): string {
  return `wi_${newUlid(nowMs)}`;
}
