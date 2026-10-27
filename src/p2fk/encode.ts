import { encodeBase58Check } from './base58.ts';
import { STANDARD_DUST_SATS } from './amounts.ts';
import { keywordPayload } from './keywords.ts';
import type { ChainOutput, ChainTransaction } from './types.ts';

/**
 * Build the payload bytes Sup writes before it splits them into addresses.
 * P2FK/contracts/Root.cs GetRootBytesByFile, and the SIG prefix in ObjectMint.cs:
 *   NAME + separator + decimal size + separator + bytes
 */

export function encodeFile(name: string, bytes: Buffer, separator = '*'): Buffer {
  return Buffer.concat([
    Buffer.from(name, 'ascii'),
    Buffer.from(separator, 'ascii'),
    Buffer.from(String(bytes.length), 'ascii'),
    Buffer.from(separator, 'ascii'),
    bytes,
  ]);
}

export function encodeMessage(text: string, separator = '*'): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([
    Buffer.from(separator, 'ascii'),
    Buffer.from(String(bytes.length), 'ascii'),
    Buffer.from(separator, 'ascii'),
    bytes,
  ]);
}

/** Split payload into 20-byte chunks, padding the last chunk with '#'. DiscoBall.cs. */
export function chunkPayload(payload: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < payload.length; i += 20) {
    const chunk = Buffer.alloc(20, 0x23);
    payload.copy(chunk, 0, i, Math.min(payload.length, i + 20));
    chunks.push(chunk);
  }
  return chunks;
}

export function addressForChunk(chunk: Buffer, versionByte: number): string {
  if (chunk.length !== 20) throw new Error('P2FK chunk must be 20 bytes.');
  return encodeBase58Check(Buffer.concat([Buffer.from([versionByte & 0xff]), chunk]));
}

export interface BuiltRoot {
  tx: ChainTransaction;
  signerAddress: string;
  signerPayload: Buffer;
}

/**
 * A transaction whose dust outputs are the P2FK payload, signature address last.
 * This does not sign or broadcast. Tests and the mock node use it.
 */
export function buildRootTransaction(options: {
  txid?: string;
  versionByte: number;
  body: Buffer;
  keywords?: string[];
  /** Extra 20-byte keyword payloads (already padded). */
  keywordPayloads?: Buffer[];
  signerPayload?: Buffer;
  size?: number;
}): BuiltRoot {
  const signerPayload = options.signerPayload ?? Buffer.alloc(20, 0x11);
  const chunks = [
    ...chunkPayload(options.body),
    ...(options.keywords ?? []).map((keyword) => keywordPayload(keyword)),
    ...(options.keywordPayloads ?? []),
    signerPayload,
  ];
  const outputs: ChainOutput[] = chunks.map((chunk) => ({
    address: addressForChunk(chunk, options.versionByte),
    sats: STANDARD_DUST_SATS,
  }));
  const unique = new Set(outputs.map((output) => output.address));
  if (unique.size !== outputs.length) {
    throw new Error(
      'P2FK payload repeats a 20-byte chunk. Sup cannot pay the same address twice in one transaction.',
    );
  }
  const signerAddress = outputs[outputs.length - 1]?.address ?? '';
  return {
    signerAddress,
    signerPayload,
    tx: {
      txid: options.txid ?? '11'.repeat(32),
      size: options.size ?? 200 + options.body.length,
      outputs,
    },
  };
}
