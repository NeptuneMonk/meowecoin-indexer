import { loadConfig } from './config.ts';
import { createApi, listen } from './api/server.ts';
import { Store } from './db/store.ts';
import { roundRate, syncSnapshot } from './indexer/progress.ts';
import { syncOnce, type SyncReport } from './indexer/scan.ts';
import { DogecoinRpc } from './rpc/client.ts';

const config = loadConfig();
const store = new Store(config.dbPath, config.versionByte);
const rpc = new DogecoinRpc(config.rpcUrl, config.rpcUser, config.rpcPassword);
const server = createApi(rpc, store, config);

let stopped = false;
let lastLogAt = 0;

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function progressLine(report: SyncReport): string {
  const indexed = report.indexedHeight;
  const indexedText = indexed === null ? 'not started' : String(indexed);
  const percent = indexed === null || report.tip <= 0 ? 0 : Math.min(100, (indexed / report.tip) * 100);
  const meter = syncSnapshot();
  const rate = roundRate(meter.blocksPerSecond);
  const behind = indexed === null ? null : Math.max(0, report.tip - indexed);
  let eta = '';
  if (behind !== null && behind > 0 && rate !== null && rate > 0) {
    eta = ` About ${formatDuration(behind / rate)} left at this speed.`;
  }
  const rateText = rate === null ? '' : ` ${rate} blocks/sec.`;
  return `Indexed height ${indexedText} of ${report.tip} (${percent.toFixed(1)}%).${rateText}${eta} New roots this pass: ${report.rootsFound}.`;
}

async function loop(): Promise<void> {
  while (!stopped) {
    try {
      const report = await syncOnce(rpc, store, config);
      const caughtUp = report.indexedHeight !== null && report.indexedHeight >= report.tip && !report.waiting;
      if (report.blocksRead > 0 || report.reorged) {
        const now = Date.now();
        if (report.reorged || caughtUp || now - lastLogAt >= 2000) {
          console.log(progressLine(report));
          lastLogAt = now;
        }
      }
      if (caughtUp || (report.blocksRead === 0 && !report.reorged)) {
        await new Promise((resolve) => setTimeout(resolve, config.pollMs));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      console.error(`Waiting for the Dogecoin node. ${message}`);
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
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
