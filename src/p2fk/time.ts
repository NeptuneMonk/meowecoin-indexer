/** Sup prints BlockDate with the invariant/en-US general pattern `M/d/yyyy h:mm:ss tt`. */

export function isoUtc(unixSeconds: number): string {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, '');
}

export function supClock(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  let hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${month}/${day}/${year} ${hour}:${minute}:${second} ${suffix}`;
}

export function changedWithinYears(iso: string | null, years: number, now = Date.now()): boolean {
  if (!iso) return false;
  const stamp = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  if (Number.isNaN(stamp)) return false;
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return stamp > cutoff.getTime();
}
