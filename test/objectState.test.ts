import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRoot, keywordAt } from '../src/p2fk/decodeRoot.ts';
import { addressForChunk, buildRootTransaction, encodeFile } from '../src/p2fk/encode.ts';
import { replayObject } from '../src/p2fk/objectState.ts';
import { replayProfile } from '../src/p2fk/profileState.ts';
import type { DecodedRoot } from '../src/p2fk/types.ts';

const VERSION = 30;

function signedRoot(options: {
  txid: string;
  body: Buffer;
  keywords?: string[];
  keywordPayloads?: Buffer[];
  signerPayload?: Buffer;
  blockTime: number;
  height: number;
}): { root: DecodedRoot; signer: string } {
  const built = buildRootTransaction({
    txid: options.txid,
    versionByte: VERSION,
    body: options.body,
    keywords: options.keywords,
    keywordPayloads: options.keywordPayloads,
    signerPayload: options.signerPayload,
  });
  const root = decodeRoot(built.tx, {
    versionByte: VERSION,
    blockTime: options.blockTime,
    blockHeight: options.height,
    txIndex: 0,
    confirmations: 1,
    verifyMessage: () => true,
  });
  return { root, signer: built.signerAddress };
}

function command(name: string, json: unknown, seed: number): Buffer {
  const signature = Buffer.alloc(88);
  for (let i = 0; i < signature.length; i += 1) signature[i] = (seed * 17 + i * 13 + 3) % 250 + 1;
  return Buffer.concat([
    encodeFile('SIG', signature),
    encodeFile(name, Buffer.from(JSON.stringify(json))),
  ]);
}

test('mints, gives, lists, and sells a Dogecoin object', () => {
  const friend = Buffer.alloc(20, 0x22);
  const buyer = Buffer.alloc(20, 0x33);
  const royalty = Buffer.alloc(20, 0x44);
  const friendAddress = addressForChunk(friend, VERSION);
  const buyerAddress = addressForChunk(buyer, VERSION);
  const royaltyAddress = addressForChunk(royalty, VERSION);

  const minted = signedRoot({
    txid: '01'.repeat(32),
    blockTime: 1_700_000_000,
    height: 6_400_100,
    body: command(
      'OBJ',
      {
        urn: 'IPFS:bafyforge/medallion.png',
        nme: 'Forge medallion',
        dsc: 'First shop piece',
        atr: { color: 'gold' },
        lic: 'CC0',
        cre: ['0'],
        own: { '0': 2 },
        roy: { '1': 5 },
        max: 2,
      },
      1,
    ),
    keywordPayloads: [royalty],
  });
  const objectAddress = minted.signer;
  assert.equal(keywordAt(minted.root, 0), objectAddress);
  assert.equal(keywordAt(minted.root, 1), royaltyAddress);

  const given = signedRoot({
    txid: '02'.repeat(32),
    blockTime: 1_700_000_100,
    height: 6_400_110,
    signerPayload: minted.root.keywords.at(-1)?.payload,
    body: command('GIV', [[1, 1], [0, -99]], 2),
    keywordPayloads: [friend],
  });

  const listed = signedRoot({
    txid: '03'.repeat(32),
    blockTime: 1_700_000_200,
    height: 6_400_120,
    signerPayload: minted.root.keywords.at(-1)?.payload,
    body: command('LST', [[objectAddress, 1, 1]], 3),
  });

  const boughtBuilt = buildRootTransaction({
    txid: '04'.repeat(32),
    versionByte: VERSION,
    signerPayload: buyer,
    keywordPayloads: [minted.root.keywords.at(-1)?.payload ?? Buffer.alloc(20)],
    body: command('BUY', [[objectAddress, '1'], [0, '-5']], 4),
  });
  for (const output of boughtBuilt.tx.outputs) {
    if (output.address === objectAddress) output.sats = 95_000_000n;
  }
  boughtBuilt.tx.outputs.push({ address: royaltyAddress, sats: 5_000_000n });
  const bought = decodeRoot(boughtBuilt.tx, {
    versionByte: VERSION,
    blockTime: 1_700_000_300,
    blockHeight: 6_400_130,
    txIndex: 0,
    confirmations: 1,
    verifyMessage: () => true,
  });

  const replay = replayObject(objectAddress, [minted.root, given.root, listed.root, bought]);
  assert.equal(replay.state.name, 'Forge medallion');
  assert.equal(replay.state.urn, 'IPFS:bafyforge/medallion.png');
  assert.equal(replay.state.license, 'CC0');
  assert.equal(replay.state.maximum, 2);
  assert.equal(replay.state.attributes?.color, 'gold');
  assert.equal(replay.state.royalties[royaltyAddress], 5);
  assert.equal(replay.state.owners[friendAddress]?.qty, 1);
  assert.equal(replay.state.owners[buyerAddress]?.qty, 1);
  assert.equal(replay.state.owners[objectAddress], undefined);
  assert.ok(replay.state.lockedDate);
  assert.equal(replay.transfers.map((transfer) => transfer.action).join(','), 'claim,give,buy');
});

test('a license-only update keeps the maximum', () => {
  const minted = signedRoot({
    txid: '05'.repeat(32),
    blockTime: 1_700_000_000,
    height: 10,
    body: command('OBJ', { urn: 'shop-piece', nme: 'Plate', cre: ['0'], own: { '0': 1 }, max: 4 }, 5),
  });
  const updated = signedRoot({
    txid: '06'.repeat(32),
    blockTime: 1_700_000_050,
    height: 11,
    signerPayload: minted.root.keywords.at(-1)?.payload,
    body: command('OBJ', { lic: 'CC0' }, 6),
  });
  const replay = replayObject(minted.signer, [minted.root, updated.root]);
  assert.equal(replay.state.license, 'CC0');
  assert.equal(replay.state.maximum, 4);
  assert.equal(replay.state.name, 'Plate');
});

test('burns the last unit and blocks the object', () => {
  const minted = signedRoot({
    txid: '07'.repeat(32),
    blockTime: 1_700_000_000,
    height: 20,
    body: command('OBJ', { urn: 'burn-me', nme: 'Ash', cre: ['0'], own: { '0': 1 }, max: 1 }, 7),
  });
  const burned = signedRoot({
    txid: '08'.repeat(32),
    blockTime: 1_700_000_080,
    height: 21,
    signerPayload: minted.root.keywords.at(-1)?.payload,
    body: command('BRN', [[0, 1]], 8),
  });
  const replay = replayObject(minted.signer, [minted.root, burned.root]);
  assert.equal(replay.state.blocked, true);
  assert.equal(replay.state.urn, null);
  assert.equal(replay.transfers.at(-1)?.action, 'burn');
});

test('reads a profile, including the private-message public key', () => {
  const profile = signedRoot({
    txid: '09'.repeat(32),
    blockTime: 1_700_000_000,
    height: 30,
    keywords: ['neptune'],
    body: command(
      'PRO',
      {
        urn: 'neptune',
        dnm: 'Neptune',
        bio: 'keeps the forge',
        pkx: 'aa',
        pky: 'bb',
        cre: ['0'],
      },
      9,
    ),
  });
  const state = replayProfile(profile.signer, [profile.root]);
  assert.equal(state.urn, 'neptune');
  assert.equal(state.displayName, 'Neptune');
  assert.equal(state.bio, 'keeps the forge');
  assert.equal(state.pkx, 'aa');
  assert.equal(state.pky, 'bb');
  assert.deepEqual(state.creators, [profile.signer]);
});
