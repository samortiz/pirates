# Corsairs of the Shattered Sea

Top-down medieval pirate naval battles in the browser.

* **Single player campaign:** open `index.html` directly, or use the server below.
* **Multiplayer battles:** co-op against AI fleets, or PvP. Runs on a small Node server with no dependencies to install.

## Play multiplayer with a friend outside your network

Requires Node 18+ and `cloudflared` (installed in `~/.local/bin/cloudflared`).

```sh
npm run tunnel        # same as: node server/server.js --tunnel
```

The server prints a link like `https://some-random-words.trycloudflare.com`:

1. Open `http://localhost:8080` yourself and choose **Multiplayer battle**.
2. Send your friend the trycloudflare link. It can take about 20 seconds before it starts working.
3. The first captain to join is the host. The host adds AI ships and starts the battle.
   * Put both players on the same side for co-op.
   * Put them on opposite sides for PvP.

Your friend doesn't need to install anything: the link opens the game in their browser. The link changes every time you restart the server, and it stops working when you press Ctrl+C.

Other ways to run it:

| Command | Who can join |
|---|---|
| `npm start` | Only this computer (`http://localhost:8080`) |
| `npm run lan` | Anyone on your home network (the server prints the address) |
| `npm run tunnel` | Anyone with the trycloudflare link |
| `PORT=9000 npm run tunnel` | Same, on another port |

### Installing cloudflared on another machine

Download `cloudflared-linux-amd64` from <https://github.com/cloudflare/cloudflared/releases/latest>. Check its SHA-256 against the release notes, then install it:

```sh
install -m 755 cloudflared-linux-amd64 ~/.local/bin/cloudflared
```

Or point the server at it with `CLOUDFLARED=/path/to/cloudflared`.

## Security notes

* By default the server listens only on `127.0.0.1`. Outside players reach it only through the tunnel.
* Anyone who has the invite link can join, up to 8 players. Only share it with people you want to play with, and stop the server when you're done.
* The server serves only the game's own files. It validates every message, rate-limits players, and runs all game logic itself, so a modified client can't teleport or give itself ammo.
* Cloudflare's servers carry the tunnel's traffic and could see the game data passing through.

## Controls

| Key | Action |
|---|---|
| A / D | Steer |
| W / S | Raise / lower sail |
| Q / E | Port / starboard broadside |
| Space | Fire at the nearest enemy |
| 1 2 3 | Round shot / chain shot / grapeshot. While boarding, these pick your melee stance instead |
| B | Board an enemy when alongside |
| Tab | Spectate another ship |
| H | Help |
| M | Mute |
| P | Pause (single player only) |

## Code layout

| File | Contents |
|---|---|
| `js/battle.js` | Battle simulation, shared by single player and the server |
| `js/view.js` | Battle rendering, HUD and effects |
| `js/net.js` | Multiplayer client and lobby |
| `js/world.js`, `js/main.js` | Campaign map, ports and menus |
| `server/server.js` | HTTP and WebSocket server, lobby, authoritative battle loop, Cloudflare tunnel launcher |
