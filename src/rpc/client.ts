import { jsonCoinToSats } from '../p2fk/amounts.ts';
import type { ChainTransaction } from '../p2fk/types.ts';

export interface BlockInfo {
  hash: string;
  previousblockhash?: string;
  time: number;
  height: number;
  tx: string[];
}

export interface BlockchainRpc {
  getBlockCount(): Promise<number>;
  getBlockHash(height: number): Promise<string>;
  getBlock(hash: string): Promise<BlockInfo>;
  getRawTransaction(txid: string): Promise<ChainTransaction>;
  verifyMessage(address: string, signature: string, message: string): Promise<boolean>;
}

interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * Dogecoin Core 1.14.6 JSON-RPC.
 * getblock is called with verbose=true (the boolean form that 1.14 understands).
 * Amounts are converted to koinu before any P2FK comparison.
 */
export class DogecoinRpc implements BlockchainRpc {
  private readonly url: string;
  private readonly username: string;
  private readonly password: string;

  constructor(url: string, username: string, password: string) {
    this.url = url;
    this.username = username;
    this.password = password;
  }

  async getBlockCount(): Promise<number> {
    return Number(await this.call('getblockcount', []));
  }

  async getBlockHash(height: number): Promise<string> {
    return String(await this.call('getblockhash', [height]));
  }

  async getBlock(hash: string): Promise<BlockInfo> {
    const block = (await this.call('getblock', [hash, true])) as {
      hash: string;
      previousblockhash?: string;
      time: number;
      height: number;
      tx: string[];
    };
    return block;
  }

  async getRawTransaction(txid: string): Promise<ChainTransaction> {
    const tx = (await this.call('getrawtransaction', [txid, true])) as {
      txid: string;
      size?: number;
      vout?: Array<{
        value: number | string;
        scriptPubKey?: { addresses?: string[]; address?: string };
      }>;
    };
    const outputs = (tx.vout ?? []).map((output) => {
      const address = output.scriptPubKey?.addresses?.[0] ?? output.scriptPubKey?.address ?? '';
      const sats = address ? jsonCoinToSats(output.value) : 0n;
      return { address, sats };
    });
    return { txid: tx.txid, size: tx.size ?? 0, outputs };
  }

  async verifyMessage(address: string, signature: string, message: string): Promise<boolean> {
    try {
      return Boolean(await this.call('verifymessage', [address, signature, message]));
    } catch {
      return false;
    }
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const [result] = await this.batch([{ method, params }]);
    return result;
  }

  async batch(calls: RpcCall[]): Promise<unknown[]> {
    const body = calls.map((rpcCall, id) => ({
      jsonrpc: '1.0',
      id,
      method: rpcCall.method,
      params: rpcCall.params,
    }));
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok && response.status !== 500) {
      throw new Error(`Dogecoin RPC HTTP ${response.status}`);
    }
    const payload = (await response.json()) as
      | { id: number; result: unknown; error: { message?: string } | null }
      | Array<{ id: number; result: unknown; error: { message?: string } | null }>;
    const rows = Array.isArray(payload) ? payload : [payload];
    rows.sort((a, b) => a.id - b.id);
    return rows.map((row, index) => {
      if (row.error) {
        throw new Error(row.error.message || `RPC ${calls[index]?.method ?? ''} failed`);
      }
      return row.result;
    });
  }
}
