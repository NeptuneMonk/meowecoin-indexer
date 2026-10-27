# Architecture

This service is a read-only Dogecoin indexer for Meowecoin P2FK records. One process scans the node and serves HTTP. There is no wallet and no private key.

The record format is the one Sup uses on Bitcoin. Decoding follows those files. It is not a new format.

## Sources followed

| What | File |
| --- | --- |
| Root bytes, dust amounts, file packets, keywords, signature hash, ledger | [Sup `P2FK/contracts/Root.cs`](https://github.com/embiimob/Sup/blob/master/P2FK/contracts/Root.cs) |
| Base58Check, checksum not verified on decode | [Sup `P2FK/classes/Base58.cs`](https://github.com/embiimob/Sup/blob/master/P2FK/classes/Base58.cs) |
| SHA-256 | [Sup `P2FK/classes/SHA256.cs`](https://github.com/embiimob/Sup/blob/master/P2FK/classes/SHA256.cs) |
| RPC transaction shape (`value`, `scriptPubKey.addresses`) | [Sup `P2FK/classes/BlockchainRPC.cs`](https://github.com/embiimob/Sup/blob/master/P2FK/classes/BlockchainRPC.cs) and `BlockchainRPC.Methods.cs` |
| OBJ, GIV, BRN, BUY, LST, owners, royalties | [Sup `P2FK/contracts/OBJ.cs`](https://github.com/embiimob/Sup/blob/master/P2FK/contracts/OBJ.cs) |
| PRO profiles, PKX, PKY | [Sup `P2FK/contracts/PRO.cs`](https://github.com/embiimob/Sup/blob/master/P2FK/contracts/PRO.cs) |
| Sample JSON field names | [Sup `P2FK/samples/`](https://github.com/embiimob/Sup/tree/master/P2FK/samples) |
| Output order of a mint: files, keywords, royalties, owners, creators, object address, signature address last | [Sup `ObjectMint.cs`](https://github.com/embiimob/Sup/blob/master/ObjectMint.cs) |
| Public and private message encoding | [Sup `DiscoBall.cs`](https://github.com/embiimob/Sup/blob/master/DiscoBall.cs) |
| Profile mint and PKX/PKY | [Sup `ProfileMint.cs`](https://github.com/embiimob/Sup/blob/master/ProfileMint.cs) |
| HTTP path names and `blockchain` / `mainnet` filters | [p2fk.io](https://github.com/embiimob/p2fk.io) controllers and `Wrapper.cs` (Dogecoin version byte 30, RPC port 22555) |
| Portal object and profile fields the API should be able to fill | [meowcoin-portal `docs/ARCHITECTURE.md`](https://github.com/NeptuneMonk/meowcoin-portal/blob/main/docs/ARCHITECTURE.md) and `src/services/types.ts` |

A real Bitcoin transaction checked the decoder: `e2a5e084e08c468f94c463211dd79b031790f6244702dcd7ab72e88649d34635` ("space tree water", block 822459). The hash, signature, SIG and OBJ sizes, keyword order, and name match the root p2fk.io published. The fixture is `test/fixtures/space-tree-water.json`. That test uses version byte 0, which is Bitcoin. Dogecoin mainnet uses version byte 30.

## Scan

`src/indexer/scan.ts` asks the node for the tip, then reads blocks from `START_HEIGHT` (default `6400000`, early October 2026) up to the tip, `BATCH_BLOCKS` at a time (default 20). It sleeps `POLL_MS` (default 15 seconds) and repeats.

Confirmed blocks only. The mempool is not indexed.

Each block is saved only after every transaction in it has been decoded. A crash in the middle of a block reads that block again. Restart continues from the highest saved block height.

`txindex=1` is required. `getrawtransaction` must return transactions that are not in the wallet.

Dogecoin Core **1.14.6** is required. Output order is the record. A newer Core reorders `sendmany` outputs and the payload no longer lines up.

## Reorgs

If the saved height is above the node's tip, those blocks are deleted.

Otherwise the scanner walks backward, up to 500 blocks, and compares `getblockhash` with the saved hash. A hash the node does not have counts as a mismatch. It rewinds to the last matching block and scans forward again.

While scanning, if a new block's previous hash does not match the saved parent, it rewinds and returns. The next pass reads the new chain.

Derived objects, profiles, ownership, and messages for the touched addresses are rebuilt from the roots that remain.

## Root decoding

`src/p2fk/decodeRoot.ts` follows `Root.GetRootByTransactionId`.

Outputs are read **in order**. An output counts only when its amount is one of the dust strings in `Root.cs`:

`0.00000001`, `0.00000546`, `0.00000548`, `0.00005480`, `0.00000550`, `0.00005500`, `0.00001000`, `0.01000000`, `0.02000000`, and `1`.

Dogecoin Core prints amounts with 8 decimals, so 1 DOGE is `1.00000000` and 546 koinu is `0.00000546`. The matcher accepts the fixed 8-decimal form and the form with trailing zeros removed, so both `1` and `1.00000000` count. Standard payload dust is 546 koinu.

Each dust output contributes 20 bytes: Base58Check-decode the address and drop the version byte. `Base58.DecodeWithCheckSum` does not check the checksum. This decoder does the same.

The last dust address is `SignedBy`.

A change output that is not dust is skipped. It does not contribute bytes. The space-tree transaction has a `0.01952618` change output between payload outputs. The decoder skips it.

If any output has no address, or two payload outputs share an address, the whole root is dropped. Sup builds a `Dictionary` keyed by address and skips the transaction when that throws. Sup cannot put the same 20 bytes twice in one `sendmany`.

### Packets

The byte string is a sequence of packets, copied from `Root.cs`:

`NAME`, one separator (`\ / : * ? " < > |`), a decimal size, the same separator, then that many bytes.

An empty name with length greater than 1 is a message (UTF-8).

`SIG` is the first file. `ObjectMint` prepends it. The signature hash is one SHA-256 of the bytes **after** the SIG packet through the last file or message, as uppercase hex. The node then runs `verifymessage` with `SignedBy`, the signature, and that hex. The Dogecoin message prefix stays inside the node. This program does not reimplement it.

A repeated signature (SHA-256 of the signature string) is ignored, matching Sup's replay check.

Keywords are the leftover bytes, realigned to 20. If the leftover length is greater than 20, the prefix `length % 20` is dropped, which drops the `#` padding Sup adds. Each 20 bytes is prefixed with the chain version byte and Base58Check-encoded. Keyword index 0 is the **last** keyword (`Dictionary` reverse in `Root.cs`), and that address is the signature address.

`GetPublicAddressByKeyword` pads or cuts UTF-8 to 20 bytes with `#` (`0x23`). `GetKeywordByPublicAddress` drops the version byte and the `#` padding.

The command file is the **second** file (`File.ElementAtOrDefault(1)`): `SIG`, then `OBJ`, `GIV`, `BRN`, `BUY`, or `LST`. A profile is a root whose file map contains `PRO`. It does not use that second-file switch. Commands must be signed.

A file whose name is exactly 64 hex characters is a ledger. If those transaction ids can be loaded, their dust bytes replace the payload (`GetRootBytesByLedger`). Unresolved ledger ids stay as a normal file. The scan preloads those ids and decodes once more. Depth is capped at 4.

## Objects and profiles

`src/p2fk/objectState.ts` replays signed roots for one address in chain order.

- `OBJ` sets name, description, URN, URI, image, attributes, license, maximum, creators, owners, and royalties. `cre`, `own`, and `roy` may be addresses or keyword indexes, as in the samples. The first creator must be this object's address, as a literal or as an index, or the mint is ignored. Sup clears `cre` after the first creator pass so the same JSON does not also run the creator-replace branch. This replay does the same.
- `GIV` moves units and locks the object.
- `BRN` burns units. Burning the last unit blocks the object. Sup writes a `BLOCK` file for that. The object is then no longer returned as live.
- `LST` lists units and locks the object.
- `BUY` requires the object address at output index `count-2` or `count-3`, and requires the royalty outputs and the seller to be paid. Units then move. A buy that does not match a listing is stored as an offer. That offer branch is shorter than the full C# branch.

Creators and owners that are numbers in sample JSON are turned into strings so the index lookup still works. Etched chain JSON is plain JSON. The sample files also contain comments, which are not part of the chain encoding.

`max` is applied only when the key is present. Sup's `long` defaults to 0 when the field is missing, so `{ "lic": "CC0" }` would set the maximum to 0. The sample comment describes that JSON as a field update. This indexer keeps the previous maximum when `max` is omitted. That difference is deliberate and listed below.

A live object has a URN, at least one owner, and is not blocked.

`src/p2fk/profileState.ts` replays `PRO` roots. The first claim is kept only when `SignedBy` is the profile address. One different creator moves the profile off the address and the old address is no longer live. PKX and PKY are stored. They are not used to decrypt anything.

URN lookup follows Sup's object-by-URN rule: keyword address of the URN string, signed `OBJ` roots, try the second-to-last keyword and then the last, the object URN must match, owners must be non-empty, the first creator must be the candidate, and the change date must be inside 3 calendar years. Lookup by address does not use that window.

A previous-claim check in Sup looks at other chains when the version byte is not 111 and the URN is not IPFS. This indexer only searches its own database. A missing referenced root is not treated as a conflicting claim. There is no Bitcoin, Litecoin, or Mazacoin node here.

`ProcessHeight` is how many roots for that address have been applied, in chain order. It is not Sup's `searchrawtransactions` skip cursor.

## Messages

Public messages are roots with a message packet. `From` is `SignedBy`. `To` is the second-to-last keyword, or the only keyword when there is one (`OBJ.GetPublicMessagesByAddress`).

Private messages are roots with a `SEC` file. Sup decrypts them with the profile private key. This program has no keys. The body is `<UNABLE TO DECRYPT>`, which is what Sup shows when decrypt fails. The ciphertext stays inside the root file bytes.

`INQ` may be stored as a file on the root. There is no separate poll state in this version.

## Database

SQLite, WAL mode, one file (`DB_PATH`, default `./data/meowecoin-indexer.sqlite`). Tables: `blocks`, `roots`, `root_outputs`, `objects`, `ownership`, `creators`, `profiles`, `transfers`, `messages`.

Deleting the file and starting again rebuilds from `START_HEIGHT`. Lowering `START_HEIGHT` after blocks are saved does not walk backward. Delete the file first.

## HTTP

`src/api/server.ts` is GET and OPTIONS only. Any other method is `405`. The default bind is `127.0.0.1`. Docker Compose sets `BIND_HOST=0.0.0.0` inside the container and publishes the port only on `127.0.0.1` of the host.

`/health` reports the node height and the indexed height. See [API.md](API.md).

## Open questions

These are the places this version does not claim to match Sup byte for byte, or where Dogecoin still needs a real Forge transaction to confirm.

1. Dust value `1` in `Root.cs` versus Core's `1.00000000`. Both are accepted. A real 1 DOGE payload output on 1.14.6 should be checked on mainnet.
2. Private `SEC` bodies are never decrypted.
3. Cross-chain "someone already claimed this URN" checks search only this Dogecoin index.
4. `INQ` is kept as a file, not as poll state.
5. Object-by-URN uses Sup's 3-year change-date window. Address lookup does not.
6. `max` is updated only when the JSON key is present. Sup's omitted `long` becomes 0.
7. The mempool is not indexed. A record appears after it is in a block.
8. Scanning from height 0 is a full chain read and is slow.
9. Dogecoin Core must stay on 1.14.6 so output order is stable.
10. Duplicate 20-byte chunks cannot appear in one Sup transaction. A root with a repeated payload address is skipped.
11. `GetObjectsByAddress` returns the object at that address, plus objects it owns, plus objects it created. That is the useful set for the portal. It is not a line-by-line port of Sup's keyword walk for that method.
12. Some `BUY` offer edges, and the culture-specific `DateTime` strings Sup writes into the change log, can differ from the C# program. Change dates in the API are UTC timestamps without a `Z`, close to Newtonsoft's `DateTime` JSON.
13. `scriptPubKey.addresses` from Core 1.14 is read. A newer `address` field is also accepted if it is present.
14. Confirmations are `indexedHeight - blockHeight + 1` at read time, using this indexer's tip rather than a fresh RPC call on every object.
