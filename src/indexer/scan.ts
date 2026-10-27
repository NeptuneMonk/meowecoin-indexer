import type { Config } from '../config.ts';
import type { Store } from '../db/store.ts';
import { decodeRoot } from '../p2fk/decodeRoot.ts';
import type { ChainTransaction, DecodedRoot } from '../p2fk/types.ts';
import type { BlockchainRpc } from '../rpc/client.ts';

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
    const roots: DecodedRoot[] = [];
    for (let txIndex = 0; txIndex < block.tx.length; txIndex += 1) {
      const txid = block.tx[txIndex];
      if (!txid) continue;
      const tx = await rpc.getRawTransaction(txid);
      const root = await decodeTransaction(rpc, tx, config, block.time, height, txIndex, tip);
      if (root) roots.push(root);
    }
    store.saveBlock(height, block.hash, block.previousblockhash ?? null, block.time, roots);
    blocksRead += 1;
    rootsFound += roots.length;
  }
  return {
    tip,
    indexedHeight: store.indexedHeight(),
    blocksRead,
    rootsFound,
    reorged,
    waiting: false,
  };
}
