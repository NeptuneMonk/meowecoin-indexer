# Replacing the portal's mock indexer

This note is for the next change in [meowcoin-portal](https://github.com/NeptuneMonk/meowcoin-portal). Do not do that change in the indexer repo. The portal demo stays as it is until that work.

The portal already keeps chain calls behind one function. `src/services/createServices.ts` builds a `MockIndexer` and passes it out as `indexer`. Screens call `IndexerService` (`getProfilesSnapshot` and `getItemsSnapshot` in `src/services/types.ts` and `src/services/hooks.ts`). They do not call Dogecoin.

When the live indexer is ready, replace `MockIndexer` in `createServices.ts` with a small client that GETs this API. Leave the page components alone.

The indexer listens on `http://127.0.0.1:8080` by default. A browser page on another origin needs `CORS_ORIGIN` set to that origin, for example `https://neptunemonk.github.io`. A server-side portal call does not need CORS.

Use `blockchain=DOG` on every search. This process has no Bitcoin index. `blockchain=BTC` returns an empty list on purpose.

## Profiles

`GET /GetKnownProfilesBySearchString?searchString=*&blockchain=DOG&qty=200&skip=0`

Walk `skip` upward by `qty` until a page is empty.

| Portal `Profile` | Indexer profile |
| --- | --- |
| `handle` | `URN` |
| `name` | `DisplayName` |
| `bio` | `Bio` |
| `walletLabel` | The profile address you asked for, or the address you used as the search key |
| `joinedLabel` | `CreatedDate` |

`role`, `look`, `localImageUrl`, and `forgedHere` are portal-only. `Image` on the indexer is the Sup image reference (often an IPFS path), not a browser object URL. `PKX` and `PKY` stay on the profile for a later private-message client. This indexer cannot decrypt those messages.

One profile: `GET /GetProfileByAddress/{address}` or `GET /GetProfileByURN/{urn}`.

## Items

`GET /GetKnownObjectsBySearchString?searchString=*&blockchain=DOG&qty=200&skip=0`

| Portal `Item` | Indexer object |
| --- | --- |
| `id` | Object address (`GetObjectByAddress`) or `TransactionId` plus the address |
| `name` | `Name` (`nme`) |
| `blurb` | `Description` (`dsc`) |
| `urn` | `URN` |
| `uri` | `URI` |
| `img` | `Image` |
| `attributes` | `Attributes` |
| `license` | `License` |
| `max` | `Maximum` |
| `qty` | `Owners[address].Item1` for the owner you are showing |
| `creators` | Keys of `Creators` |
| `royalties` | `Royalties` (address to percent) |
| `dogeTxid` | `TransactionId` |
| `mintedLabel` | `CreatedDate` |
| `ownerHandle` | An owner address from `Owners` |
| `creatorHandle` | The first creator address |

`files` on an `Item` is the demo stand-in for the root `File` map. Sup does not put that list inside the OBJ JSON. Load `GET /GetRootByTransactionID/{TransactionId}` and read `File` (name to size). The bytes are not in the API response. `urn`, `img`, and `uri` are the references the viewer should open.

`previewMeowe` is a portal shelf price. Do not invent one from this API. A listing's `Value` is only the amount written in the `LST` record. `art`, `localImageUrl`, `forgedHere`, `kind`, and `mainFileName` stay portal concerns. `mainFileName` should follow the file name inside `URN` when the URN has one.

## Spaces and channels

Spaces and channels come back as ordinary objects from the same search.

| Portal | Indexer object |
| --- | --- |
| Space | `License` is `meowe:space`. Its address is the Space id |
| Channel | `License` is `meowe:space:channel`. `URI` is the parent Space's address |
| Channel belongs to the Space | Keep a channel only when its creator matches the Space's owner. This is the rule in the portal's `src/services/directory.ts` |
| Space owner | An owner address from the Space's `Owners` |
| Space or channel chat | `GET /GetPublicMessagesByAddress/{object address}` for messages carved to Dogecoin. Batched messages come from IPFS, not from this API |

A give or sale of a Space shows up as a transfer on the Space object (`GetTransfersByObject`). The portal moves the Space's channels with it.

Owned and created shelves:

- `GET /GetObjectsOwnedByAddress/{address}?blockchain=DOG`
- `GET /GetObjectsCreatedByAddress/{address}?blockchain=DOG`

## What this API will not do for the portal

It does not send transactions, hold keys, pin IPFS, price MEOWE, or run chat. Those stay on their own services in `createServices.ts`. In the portal plan, follows and messages are paid in MEOWE on Solana, stored on IPFS, and recorded to Dogecoin in a periodic batch record. That is separate from P2FK objects. If the batch record is written as a P2FK root, it will show up here as a root. It is not given a special route in this version.
