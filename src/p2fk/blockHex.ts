import { createHash } from 'node:crypto';
import { encodeBase58Check, sha256 } from './base58.ts';
import type { ChainTransaction } from './types.ts';

/**
 * Read transactions out of a Dogecoin Core 1.14 block hex.
 *
 * Core 1.14's getblock is boolean verbose: true returns transaction ids only,
 * false returns this hex. There is no verbosity level that includes outputs.
 * Asking for every transaction with getrawtransaction would be one RPC per
 * transaction across millions of blocks. Parsing the hex locally keeps the
 * output order Sup needs and skips the extra calls.
 *
 * Addresses match Core's scriptPubKey.addresses for the scripts Sup actually
 * spends to: pay-to-pubkey-hash, pay-to-script-hash, pay-to-pubkey, and the
 * first key of a standard multisig. Any other script has an empty address.
 * decodeRoot already drops a transaction that contains an empty address.
 */

export interface ParsedBlock {
  previousHash: string;
  time: number;
  txs: ChainTransaction[];
}

export function scriptVersionFor(pubkeyVersion: number): number {
  if (pubkeyVersion === 30) return 22;
  if (pubkeyVersion === 0) return 5;
  if (pubkeyVersion === 48) return 50;
  return pubkeyVersion;
}

function hash160(data: Buffer): Buffer {
  return createHash('ripemd160').update(sha256(data)).digest();
}

function txidOf(raw: Buffer): string {
  return Buffer.from(sha256(sha256(raw))).reverse().toString('hex');
}

function readU32(bytes: Buffer, offset: number): number {
  return bytes.readUInt32LE(offset);
}

function readU64(bytes: Buffer, offset: number): bigint {
  return bytes.readBigUInt64LE(offset);
}

function readCompact(bytes: Buffer, offset: number): { value: number; offset: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error('Block ended during a compact size.');
  if (first < 253) return { value: first, offset: offset + 1 };
  if (first === 253) return { value: bytes.readUInt16LE(offset + 1), offset: offset + 3 };
  if (first === 254) return { value: bytes.readUInt32LE(offset + 1), offset: offset + 5 };
  const wide = bytes.readBigUInt64LE(offset + 1);
  if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Compact size is too large.');
  return { value: Number(wide), offset: offset + 9 };
}

function pushData(script: Buffer, offset: number): { data: Buffer; offset: number } | null {
  const opcode = script[offset];
  if (opcode === undefined || opcode === 0 || opcode > 78) return null;
  let length = opcode;
  let next = offset + 1;
  if (opcode === 76) {
    length = script[next] ?? -1;
    next += 1;
  } else if (opcode === 77) {
    if (next + 2 > script.length) return null;
    length = script.readUInt16LE(next);
    next += 2;
  } else if (opcode === 78) {
    if (next + 4 > script.length) return null;
    length = script.readUInt32LE(next);
    next += 4;
  }
  if (length < 0 || next + length > script.length) return null;
  return { data: script.subarray(next, next + length), offset: next + length };
}

function addressForHash(hash: Buffer, version: number): string {
  return encodeBase58Check(Buffer.concat([Buffer.from([version & 0xff]), hash]));
}

export function addressFromScript(script: Buffer, pubkeyVersion: number, scriptVersion: number): string {
  if (
    script.length === 25 &&
    script[0] === 0x76 &&
    script[1] === 0xa9 &&
    script[2] === 0x14 &&
    script[23] === 0x88 &&
    script[24] === 0xac
  ) {
    return addressForHash(script.subarray(3, 23), pubkeyVersion);
  }
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return addressForHash(script.subarray(2, 22), scriptVersion);
  }
  if ((script.length === 35 && script[0] === 33 && script[34] === 0xac) || (script.length === 67 && script[0] === 65 && script[66] === 0xac)) {
    return addressForHash(hash160(script.subarray(1, script.length - 1)), pubkeyVersion);
  }
  if (script.length >= 37 && script[0] >= 0x51 && script[0] <= 0x60 && script[script.length - 1] === 0xae) {
    const pushed = pushData(script, 1);
    if (pushed && (pushed.data.length === 33 || pushed.data.length === 65)) {
      return addressForHash(hash160(pushed.data), pubkeyVersion);
    }
  }
  return '';
}

