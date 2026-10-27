import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlockHex, serializeBlockHex } from '../src/p2fk/blockHex.ts';
import { addressForChunk } from '../src/p2fk/encode.ts';

test('parses pay-to-pubkey-hash outputs from block hex', () => {
  const hash160 = Buffer.from('00112233445566778899aabbccddeeff00112233', 'hex');
  const built = serializeBlockHex({
    previousHash: '00'.repeat(32),
    time: 1_700_000_000,
    nonce: 7,
    pubkeyVersion: 30,
    outputs: [[{ hash160, sats: 5_000_000_000n }]],
  });
  const parsed = parseBlockHex(built.hex, 30);
  assert.equal(parsed.previousHash, '00'.repeat(32));
  assert.equal(parsed.time, 1_700_000_000);
  assert.equal(parsed.txs.length, 1);
  assert.equal(parsed.txs[0]?.outputs[0]?.sats, 5_000_000_000n);
  assert.equal(parsed.txs[0]?.outputs[0]?.address, addressForChunk(hash160, 30));
  const again = parseBlockHex(built.hex, 30);
  assert.equal(again.txs[0]?.txid, parsed.txs[0]?.txid);
});
