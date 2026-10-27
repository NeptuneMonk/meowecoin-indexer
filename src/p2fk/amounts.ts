/**
 * Coin amounts the way Sup decides which outputs carry P2FK bytes.
 *
 * Root.cs keeps a fixed set of strings and compares them to
 * `vout.value.ToString()` after Newtonsoft reads the RPC JSON into a C# decimal.
 * Dogecoin Core 1.14.6 prints amounts with 8 decimal places (ValueFromAmount),
 * so 1 DOGE arrives as 1.00000000. That string is not in Sup's set, but "1" is.
 * We treat an output as payload when either the 8-decimal form or the
 * trailing-zero-stripped form is in the set.
 *
 * Source: Sup P2FK/contracts/Root.cs, GetRootByTransactionId allowedValues.
 */

export const DUST_VALUE_STRINGS = new Set([
  '0.00000001',
  '0.00000546',
  '0.00000548',
  '0.00005480',
  '0.00000550',
  '0.00005500',
  '0.00001000',
  '0.01000000',
  '0.02000000',
  '1',
]);

/** 546 koinu. Sup's usual payload output. */
export const STANDARD_DUST_SATS = 546n;

export function satsToFixed8(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(8, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function stripTrailingZeros(fixed8: string): string {
  return fixed8.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function isPayloadAmount(sats: bigint): boolean {
  const fixed = satsToFixed8(sats);
  return DUST_VALUE_STRINGS.has(fixed) || DUST_VALUE_STRINGS.has(stripTrailingZeros(fixed));
}

/** The string Sup stores on Root.Output for an RPC amount with scale 8. */
export function outputValueString(sats: bigint): string {
  return satsToFixed8(sats);
}

export function decimalToSats(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Not a coin amount: ${value}`);
  }
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const frac8 = (frac + '00000000').slice(0, 8);
  const sats = BigInt(whole) * 100_000_000n + BigInt(frac8);
  return negative ? -sats : sats;
}

/** JSON numbers from dogecoind are safe to round to koinu. */
export function jsonCoinToSats(value: number | string): bigint {
  if (typeof value === 'string') {
    if (/[eE]/.test(value)) return jsonCoinToSats(Number(value));
    return decimalToSats(value);
  }
  if (!Number.isFinite(value)) throw new Error('Coin amount is not a finite number.');
  return BigInt(Math.round(value * 1e8));
}
