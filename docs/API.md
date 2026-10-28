# HTTP API

Base URL on this computer: `http://127.0.0.1:8080`

GET and OPTIONS only. Anything else returns `405` and `{ "error": "This indexer is read-only." }`.

CORS uses `CORS_ORIGIN` from `.env`. The default `*` allows a browser on this computer. For the Forge site, set `https://neptunemonk.github.io`.

Responses are JSON. Unknown paths return `404` and `{ "error": "No such path. See docs/API.md." }`.

## Chain filter

Most routes accept the same query Sup's public indexer uses:

- `blockchain` — `BTC`, `LTC`, `DOG`, or `MZC`. Omitted means Dogecoin. `BTC`, `LTC`, and `MZC` return an empty object or an empty list, because this process only has a Dogecoin node. Any other value returns:

  `["invalid blockchain parameter, valid values are BTC, LTC, DOG, MZC"]`

- `mainnet=false` returns an empty object or an empty list. This node is mainnet.

`/health` ignores those parameters.

## Paging

`skip` is how many matches to pass over. `qty` is how many to return.

Search routes (`GetKnownObjectsBySearchString`, `GetKnownProfilesBySearchString`, `GetKnownRootsBySearchString`) default to `qty=200`. `skip` is kept between 0 and 4999. `qty` is kept between 1 and 5000, and it is cut so `skip + qty` does not pass 5000.

Owned, created, and keyword object routes default to all matches (`qty` omitted or negative).

Message routes default to `qty=10`.

## Health

`GET /health`

```json
{
  "ok": true,
  "chain": "DOG",
  "versionByte": 30,
  "nodeHeight": "<node tip height>",
  "indexedHeight": "<highest saved block>",
  "startHeight": 0,
  "blocksBehind": "<nodeHeight minus indexedHeight>",
  "waitingForStartHeight": false,
  "rootCount": 0,
  "objectCount": 0,
  "profileCount": 0,
  "dbPath": "/app/data/meowecoin-indexer.sqlite",
  "rpc": "connected",
  "rpcError": null
}
```

Values in angle brackets are placeholders. The real response has numbers there.

`ok` is false and `rpc` is `"error"` when the node does not answer. `rpcError` is the message. `indexedHeight` is null until the first block is saved.

## Keyword helpers

`GET /GetPublicAddressByKeyword?keyword=meowecoin`

```json
{ "address": "D..." }
```

The address uses `VERSION_BYTE` (30 on Dogecoin mainnet). The keyword is padded or cut to 20 bytes with `#`, then Base58Check-encoded, matching `Root.GetPublicAddressByKeyword`.

`GET /GetKeywordByPublicAddress/{address}`

```json
{ "keyword": "meowecoin" }
```

A bad address returns `["invalid address format"]`.

## Objects

`GET /GetObjectByAddress/{address}`

One object, or `{}` when there is none. A bad address returns `["invalid address format"]`.

```json
{
  "Id": 1,
  "TransactionId": "hex",
  "URN": "forge-hammer",
  "URI": null,
  "Image": null,
  "Name": "Hammer",
  "Description": null,
  "Attributes": null,
  "License": null,
  "Maximum": 2,
  "Creators": { "DObjectAddress": "2026-10-27T00:00:00" },
  "Owners": {
    "DOwnerAddress": { "Item1": 1, "Item2": null }
  },
  "Royalties": { "DRoyaltyAddress": 5 },
  "Offers": [],
  "Listings": {},
  "LockedDate": null,
  "ProcessHeight": 1,
  "CreatedDate": "2026-10-27T00:00:00",
  "ChangeDate": "2026-10-27T00:00:00",
  "ChangeLog": [],
  "Verbose": true
}
```

`Owners` uses `Item1` (units) and `Item2` (generation id) because that is how Sup serializes the owner tuple.

There is no sale price on this object. A listing's `Value` is the amount in the `LST` record. This API does not add a fee or a markup.

`GET /GetObjectByURN/{urn}`

