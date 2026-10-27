import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';

test('START_HEIGHT defaults to genesis and can be overridden', () => {
  const previousStart = process.env.START_HEIGHT;
  const previousBatch = process.env.BATCH_BLOCKS;
  delete process.env.START_HEIGHT;
  delete process.env.BATCH_BLOCKS;
  const directory = mkdtempSync(join(tmpdir(), 'meowe-config-'));
  try {
    const defaults = loadConfig(join(directory, 'missing.env'));
    assert.equal(defaults.startHeight, 0);
    assert.equal(defaults.batchBlocks, 200);
    writeFileSync(join(directory, '.env'), 'START_HEIGHT=123456\nBATCH_BLOCKS=10\n', 'utf8');
    delete process.env.START_HEIGHT;
    delete process.env.BATCH_BLOCKS;
    const overridden = loadConfig(join(directory, '.env'));
    assert.equal(overridden.startHeight, 123456);
    assert.equal(overridden.batchBlocks, 10);
  } finally {
    if (previousStart === undefined) delete process.env.START_HEIGHT;
    else process.env.START_HEIGHT = previousStart;
    if (previousBatch === undefined) delete process.env.BATCH_BLOCKS;
    else process.env.BATCH_BLOCKS = previousBatch;
  }
});
