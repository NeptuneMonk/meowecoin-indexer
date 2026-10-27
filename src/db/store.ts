import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileSizes } from '../p2fk/decodeRoot.ts';
import { publicAddressByKeyword } from '../p2fk/keywords.ts';
import { messagesFromRoot } from '../p2fk/messages.ts';
import { objectIsLive, replayObject } from '../p2fk/objectState.ts';
import { profileIsLive, replayProfile } from '../p2fk/profileState.ts';
import { changedWithinYears, isoUtc } from '../p2fk/time.ts';
import type { DecodedRoot, ObjectState, ProfileState, PublicMessage } from '../p2fk/types.ts';

/**
 * One SQLite file. It can be deleted and built again from the node.
 * Derived objects and profiles are replayed from the roots whenever a root
 * that pays that address is added or removed.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  height INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  prev_hash TEXT,
  time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roots (
  txid TEXT PRIMARY KEY,
  height INTEGER NOT NULL,
  tx_index INTEGER NOT NULL,
  block_time INTEGER NOT NULL,
  signed_by TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS roots_height ON roots(height, tx_index);
CREATE TABLE IF NOT EXISTS root_outputs (
  address TEXT NOT NULL,
  txid TEXT NOT NULL,
  PRIMARY KEY (address, txid)
);
CREATE TABLE IF NOT EXISTS objects (
  address TEXT PRIMARY KEY,
  urn TEXT,
  name TEXT,
  searchable TEXT NOT NULL,
  change_time INTEGER NOT NULL,
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ownership (
  object_address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  qty INTEGER NOT NULL,
  gen_id TEXT,
  PRIMARY KEY (object_address, owner_address)
);
CREATE TABLE IF NOT EXISTS creators (
  object_address TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  granted TEXT,
  PRIMARY KEY (object_address, creator_address)
);
CREATE TABLE IF NOT EXISTS profiles (
  address TEXT PRIMARY KEY,
  urn TEXT,
  searchable TEXT NOT NULL,
  change_time INTEGER NOT NULL,
  state_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txid TEXT NOT NULL,
  object_address TEXT NOT NULL,
  action TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  qty INTEGER NOT NULL,
  height INTEGER NOT NULL,
  block_time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  txid TEXT NOT NULL,
  private INTEGER NOT NULL,
  height INTEGER NOT NULL,
  block_time INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  body TEXT NOT NULL,
  files_json TEXT NOT NULL,
  PRIMARY KEY (txid, private)
);
CREATE INDEX IF NOT EXISTS messages_to ON messages(to_address, height);
CREATE INDEX IF NOT EXISTS messages_from ON messages(from_address, height);
`;

function encodeRoot(root: DecodedRoot): string {
  const files: Record<string, string> = {};
  for (const name of root.fileOrder) files[name] = root.files[name]?.toString('base64') ?? '';
  return JSON.stringify({
    isP2fk: root.isP2fk,
    message: root.message,
    fileOrder: root.fileOrder,
    files,
    keywords: root.keywords.map((keyword) => ({
      address: keyword.address,
      text: keyword.text,
      payload: keyword.payload.toString('base64'),
    })),
    outputs: root.outputs,
    hash: root.hash,
    signedBy: root.signedBy,
    signature: root.signature,
    signed: root.signed,
    transactionId: root.transactionId,
    blockTime: root.blockTime,
    blockHeight: root.blockHeight,
    txIndex: root.txIndex,
    totalByteSize: root.totalByteSize,
    confirmations: root.confirmations,
    ledger: root.ledger,
  });
}

function decodeStoredRoot(body: string): DecodedRoot {
  const parsed = JSON.parse(body) as Omit<DecodedRoot, 'files' | 'keywords'> & {
    files: Record<string, string>;
    keywords: Array<{ address: string; text: string; payload: string }>;
  };
  const files: Record<string, Buffer> = {};
  for (const [name, b64] of Object.entries(parsed.files)) files[name] = Buffer.from(b64, 'base64');
  return {
    ...parsed,
    files,
    keywords: parsed.keywords.map((keyword) => ({
      address: keyword.address,
      text: keyword.text,
      payload: Buffer.from(keyword.payload, 'base64'),
    })),
  };
}

export class Store {
  readonly db: DatabaseSync;
  private readonly versionByte: number;

  constructor(path: string, versionByte: number) {
    this.versionByte = versionByte;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  indexedHeight(): number | null {
    const row = this.db.prepare('SELECT MAX(height) AS height FROM blocks').get() as { height: number | null };
    return row.height;
  }

  getBlock(height: number): { height: number; hash: string; prevHash: string | null; time: number } | null {
    const row = this.db.prepare('SELECT height, hash, prev_hash, time FROM blocks WHERE height = ?').get(height) as
      | { height: number; hash: string; prev_hash: string | null; time: number }
      | undefined;
    if (!row) return null;
    return { height: row.height, hash: row.hash, prevHash: row.prev_hash, time: row.time };
  }

  rootCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM roots').get() as { n: number };
    return row.n;
  }

  objectCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM objects').get() as { n: number };
    return row.n;
  }

  profileCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number };
    return row.n;
  }

  getRoot(txid: string): DecodedRoot | null {
    const row = this.db.prepare('SELECT body FROM roots WHERE txid = ?').get(txid) as { body: string } | undefined;
    return row ? decodeStoredRoot(row.body) : null;
  }

  private rootsForAddress(address: string): DecodedRoot[] {
    const rows = this.db
      .prepare(
        `SELECT roots.body FROM roots
         JOIN root_outputs ON root_outputs.txid = roots.txid
         WHERE root_outputs.address = ?
         ORDER BY roots.height ASC, roots.tx_index ASC`,
      )
      .all(address) as Array<{ body: string }>;
    return rows.map((row) => decodeStoredRoot(row.body));
  }

  saveBlock(height: number, hash: string, prevHash: string | null, time: number, roots: DecodedRoot[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO blocks(height, hash, prev_hash, time) VALUES(?, ?, ?, ?)').run(height, hash, prevHash, time);
      for (const root of roots) this.insertRoot(root);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const touched = new Set<string>();
    for (const root of roots) {
      for (const output of root.outputs) touched.add(output.address);
    }
    for (const address of touched) this.recompute(address);
  }

  /**
   * Save a contiguous run of blocks in one commit.
   * A crash rolls the whole run back, and the next start continues from the last commit.
   */
  saveBlocks(blocks: Array<{ height: number; hash: string; prevHash: string | null; time: number; roots: DecodedRoot[] }>): void {
    if (blocks.length === 0) return;
    const insertBlock = this.db.prepare('INSERT INTO blocks(height, hash, prev_hash, time) VALUES(?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const block of blocks) {
        insertBlock.run(block.height, block.hash, block.prevHash, block.time);
        for (const root of block.roots) this.insertRoot(root);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const touched = new Set<string>();
    for (const block of blocks) {
      for (const root of block.roots) {
        for (const output of root.outputs) touched.add(output.address);
      }
    }
    for (const address of touched) this.recompute(address);
  }

  private insertRoot(root: DecodedRoot): void {
    this.db
      .prepare(
        `INSERT INTO roots(txid, height, tx_index, block_time, signed_by, body)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(txid) DO UPDATE SET
           height = excluded.height,
           tx_index = excluded.tx_index,
           block_time = excluded.block_time,
           signed_by = excluded.signed_by,
           body = excluded.body`,
      )
      .run(root.transactionId, root.blockHeight, root.txIndex, root.blockTime, root.signedBy, encodeRoot(root));
    this.db.prepare('DELETE FROM root_outputs WHERE txid = ?').run(root.transactionId);
    const insertOutput = this.db.prepare('INSERT OR IGNORE INTO root_outputs(address, txid) VALUES(?, ?)');
    for (const output of root.outputs) insertOutput.run(output.address, root.transactionId);
    for (const keyword of root.keywords) insertOutput.run(keyword.address, root.transactionId);
    this.db.prepare('DELETE FROM messages WHERE txid = ?').run(root.transactionId);
    const insertMessage = this.db.prepare(
      `INSERT INTO messages(txid, private, height, block_time, from_address, to_address, body, files_json)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of messagesFromRoot(root)) {
      insertMessage.run(
        message.txid,
        message.private ? 1 : 0,
        message.height,
        message.blockTime,
        message.fromAddress,
        message.toAddress,
        message.message,
        JSON.stringify(message.files),
      );
    }
  }

  rewindTo(height: number): void {
    const rows = this.db.prepare('SELECT body FROM roots WHERE height > ?').all(height) as Array<{ body: string }>;
    const touched = new Set<string>();
    for (const row of rows) {
      const root = decodeStoredRoot(row.body);
      for (const output of root.outputs) touched.add(output.address);
      for (const keyword of root.keywords) touched.add(keyword.address);
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM roots WHERE height > ?').run(height);
      this.db.prepare('DELETE FROM blocks WHERE height > ?').run(height);
      this.db.prepare('DELETE FROM root_outputs WHERE txid NOT IN (SELECT txid FROM roots)').run();
      this.db.prepare('DELETE FROM messages WHERE height > ?').run(height);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const address of touched) this.recompute(address);
  }

  private recompute(address: string): void {
    const roots = this.rootsForAddress(address);
    const objectReplay = replayObject(address, roots, (txid) => this.getRoot(txid), this.versionByte);
    this.db.prepare('DELETE FROM ownership WHERE object_address = ?').run(address);
    this.db.prepare('DELETE FROM creators WHERE object_address = ?').run(address);
    this.db.prepare('DELETE FROM transfers WHERE object_address = ?').run(address);
    if (objectIsLive(objectReplay.state)) {
      this.writeObject(address, objectReplay.state);
      const insertOwner = this.db.prepare(
        'INSERT INTO ownership(object_address, owner_address, qty, gen_id) VALUES(?, ?, ?, ?)',
      );
      for (const [owner, holding] of Object.entries(objectReplay.state.owners)) {
        if (holding.qty > 0) insertOwner.run(address, owner, holding.qty, holding.genId);
      }
      const insertCreator = this.db.prepare(
        'INSERT INTO creators(object_address, creator_address, granted) VALUES(?, ?, ?)',
      );
      for (const [creator, granted] of Object.entries(objectReplay.state.creators)) {
        insertCreator.run(address, creator, granted);
      }
      const insertTransfer = this.db.prepare(
        `INSERT INTO transfers(txid, object_address, action, from_address, to_address, qty, height, block_time)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const transfer of objectReplay.transfers) {
        insertTransfer.run(
          transfer.txid,
          transfer.objectAddress,
          transfer.action,
          transfer.fromAddress,
          transfer.toAddress,
          transfer.qty,
          transfer.height,
          transfer.blockTime,
        );
      }
    } else {
      this.db.prepare('DELETE FROM objects WHERE address = ?').run(address);
    }

    const profile = replayProfile(address, roots);
    if (profileIsLive(profile)) this.writeProfile(address, profile);
    else this.db.prepare('DELETE FROM profiles WHERE address = ?').run(address);
  }

  private writeObject(address: string, state: ObjectState): void {
    const searchable = [
      state.name ?? '',
      state.description ?? '',
      state.urn ?? '',
      state.license ?? '',
      ...Object.entries(state.attributes ?? {}).map(([key, value]) => `${key} ${value}`),
    ]
      .join('\n')
      .toLowerCase();
    const changeTime = state.changeDate ? Date.parse(`${state.changeDate}Z`) || 0 : 0;
    this.db
      .prepare(
        `INSERT INTO objects(address, urn, name, searchable, change_time, state_json)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           urn = excluded.urn,
           name = excluded.name,
           searchable = excluded.searchable,
           change_time = excluded.change_time,
           state_json = excluded.state_json`,
      )
      .run(address, state.urn, state.name, searchable, Math.floor(changeTime / 1000), JSON.stringify(state));
  }

  private writeProfile(address: string, state: ProfileState): void {
    const searchable = [state.urn ?? '', state.displayName ?? '', state.bio ?? '', state.firstName ?? '', state.lastName ?? '']
      .join('\n')
      .toLowerCase();
    const changeTime = state.changeDate ? Date.parse(`${state.changeDate}Z`) || 0 : 0;
    this.db
      .prepare(
        `INSERT INTO profiles(address, urn, searchable, change_time, state_json)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           urn = excluded.urn,
           searchable = excluded.searchable,
           change_time = excluded.change_time,
           state_json = excluded.state_json`,
      )
      .run(address, state.urn, searchable, Math.floor(changeTime / 1000), JSON.stringify(state));
  }

  getObject(address: string): ObjectState | null {
    const row = this.db.prepare('SELECT state_json FROM objects WHERE address = ?').get(address) as
      | { state_json: string }
      | undefined;
    return row ? (JSON.parse(row.state_json) as ObjectState) : null;
  }

  getProfile(address: string): ProfileState | null {
    const row = this.db.prepare('SELECT state_json FROM profiles WHERE address = ?').get(address) as
      | { state_json: string }
      | undefined;
    return row ? (JSON.parse(row.state_json) as ProfileState) : null;
  }

  /**
   * Sup GetObjectByURN looks at roots paid to the keyword address of the URN,
   * then opens the object address stored as the second-to-last keyword.
   * It also ignores an object whose change date is more than three years old.
   */
  getObjectByUrn(urn: string, now = Date.now()): ObjectState | null {
    const keywordAddress = publicAddressByKeyword(urn, this.versionByte);
    const roots = this.rootsForAddress(keywordAddress);
    for (const root of roots) {
      if (!root.signed || !root.fileOrder.includes('OBJ')) continue;
      const candidates =
        root.keywords.length > 1
          ? [root.keywords[root.keywords.length - 2]?.address, root.keywords[root.keywords.length - 1]?.address]
          : [root.keywords[0]?.address];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const state = this.getObject(candidate);
        if (!state?.urn || state.urn !== urn || Object.keys(state.owners).length === 0) continue;
        const firstCreator = Object.keys(state.creators)[0];
        if (firstCreator !== candidate) continue;
        if (!changedWithinYears(state.changeDate, 3, now)) continue;
        return state;
      }
    }
    return null;
  }

  getProfileByUrn(urn: string): ProfileState | null {
    const keywordAddress = publicAddressByKeyword(urn, this.versionByte);
    const roots = this.rootsForAddress(keywordAddress);
    for (const root of roots) {
      if (!root.signed || !root.fileOrder.includes('PRO')) continue;
      const candidates =
        root.keywords.length > 1
          ? [root.keywords[root.keywords.length - 2]?.address, root.keywords[root.keywords.length - 1]?.address]
          : [root.keywords[0]?.address];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const state = this.getProfile(candidate);
        if (state?.urn === urn) return state;
      }
    }
    const row = this.db.prepare('SELECT state_json FROM profiles WHERE urn = ? ORDER BY change_time DESC LIMIT 1').get(urn) as
      | { state_json: string }
      | undefined;
    return row ? (JSON.parse(row.state_json) as ProfileState) : null;
  }

  searchObjects(query: string, skip: number, qty: number): ObjectState[] {
    return this.searchTable('objects', query, skip, qty) as ObjectState[];
  }

  searchProfiles(query: string, skip: number, qty: number): ProfileState[] {
    return this.searchTable('profiles', query, skip, qty) as ProfileState[];
  }

  private searchTable(table: 'objects' | 'profiles', query: string, skip: number, qty: number): unknown[] {
    const all = query === '*' || query === '';
    const like = `%${query.toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const sql = all
      ? `SELECT state_json FROM ${table} ORDER BY change_time DESC, address ASC LIMIT ? OFFSET ?`
      : `SELECT state_json FROM ${table} WHERE searchable LIKE ? ESCAPE '\\' ORDER BY change_time DESC, address ASC LIMIT ? OFFSET ?`;
    const rows = (all
      ? this.db.prepare(sql).all(qty, skip)
      : this.db.prepare(sql).all(like, qty, skip)) as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json));
  }

  objectsOwnedBy(address: string, skip: number, qty: number): ObjectState[] {
    return this.objectsByJoin(
      `SELECT objects.state_json FROM objects
       JOIN ownership ON ownership.object_address = objects.address
       WHERE ownership.owner_address = ? AND ownership.qty > 0
       ORDER BY objects.change_time DESC`,
      address,
      skip,
      qty,
    );
  }

  objectsCreatedBy(address: string, skip: number, qty: number): ObjectState[] {
    return this.objectsByJoin(
      `SELECT objects.state_json FROM objects
       JOIN creators ON creators.object_address = objects.address
       WHERE creators.creator_address = ? AND creators.granted IS NOT NULL AND creators.granted != ''
       ORDER BY objects.change_time DESC`,
      address,
      skip,
      qty,
    );
  }

  private objectsByJoin(sql: string, address: string, skip: number, qty: number): ObjectState[] {
    const rows = this.db.prepare(sql).all(address) as Array<{ state_json: string }>;
    const sliced = qty < 0 ? rows.slice(skip) : rows.slice(skip, skip + qty);
    return sliced.map((row) => JSON.parse(row.state_json) as ObjectState);
  }

  transfersForObject(address: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT txid, object_address, action, from_address, to_address, qty, height, block_time
         FROM transfers WHERE object_address = ? ORDER BY height ASC, id ASC`,
      )
      .all(address) as Array<Record<string, unknown>>;
  }

  objectsForKeyword(keywordAddress: string): ObjectState[] {
    const roots = this.rootsForAddress(keywordAddress);
    const seen = new Set<string>();
    const states: ObjectState[] = [];
    for (const root of roots) {
      if (!root.signed || !root.signedBy || seen.has(root.signedBy)) continue;
      seen.add(root.signedBy);
      const state = this.getObject(root.signedBy);
      if (state && !state.blocked && state.urn) states.push(state);
    }
    return states;
  }

  rootsByAddress(address: string, skip: number, qty: number): DecodedRoot[] {
    const roots = this.rootsForAddress(address);
    return qty < 0 ? roots.slice(skip) : roots.slice(skip, skip + qty);
  }

  listMessages(address: string, priv: boolean, skip: number, qty: number): PublicMessage[] {
    const rows = this.db
      .prepare(
        `SELECT txid, height, block_time, from_address, to_address, body, files_json
         FROM messages
         WHERE private = ? AND (to_address = ? OR from_address = ?)
         ORDER BY height DESC, txid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(priv ? 1 : 0, address, address, qty < 0 ? 5000 : qty, skip) as Array<{
      txid: string;
      height: number;
      block_time: number;
      from_address: string;
      to_address: string;
      body: string;
      files_json: string;
    }>;
    return rows.map((row) => ({
      txid: row.txid,
      height: row.height,
      blockTime: row.block_time,
      fromAddress: row.from_address,
      toAddress: row.to_address,
      message: row.body,
      private: priv,
      files: JSON.parse(row.files_json) as Record<string, number>,
    }));
  }

  searchRoots(query: string, skip: number, qty: number): DecodedRoot[] {
    const rows = this.db.prepare('SELECT body FROM roots ORDER BY height DESC, tx_index DESC').all() as Array<{ body: string }>;
    const needle = query === '*' || query === '' ? '' : query.toLowerCase();
    const matched = rows
      .map((row) => decodeStoredRoot(row.body))
      .filter((root) => {
        if (!needle) return true;
        const hay = [
          root.transactionId,
          root.signedBy,
          root.message.join('\n'),
          ...root.fileOrder,
          ...root.keywords.map((keyword) => keyword.text),
        ]
          .join('\n')
          .toLowerCase();
        return hay.includes(needle);
      });
    return qty < 0 ? matched.slice(skip) : matched.slice(skip, skip + qty);
  }
}

export function rootJson(root: DecodedRoot, indexedHeight: number | null): Record<string, unknown> {
  const confirmations =
    root.blockHeight > 0 && indexedHeight !== null ? Math.max(0, indexedHeight - root.blockHeight + 1) : root.confirmations;
  const keywords: Record<string, string> = {};
  for (const keyword of root.keywords) keywords[keyword.address] = keyword.text;
  const outputs: Record<string, string> = {};
  for (const output of root.outputs) outputs[output.address] = output.value;
  return {
    Id: -1,
    Message: root.message,
    File: fileSizes(root),
    Keyword: keywords,
    Output: outputs,
    Hash: root.hash,
    SignedBy: root.signedBy,
    Signature: root.signature,
    Signed: root.signed,
    TransactionId: root.transactionId,
    BlockDate: isoUtc(root.blockTime),
    BlockHeight: root.blockHeight,
    TotalByteSize: root.totalByteSize,
    Confirmations: confirmations,
    BuildDate: new Date().toISOString(),
    Cached: true,
  };
}

export function objectJson(state: ObjectState): Record<string, unknown> {
  const owners: Record<string, { Item1: number; Item2: string | null }> = {};
  for (const [address, holding] of Object.entries(state.owners)) {
    owners[address] = { Item1: holding.qty, Item2: holding.genId };
  }
  return {
    Id: state.id,
    TransactionId: state.transactionId,
    URN: state.urn,
    URI: state.uri,
    Image: state.image,
    Name: state.name,
    Description: state.description,
    Attributes: state.attributes,
    License: state.license,
    Maximum: state.maximum,
    Creators: state.creators,
    Owners: owners,
    Royalties: state.royalties,
    Offers: state.offers.map((offer) => ({
      Requestor: offer.requestor,
      Owner: offer.owner,
      Qty: offer.qty,
      Value: offer.value,
      BlockDate: offer.blockDate,
    })),
    Listings: Object.fromEntries(
      Object.entries(state.listings).map(([address, listing]) => [
        address,
        {
          Requestor: listing.requestor,
          Owner: listing.owner,
          Qty: listing.qty,
          Value: listing.value,
          BlockDate: listing.blockDate,
        },
      ]),
    ),
    LockedDate: state.lockedDate,
    ProcessHeight: state.processHeight,
    CreatedDate: state.createdDate,
    ChangeDate: state.changeDate,
    ChangeLog: state.changeLog,
    Verbose: true,
  };
}

export function profileJson(state: ProfileState): Record<string, unknown> {
  return {
    Id: state.id,
    URN: state.urn,
    DisplayName: state.displayName,
    FirstName: state.firstName,
    MiddleName: state.middleName,
    LastName: state.lastName,
    Suffix: state.suffix,
    Bio: state.bio,
    Image: state.image,
    URL: state.url,
    Location: state.location,
    PKX: state.pkx,
    PKY: state.pky,
    Creators: state.creators,
    ProcessHeight: state.processHeight,
    CreatedDate: state.createdDate,
    ChangeDate: state.changeDate,
  };
}
