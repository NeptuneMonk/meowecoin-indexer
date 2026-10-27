export interface ChainOutput {
  address: string;
  sats: bigint;
}

export interface ChainTransaction {
  txid: string;
  size: number;
  outputs: ChainOutput[];
}

export interface KeywordEntry {
  address: string;
  /** UTF-8 of the version byte plus the 20 payload bytes. Matches Sup's Keyword value. */
  text: string;
  payload: Buffer;
}

export interface DecodedRoot {
  isP2fk: boolean;
  message: string[];
  fileOrder: string[];
  files: Record<string, Buffer>;
  keywords: KeywordEntry[];
  outputs: Array<{ address: string; value: string }>;
  hash: string;
  signedBy: string;
  signature: string;
  signed: boolean;
  transactionId: string;
  blockTime: number;
  blockHeight: number;
  txIndex: number;
  totalByteSize: number;
  confirmations: number;
  /** True when a 64-hex file name was treated as a ledger of other transactions. */
  ledger: boolean;
}

export interface DecodeContext {
  versionByte: number;
  blockTime: number;
  blockHeight: number;
  txIndex: number;
  confirmations: number;
  /** Load another transaction when a file name is a ledger of transaction ids. */
  loadTransaction?: (txid: string) => ChainTransaction | null;
  /** Dogecoin Core verifymessage. When omitted, Signed stays false. */
  verifyMessage?: (address: string, signature: string, hashHex: string) => boolean;
}

export interface ObjectState {
  id: number;
  transactionId: string;
  urn: string | null;
  uri: string | null;
  image: string | null;
  name: string | null;
  description: string | null;
  attributes: Record<string, string> | null;
  license: string | null;
  maximum: number;
  creators: Record<string, string | null>;
  owners: Record<string, { qty: number; genId: string | null }>;
  royalties: Record<string, number>;
  offers: Offer[];
  listings: Record<string, Listing>;
  lockedDate: string | null;
  processHeight: number;
  createdDate: string | null;
  changeDate: string | null;
  changeLog: string[];
  blocked: boolean;
}

export interface Offer {
  requestor: string;
  owner: string;
  qty: number;
  value: number;
  blockDate: string;
}

export interface Listing {
  requestor: string;
  owner: string;
  qty: number;
  value: number;
  blockDate: string;
}

export interface ProfileState {
  id: number;
  urn: string | null;
  displayName: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  suffix: string | null;
  bio: string | null;
  image: string | null;
  url: Record<string, string> | null;
  location: Record<string, string> | null;
  pkx: string | null;
  pky: string | null;
  creators: string[];
  processHeight: number;
  createdDate: string | null;
  changeDate: string | null;
  /** Set when a creator transfer moved the profile off this address. */
  moved: boolean;
}

export interface TransferEvent {
  txid: string;
  objectAddress: string;
  action: 'claim' | 'give' | 'buy' | 'burn';
  fromAddress: string;
  toAddress: string;
  qty: number;
  blockTime: number;
  height: number;
}

export interface PublicMessage {
  txid: string;
  fromAddress: string;
  toAddress: string;
  message: string;
  blockTime: number;
  height: number;
  private: boolean;
  files: Record<string, number>;
}
