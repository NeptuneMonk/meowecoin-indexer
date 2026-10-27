import { createHash } from 'node:crypto';
import { decimalToSats } from './amounts.ts';
import { commandFile, keywordAt } from './decodeRoot.ts';
import { isoUtc, supClock } from './time.ts';
import type { DecodedRoot, Listing, ObjectState, Offer, TransferEvent } from './types.ts';

/**
 * Replay OBJ / GIV / BRN / BUY / LST into one object.
 *
 * Follows Sup P2FK/contracts/OBJ.cs GetObjectByAddress.
 * The command is the second file (File.ElementAtOrDefault(1)): SIG is first,
 * the command file is second. Keyword index 0 is the last keyword
 * (Dictionary.Reverse()), which Sup treats as the signing address.
 *
 * One deliberate difference: Sup's `long max` becomes 0 when the JSON omits
 * `max`, so a license-only update would also clear the maximum. The sample
 * Create Object.json says `{ "lic": "CC0" }` updates that field. We change
 * `max` only when the key is present.
 */

const COMMANDS = new Set(['OBJ', 'GIV', 'BRN', 'BUY', 'LST']);

interface Working {
  minted: boolean;
  transactionId: string;
  urn: string | null;
  uri: string | null;
  image: string | null;
  name: string | null;
  description: string | null;
  attributes: Record<string, string> | null;
  license: string | null;
  maximum: number;
  creators: Map<string, string | null> | null;
  owners: Map<string, { qty: number; genId: string | null }> | null;
  royalties: Map<string, number>;
  offers: Offer[];
  listings: Map<string, Listing>;
  lockedDate: string | null;
  createdDate: string | null;
  changeDate: string | null;
  changeLog: string[];
  blocked: boolean;
  seenSignatures: Set<string>;
  id: number;
}

export interface ReplayResult {
  state: ObjectState;
  transfers: TransferEvent[];
}

function blank(): Working {
  return {
    minted: false,
    transactionId: '',
    urn: null,
    uri: null,
    image: null,
    name: null,
    description: null,
    attributes: null,
    license: null,
    maximum: 0,
    creators: null,
    owners: null,
    royalties: new Map(),
    offers: [],
    listings: new Map(),
    lockedDate: null,
    createdDate: null,
    changeDate: null,
    changeLog: [],
    blocked: false,
    seenSignatures: new Set(),
    id: 0,
  };
}

function log(work: Working, signedBy: string, target: string, action: string, qty: string, note: string, unix: number): void {
  work.changeLog.push(
    JSON.stringify([signedBy, target, action, qty, '', note, supClock(unix)]),
  );
}

