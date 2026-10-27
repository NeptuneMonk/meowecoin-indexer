import { createHash } from 'node:crypto';
import { commandFile } from './decodeRoot.ts';
import { keywordAt } from './decodeRoot.ts';
import { isoUtc } from './time.ts';
import type { DecodedRoot, ProfileState } from './types.ts';

/**
 * Replay PRO files into a profile.
 * Sup P2FK/contracts/PRO.cs GetProfileByAddress.
 * The first signed PRO whose SignedBy is this address claims it.
 * Later PRO files apply when the signer is still a creator.
 * A creator list that resolves to one different address moves the profile away.
 */

function blank(): ProfileState {
  return {
    id: 0,
    urn: null,
    displayName: null,
    firstName: null,
    middleName: null,
    lastName: null,
    suffix: null,
    bio: null,
    image: null,
    url: null,
    location: null,
    pkx: null,
    pky: null,
    creators: [],
    processHeight: 0,
    createdDate: null,
    changeDate: null,
    moved: false,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringMap(value: unknown): Record<string, string> | null {
  const record = asObject(value);
  if (!record) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function resolveCreators(root: DecodedRoot, cre: unknown): string[] | null {
  if (!Array.isArray(cre)) return null;
  const resolved: string[] = [];
  for (const entry of cre) {
    const ref = String(entry);
    if (/^-?\d+$/.test(ref)) {
      const index = Number(ref);
      if (index < 0) continue;
      const address = keywordAt(root, index);
      if (address && !resolved.includes(address)) resolved.push(address);
    } else if (!resolved.includes(ref)) {
      resolved.push(ref);
    }
  }
  return resolved;
}

export function replayProfile(profileAddress: string, roots: readonly DecodedRoot[]): ProfileState {
  const state = blank();
  const seen = new Set<string>();
  let claimed = false;
  for (const root of roots) {
    if (!root.isP2fk || root.blockTime <= 0) continue;
    state.id += 1;
    state.processHeight = state.id;
    const hasPro = root.fileOrder.includes('PRO') || commandFile(root) === 'PRO';
    if (!root.signed || !hasPro) continue;
    const sig = createHash('sha256').update(root.signature, 'utf8').digest('hex');
    if (seen.has(sig)) continue;
    seen.add(sig);
    let parsed: unknown;
    try {
      parsed = JSON.parse((root.files.PRO ?? Buffer.alloc(0)).toString('utf8'));
    } catch {
      continue;
    }
    const json = asObject(parsed);
    if (!json) continue;

    if (!claimed) {
      if (root.signedBy !== profileAddress) continue;
      const creators = resolveCreators(root, json.cre);
      state.creators = creators && creators.length > 0 ? creators : [profileAddress];
      state.createdDate = isoUtc(root.blockTime);
      state.changeDate = state.createdDate;
      claimed = true;
    } else if (!state.creators.includes(root.signedBy)) {
      continue;
    }

    if (Array.isArray(json.cre)) {
      const resolved = resolveCreators(root, json.cre) ?? [];
      if (resolved.includes(root.signedBy)) {
        state.creators = resolved;
        state.changeDate = isoUtc(root.blockTime);
        if (state.creators.length === 1 && state.creators[0] !== profileAddress) {
          const moved = blank();
          moved.id = state.id;
          moved.processHeight = state.id;
          moved.moved = true;
          return moved;
        }
      }
    }

    const assign: Array<[keyof ProfileState, unknown]> = [
      ['urn', text(json.urn)],
      ['displayName', text(json.dnm)],
      ['firstName', text(json.fnm)],
      ['middleName', text(json.mnm)],
      ['lastName', text(json.lnm)],
      ['suffix', text(json.sfx)],
      ['bio', text(json.bio)],
      ['image', text(json.img)],
      ['pkx', text(json.pkx)],
      ['pky', text(json.pky)],
    ];
    for (const [key, value] of assign) {
      if (typeof value === 'string') {
        (state[key] as string | null) = value;
        state.changeDate = isoUtc(root.blockTime);
      }
    }
    const url = stringMap(json.url);
    const location = stringMap(json.loc);
    if (url) {
      state.url = url;
      state.changeDate = isoUtc(root.blockTime);
    }
    if (location) {
      state.location = location;
      state.changeDate = isoUtc(root.blockTime);
    }
  }
  return state;
}

export function profileIsLive(state: ProfileState): boolean {
  return !state.moved && (state.urn !== null || state.displayName !== null || state.bio !== null);
}
