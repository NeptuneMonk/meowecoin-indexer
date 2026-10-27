import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  startHeight: number;
  bindHost: string;
  port: number;
  corsOrigin: string;
  dbPath: string;
  versionByte: number;
  pollMs: number;
  batchBlocks: number;
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number. Got "${raw}".`);
  }
  return value;
}

export function loadConfig(envPath = resolve(process.cwd(), '.env')): Config {
  loadDotEnv(envPath);
  const versionByte = intEnv('VERSION_BYTE', 30);
  if (versionByte < 0 || versionByte > 255) {
    throw new Error('VERSION_BYTE must be from 0 to 255.');
  }
  const startHeight = intEnv('START_HEIGHT', 0);
  if (startHeight < 0) throw new Error('START_HEIGHT cannot be negative.');
  return {
    rpcUrl: process.env.DOGE_RPC_URL?.trim() || 'http://127.0.0.1:22555',
    rpcUser: process.env.DOGE_RPC_USER?.trim() || '',
    rpcPassword: process.env.DOGE_RPC_PASSWORD ?? '',
    startHeight,
    bindHost: process.env.BIND_HOST?.trim() || '127.0.0.1',
    port: intEnv('PORT', 8080),
    corsOrigin: process.env.CORS_ORIGIN?.trim() || '*',
    dbPath: resolve(process.env.DB_PATH?.trim() || './data/meowecoin-indexer.sqlite'),
    versionByte,
    pollMs: intEnv('POLL_MS', 15_000),
    batchBlocks: Math.max(1, intEnv('BATCH_BLOCKS', 200)),
  };
}