Same object shape, or `{}`. The URN follows Sup's keyword lookup and the 3-year window described in [ARCHITECTURE.md](ARCHITECTURE.md).

`GET /GetObjectByTransactionID/{txid}`

The live object whose address is the `SignedBy` of that root, or `{}`.

`GET /GetObjectsOwnedByAddress/{address}?skip=0&qty=50`

`GET /GetObjectsCreatedByAddress/{address}?skip=0&qty=50`

`GET /GetObjectsByAddress/{address}`

The object at that address, objects that address owns, and objects that address created, with duplicates removed. See the note in [ARCHITECTURE.md](ARCHITECTURE.md).

`GET /GetObjectsByKeyword?keyword=hammer`

`GET /GetObjectsByKeyword/{keyword}`

Live objects whose signing root paid that keyword address.

`GET /GetKnownObjectsBySearchString?searchString=hammer&qty=200&skip=0&blockchain=DOG`

`searchString=*` or an empty string returns every live object, paged. The match is a case-insensitive substring of the name, description, URN, and creator and owner addresses. A search longer than 2048 characters returns `["invalid search string"]`.

## Profiles

`GET /GetProfileByAddress/{address}`

`GET /GetProfileByURN/{urn}`

```json
{
  "Id": 1,
  "URN": "neptune",
  "DisplayName": "Neptune",
  "FirstName": null,
  "MiddleName": null,
  "LastName": null,
  "Suffix": null,
  "Bio": null,
  "Image": null,
  "URL": null,
  "Location": null,
  "PKX": "hex",
  "PKY": "hex",
  "Creators": {},
  "ProcessHeight": 1,
  "CreatedDate": "2026-10-27T00:00:00",
  "ChangeDate": "2026-10-27T00:00:00"
}
```

`{}` when the profile is missing or was moved off that address.

`GET /GetKnownProfilesBySearchString?searchString=*&qty=200&skip=0`

Same paging rules as objects. The match covers URN, display name, and bio.

## Roots

`GET /GetRootByTransactionID/{txid}`

`GET /GetRootsByAddress/{address}?skip=0&qty=20`

`GET /GetKnownRootsBySearchString?searchString=*&qty=200&skip=0`

```json
{
  "Id": -1,
  "Message": [],
  "File": { "SIG": 88, "OBJ": 120 },
  "Keyword": { "DAddress": "keyword text" },
  "Output": { "DAddress": "0.00000546" },
  "Hash": "ABC...",
  "SignedBy": "DAddress",
  "Signature": "base64",
  "Signed": true,
  "TransactionId": "hex",
  "BlockDate": "<block date, UTC>",
  "BlockHeight": "<block height>",
  "TotalByteSize": 250,
  "Confirmations": 12,
  "BuildDate": "<time this root was decoded, UTC>",
  "Cached": true
}
```

`File` is name to size in bytes. The file bytes themselves are kept in the database and are not returned by this route. `Id` is `-1` because this indexer does not use Sup's numeric root cache id.

## Messages and transfers

`GET /GetPublicMessagesByAddress/{address}?skip=0&qty=10`

`GET /GetPrivateMessagesByAddress/{address}?skip=0&qty=10`

```json
[
  {
    "txid": "hex",
    "fromAddress": "DFrom",
    "toAddress": "DTo",
    "message": "minted on doge",
    "blockTime": "<block time, unix seconds>",
    "height": "<block height>",
    "private": false,
    "files": { "SIG": 88, "OBJ": 40 }
  }
]
```

Private rows have `"private": true` and `"message": "<UNABLE TO DECRYPT>"`.

`GET /GetTransfersByObject/{address}`

```json
[
  {
    "txid": "hex",
    "object_address": "DObject",
    "action": "claim",
    "from_address": "",
    "to_address": "DOwner",
    "qty": 2,
    "height": "<block height>",
    "block_time": "<block time, unix seconds>"
  }
]
```

`action` is `claim`, `give`, `buy`, or `burn`.
