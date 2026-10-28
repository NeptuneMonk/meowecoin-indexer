# Meowecoin Dogecoin indexer

This program reads Dogecoin and writes down Meowecoin profiles, store items, Spaces, channels, and who owns them. It reads every block, starting from the very first one (block 0). It only reads. It has no wallet, no private keys, and it cannot send coins.

You need **Dogecoin Core 1.14.6**, and only that version. Newer Dogecoin Core shuffles the outputs of a `sendmany` payment, and that breaks these records.

The index is one file on disk. If you delete it, the program builds it again from your Dogecoin node.

## Keep this private

- Do not forward port **22555** (the Dogecoin node) on your router.
- Do not forward port **8080** (this program) on your router.
- The password in `.env` is the same as the one in `dogecoin.conf`. `.env` is not uploaded to GitHub. Do not email it or put it in a chat.
- The website address `http://127.0.0.1:8080` only works on this computer. That is what you want.

## 1. Turn on the Dogecoin node API

1. Quit Dogecoin Core completely. Check the system tray (the ^ arrow by the clock) and exit Dogecoin if it is still there.
2. Open Notepad.
3. Open this file. Paste the path into the Notepad address bar:

   `%APPDATA%\Dogecoin\dogecoin.conf`

   If Notepad says the file does not exist, create it in that folder with that exact name.
4. Put these lines in the file. Use your own password. Write the password down. You will type the same one in `.env`.

```
server=1
rpcuser=meowe
rpcpassword=change-this-password
rpcport=22555
txindex=1
rpcallowip=127.0.0.1
rpcallowip=172.16.0.0/12
rpcallowip=192.168.0.0/16
```

`txindex=1` tells Dogecoin to remember every transaction. This indexer cannot work without it.

The `rpcallowip` lines let this computer, and Docker on this computer, talk to the node. They do not open the node to the internet. The password is what keeps it locked.

5. Save the file and close Notepad.

### First start after adding txindex

The first time you turn `txindex` on, Dogecoin has to rebuild that index. That can take hours. Leave the computer on.

1. Press the Windows key, type `cmd`, and open Command Prompt.
2. Paste this and press Enter:

```
"%ProgramFiles%\Dogecoin\dogecoin-qt.exe" -reindex
```

If Windows says it cannot find the program, try:

```
"%ProgramFiles(x86)%\Dogecoin\dogecoin-qt.exe" -reindex
```

Wait until Dogecoin shows it is fully synced again. Later starts are normal: open Dogecoin Core from the Start menu. You do not pass `-reindex` again.

If Docker later says it cannot reach the node, quit Dogecoin and add these two lines to `dogecoin.conf`, then start Dogecoin again:

```
rpcbind=127.0.0.1
rpcbind=0.0.0.0
```

Try without those two lines first. `rpcbind=0.0.0.0` listens on every network adapter of this PC. The password and the `rpcallowip` list are what stop other people from using it. Still do not forward port 22555.

## 2. Install Docker Desktop

1. Download Docker Desktop from [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/).
2. Install it and start it. Wait until it says Docker is running.
3. You do not need a Docker account for this.

## 3. Download this program

1. Open [https://github.com/NeptuneMonk/meowecoin-indexer](https://github.com/NeptuneMonk/meowecoin-indexer).
2. Click **Code**, then **Download ZIP**.
3. Unzip it. You will get a folder. Move that folder somewhere you can find, for example `C:\meowecoin-indexer`.

Or, if you use Git:

```
git clone https://github.com/NeptuneMonk/meowecoin-indexer.git
cd meowecoin-indexer
```

## 4. Fill in the password

1. In that folder, copy `.env.example` and name the copy `.env`.
2. Open `.env` in Notepad.
3. Set `DOGE_RPC_PASSWORD` to the same password you put in `dogecoin.conf`.
4. Leave `DOGE_RPC_URL` as `http://host.docker.internal:22555` when you use Docker. That name means "the Windows PC, from inside Docker."
5. Set `START_HEIGHT=0`. The program reads Dogecoin from the very first block, then keeps following new blocks. The first full read takes a long time. Leave the computer on until `blocksBehind` gets close to 0.
6. Save `.env`.

Changing `START_HEIGHT` after the first successful run does nothing until you delete the `data` folder and start again.

## 5. Start it

1. Dogecoin Core must be open and synced.
2. Open Command Prompt.
3. Go to the folder. Example:

```
cd C:\meowecoin-indexer
```

4. Paste:

```
docker compose up -d
```

The first time, Docker downloads Node and builds the program. When it finishes, the indexer keeps running in the background.

## 6. Check that it is working

Open this address in a browser on the same computer:

[http://127.0.0.1:8080/health](http://127.0.0.1:8080/health)

You should see a page of JSON. These fields matter:

| Field | What it means |
| --- | --- |
| `ok` | `true` when the program can talk to Dogecoin. |
| `rpc` | `connected` when the node answered. |
| `nodeHeight` | The newest block Dogecoin has. |
| `indexedHeight` | The newest block this program has read. It climbs toward `nodeHeight`. |
| `blocksBehind` | How many blocks are still left. |
| `waitingForStartHeight` | `true` only if Dogecoin is not synced up to `START_HEIGHT` yet. With `START_HEIGHT=0` this is `false` once the node answers. |
| `rootCount` | How many P2FK records it has found. Zero is normal until it reaches a block that has one. |

To watch the log:

```
docker compose logs -f
```

Press Ctrl+C to stop watching. The indexer keeps running.

To stop it:

```
docker compose down
```

Your index stays in the `data` folder.

## 7. Move it to another computer

The later home for this is the mini PC. Dogecoin Core on that PC must also be **1.14.6**, with the same `dogecoin.conf` settings and a finished `-reindex` if `txindex` was off.

1. Install Docker Desktop there.
2. Copy the program folder, including `.env`.
3. Start Dogecoin and wait until it is synced.
4. In the folder, run `docker compose up -d`.

Two ways to bring the index:

- Copy the `data` folder too. The program continues from the last block in that file. The Dogecoin node on the new PC must be able to serve those same blocks.
- Or leave `data` behind. The program builds the index again from `START_HEIGHT` (block 0). That takes much longer, and the result is the same.

## Run it without Docker

Use this if you would rather install Node than Docker.

1. Install Node.js 22 from [https://nodejs.org/](https://nodejs.org/).
2. Copy `.env.example` to `.env`.
3. Change this line so the program talks to Dogecoin on the same PC:

```
DOGE_RPC_URL=http://127.0.0.1:22555
```

4. Double-click `start.bat`. Leave the window open.
5. Open [http://127.0.0.1:8080/health](http://127.0.0.1:8080/health).

## What it stores

Profiles, objects (including Spaces and their channels), owners, gives, buys, burns, listings, public messages, and keywords, when the Dogecoin transaction is a Sup-style P2FK (Pay to Future Key) record. Follows and messages paid in MEOWE are recorded to Dogecoin in a periodic batch record; that record shows up here as a root, and the messages themselves are on IPFS. Details and the list of Sup files this follows are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The web addresses are in [docs/API.md](docs/API.md). How the Forge website will call this later is in [docs/PORTAL.md](docs/PORTAL.md).
