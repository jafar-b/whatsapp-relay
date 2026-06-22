# WhatsApp Relay Bridge — Setup & Notes

## What This Is
A self-hosted WhatsApp relay bridge using [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp Web API). It exposes a local HTTP/WebSocket server with a dashboard UI for multiple operators to send and receive WhatsApp messages in real-time.

## Key Features (v3.0)
- **Multi-operator support** — dozens of browser clients can connect simultaneously and see each other's presence
- **Real-time sync** — messages, edits, and deletions broadcast instantly to all connected operators
- **Message edit & delete** — edit or delete sent messages using WhatsApp's native protocol
- **Persistent message history** — per-chat message storage survives restarts, with pagination
- **Full media support** — images, video, audio, documents, stickers, location
- **Operator registry** — live operator list visible in the dashboard

## Stack
- **bridge.js** — Node.js server (Express + Socket.io + Baileys)
- **dashboard.html** — Multi-operator dashboard UI (open directly in browser)
- **auth_info/** — WhatsApp session credentials (auto-generated on first link)
- **relay.sqlite** — Persisted chats, contacts, assignments, and messages (survives restarts)
- **media/** — Incoming/outgoing media files
- **config.json** — Runtime configuration (message caps, save debounce)
- **ecosystem.config.js** — PM2 process manager configuration

## Running the Bridge
The bridge is managed by PM2 (process manager).

```bash
# Start (using ecosystem file)
pm2 start ecosystem.config.js

# Or start directly
pm2 start wa-relay

# Stop
pm2 stop wa-relay

# Restart
pm2 restart wa-relay

# View logs
pm2 logs wa-relay

# Check status
pm2 status
```

The server runs on **http://localhost:3001**

## First-Time Setup / Re-linking
1. Stop the bridge and clear the session:
   ```bash
   pm2 stop wa-relay
   rm -rf auth_info/* relay.sqlite store.json
   ```
2. On your phone: **WhatsApp → Settings → Linked Devices → Unlink** any existing entry
3. Start the bridge: `pm2 start ecosystem.config.js`
4. Open `dashboard.html` in Chrome, click **Connect Bridge**
5. Enter your operator name (visible to other operators)
6. On your phone (keep WhatsApp in the foreground): **Settings → Linked Devices → Link a Device** and scan the QR
7. Keep the dashboard open while history sync runs (~1-2 mins)

## Multi-Operator Usage
1. Open `dashboard.html` on each operator's machine
2. Each operator clicks **Connect Bridge** and enters the bridge URL (`http://<server-ip>:3001`)
3. Each operator sets their name — all operators appear in the right panel
4. Click any chat to load its message history
5. All incoming and outgoing messages sync in real-time across all operators
6. Edit or delete messages by hovering over sent message bubbles

## Message Edit & Delete
- **Edit**: hover over a sent text message → click ✎ Edit → modify text → press Enter
- **Delete**: hover over a sent message → click 🗑 Delete → confirm
- Changes sync to all connected operators and are sent to WhatsApp

## Contact Name Resolution
WhatsApp's linked device protocol only provides WhatsApp display names, not phone address book names. To get full name resolution:

1. Export contacts from **contacts.google.com → Export → vCard format**
2. Save the `.vcf` file into this folder
3. Run the sync script:
   ```bash
   node sync_contacts.js
   pm2 restart wa-relay
   ```
   *(See sync_contacts.js for the standalone script)*

### Current State (as of March 2026)
- **835** personal chats loaded
- **356** resolved with names (135 from WhatsApp + 221 from Google VCF)
- **479** still showing as numbers (not in Google contacts)
- **122** groups loaded with names

## Issues Fixed During Setup

### 1. Port already in use (EADDRINUSE)
PM2 was auto-restarting the bridge, keeping port 3001 occupied.
**Fix:** `pm2 stop wa-relay` before restarting manually.

### 2. WhatsApp Connection Failure loop
Baileys v6 was being rejected by WhatsApp servers. PM2 kept restarting causing IP rate-limiting.
**Fix:**
- Updated Baileys to v7 (`npm install @whiskeysockets/baileys@latest`)
- Added exponential backoff reconnect (5s → 10s → 20s... up to 5 min)
- Added `fetchLatestWaWebVersion()` to use current WA version

### 3. Contacts showing as numbers
- `chats.set` / `contacts.set` events removed in Baileys v7, replaced by `messaging-history.set`
- History sync was timing out because phone wasn't in foreground during link
- Added SQLite persistence so chats/contacts survive restarts and scale better than flat-file storage
- Added `backfillContactNames()` called on connect and after every contact sync
- Supplemented with Google Contacts `.vcf` import

### 4. Timestamps broken (protobuf Long objects)
Baileys returns timestamps as protobuf `{low, high, unsigned}` objects.
**Fix:** Added `toTimestamp()` helper to normalise before saving/sorting.

## API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection status + QR data |
| GET | `/api/health` | Server health, uptime, operator count |
| GET | `/api/operators` | Live operator list |
| GET | `/api/chats` | All chats sorted by recency |
| GET | `/api/groups` | All WhatsApp groups |
| GET | `/api/messages?jid=&limit=&before=` | Messages with pagination |
| GET | `/api/contacts/search?q=` | Search contacts by name/phone |
| POST | `/api/send` | Send text message |
| POST | `/api/send/image` | Send image |
| POST | `/api/send/video` | Send video |
| POST | `/api/send/audio` | Send audio / voice note |
| POST | `/api/send/document` | Send document |
| POST | `/api/send/location` | Send location |
| POST | `/api/groups/create` | Create a group |
| PUT | `/api/messages/:messageId` | Edit a sent message |
| DELETE | `/api/messages/:messageId?jid=` | Delete a sent message |

## Configuration (config.json)
| Key | Default | Description |
|-----|---------|-------------|
| `MAX_MESSAGES_PER_CHAT` | 500 | Max messages stored per chat (oldest trimmed) |
| `SAVE_DEBOUNCE_MS` | 2000 | Debounce interval before syncing contacts/chats to SQLite |
| `DB_PATH` | `./relay.sqlite` | SQLite database file path |
| `RELEASE_ASSIGNMENTS_ON_DISCONNECT` | `true` | Release claimed customer conversations when an operator disconnects |

## Known Limitations
- No message history older than what WhatsApp syncs (~3 months)
- Phone address book names not synced by WhatsApp protocol (workaround: VCF import)
- No read receipts or typing indicators
- No status/Stories support
- Media files accumulate in `media/` folder — clean up periodically
- Edit only works for text messages (WhatsApp limitation)
