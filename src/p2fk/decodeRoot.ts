import { decodeBase58Check, encodeBase58Check, sha256 } from './base58.ts';
import { isPayloadAmount, outputValueString } from './amounts.ts';
import type { ChainTransaction, DecodeContext, DecodedRoot, KeywordEntry } from './types.ts';

/**
 * Decode one P2FK root from a transaction's outputs.
 *
 * Follows Sup P2FK/contracts/Root.cs GetRootByTransactionId and
 * GetRootBytesByFile / GetRootBytesByLedger:
 *
 * - Outputs are read in order. Only amounts in the dust set contribute bytes.
 * - Each of those addresses is base58check-decoded. The version byte is
 *   dropped and the next 20 bytes are appended.
 * - The last dust address is the signature address (SignedBy).
 * - The byte string is a sequence of NAME, separator, size, separator, bytes.
 *   Separators are one of \ / : * ? " < > |
 * - A leading separator with an empty name is a message.
 * - SIG is the Bitcoin/Dogecoin signed-message signature. The hash is one
 *   SHA-256 of the bytes after that SIG packet, through the last file or
 *   message. Sup then calls the node's verifymessage.
 * - Bytes left over are keywords, realigned to 20-byte groups. Each group
 *   is prefixed with the chain version byte and base58check-encoded.
 *   Keyword index 0 in Sup is the last group (Keyword.Reverse()).
 *
 * An output with no address aborts the decode. That is what the C# does
 * when scriptPubKey.addresses is missing: the exception skips parsing.
 * A repeated address does the same, because Dictionary.Add throws.
 */

const SPECIAL = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
const PACKET = /([\\/:*?"<>|])\d+/;
const TXID = /\b[0-9a-f]{64}\b/;
const CHAIN_NAMES = 'BTC,LTC,DOG,MZC,IPFS';
const RESERVED_WINDOWS = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function emptyRoot(txid: string, ctx: DecodeContext, size = 0): DecodedRoot {
  return {
    isP2fk: false,
    message: [],
    fileOrder: [],
    files: {},
    keywords: [],
    outputs: [],
    hash: '',
    signedBy: '',
    signature: '',
    signed: false,
    transactionId: txid,
    blockTime: ctx.blockTime,
    blockHeight: ctx.blockHeight,
    txIndex: ctx.txIndex,
    totalByteSize: size,
    confirmations: ctx.confirmations,
    ledger: false,
  };
}

function toAscii(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) out += byte < 128 ? String.fromCharCode(byte) : '?';
  return out;
}

function firstSpecial(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (SPECIAL.has(text[i])) return i;
  }
  return -1;
}