function readTransaction(bytes: Buffer, offset: number, pubkeyVersion: number, scriptVersion: number): { tx: ChainTransaction; offset: number } {
  const start = offset;
  if (offset + 4 > bytes.length) throw new Error('Transaction version is missing.');
  offset += 4;
  const inputs = readCompact(bytes, offset);
  offset = inputs.offset;
  for (let i = 0; i < inputs.value; i += 1) {
    if (offset + 36 > bytes.length) throw new Error('Transaction input is truncated.');
    offset += 36;
    const script = readCompact(bytes, offset);
    offset = script.offset + script.value;
    if (offset + 4 > bytes.length) throw new Error('Transaction input sequence is truncated.');
    offset += 4;
  }
  const outputs = readCompact(bytes, offset);
  offset = outputs.offset;
  const parsedOutputs: ChainTransaction['outputs'] = [];
  for (let i = 0; i < outputs.value; i += 1) {
    if (offset + 8 > bytes.length) throw new Error('Transaction output value is truncated.');
    const sats = readU64(bytes, offset);
    offset += 8;
    const script = readCompact(bytes, offset);
    offset = script.offset;
    if (offset + script.value > bytes.length) throw new Error('Transaction output script is truncated.');
    const scriptBytes = bytes.subarray(offset, offset + script.value);
    offset += script.value;
    parsedOutputs.push({
      address: addressFromScript(scriptBytes, pubkeyVersion, scriptVersion),
      sats,
    });
  }
  if (offset + 4 > bytes.length) throw new Error('Transaction locktime is truncated.');
  offset += 4;
  const raw = bytes.subarray(start, offset);
  return { tx: { txid: txidOf(raw), size: raw.length, outputs: parsedOutputs }, offset };
}

export function parseBlockHex(hex: string, pubkeyVersion: number): ParsedBlock {
  if (hex.length % 2 !== 0) throw new Error('Block hex has an odd length.');
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < 80) throw new Error('Block header is too short.');
  const previousHash = Buffer.from(bytes.subarray(4, 36)).reverse().toString('hex');
  const time = readU32(bytes, 68);
  const count = readCompact(bytes, 80);
  if (count.value > 100_000) throw new Error('Block transaction count is not plausible.');
  let offset = count.offset;
  const scriptVersion = scriptVersionFor(pubkeyVersion);
  const txs: ChainTransaction[] = [];
  for (let i = 0; i < count.value; i += 1) {
    const read = readTransaction(bytes, offset, pubkeyVersion, scriptVersion);
    txs.push(read.tx);
    offset = read.offset;
  }
  return { previousHash, time, txs };
}

function writeCompact(value: number): Buffer {
  if (value < 253) return Buffer.from([value]);
  if (value <= 0xffff) {
    const out = Buffer.alloc(3);
    out[0] = 253;
    out.writeUInt16LE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = 254;
  out.writeUInt32LE(value, 1);
  return out;
}

function p2pkhScript(hash: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);
}

/** Build a block hex the parser understands. Tests use this. It does not create a valid proof of work. */
export function serializeBlockHex(options: {
  previousHash: string;
  time: number;
  nonce: number;
  pubkeyVersion: number;
  outputs: Array<Array<{ hash160: Buffer; sats: bigint }>>;
}): { hex: string; hash: string } {
  const header = Buffer.alloc(80);
  header.writeUInt32LE(1, 0);
  Buffer.from(options.previousHash, 'hex').reverse().copy(header, 4);
  header.writeUInt32LE(options.time, 68);
  header.writeUInt32LE(options.nonce, 76);
  const txs: Buffer[] = [];
  options.outputs.forEach((txOutputs, index) => {
    const parts: Buffer[] = [Buffer.alloc(4)];
    parts[0].writeUInt32LE(1, 0);
    parts.push(writeCompact(1));
    parts.push(Buffer.alloc(32));
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(0xffffffff, 0);
    parts.push(vout);
    const inputScript = Buffer.from([index & 0xff]);
    parts.push(writeCompact(inputScript.length), inputScript);
    const sequence = Buffer.alloc(4, 0xff);
    parts.push(sequence);
    parts.push(writeCompact(txOutputs.length));
    for (const output of txOutputs) {
      const value = Buffer.alloc(8);
      value.writeBigUInt64LE(output.sats, 0);
      const script = p2pkhScript(output.hash160);
      parts.push(value, writeCompact(script.length), script);
    }
    const locktime = Buffer.alloc(4);
    parts.push(locktime);
    txs.push(Buffer.concat(parts));
  });
  const body = Buffer.concat([header, writeCompact(txs.length), ...txs]);
  const hash = txidOf(header);
  return { hex: body.toString('hex'), hash };
}
