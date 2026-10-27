import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import { isPayloadSats } from '../p2fk/amounts.ts';
import { parseBlockHex } from '../p2fk/blockHex.ts';
import { decodeRoot } from '../p2fk/decodeRoot.ts';
import type { ChainTransaction, DecodedRoot } from '../p2fk/types.ts';
import { noteBatch } from './progress.ts';
import type { BlockchainRpc } from '../rpc/client.ts';

/** How many raw blocks to pull in one HTTP call. Keeps a multi-megabyte response off the wire. */
const HEX_CHUNK = 8;

export interface SyncReport {
  tip: number;
  indexedHeight: number | null;
  blocksRead: number;
  rootsFound: number;
  reorged: boolean;
  waiting: boolean;
}

const TXID = /\b[0-9a-f]{64}\b/g;

async function commonHeight(rpc: BlockchainRpc, store: Store, floor: number, from: number): Promise<number> {
  let height = from;
  let walked = 0;
  while (height >= floor && walked < 500) {
    const saved = store.getBlock(height);
    if (!saved) return height - 1;
    try {
      const hash = await rpc.getBlockHash(height);
      if (hash === saved.hash) return height;
    } catch {
      /* The node has no block at this height. Keep walking back. */
    }
    height -= 1;
    walked += 1;
  }
  return Math.max(floor - 1, height);
}

function referencedTxids(root: DecodedRoot): string[] {
  const ids = new Set<string>();
  for (const name of root.fileOrder) {
    if (/^[0-9a-f]{64}$/.test(name)) ids.add(name);
    const text = root.files[name]?.toString('utf8') ?? '';
    for (const match of text.matchAll(TXID)) ids.add(match[0]);
  }
  return [...ids];
}

async function decodeTransaction(
  rpc: BlockchainRpc,
  tx: ChainTransaction,
  config: Config,
  blockTime: number,
  blockHeight: number,
  txIndex: number,
  tip: number,
): Promise<DecodedRoot | null> {
  const ctx = {
    versionByte: config.versionByte,
    blockTime,
    blockHeight,
    txIndex,
    confirmations: Math.max(1, tip - blockHeight + 1),
  };
  let root = decodeRoot(tx, ctx);
  const ids = referencedTxids(root);
  if (ids.length > 0) {
    const loaded = new Map<string, ChainTransaction>();
    for (const id of ids) {
      if (id === tx.txid) continue;
      try {
        loaded.set(id, await rpc.getRawTransaction(id));
      } catch {
        /* Sup leaves the root unresolved when the ledger transaction cannot be read. */
      }
    }
    if (loaded.size > 0) {
      root = decodeRoot(tx, {
        ...ctx,
        loadTransaction: (id) => loaded.get(id) ?? null,
      });
    }
  }
  if (!root.isP2fk) return null;
  if (root.signedBy && root.signature && root.hash) {
    root.signed = await rpc.verifyMessage(root.signedBy, root.signature, root.hash);
  }
  return root;
}

function mightBeRoot(tx: ChainTransaction): boolean {
  const seen = new Set<string>();
  let dust = false;
  for (const output of tx.outputs) {
    if (!output.address) return false;
    if (seen.has(output.address)) return false;
    seen.add(output.address);
    if (isPayloadSats(output.sats)) dust = true;
  }
  return dust;
}

function hasHexPath(rpc: BlockchainRpc): rpc is BlockchainRpc & {
  getBlockHashBatch: (heights: number[]) => Promise<string[]>;
  getBlockHexBatch: (hashes: string[]) => Promise<string[]>;
} {
  return typeof rpc.getBlockHashBatch === 'function' && typeof rpc.getBlockHexBatch === 'function';
}

async function readRoots(
  rpc: BlockchainRpc,
  txs: ChainTransaction[],
  config: Config,
  blockTime: number,
  blockHeight: number,
  tip: number,
): Promise<DecodedRoot[]> {
  const roots: DecodedRoot[] = [];
  for (let txIndex = 0; txIndex < txs.length; txIndex += 1) {
    const tx = txs[txIndex];
    if (!tx || !mightBeRoot(tx)) continue;
    const root = await decodeTransaction(rpc, tx, config, blockTime, blockHeight, txIndex, tip);
    if (root) roots.push(root);
  }
  return roots;
}

