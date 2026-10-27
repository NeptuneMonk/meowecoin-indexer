import { createHash } from 'node:crypto';

/**
 * Base58Check as implemented in Sup P2FK/classes/Base58.cs
 * (CodesInChaos public-domain base58, double-SHA256 checksum).
 * DecodeWithCheckSum in that file does not verify the checksum.
 * We match that: a bad checksum still returns the payload.
 */

const DIGITS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function doubleSha256(data: Buffer): Buffer {
  return sha256(sha256(data));
}

export function encodeBase58(data: Buffer): string {
  let intData = 0n;
  for (const byte of data) intData = intData * 256n + BigInt(byte);
  let result = '';
  while (intData > 0n) {
    const remainder = intData % 58n;
    intData /= 58n;
    result = DIGITS[Number(remainder)] + result;
  }
  for (let i = 0; i < data.length && data[i] === 0; i++) result = '1' + result;
  return result;
}

export function decodeBase58(base58: string): Buffer {
  let intData = 0n;
  for (let i = 0; i < base58.length; i++) {
    const digit = DIGITS.indexOf(base58[i]);
    if (digit < 0) {
      throw new Error(`Invalid Base58 character \`${base58[i]}\` at position ${i}`);
    }
    intData = intData * 58n + BigInt(digit);
  }
  let leadingZeroCount = 0;
  while (leadingZeroCount < base58.length && base58[leadingZeroCount] === '1') leadingZeroCount++;
  const bytes: number[] = [];
  while (intData > 0n) {
    bytes.push(Number(intData % 256n));
    intData /= 256n;
  }
  bytes.reverse();
  while (bytes.length > 0 && bytes[0] === 0) bytes.shift();
  return Buffer.concat([Buffer.alloc(leadingZeroCount), Buffer.from(bytes)]);
}

export function encodeBase58Check(payload: Buffer): string {
  const checksum = doubleSha256(payload).subarray(0, 4);
  return encodeBase58(Buffer.concat([payload, checksum]));
}

/** Version byte + body, checksum stripped. Same shape as Base58.DecodeWithCheckSum. */
export function decodeBase58Check(address: string): Buffer {
  const data = decodeBase58(address);
  if (data.length < 5) throw new Error('Base58Check payload is too short.');
  return data.subarray(0, data.length - 4);
}
