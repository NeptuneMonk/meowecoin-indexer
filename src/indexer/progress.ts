/**
 * In-memory sync rate for /health and the log.
 * The database remains the resume point. This resets when the process starts.
 */

export interface SyncMeter {
  blocksRead: number;
  startedAtMs: number | null;
  /** Blocks per second over the batch that just finished. */
  blocksPerSecond: number | null;
  /** Blocks per second since this process started reading. */
  averageBlocksPerSecond: number | null;
}

const meter: SyncMeter = {
  blocksRead: 0,
  startedAtMs: null,
  blocksPerSecond: null,
  averageBlocksPerSecond: null,
};

export function noteBatch(blocks: number, elapsedMs: number): void {
  if (blocks <= 0) return;
  const now = Date.now();
  if (meter.startedAtMs === null) meter.startedAtMs = now - elapsedMs;
  meter.blocksRead += blocks;
  const instant = blocks / Math.max(elapsedMs / 1000, 0.001);
  meter.blocksPerSecond = instant;
  const totalSeconds = (now - meter.startedAtMs) / 1000;
  meter.averageBlocksPerSecond = totalSeconds > 0 ? meter.blocksRead / totalSeconds : instant;
}

export function syncSnapshot(): SyncMeter {
  return { ...meter };
}

export function roundRate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}
