import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeBase58Check } from '../src/p2fk/base58.ts';
import { decodeRoot } from '../src/p2fk/decodeRoot.ts';
import { buildRootTransaction, encodeFile, encodeMessage } from '../src/p2fk/encode.ts';
import { keywordByPublicAddress, publicAddressByKeyword } from '../src/p2fk/keywords.ts';
import type { ChainTransaction } from '../src/p2fk/types.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/space-tree-water.json', import.meta.url), 'utf8')) as {
  txid: string;
  size: number;
  blockTime: number;
  blockHeight: number;
  signedBy: string;
  signature: string;
  hash: string;
  keywords: string[];
  outputs: Array<[string, number]>;
};

function spaceTree(): ChainTransaction {
  return {
    txid: fixture.txid,
    size: fixture.size,
    outputs: fixture.outputs.map(([address, sats]) => ({ address, sats: BigInt(sats) })),
  };
}

test('decodes the Bitcoin space tree water root the way p2fk.io does', () => {
  const root = decodeRoot(spaceTree(), {
    versionByte: 0,
    blockTime: fixture.blockTime,
    blockHeight: fixture.blockHeight,
    txIndex: 0,
    confirmations: 10,
  });
  assert.equal(root.isP2fk, true);
  assert.equal(root.signedBy, fixture.signedBy);
  assert.equal(root.signature, fixture.signature);
  assert.equal(root.hash, fixture.hash);
  assert.deepEqual(root.fileOrder, ['SIG', 'OBJ']);
  assert.equal(root.files.SIG?.length, 88);
  assert.equal(root.files.OBJ?.length, 296);
  assert.deepEqual(
    root.keywords.map((keyword) => keyword.address),
    fixture.keywords,
  );
  const obj = JSON.parse(root.files.OBJ?.toString('utf8') ?? '{}') as { nme?: string };
  assert.equal(obj.nme, 'space tree water');
  assert.equal(root.outputs[1]?.value, '0.01952618');
  assert.equal(root.outputs[0]?.value, '0.00000546');
  assert.equal(root.message.length, 0);
});

test('keyword addresses round-trip the Sup padding rules', () => {
  assert.equal(publicAddressByKeyword('embii', 0), '1AFJHYBkdzXbFiHgPSRquYB6P2DdbdnrYB');
  assert.equal(publicAddressByKeyword('a351d89c07c917fc2918', 0), '19rwtb34uDHiGNYrriqRxVrR7r4kXoMqo7');
  assert.equal(keywordByPublicAddress('1AFJHYBkdzXbFiHgPSRquYB6P2DdbdnrYB'), 'embii');
  const doge = publicAddressByKeyword('meowecoin', 30);
  assert.equal(keywordByPublicAddress(doge), 'meowecoin');
  assert.equal(decodeBase58Check(doge)[0], 30);
});

test('a plain payment is not a P2FK root', () => {
  const root = decodeRoot(
    {
      txid: 'aa'.repeat(32),
      size: 120,
      outputs: [{ address: publicAddressByKeyword('not-a-root', 30), sats: 50_000_000n }],
    },
    { versionByte: 30, blockTime: 1, blockHeight: 1, txIndex: 0, confirmations: 1 },
  );
  assert.equal(root.isP2fk, false);
});

test('reconstructs a Dogecoin object file and a public message', () => {
  const obj = Buffer.from(
    JSON.stringify({
      urn: 'IPFS:bafyexample/medallion.png',
      nme: 'Forge medallion',
      dsc: 'A shop piece',
      cre: ['0'],
      own: { '0': 1 },
      max: 1,
    }),
  );
  const signature = Buffer.alloc(88);
  for (let i = 0; i < signature.length; i += 1) signature[i] = (i * 13 + 7) % 250 + 1;
  const body = Buffer.concat([
    encodeFile('SIG', signature),
    encodeFile('OBJ', obj),
    encodeMessage('hello from the forge'),
  ]);
  const built = buildRootTransaction({
    versionByte: 30,
    body,
    keywords: ['IPFS:bafyexample/m'],
    txid: 'bb'.repeat(32),
  });
  const root = decodeRoot(built.tx, {
    versionByte: 30,
    blockTime: 1_700_000_000,
    blockHeight: 6_400_010,
    txIndex: 2,
    confirmations: 1,
    verifyMessage: () => true,
  });
  assert.equal(root.isP2fk, true);
  assert.equal(root.signed, true);
  assert.equal(root.signedBy, built.signerAddress);
  assert.equal(root.files.OBJ?.toString('utf8'), obj.toString('utf8'));
  assert.deepEqual(root.message, ['hello from the forge']);
  assert.equal(root.keywords.at(-1)?.address, built.signerAddress);
  assert.ok(root.hash.length === 64);
});
