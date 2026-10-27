import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import { objectJson, profileJson, rootJson, type Store } from '../db/store.ts';
import { keywordByPublicAddress, publicAddressByKeyword } from '../p2fk/keywords.ts';
import type { BlockchainRpc } from '../rpc/client.ts';

const ADDRESS = /^[a-zA-Z0-9][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

function send(response: ServerResponse, status: number, body: unknown, origin: string): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Content-Type',
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function page(url: URL, fallbackQty: number): { skip: number; qty: number } {
  const skip = Math.max(0, Number(url.searchParams.get('skip') ?? '0') || 0);
  const rawQty = url.searchParams.get('qty');
  const qty = rawQty === null || rawQty === '' ? fallbackQty : Number(rawQty);
  return { skip: Number.isFinite(skip) ? skip : 0, qty: Number.isFinite(qty) ? qty : fallbackQty };
}

function searchPage(url: URL): { skip: number; qty: number } | { error: string } {
  const { skip, qty } = page(url, 200);
  const clampedSkip = Math.min(4999, Math.max(0, skip));
  let clampedQty = Math.min(5000, Math.max(1, qty));
  clampedQty = Math.min(clampedQty, 5000 - clampedSkip);
  if (clampedQty < 1) return { error: 'skip is past the last page' };
  return { skip: clampedSkip, qty: clampedQty };
}

type ChainCheck = 'ok' | 'empty' | 'invalid';

function chainCheck(url: URL): ChainCheck {
  const blockchain = url.searchParams.get('blockchain');
  if (blockchain && !['BTC', 'LTC', 'DOG', 'MZC'].includes(blockchain)) return 'invalid';
  if (blockchain && blockchain !== 'DOG') return 'empty';
  if (url.searchParams.get('mainnet') === 'false') return 'empty';
  return 'ok';
}

async function health(rpc: BlockchainRpc, store: Store, config: Config): Promise<Record<string, unknown>> {
  const indexedHeight = store.indexedHeight();
  let nodeHeight: number | null = null;
  let rpcError: string | null = null;
  try {
    nodeHeight = await rpc.getBlockCount();
  } catch (error) {
    rpcError = error instanceof Error ? error.message : 'The Dogecoin node did not answer.';
  }
  const waiting = nodeHeight !== null && nodeHeight < config.startHeight;
  const behind = nodeHeight === null || indexedHeight === null ? null : Math.max(0, nodeHeight - indexedHeight);
  return {
    ok: rpcError === null,
    chain: 'DOG',
    versionByte: config.versionByte,
    nodeHeight,
    indexedHeight,
    startHeight: config.startHeight,
    blocksBehind: behind,
    waitingForStartHeight: waiting,
    rootCount: store.rootCount(),
    objectCount: store.objectCount(),
    profileCount: store.profileCount(),
    dbPath: config.dbPath,
    rpc: rpcError ? 'error' : 'connected',
    rpcError,
  };
}

export function createApi(rpc: BlockchainRpc, store: Store, config: Config): Server {
  const origin = config.corsOrigin || '*';
  return createServer((request, response) => {
    void handle(request, response, rpc, store, config, origin);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  rpc: BlockchainRpc,
  store: Store,
  config: Config,
  origin: string,
): Promise<void> {
  if (request.method === 'OPTIONS') {
    send(response, 204, {}, origin);
    return;
  }
  if (request.method !== 'GET') {
    send(response, 405, { error: 'This indexer is read-only.' }, origin);
    return;
  }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${config.port}`);
  const path = decodeURIComponent(url.pathname);
  try {
    if (path === '/health') {
      send(response, 200, await health(rpc, store, config), origin);
      return;
    }
    const chain = chainCheck(url);
    if (chain === 'invalid') {
      send(response, 200, ['invalid blockchain parameter, valid values are BTC, LTC, DOG, MZC'], origin);
      return;
    }
    if (path === '/GetPublicAddressByKeyword') {
      const keyword = url.searchParams.get('keyword') ?? '';
      send(response, 200, { address: keyword ? publicAddressByKeyword(keyword, config.versionByte) : null }, origin);
      return;
    }
    const keywordAddress = path.match(/^\/GetKeywordByPublicAddress\/([^/]+)$/);
    if (keywordAddress) {
      const address = keywordAddress[1] ?? '';
      if (!ADDRESS.test(address)) {
        send(response, 200, ['invalid address format'], origin);
        return;
      }
      try {
        send(response, 200, { keyword: keywordByPublicAddress(address) }, origin);
      } catch {
        send(response, 200, ['invalid address format'], origin);
      }
      return;
    }
    if (chain === 'empty') {
      send(response, 200, pathIncludesList(path) ? [] : {}, origin);
      return;
    }
    const routed = route(path, url, store, config);
    if (routed === undefined) {
      send(response, 404, { error: 'No such path. See docs/API.md.' }, origin);
      return;
    }
    send(response, 200, routed, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    send(response, 500, { error: message }, origin);
  }
}

function pathIncludesList(path: string): boolean {
  return (
    path.startsWith('/GetKnown') ||
    path.startsWith('/GetObjects') ||
    path.startsWith('/GetRoots') ||
    path.startsWith('/GetPublicMessages') ||
    path.startsWith('/GetPrivateMessages') ||
    path.startsWith('/GetTransfers')
  );
}

function route(path: string, url: URL, store: Store, config: Config): unknown {
  const indexed = store.indexedHeight();
  const objectAddress = path.match(/^\/GetObjectByAddress\/([^/]+)$/);
  if (objectAddress) {
    const address = objectAddress[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const state = store.getObject(address);
    return state ? objectJson(state) : {};
  }
  if (path.startsWith('/GetObjectByURN/')) {
    const urn = path.slice('/GetObjectByURN/'.length).replaceAll('%2F', '/');
    const state = store.getObjectByUrn(urn || (url.searchParams.get('urn') ?? ''));
    return state ? objectJson(state) : {};
  }
  const objectTx = path.match(/^\/GetObjectByTransactionID\/([^/]+)$/);
  if (objectTx) {
    const root = store.getRoot(objectTx[1] ?? '');
    if (!root) return {};
    const state = store.getObject(root.signedBy);
    return state ? objectJson(state) : {};
  }
  const owned = path.match(/^\/GetObjectsOwnedByAddress\/([^/]+)$/);
  if (owned) {
    const address = owned[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const { skip, qty } = page(url, -1);
    return store.objectsOwnedBy(address, skip, qty).map(objectJson);
  }
  const created = path.match(/^\/GetObjectsCreatedByAddress\/([^/]+)$/);
  if (created) {
    const address = created[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const { skip, qty } = page(url, -1);
    return store.objectsCreatedBy(address, skip, qty).map(objectJson);
  }
  const byAddress = path.match(/^\/GetObjectsByAddress\/([^/]+)$/);
  if (byAddress) {
    const address = byAddress[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const { skip, qty } = page(url, -1);
    const merged = new Map<string, ReturnType<typeof objectJson>>();
    const self = store.getObject(address);
    if (self) merged.set(self.transactionId || address, objectJson(self));
    for (const state of store.objectsOwnedBy(address, 0, -1)) merged.set(state.transactionId || state.urn || '', objectJson(state));
    for (const state of store.objectsCreatedBy(address, 0, -1)) merged.set(state.transactionId || state.urn || '', objectJson(state));
    const list = [...merged.values()];
    return qty < 0 ? list.slice(skip) : list.slice(skip, skip + qty);
  }
  if (path === '/GetObjectsByKeyword' || path.startsWith('/GetObjectsByKeyword/')) {
    const keyword = url.searchParams.get('keyword') ?? path.slice('/GetObjectsByKeyword/'.length);
    const { skip, qty } = page(url, -1);
    const states = store.objectsForKeyword(publicAddressByKeyword(keyword, config.versionByte)).map(objectJson);
    return qty < 0 ? states.slice(skip) : states.slice(skip, skip + qty);
  }
  if (path === '/GetKnownObjectsBySearchString') {
    const paging = searchPage(url);
    if ('error' in paging) return [paging.error];
    const query = url.searchParams.get('searchString') ?? '';
    if (query.length > 2048) return ['invalid search string'];
    return store.searchObjects(query, paging.skip, paging.qty).map(objectJson);
  }
  const profileAddress = path.match(/^\/GetProfileByAddress\/([^/]+)$/);
  if (profileAddress) {
    const address = profileAddress[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const state = store.getProfile(address);
    return state ? profileJson(state) : {};
  }
  if (path.startsWith('/GetProfileByURN/')) {
    const urn = path.slice('/GetProfileByURN/'.length);
    const state = store.getProfileByUrn(urn);
    return state ? profileJson(state) : {};
  }
  if (path === '/GetKnownProfilesBySearchString') {
    const paging = searchPage(url);
    if ('error' in paging) return [paging.error];
    const query = url.searchParams.get('searchString') ?? '';
    if (query.length > 2048) return ['invalid search string'];
    return store.searchProfiles(query, paging.skip, paging.qty).map(profileJson);
  }
  const rootTx = path.match(/^\/GetRootByTransactionID\/([^/]+)$/);
  if (rootTx) {
    const root = store.getRoot(rootTx[1] ?? '');
    return root ? rootJson(root, indexed) : {};
  }
  const roots = path.match(/^\/GetRootsByAddress\/([^/]+)$/);
  if (roots) {
    const address = roots[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const { skip, qty } = page(url, -1);
    return store.rootsByAddress(address, skip, qty).map((root) => rootJson(root, indexed));
  }
  if (path === '/GetKnownRootsBySearchString') {
    const paging = searchPage(url);
    if ('error' in paging) return [paging.error];
    const query = url.searchParams.get('searchString') ?? '';
    if (query.length > 2048) return ['invalid search string'];
    return store.searchRoots(query, paging.skip, paging.qty).map((root) => rootJson(root, indexed));
  }
  const publicMessages = path.match(/^\/GetPublicMessagesByAddress\/([^/]+)$/);
  if (publicMessages) {
    const address = publicMessages[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const { skip, qty } = page(url, 10);
    return store.listMessages(address, false, skip, qty);
  }
  const privateMessages = path.match(/^\/GetPrivateMessagesByAddress\/([^/]+)$/);
  if (privateMessages) {
    const address = privateMessages[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    const { skip, qty } = page(url, 10);
    return store.listMessages(address, true, skip, qty);
  }
  const transfers = path.match(/^\/GetTransfersByObject\/([^/]+)$/);
  if (transfers) {
    const address = transfers[1] ?? '';
    if (!ADDRESS.test(address)) return ['invalid address format'];
    return store.transfersForObject(address);
  }
  return undefined;
}

export function listen(server: Server, config: Config): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindHost, () => resolve());
  });
}