async function syncHex(
  rpc: BlockchainRpc & {
    getBlockHashBatch: (heights: number[]) => Promise<string[]>;
    getBlockHexBatch: (hashes: string[]) => Promise<string[]>;
  },
  store: Store,
  config: Config,
  tip: number,
  cursor: number,
  end: number,
  reorged: boolean,
): Promise<SyncReport> {
  const heights: number[] = [];
  for (let height = cursor + 1; height <= end; height += 1) heights.push(height);
  const hashes = await rpc.getBlockHashBatch(heights);
  let blocksRead = 0;
  let rootsFound = 0;
  let previousHash = cursor >= config.startHeight ? (store.getBlock(cursor)?.hash ?? null) : null;

  for (let offset = 0; offset < heights.length; offset += HEX_CHUNK) {
    const started = Date.now();
    const sliceHeights = heights.slice(offset, offset + HEX_CHUNK);
    const sliceHashes = hashes.slice(offset, offset + HEX_CHUNK);
    const hexes = await rpc.getBlockHexBatch(sliceHashes);
    const saving: Array<{ height: number; hash: string; prevHash: string | null; time: number; roots: DecodedRoot[] }> = [];
    for (let index = 0; index < sliceHeights.length; index += 1) {
      const height = sliceHeights[index] ?? 0;
      const hash = sliceHashes[index] ?? '';
      let parsed;
      try {
        parsed = parseBlockHex(hexes[index] ?? '', config.versionByte);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unreadable block';
        throw new Error(`Could not read block ${height}. ${message}`);
      }
      if (height > config.startHeight && previousHash && parsed.previousHash !== previousHash) {
        if (saving.length > 0) store.saveBlocks(saving);
        const matched = await commonHeight(rpc, store, config.startHeight, height - 1);
        store.rewindTo(matched);
        noteBatch(saving.length, Date.now() - started);
        return {
          tip,
          indexedHeight: store.indexedHeight(),
          blocksRead: blocksRead + saving.length,
          rootsFound,
          reorged: true,
          waiting: false,
        };
      }
      const roots = await readRoots(rpc, parsed.txs, config, parsed.time, height, tip);
      saving.push({ height, hash, prevHash: parsed.previousHash, time: parsed.time, roots });
      rootsFound += roots.length;
      previousHash = hash;
    }
    store.saveBlocks(saving);
    blocksRead += saving.length;
    noteBatch(saving.length, Date.now() - started);
  }

  return { tip, indexedHeight: store.indexedHeight(), blocksRead, rootsFound, reorged, waiting: false };
}

export async function syncOnce(rpc: BlockchainRpc, store: Store, config: Config, maxBlocks = config.batchBlocks): Promise<SyncReport> {
  const tip = await rpc.getBlockCount();
  let indexed = store.indexedHeight();
  let reorged = false;
  if (indexed !== null && indexed > tip) {
    store.rewindTo(tip);
    indexed = store.indexedHeight();
    reorged = true;
  }
  if (indexed !== null && indexed >= config.startHeight) {
    const matched = await commonHeight(rpc, store, config.startHeight, indexed);
    if (matched < indexed) {
      store.rewindTo(matched);
      indexed = store.indexedHeight();
      reorged = true;
    }
  }
  const cursor = indexed === null ? config.startHeight - 1 : indexed;
  if (tip < config.startHeight) {
    return { tip, indexedHeight: indexed, blocksRead: 0, rootsFound: 0, reorged, waiting: true };
  }
  const end = Math.min(tip, cursor + maxBlocks);
  if (hasHexPath(rpc)) return syncHex(rpc, store, config, tip, cursor, end, reorged);
  const started = Date.now();
  let blocksRead = 0;
  let rootsFound = 0;
  for (let height = cursor + 1; height <= end; height += 1) {
    const hash = await rpc.getBlockHash(height);
    const block = await rpc.getBlock(hash);
    if (height > config.startHeight) {
      const previous = store.getBlock(height - 1);
      if (previous && block.previousblockhash && previous.hash !== block.previousblockhash) {
        const matched = await commonHeight(rpc, store, config.startHeight, height - 1);
        store.rewindTo(matched);
        noteBatch(blocksRead, Date.now() - started);
        return {
          tip,
          indexedHeight: store.indexedHeight(),
          blocksRead,
          rootsFound,
          reorged: true,
          waiting: false,
        };
      }
    }
    const txs: ChainTransaction[] = [];
    for (const txid of block.tx) {
      if (!txid) continue;
      txs.push(await rpc.getRawTransaction(txid));
    }
    const roots = await readRoots(rpc, txs, config, block.time, height, tip);
    store.saveBlock(height, block.hash, block.previousblockhash ?? null, block.time, roots);
    blocksRead += 1;
    rootsFound += roots.length;
  }
  noteBatch(blocksRead, Date.now() - started);
  return {
    tip,
    indexedHeight: store.indexedHeight(),
    blocksRead,
    rootsFound,
    reorged,
    waiting: false,
  };
}