function validFileName(name: string): boolean {
  const ok =
    (name.length > 2 && name.includes('.')) ||
    (name.length === 3 && !CHAIN_NAMES.includes(name)) ||
    (!name.includes('.') && name.length === 64);
  if (!ok) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (RESERVED_WINDOWS.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  return true;
}

function payloadBytes(tx: ChainTransaction): { bytes: Buffer; signedBy: string; outputs: DecodedRoot['outputs'] } | null {
  const chunks: Buffer[] = [];
  const outputs: DecodedRoot['outputs'] = [];
  const seen = new Set<string>();
  let signedBy = '';
  for (const output of tx.outputs) {
    if (!output.address) return null;
    if (seen.has(output.address)) return null;
    seen.add(output.address);
    const value = outputValueString(output.sats);
    outputs.push({ address: output.address, value });
    if (!isPayloadAmount(output.sats)) continue;
    let decoded: Buffer;
    try {
      decoded = decodeBase58Check(output.address);
    } catch {
      return null;
    }
    if (decoded.length < 21) return null;
    signedBy = output.address;
    chunks.push(decoded.subarray(1, 21));
  }
  return { bytes: Buffer.concat(chunks), signedBy, outputs };
}

interface ParsedBody {
  message: string[];
  fileOrder: string[];
  files: Record<string, Buffer>;
  hash: string;
  signature: string;
  signedBy: string;
  keywords: KeywordEntry[];
}

function parseBody(bytes: Buffer, versionByte: number, signedBy: string): ParsedBody {
  let ascii = toAscii(bytes);
  let offset = 0;
  let sigStart = 0;
  let sigEnd = 0;
  const message: string[] = [];
  const fileOrder: string[] = [];
  const files: Record<string, Buffer> = {};
  let signature = '';

  while (PACKET.test(ascii)) {
    const match = PACKET.exec(ascii);
    if (!match || match.index === undefined) break;
    const packetSize = Number.parseInt(match[0].slice(1), 10);
    if (!Number.isFinite(packetSize) || packetSize < 0) break;
    const headerSize = match.index + match[0].length + 1;
    if (firstSpecial(ascii) !== match.index) break;
    if (offset + headerSize + packetSize > bytes.length) break;

    const fileName = ascii.slice(0, match.index);
    const fileBytes = bytes.subarray(offset + headerSize, offset + headerSize + packetSize);
    const consume = headerSize + packetSize;

    if (validFileName(fileName)) {
      sigEnd += consume;
      if (fileName === 'SIG') {
        sigStart = sigEnd;
        signature = ascii.slice(headerSize, headerSize + packetSize);
      }
      if (!Object.hasOwn(files, fileName)) fileOrder.push(fileName);
      files[fileName] = fileBytes;
    } else if (fileName === '' && fileBytes.length > 1) {
      sigEnd += consume;
      message.push(fileBytes.toString('utf8'));
    } else {
      break;
    }

    ascii = ascii.slice(consume);
    offset += consume;
  }

  const keywords: KeywordEntry[] = [];
  if (fileOrder.length + message.length > 0) {
    let rest = ascii;
    let keywordOffset = offset;
    if (rest.length > 20) {
      const remainder = rest.length % 20;
      rest = rest.slice(remainder);
      keywordOffset += remainder;
    }
    const version = Buffer.from([versionByte & 0xff]);
    for (let i = 0; i + 20 <= rest.length; i += 20) {
      const chunk = bytes.subarray(keywordOffset + i, keywordOffset + i + 20);
      const withVersion = Buffer.concat([version, chunk]);
      try {
        keywords.push({
          address: encodeBase58Check(withVersion),
          text: withVersion.toString('utf8'),
          payload: Buffer.from(chunk),
        });
      } catch {
        /* Sup swallows a bad keyword and continues. */
      }
    }
  }

  let hash = '';
  let signer = signedBy;
  if (sigStart > 0) {
    hash = sha256(bytes.subarray(sigStart, sigEnd)).toString('hex').toUpperCase();
  } else {
    signer = '';
  }

  return { message, fileOrder, files, hash, signature, signedBy: signer, keywords };
}

function ledgerPayload(fileName: string, fileBytes: Buffer, load: (txid: string) => ChainTransaction | null): Buffer | null {
  let text = fileName + '\n' + fileBytes.toString('ascii');
  if (fileBytes.subarray(0, fileName.length).toString('ascii') === fileName) {
    text = fileName + '\n' + fileBytes.subarray(fileName.length).toString('ascii');
  }
  const ids = text.match(new RegExp(TXID, 'g')) ?? [];
  const chunks: Buffer[] = [];
  for (const id of ids) {
    const tx = load(id);
    if (!tx) return null;
    const payload = payloadBytes(tx);
    if (!payload) return null;
    chunks.push(payload.bytes);
  }
  return Buffer.concat(chunks);
}

export function decodeRoot(tx: ChainTransaction, ctx: DecodeContext, depth = 0): DecodedRoot {
  const root = emptyRoot(tx.txid, ctx, tx.size);
  const payload = payloadBytes(tx);
  if (!payload) return root;
  root.outputs = payload.outputs;

  let bytes = payload.bytes;
  let signedBy = payload.signedBy;
  if (bytes.length === 0 || !signedBy) return root;

  let parsed = parseBody(bytes, ctx.versionByte, signedBy);
  // Sup replaces the root when a file name is a 64-hex transaction id.
  // Root.cs GetRootByTransactionId, the regexTransactionId loop.
  const ledgerName = parsed.fileOrder.find((name) => /^[0-9a-f]{64}$/.test(name));
  if (ledgerName && ctx.loadTransaction && depth < 4) {
    const ledgerBytes = ledgerPayload(ledgerName, parsed.files[ledgerName] ?? Buffer.alloc(0), ctx.loadTransaction);
    if (ledgerBytes && ledgerBytes.length > 0) {
      root.ledger = true;
      parsed = parseBody(ledgerBytes, ctx.versionByte, signedBy);
    }
  }

  if (parsed.fileOrder.length + parsed.message.length === 0) return root;

  root.isP2fk = true;
  root.message = parsed.message;
  root.fileOrder = parsed.fileOrder;
  root.files = parsed.files;
  root.keywords = parsed.keywords;
  root.hash = parsed.hash;
  root.signature = parsed.signature;
  root.signedBy = parsed.signedBy;
  if (root.signedBy && root.signature && root.hash && ctx.verifyMessage) {
    try {
      root.signed = ctx.verifyMessage(root.signedBy, root.signature, root.hash);
    } catch {
      root.signed = false;
    }
  }
  return root;
}

/** Second file in insertion order. OBJ.cs switches on File.ElementAtOrDefault(1). */
export function commandFile(root: DecodedRoot): string | null {
  return root.fileOrder[1] ?? null;
}

export function fileSizes(root: DecodedRoot): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const name of root.fileOrder) sizes[name] = root.files[name]?.length ?? 0;
  return sizes;
}

/** Keyword index 0 is the last keyword, matching Dictionary.Reverse(). */
export function keywordAt(root: DecodedRoot, index: number): string | null {
  if (index < 0 || index >= root.keywords.length) return null;
  return root.keywords[root.keywords.length - 1 - index]?.address ?? null;
}
