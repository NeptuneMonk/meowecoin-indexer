import { loadConfig } from './config.ts';
import { createApi, listen } from './api/server.ts';
import { Store } from './db/store.ts';
import { syncOnce } from './indexer/scan.ts';
import { DogecoinRpc } from './rpc/client.ts';

const config = loadConfig();
const store = new Store(config.dbPath, config.versionByte);
const rpc = new DogecoinRpc(config.rpcUrl, config.rpcUser, config.rpcPassword);
const server = createApi(rpc, store, config);

let stopped = false;

async function loop(): Promise<void> {
  while (!stopped) {
    try {
      const report = await syncOnce(rpc, store, config);
      if (report.blocksRead > 0 || report.reorged) {
        const indexed = report.indexedHeight ?? 'not started';
        console.log(
          `Indexed height ${indexed}. Node height ${report.tip}. New roots this pass: ${report.rootsFound}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      console.error(`Waiting for the Dogecoin node. ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}

function shutdown(): void {
  stopped = true;
  server.close();
  store.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await listen(server, config);
console.log(`Meowecoin Dogecoin indexer API is at http://${config.bindHost}:${config.port}/health`);
void loop();
