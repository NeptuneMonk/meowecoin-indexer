import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApi, listen } from '../src/api/server.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db/store.ts';
import { syncOnce } from '../src/indexer/scan.ts';
import { buildRootTransaction, encodeFile, encodeMessage } from '../src/p2fk/encode.ts';
import type { ChainTransaction } from '../src/p2fk/types.ts';
import type { BlockInfo, BlockchainRpc } from '../src/rpc/client.ts';

interface FakeBlock {
  hash: string;
  previous?: string;
  time: number;
  height: number;
  txs: ChainTransaction[];
}

class FakeChain implements BlockchainRpc {
  blocks: FakeBlock[] = [];
  verified = 0;

  getBlockCount(): Promise<number> {
    return Promise.resolve(this.blocks.length === 0 ? 0 : Math.max(...this.blocks.map((block) => block.height)));
  }

  async getBlockHash(height: number): Promise<string> {
    const block = this.blocks.find((item) => item.height === height);
    if (!block) throw new Error(`no block ${height}`);
    return block.hash;
  }

  async getBlock(hash: string): Promise<BlockInfo> {
    const block = this.blocks.find((item) => item.hash === hash);
    if (!block) throw new Error(`missing ${hash}`);
    return {
      hash: block.hash,
      previousblockhash: block.previous,
      time: block.time,
      height: block.height,
      tx: block.txs.map((tx) => tx.txid),
    };
  }

  async getRawTransaction(txid: string): Promise<ChainTransaction> {
    for (const block of this.blocks) {
      const tx = block.txs.find((item) => item.txid === txid);
      if (tx) return tx;
    }
    throw new Error(`missing tx ${txid}`);
  }

  verifyMessage(): Promise<boolean> {
    this.verified += 1;
    return Promise.resolve(true);
  }
}

function config(dbPath: string, port: number): Config {
  return {
    rpcUrl: 'http://127.0.0.1:9',
    rpcUser: 'meowe',
    rpcPassword: 'secret',
    startHeight: 100,
    bindHost: '127.0.0.1',
    port,
    corsOrigin: 'https://neptunemonk.github.io',
    dbPath,
    versionByte: 30,
    pollMs: 1000,
    batchBlocks: 20,
  };
}

function payment(txid: string): ChainTransaction {
  return {
    txid,
    size: 100,
    outputs: [{ address: 'DPayment1111111111111111111111111', sats: 100_000_000n }],
  };
}

test('scan loop resumes, serves the API, and drops a reorged root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'meowe-indexer-'));
  const dbPath = join(directory, 'index.sqlite');
  const chain = new FakeChain();
  const obj = Buffer.from(
    JSON.stringify({
      urn: 'forge-hammer',
      nme: 'Hammer',
      dsc: 'strikes the coin',
      cre: ['0'],
      own: { '0': 1 },
      max: 1,
    }),
  );
  const built = buildRootTransaction({
    txid: 'ab'.repeat(32),
    versionByte: 30,
    keywords: ['forge-hammer'],
    body: Buffer.concat([
      encodeFile('SIG', Buffer.from(Array.from({ length: 88 }, (_, index) => (index * 19 + 5) % 250 + 1))),
      encodeFile('OBJ', obj),
      encodeMessage('minted on doge'),
    ]),
  });
  chain.blocks.push({
    hash: 'hash-100',
    previous: 'hash-099',
    time: 1_700_000_000,
    height: 100,
    txs: [payment('10'.repeat(32))],
  });
  chain.blocks.push({
    hash: 'hash-101',
    previous: 'hash-100',
    time: 1_700_000_060,
    height: 101,
    txs: [payment('11'.repeat(32)), built.tx],
  });

  const store = new Store(dbPath, 30);
  const appConfig = config(dbPath, 18_080 + (process.pid % 1000));
  const first = await syncOnce(chain, store, appConfig);
  assert.equal(first.indexedHeight, 101);
  assert.equal(first.rootsFound, 1);
  const object = store.getObject(built.signerAddress);
  assert.equal(object?.name, 'Hammer');
  assert.equal(store.getObjectByUrn('forge-hammer')?.name, 'Hammer');
  assert.equal(store.getProfile(built.signerAddress), null);

  store.close();
  const resumed = new Store(dbPath, 30);
  chain.blocks.push({
    hash: 'hash-102',
    previous: 'hash-101',
    time: 1_700_000_120,
    height: 102,
    txs: [payment('12'.repeat(32))],
  });
  const second = await syncOnce(chain, resumed, appConfig);
  assert.equal(second.indexedHeight, 102);
  assert.equal(second.blocksRead, 1);
  assert.equal(resumed.getObject(built.signerAddress)?.name, 'Hammer');

  const server = createApi(chain, resumed, appConfig);
  await listen(server, appConfig);
  try {
    const health = await fetch(`http://127.0.0.1:${appConfig.port}/health`);
    assert.equal(health.headers.get('access-control-allow-origin'), 'https://neptunemonk.github.io');
    const healthBody = (await health.json()) as { indexedHeight: number; nodeHeight: number; objectCount: number };
    assert.equal(healthBody.indexedHeight, 102);
    assert.equal(healthBody.nodeHeight, 102);
    assert.equal(healthBody.objectCount, 1);

    const byAddress = await fetch(`http://127.0.0.1:${appConfig.port}/GetObjectByAddress/${built.signerAddress}`);
    const body = (await byAddress.json()) as { Name: string; Owners: Record<string, { Item1: number }> };
    assert.equal(body.Name, 'Hammer');
    assert.equal(body.Owners[built.signerAddress]?.Item1, 1);

    const search = await fetch(
      `http://127.0.0.1:${appConfig.port}/GetKnownObjectsBySearchString?searchString=hammer&qty=10&skip=0&blockchain=DOG`,
    );
    const found = (await search.json()) as Array<{ Name: string }>;
    assert.equal(found.length, 1);

    const otherChain = await fetch(
      `http://127.0.0.1:${appConfig.port}/GetKnownObjectsBySearchString?searchString=hammer&blockchain=BTC`,
    );
    assert.deepEqual(await otherChain.json(), []);

    const messages = await fetch(
      `http://127.0.0.1:${appConfig.port}/GetPublicMessagesByAddress/${built.signerAddress}`,
    );
    const messageBody = (await messages.json()) as Array<{ message: string }>;
    assert.equal(messageBody[0]?.message, 'minted on doge');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  chain.blocks = chain.blocks.filter((block) => block.height < 101);
  chain.blocks.push({
    hash: 'hash-101-b',
    previous: 'hash-100',
    time: 1_700_000_061,
    height: 101,
    txs: [payment('13'.repeat(32))],
  });
  const third = await syncOnce(chain, resumed, appConfig);
  assert.equal(third.reorged, true);
  assert.equal(resumed.getObject(built.signerAddress), null);
  assert.equal(resumed.getRoot(built.tx.txid), null);
  resumed.close();
  assert.ok(chain.verified > 0);
});
