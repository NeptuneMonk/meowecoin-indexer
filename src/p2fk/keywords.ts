import { decodeBase58Check, encodeBase58Check } from './base58.ts';

/**
 * Keyword addresses. Sup P2FK/contracts/Root.cs
 * GetPublicAddressByKeyword / GetKeywordByPublicAddress.
 *
 * A keyword is UTF-8, padded or cut to 20 bytes with '#', then base58check
 * with the chain version byte. Dogecoin mainnet uses version byte 30.
 */

export function keywordPayload(keyword: string): Buffer {
  const raw = Buffer.from(keyword, 'utf8');
  const payload = Buffer.alloc(20, 0x23);
  raw.copy(payload, 0, 0, Math.min(20, raw.length));
  return payload;
}

export function publicAddressByKeyword(keyword: string, versionByte: number): string {
  const payload = Buffer.concat([Buffer.from([versionByte & 0xff]), keywordPayload(keyword)]);
  return encodeBase58Check(payload);
}

export function keywordByPublicAddress(address: string): string {
  const payload = decodeBase58Check(address);
  return payload.toString('utf8').replaceAll('#', '').slice(1);
}