function signatureKey(signature: string): string {
  return createHash('sha256').update(signature, 'utf8').digest('hex');
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | null {
  if (typeof value === 'string') return value.replaceAll('“', '"').replaceAll('”', '"');
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberList(value: unknown): number[][] | null {
  if (!Array.isArray(value)) return null;
  const rows: number[][] = [];
  for (const row of value) {
    if (!Array.isArray(row)) return null;
    const nums = row.map((cell) => (typeof cell === 'number' ? cell : Number(cell)));
    if (nums.some((cell) => !Number.isFinite(cell))) return null;
    rows.push(nums);
  }
  return rows;
}

function stringRows(value: unknown): string[][] | null {
  if (!Array.isArray(value)) return null;
  const rows: string[][] = [];
  for (const row of value) {
    if (!Array.isArray(row)) return null;
    rows.push(row.map((cell) => String(cell)));
  }
  return rows;
}

function resolveRef(root: DecodedRoot, ref: string): string | null {
  if (/^-?\d+$/.test(ref)) {
    const index = Number(ref);
    if (index < 0) return null;
    return keywordAt(root, index);
  }
  return ref;
}

function outputSats(root: DecodedRoot, address: string): bigint | null {
  const found = root.outputs.find((output) => output.address === address);
  if (!found) return null;
  try {
    return decimalToSats(found.value);
  } catch {
    return null;
  }
}

function percentOf(sats: bigint, percent: number): bigint {
  const basisPoints = BigInt(Math.round(percent * 100));
  return (sats * basisPoints) / 10_000n;
}

function hasKeyword(root: DecodedRoot, address: string): boolean {
  return root.keywords.some((keyword) => keyword.address === address);
}

function applyObj(
  work: Working,
  root: DecodedRoot,
  objectAddress: string,
  findRoot: (txid: string) => DecodedRoot | null,
  versionByte: number,
): void {
  if (!hasKeyword(root, objectAddress)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse((root.files.OBJ ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    log(work, root.signedBy, objectAddress, 'inspect', '', 'failed due to invalid format', root.blockTime);
    return;
  }
  const json = asObject(parsed);
  if (!json) {
    log(work, root.signedBy, objectAddress, 'inspect', '', 'failed due to invalid format', root.blockTime);
    return;
  }

  const cre = Array.isArray(json.cre) ? json.cre.map((entry) => String(entry)) : null;
  const urn = stringField(json.urn);
  // Sup nulls `cre` after the first creator build so this same JSON does not
  // also run the later creator-replace branch. OBJ.cs around the cre = null lines.
  let consumedInitialCreators = false;

  if (urn && cre && cre.length > 0 && !work.creators) {
    const first = cre[0] ?? '';
    const firstAddress = first === objectAddress || resolveRef(root, first) === objectAddress;
    if (!firstAddress) return;
    work.creators = new Map();
    for (const ref of cre) {
      const creator = resolveRef(root, ref);
      if (creator && !work.creators.has(creator)) work.creators.set(creator, null);
    }
    work.changeDate = isoUtc(root.blockTime);
    consumedInitialCreators = true;
  }

  if (!work.creators || !work.creators.has(root.signedBy)) {
    log(work, root.signedBy, objectAddress, 'inspect', '', 'failed due to insufficient privileges', root.blockTime);
    return;
  }

  if (cre && Object.hasOwn(json, 'cre') && !consumedInitialCreators) {
    const resolved = cre
      .map((ref) => resolveRef(root, ref))
      .filter((creator): creator is string => Boolean(creator));
    if (resolved.includes(root.signedBy)) {
      const kept = work.creators.keys().next().value as string | undefined;
      work.creators = new Map();
      if (kept) work.creators.set(kept, null);
      for (const creator of resolved) {
        if (!work.creators.has(creator)) work.creators.set(creator, null);
      }
      work.changeDate = isoUtc(root.blockTime);
    }
  }

  if (work.lockedDate) {
    log(work, root.signedBy, objectAddress, 'update', '', 'failed due to object lock', root.blockTime);
    return;
  }

  if (urn && versionByte !== 111 && !urn.toUpperCase().startsWith('IPFS:')) {
    const stripped = urn.replace(/^(BTC:|MZC:|LTC:|DOG:|btc:|mzc:|ltc:|dog:)/, '');
    const txid = stripped.slice(0, 64);
    if (/^[0-9a-f]{64}$/.test(txid)) {
      const earlier = findRoot(txid);
      if (earlier?.signed && earlier.signedBy && earlier.signedBy !== root.signedBy) {
        log(work, root.signedBy, objectAddress, 'create', '', 'failed due to previous claim', root.blockTime);
        return;
      }
      if (earlier && earlier.blockTime > 0 && !work.createdDate) {
        work.createdDate = isoUtc(earlier.blockTime);
        log(work, earlier.signedBy, objectAddress, 'create', '', 'success', earlier.blockTime);
      }
    }
  }

  if (urn) {
    work.urn = urn;
    work.changeDate = isoUtc(root.blockTime);
  }
  const uri = stringField(json.uri);
  const image = stringField(json.img);
  const name = stringField(json.nme);
  const description = stringField(json.dsc);
  const license = stringField(json.lic);
  if (uri) {
    work.uri = uri;
    work.changeDate = isoUtc(root.blockTime);
  }
  if (image) {
    work.image = image;
    work.changeDate = isoUtc(root.blockTime);
  }
  if (name) {
    work.name = name;
    work.changeDate = isoUtc(root.blockTime);
  }
  if (description) {
    work.description = description;
    work.changeDate = isoUtc(root.blockTime);
  }
  if (asObject(json.atr)) {
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(asObject(json.atr) ?? {})) {
      attributes[key] = stringField(value) ?? '';
    }
    work.attributes = attributes;
    work.changeDate = isoUtc(root.blockTime);
  }
  if (license) {
    work.license = license;
    work.changeDate = isoUtc(root.blockTime);
  }
  if (Object.hasOwn(json, 'max') && typeof json.max === 'number') {
    work.maximum = json.max;
    work.changeDate = isoUtc(root.blockTime);
  }

  const own = asObject(json.own);
  if (own) {
    const firstOwners = work.owners === null;
    if (firstOwners && !work.createdDate) work.createdDate = isoUtc(root.blockTime);
    work.owners = new Map();
    work.transactionId = root.transactionId;
    let claimed = 0;
    for (const [ref, qtyValue] of Object.entries(own)) {
      const owner = resolveRef(root, ref);
      const qty = typeof qtyValue === 'number' ? qtyValue : Number(qtyValue);
      if (!owner || !Number.isFinite(qty)) continue;
      claimed += qty;
      work.owners.set(owner, { qty, genId: null });
    }
    if (firstOwners) {
      log(work, root.signedBy, objectAddress, 'claim', String(claimed), 'success', root.blockTime);
    }
    work.changeDate = isoUtc(root.blockTime);
    work.minted = true;
  }

  const roy = asObject(json.roy);
  if (roy) {
    work.royalties = new Map();
    for (const [ref, pct] of Object.entries(roy)) {
      const who = resolveRef(root, ref);
      const percent = typeof pct === 'number' ? pct : Number(pct);
      if (who && Number.isFinite(percent)) work.royalties.set(who, percent);
    }
    work.changeDate = isoUtc(root.blockTime);
  }

  if (work.creators.get(root.signedBy) == null) {
    work.creators.set(root.signedBy, isoUtc(root.blockTime));
    work.changeDate = isoUtc(root.blockTime);
    log(work, root.signedBy, objectAddress, 'grant', '', 'success', root.blockTime);
  }
  work.minted = work.urn !== null;
}

function ownedQty(work: Working, address: string): number {
  return work.owners?.get(address)?.qty ?? 0;
}

function applyGive(work: Working, root: DecodedRoot, objectAddress: string, transfers: TransferEvent[]): void {
  if (!hasKeyword(root, objectAddress) || !work.owners) return;
  const rows = numberList(JSON.parse((root.files.GIV ?? Buffer.alloc(0)).toString('utf8')));
  if (!rows) return;
  for (const give of rows) {
    const receiver = keywordAt(root, give[0] ?? -1);
    const qty = give[1];
    if (!receiver || qty === undefined) {
      log(work, root.signedBy, objectAddress, 'give', '', 'failed due to invalid keyword count', root.blockTime);
      return;
    }
    if (qty < 0) return;
    if (qty === 0) {
      work.offers = work.offers.filter((offer) => !(offer.requestor === receiver && offer.owner === root.signedBy));
      log(work, root.signedBy, receiver, 'give', '0', 'close all offers', root.blockTime);
      return;
    }
    let giveQty = qty;
    if (work.maximum > 0 && giveQty > work.maximum) giveQty = work.maximum;
    const already = ownedQty(work, receiver);
    if (work.maximum > 0 && already + giveQty > work.maximum) {
      log(work, root.signedBy, receiver, 'give', String(giveQty), 'failed due to over maximum qty', root.blockTime);
      return;
    }

    let giver = root.signedBy;
    if (!work.owners.has(giver)) {
      const container = work.owners.get(objectAddress);
      if (!container || container.qty <= 0 || !work.creators?.has(root.signedBy)) {
        log(work, root.signedBy, receiver, 'give', String(giveQty), 'failed due to insufficient qty owned', root.blockTime);
        return;
      }
      giver = objectAddress;
    }
    const holding = work.owners.get(giver);
    if (!holding || holding.qty < giveQty) {
      log(work, root.signedBy, receiver, 'give', String(giveQty), 'failed due to insufficent available qty owned', root.blockTime);
      return;
    }
    const genId = giver === objectAddress ? root.transactionId : holding.genId;
    const receiverHolding = work.owners.get(receiver);
    work.owners.set(receiver, {
      qty: (receiverHolding?.qty ?? 0) + giveQty,
      genId,
    });
    const left = holding.qty - giveQty;
    if (left > 0) {
      work.owners.set(giver, { qty: left, genId: giver === objectAddress ? null : holding.genId });
      const listing = work.listings.get(giver);
      if (listing && listing.qty > left) listing.qty = left;
    } else {
      work.owners.delete(giver);
      work.listings.delete(giver);
    }
    work.offers = work.offers.filter((offer) => !(offer.requestor === receiver && offer.owner === giver));
    if (!work.lockedDate) {
      work.lockedDate = isoUtc(root.blockTime);
      log(work, root.signedBy, objectAddress, 'lock', '', 'success', root.blockTime);
    }
    work.changeDate = isoUtc(root.blockTime);
    log(work, root.signedBy, receiver, 'give', String(giveQty), 'success', root.blockTime);
    transfers.push({
      txid: root.transactionId,
      objectAddress,
      action: 'give',
      fromAddress: giver,
      toAddress: receiver,
      qty: giveQty,
      blockTime: root.blockTime,
      height: root.blockHeight,
    });
    if (work.creators?.has(root.signedBy) && work.creators.get(root.signedBy) == null) {
      work.creators.set(root.signedBy, isoUtc(root.blockTime));
      log(work, root.signedBy, objectAddress, 'grant', '', 'success', root.blockTime);
    }
  }
}

function applyBurn(work: Working, root: DecodedRoot, objectAddress: string, transfers: TransferEvent[]): void {
  if (!hasKeyword(root, objectAddress) || !work.owners) return;
  let rows: number[][] | null = null;
  try {
    rows = numberList(JSON.parse((root.files.BRN ?? Buffer.alloc(0)).toString('utf8')));
  } catch {
    return;
  }
  if (!rows) return;
  for (const burn of rows) {
    const target = keywordAt(root, burn[0] ?? -1);
    if (target !== objectAddress) return;
    const qty = burn[1] ?? 0;
    if (qty < 1) return;
    let burner = root.signedBy;
    if (!work.owners.has(burner)) {
      const container = work.owners.get(objectAddress);
      if (!container || container.qty <= 0 || !work.creators?.has(root.signedBy)) {
        log(work, root.signedBy, objectAddress, 'burn', String(qty), 'failed due to insufficient qty owned', root.blockTime);
        return;
      }
      burner = objectAddress;
    }
    const holding = work.owners.get(burner);
    if (!holding || holding.qty < qty) {
      log(work, root.signedBy, objectAddress, 'burn', String(qty), 'failed due to a insufficent qty owned', root.blockTime);
      return;
    }
    const left = holding.qty - qty;
    if (left > 0) {
      work.owners.set(burner, { qty: left, genId: holding.genId });
      const listing = work.listings.get(burner);
      if (listing && listing.qty > left) listing.qty = left;
    } else {
      work.owners.delete(burner);
      work.listings.delete(burner);
    }
    transfers.push({
      txid: root.transactionId,
      objectAddress,
      action: 'burn',
      fromAddress: burner,
      toAddress: '',
      qty,
      blockTime: root.blockTime,
      height: root.blockHeight,
    });
    if (work.owners.size < 1) {
      work.blocked = true;
      work.urn = null;
      work.owners = null;
      work.minted = false;
      return;
    }
    if (!work.lockedDate) {
      work.lockedDate = isoUtc(root.blockTime);
      log(work, root.signedBy, objectAddress, 'lock', '', 'success', root.blockTime);
    }
    work.changeDate = isoUtc(root.blockTime);
    log(work, root.signedBy, objectAddress, 'burn', String(qty), 'success', root.blockTime);
  }
}

function applyList(work: Working, root: DecodedRoot, objectAddress: string): void {
  if (!hasKeyword(root, objectAddress) || !work.owners) return;
  let rows: string[][] | null = null;
  try {
    rows = stringRows(JSON.parse((root.files.LST ?? Buffer.alloc(0)).toString('utf8')));
  } catch {
    log(work, root.signedBy, objectAddress, 'inspect', '', 'failed due to invalid transaction format', root.blockTime);
    return;
  }
  if (!rows) return;
  for (const row of rows) {
    const listedObject = row[0];
    if (listedObject !== objectAddress) continue;
    const qty = Number(row[1]);
    const eachCost = Number(row[2]);
    if (!Number.isFinite(qty) || !Number.isFinite(eachCost)) return;
    if (qty < 0) return;
    if (work.creators?.has(root.signedBy) && work.creators.get(root.signedBy) == null) {
      work.creators.set(root.signedBy, isoUtc(root.blockTime));
      log(work, root.signedBy, objectAddress, 'grant', '', 'success', root.blockTime);
    }
    if (qty === 0) {
      if (work.listings.has(root.signedBy)) work.listings.delete(root.signedBy);
      else if (work.creators?.has(root.signedBy)) work.listings.delete(objectAddress);
      log(work, root.signedBy, listedObject, 'List', '0', 'close all listings', root.blockTime);
      return;
    }
    let lister = root.signedBy;
    let qtyOwned = ownedQty(work, lister);
    if (!work.owners.has(lister)) {
      const container = work.owners.get(objectAddress);
      if (!container || (!work.creators?.has(root.signedBy) && root.signedBy !== objectAddress)) {
        log(work, root.signedBy, listedObject, 'List', String(qty), 'failed due to insufficient qty owned', root.blockTime);
        return;
      }
      lister = objectAddress;
      qtyOwned = container.qty;
    }
    if (qtyOwned < qty) {
      log(work, root.signedBy, listedObject, 'List', String(qty), 'failed due to insufficient qty owned', root.blockTime);
      return;
    }
    work.listings.set(lister, {
      owner: lister,
      requestor: root.signedBy,
      qty,
      value: eachCost,
      blockDate: isoUtc(root.blockTime),
    });
    if (!work.lockedDate) {
      work.lockedDate = isoUtc(root.blockTime);
      log(work, root.signedBy, objectAddress, 'lock', '', 'success', root.blockTime);
    }
    work.changeDate = isoUtc(root.blockTime);
    log(work, root.signedBy, listedObject, 'List', String(qty), 'Success', root.blockTime);
  }
}

function royaltiesCovered(work: Working, root: DecodedRoot, listValueSats: bigint, qty: bigint): { ok: boolean; paid: bigint } {
  let paid = 0n;
  for (const [who, percent] of work.royalties) {
    if (who === root.signedBy) continue;
    const sent = outputSats(root, who);
    const required = percentOf(listValueSats * qty, percent);
    if (sent === null || sent < required) return { ok: false, paid };
    paid += required;
  }
  return { ok: true, paid };
}

function moveQty(work: Working, from: string, to: string, qty: number, txid: string): void {
  const holding = work.owners?.get(from);
  if (!work.owners || !holding) return;
  const genId = from === to ? txid : holding.genId;
  const left = holding.qty - qty;
  if (left < 1) work.owners.delete(from);
  else work.owners.set(from, { qty: left, genId: holding.genId });
  const buyer = work.owners.get(to);
  work.owners.set(to, { qty: (buyer?.qty ?? 0) + qty, genId: from === work.transactionId ? txid : genId });
}

function applyBuy(work: Working, root: DecodedRoot, objectAddress: string, transfers: TransferEvent[]): void {
  const count = root.outputs.length;
  const nearEnd =
    root.outputs[count - 2]?.address === objectAddress || root.outputs[count - 3]?.address === objectAddress;
  if (!nearEnd || !work.owners || root.signedBy === objectAddress) return;
  let rows: string[][] | null = null;
  try {
    rows = stringRows(JSON.parse((root.files.BUY ?? Buffer.alloc(0)).toString('utf8')));
  } catch {
    return;
  }
  if (!rows) return;
  for (const row of rows) {
    const seller = row[0] ?? '';
    let qty = Number(row[1]);
    if (!Number.isFinite(qty) || qty < 1) return;
    if (work.maximum > 0 && qty > work.maximum) {
      log(work, root.signedBy, seller, 'buy', String(qty), 'failed due to over maximum qty', root.blockTime);
      return;
    }
    const buyerHeld = ownedQty(work, root.signedBy);
    if (work.maximum > 0 && buyerHeld + qty > work.maximum) {
      log(work, root.signedBy, seller, 'buy', String(qty), 'failed due to over maximum qty held', root.blockTime);
      return;
    }
    const listing = work.listings.get(seller);
    if (listing && listing.qty > 0) {
      if (qty > listing.qty) qty = listing.qty;
      const listSats = decimalToSats(String(listing.value));
      const royalties = royaltiesCovered(work, root, listSats, BigInt(qty));
      if (!royalties.ok) {
        log(work, root.signedBy, seller, 'buy', String(qty), 'failed insuficent royalties paid', root.blockTime);
        return;
      }
      const ownerPaid = outputSats(root, seller) ?? 0n;
      const due = listSats * BigInt(qty) - royalties.paid;
      if (ownerPaid < due) {
        log(work, root.signedBy, seller, 'buy', String(qty), 'failed insuficent owner paid', root.blockTime);
        return;
      }
      if (ownedQty(work, seller) < qty) {
        log(work, root.signedBy, objectAddress, 'buy', String(qty), 'failed due to insuficent Qty owned', root.blockTime);
        return;
      }
      moveQty(work, seller, root.signedBy, qty, root.transactionId);
      listing.qty -= qty;
      if (listing.qty < 1) work.listings.delete(seller);
      work.changeDate = isoUtc(root.blockTime);
      log(work, root.signedBy, seller, 'buy', String(qty), `success ${ownerPaid.toString()}`, root.blockTime);
      transfers.push({
        txid: root.transactionId,
        objectAddress,
        action: 'buy',
        fromAddress: seller,
        toAddress: root.signedBy,
        qty,
        blockTime: root.blockTime,
        height: root.blockHeight,
      });
      return;
    }

    if (ownedQty(work, seller) < qty) {
      log(work, root.signedBy, objectAddress, 'buy', String(qty), 'failed due to insuficent Qty owned', root.blockTime);
      return;
    }
    let royaltiesPaid = 0;
    let royaltyPercent = 0;
    for (const [who, percent] of work.royalties) {
      const sent = outputSats(root, who);
      if (sent === null) {
        log(work, root.signedBy, objectAddress, 'buy', String(qty), `failed ${who} insuficent royalties paid`, root.blockTime);
        return;
      }
      if (who !== seller) {
        royaltiesPaid += Number(sent) / 1e8;
        royaltyPercent += percent;
      }
    }
    const ownerPaid = outputSats(root, seller);
    if (ownerPaid === null) return;
    const ownerCoins = Number(ownerPaid) / 1e8;
    const totalPaid = ownerCoins + royaltiesPaid;
    if (Math.abs(totalPaid * (royaltyPercent / 100) - royaltiesPaid) > 1e-8) return;
    work.offers.push({
      requestor: root.signedBy,
      owner: seller,
      qty,
      value: qty === 0 ? 0 : totalPaid / qty,
      blockDate: isoUtc(root.blockTime),
    });
    log(work, root.signedBy, seller, 'offer', String(qty), `success - ${totalPaid / qty}`, root.blockTime);
  }
}

function toState(work: Working): ObjectState {
  const creators: Record<string, string | null> = {};
  if (work.creators) {
    for (const [address, granted] of work.creators) creators[address] = granted;
  }
  const owners: ObjectState['owners'] = {};
  if (work.owners) {
    for (const [address, holding] of work.owners) owners[address] = { qty: holding.qty, genId: holding.genId };
  }
  const royalties: Record<string, number> = {};
  for (const [address, percent] of work.royalties) royalties[address] = percent;
  const listings: Record<string, Listing> = {};
  for (const [address, listing] of work.listings) listings[address] = listing;
  return {
    id: work.id,
    transactionId: work.transactionId,
    urn: work.blocked ? null : work.urn,
    uri: work.uri,
    image: work.image,
    name: work.name,
    description: work.description,
    attributes: work.attributes,
    license: work.license,
    maximum: work.maximum,
    creators,
    owners: work.blocked || !work.owners ? {} : owners,
    royalties,
    offers: work.offers,
    listings,
    lockedDate: work.lockedDate,
    processHeight: work.id,
    createdDate: work.createdDate,
    changeDate: work.changeDate,
    changeLog: work.changeLog,
    blocked: work.blocked,
  };
}

export function replayObject(
  objectAddress: string,
  roots: readonly DecodedRoot[],
  findRoot: (txid: string) => DecodedRoot | null = () => null,
  versionByte = 30,
): ReplayResult {
  const work = blank();
  const transfers: TransferEvent[] = [];
  const ordered = roots.filter((root) => root.isP2fk && root.blockTime > 0);
  for (const root of ordered) {
    work.id += 1;
    const command = commandFile(root);
    if (!root.signed || !command || !COMMANDS.has(command)) continue;
    const seen = signatureKey(root.signature);
    if (work.seenSignatures.has(seen)) continue;
    work.seenSignatures.add(seen);
    try {
      if (command === 'OBJ') applyObj(work, root, objectAddress, findRoot, versionByte);
      else if (command === 'GIV') applyGive(work, root, objectAddress, transfers);
      else if (command === 'BRN') applyBurn(work, root, objectAddress, transfers);
      else if (command === 'LST') applyList(work, root, objectAddress);
      else if (command === 'BUY') applyBuy(work, root, objectAddress, transfers);
    } catch {
      log(work, root.signedBy, objectAddress, command.toLowerCase(), '', 'failed due to invalid transaction format', root.blockTime);
    }
    if (work.blocked) break;
  }
  const state = toState(work);
  if (work.owners && work.minted) {
    const claimed = Object.values(state.owners).reduce((sum, owner) => sum + owner.qty, 0);
    if (claimed > 0 && !transfers.some((transfer) => transfer.action === 'claim')) {
      transfers.unshift({
        txid: state.transactionId,
        objectAddress,
        action: 'claim',
        fromAddress: '',
        toAddress: objectAddress,
        qty: claimed,
        blockTime: roots.find((root) => root.transactionId === state.transactionId)?.blockTime ?? 0,
        height: roots.find((root) => root.transactionId === state.transactionId)?.blockHeight ?? 0,
      });
    }
  }
  return { state, transfers };
}

export function objectIsLive(state: ObjectState): boolean {
  return !state.blocked && state.urn !== null && Object.keys(state.owners).length > 0;
}
