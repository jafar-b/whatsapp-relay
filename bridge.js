/**
 * WhatsApp Relay Bridge - Full Media Support
 * Supports: text, images, video, audio, documents, stickers, location
 *
 * Install:
 *   npm install @whiskeysockets/baileys @hapi/boom express socket.io qrcode cors multer mime-types better-sqlite3
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Database = require('better-sqlite3');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const ROOT_DIR = __dirname;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50 * 1024 * 1024,
});

app.use(cors());
app.use(express.json());

// Serve the operator dashboard directly from the backend.
const DASHBOARD_FILE = path.join(__dirname, 'dashboard.html');
app.get('/', (req, res) => {
  res.sendFile(DASHBOARD_FILE);
});
app.get('/dashboard.html', (req, res) => {
  res.sendFile(DASHBOARD_FILE);
});

// Media storage setup
const MEDIA_DIR = path.join(ROOT_DIR, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
app.use('/media', express.static(MEDIA_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = path.extname(file.originalname) || `.${mime.extension(file.mimetype) || 'bin'}`;
    cb(null, unique + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Configuration
const CONFIG = {
  MAX_MESSAGES_PER_CHAT: 500,
  SAVE_DEBOUNCE_MS: 2000,
  DB_PATH: './relay.sqlite',
  RELEASE_ASSIGNMENTS_ON_DISCONNECT: true,
};
try {
  const configFile = path.join(ROOT_DIR, 'config.json');
  if (fs.existsSync(configFile)) {
    Object.assign(CONFIG, JSON.parse(fs.readFileSync(configFile, 'utf8')));
  }
} catch (e) {
  console.error('[Bridge] Failed to load config.json:', e.message);
}

// State
let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
const messageStore = {};
const groupStore = {};
const contactStore = {};
const chatStore = {};
// Maps @lid JIDs to their corresponding @s.whatsapp.net JID and vice-versa.
// WhatsApp's multi-device protocol uses opaque @lid identifiers internally;
// we track both directions so resolveContactName() works regardless of format.
const lidToJid = {};  // "hex123@lid" -> "91987...@s.whatsapp.net"
const jidToLid = {};  // "91987...@s.whatsapp.net" -> "hex123@lid"

// Operator registry
const operators = new Map(); // socketId -> { id, name, connectedAt, socketId }
let connectorOperatorId = null;
let connectorOperatorName = null;
let linkingOperator = null;

// Persistence
const STORE_FILE = path.join(ROOT_DIR, 'store.json');
let saveTimer = null;

function toTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string' && ts.trim()) return Number(ts) || 0;
  if (typeof ts === 'object' && 'low' in ts) return ts.low + ts.high * 4294967296;
  return 0;
}

function normalizeChat(chat = {}) {
  let phone = null;
  const id = chat.id;
  if (id) {
    if (id.endsWith('@s.whatsapp.net')) {
      phone = id.split('@')[0];
    } else if (id.endsWith('@lid')) {
      const phoneJid = lidToJid[id];
      if (phoneJid) {
        phone = phoneJid.split('@')[0];
      }
    }
  }
  return {
    ...chat,
    phone: phone || chat.phone || null,
    unreadCount: Number(chat.unreadCount || 0),
    timestamp: toTimestamp(chat.timestamp),
    lastMsg: chat.lastMsg || '',
    assignedOperatorId: chat.assignedOperatorId || null,
    assignedOperatorName: chat.assignedOperatorName || null,
    assignedAt: chat.assignedAt || null,
  };
}

function normalizeMessageRecord(msg = {}) {
  return {
    ...msg,
    id: msg.id,
    from: msg.from || msg.jid,
    jid: msg.from || msg.jid,
    fromMe: Boolean(msg.fromMe),
    participant: msg.participant || null,
    sender: msg.sender || null,
    operatorId: msg.operatorId || null,
    operatorName: msg.operatorName || null,
    content: msg.content || '',
    mediaType: msg.mediaType || 'text',
    mediaUrl: msg.mediaUrl || null,
    fileName: msg.fileName || null,
    mimetype: msg.mimetype || null,
    timestamp: toTimestamp(msg.timestamp),
    isGroup: Boolean(msg.isGroup),
    editedAt: msg.editedAt ? toTimestamp(msg.editedAt) : null,
    deleted: Boolean(msg.deleted),
    clientTempId: msg.clientTempId || null,
  };
}

class RelayDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    const absolute = path.isAbsolute(dbPath) ? dbPath : path.join(ROOT_DIR, dbPath);
    const dir = path.dirname(absolute);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(absolute);
    console.log(`[Bridge] Using SQLite database: ${absolute}`);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
    this.prepare();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_msg TEXT,
        timestamp INTEGER NOT NULL DEFAULT 0,
        assigned_operator_id TEXT,
        assigned_operator_name TEXT,
        assigned_at TEXT,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT 0,
        from_me INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_jid_timestamp
      ON messages(jid, timestamp, id);
    `);
  }

  prepare() {
    this.upsertContactStmt = this.db.prepare(`
      INSERT INTO contacts (id, payload, updated_at)
      VALUES (@id, @payload, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    this.upsertChatStmt = this.db.prepare(`
      INSERT INTO chats (
        id, name, type, unread_count, last_msg, timestamp,
        assigned_operator_id, assigned_operator_name, assigned_at,
        payload, updated_at
      ) VALUES (
        @id, @name, @type, @unread_count, @last_msg, @timestamp,
        @assigned_operator_id, @assigned_operator_name, @assigned_at,
        @payload, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        unread_count = excluded.unread_count,
        last_msg = excluded.last_msg,
        timestamp = excluded.timestamp,
        assigned_operator_id = excluded.assigned_operator_id,
        assigned_operator_name = excluded.assigned_operator_name,
        assigned_at = excluded.assigned_at,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    this.upsertMessageStmt = this.db.prepare(`
      INSERT INTO messages (id, jid, timestamp, from_me, deleted, payload, updated_at)
      VALUES (@id, @jid, @timestamp, @from_me, @deleted, @payload, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        jid = excluded.jid,
        timestamp = excluded.timestamp,
        from_me = excluded.from_me,
        deleted = excluded.deleted,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `);
    this.deleteMessagesStmt = this.db.prepare(`
      DELETE FROM messages
      WHERE jid = ? AND id IN (
        SELECT id FROM messages
        WHERE jid = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `);
    this.contactCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM contacts');
    this.chatCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM chats');
    this.messageCountStmt = this.db.prepare('SELECT COUNT(*) AS count FROM messages');
    this.allContactsStmt = this.db.prepare('SELECT payload FROM contacts');
    this.allChatsStmt = this.db.prepare('SELECT payload FROM chats ORDER BY timestamp DESC, id DESC');
    this.allMessagesStmt = this.db.prepare('SELECT payload FROM messages ORDER BY jid ASC, timestamp ASC, id ASC');
    this.getMetadataStmt = this.db.prepare('SELECT value FROM bridge_metadata WHERE key = ?');
    this.setMetadataStmt = this.db.prepare(`
      INSERT INTO bridge_metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.inTransaction = this.db.transaction((contacts, chats, messages) => {
      for (const contact of contacts) this.upsertContact(contact);
      for (const chat of chats) this.upsertChat(chat);
      for (const msg of messages) this.upsertMessage(msg);
    });
  }

  counts() {
    return {
      contacts: this.contactCountStmt.get().count,
      chats: this.chatCountStmt.get().count,
      messages: this.messageCountStmt.get().count,
    };
  }

  loadState() {
    const contacts = this.allContactsStmt.all().map((row) => JSON.parse(row.payload));
    const chats = this.allChatsStmt.all().map((row) => normalizeChat(JSON.parse(row.payload)));
    const messages = this.allMessagesStmt.all().map((row) => normalizeMessageRecord(JSON.parse(row.payload)));
    return { contacts, chats, messages };
  }

  getMetadata(key) {
    try {
      const row = this.getMetadataStmt.get(key);
      return row ? row.value : null;
    } catch (e) {
      console.error('[Database] getMetadata error:', e.message);
      return null;
    }
  }

  setMetadata(key, value) {
    try {
      this.setMetadataStmt.run(key, value);
    } catch (e) {
      console.error('[Database] setMetadata error:', e.message);
    }
  }

  upsertContact(contact) {
    const payload = { ...contact };
    this.upsertContactStmt.run({
      id: payload.id,
      payload: JSON.stringify(payload),
      updated_at: Date.now(),
    });
  }

  upsertChat(chat) {
    const payload = normalizeChat(chat);
    this.upsertChatStmt.run({
      id: payload.id,
      name: payload.name || null,
      type: payload.type || null,
      unread_count: Number(payload.unreadCount || 0),
      last_msg: payload.lastMsg || '',
      timestamp: toTimestamp(payload.timestamp),
      assigned_operator_id: payload.assignedOperatorId || null,
      assigned_operator_name: payload.assignedOperatorName || null,
      assigned_at: payload.assignedAt || null,
      payload: JSON.stringify(payload),
      updated_at: Date.now(),
    });
  }

  upsertMessage(message) {
    const payload = normalizeMessageRecord(message);
    this.upsertMessageStmt.run({
      id: payload.id,
      jid: payload.jid,
      timestamp: toTimestamp(payload.timestamp),
      from_me: payload.fromMe ? 1 : 0,
      deleted: payload.deleted ? 1 : 0,
      payload: JSON.stringify(payload),
      updated_at: Date.now(),
    });
    this.trimMessages(payload.jid);
  }

  trimMessages(jid) {
    this.deleteMessagesStmt.run(jid, jid, CONFIG.MAX_MESSAGES_PER_CHAT);
  }

  saveContacts(contacts) {
    const tx = this.db.transaction((items) => {
      for (const item of items) this.upsertContact(item);
    });
    tx(contacts);
  }

  saveChats(chats) {
    const tx = this.db.transaction((items) => {
      for (const item of items) this.upsertChat(item);
    });
    tx(chats);
  }

  importLegacyStore(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const contacts = Object.values(data.contacts || {});
    const chats = Object.values(data.chats || {}).map(normalizeChat);
    const messages = Object.values(data.messages || {})
      .flat()
      .map(normalizeMessageRecord)
      .filter((msg) => msg.id && msg.jid);
    this.inTransaction(contacts, chats, messages);
    return true;
  }
}

const database = new RelayDatabase(CONFIG.DB_PATH);

function loadStore() {
  try {
    const counts = database.counts();
    if (!counts.contacts && !counts.chats && !counts.messages && fs.existsSync(STORE_FILE)) {
      database.importLegacyStore(STORE_FILE);
      console.log('[Bridge] Migrated legacy store.json into SQLite');
    }
    const state = database.loadState();
    for (const contact of state.contacts) {
      if (contact?.id) {
        contactStore[contact.id] = contact;
        // Rebuild @lid <-> phone JID cross-reference from persisted contacts.
        if (contact.lid && contact.id && !contact.id.endsWith('@lid')) {
          lidToJid[contact.lid] = contact.id;
          jidToLid[contact.id] = contact.lid;
        }
      }
    }
    for (const chat of state.chats) {
      if (chat?.id) chatStore[chat.id] = normalizeChat(chat);
    }
    for (const msg of state.messages) {
      if (!msg?.jid) continue;
      if (!messageStore[msg.jid]) messageStore[msg.jid] = [];
      messageStore[msg.jid].push(msg);
    }
    connectorOperatorId = database.getMetadata('connector_operator_id');
    connectorOperatorName = database.getMetadata('connector_operator_name');
    console.log(
      `[Bridge] Loaded SQLite store: ${Object.keys(chatStore).length} chats, ${Object.keys(contactStore).length} contacts, ${Object.keys(messageStore).length} message threads, ${Object.keys(lidToJid).length} lid mappings`
    );
    if (connectorOperatorId) {
      console.log(`[Bridge] Loaded connector operator: ${connectorOperatorName} (${connectorOperatorId})`);
    }
  } catch (e) {
    console.error('[Bridge] Failed to load store:', e.message);
  }
}

function sortedChats() {
  const chats = Object.values(chatStore).map(normalizeChat);
  const filtered = [];
  const seenPhoneJids = new Set();
  
  for (const chat of chats) {
    if (chat.id && !chat.id.endsWith('@lid')) {
      filtered.push(chat);
      if (chat.id.endsWith('@s.whatsapp.net')) {
        seenPhoneJids.add(chat.id);
      }
    }
  }
  
  for (const chat of chats) {
    if (chat.id && chat.id.endsWith('@lid')) {
      const phoneJid = lidToJid[chat.id];
      if (!phoneJid || !seenPhoneJids.has(phoneJid)) {
        filtered.push(chat);
      }
    }
  }
  
  return filtered.sort((a, b) => toTimestamp(b.timestamp) - toTimestamp(a.timestamp));
}

function resolveContactName(jid) {
  // Direct lookup first.
  let contact = contactStore[jid];
  if (contact?.name || contact?.notify || contact?.verifiedName) {
    return contact.name || contact.notify || contact.verifiedName;
  }
  // Cross-reference: if jid is a @lid, look up the mapped phone JID.
  const mappedJid = lidToJid[jid];
  if (mappedJid) {
    contact = contactStore[mappedJid];
    if (contact?.name || contact?.notify || contact?.verifiedName) {
      return contact.name || contact.notify || contact.verifiedName;
    }
  }
  // Cross-reference: if jid is a phone JID, check if the @lid alias has a name.
  const mappedLid = jidToLid[jid];
  if (mappedLid) {
    contact = contactStore[mappedLid];
    if (contact?.name || contact?.notify || contact?.verifiedName) {
      return contact.name || contact.notify || contact.verifiedName;
    }
  }
  return null;
}

function getPreferredJid(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@lid')) {
    const phoneJid = lidToJid[jid];
    if (phoneJid) return phoneJid;
  } else {
    const lidJid = jidToLid[jid];
    if (lidJid && chatStore[lidJid] && !chatStore[jid]) {
      return lidJid;
    }
  }
  return jid;
}

function getMessagesForJid(jid) {
  const altJid = jid.endsWith('@lid') ? lidToJid[jid] : jidToLid[jid];
  let msgs = messageStore[jid] || [];
  if (altJid && messageStore[altJid]) {
    const combined = [...msgs, ...messageStore[altJid]];
    const unique = [];
    const seen = new Set();
    for (const msg of combined) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        unique.push(msg);
      }
    }
    msgs = unique.sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
  }
  return msgs;
}

function backfillContactNames() {
  let updated = false;
  for (const [jid, chat] of Object.entries(chatStore)) {
    if (chat.type !== 'personal') continue;
    const name = resolveContactName(jid);
    if (name && chat.name !== name) {
      chat.name = name;
      updated = true;
    }
  }
  if (updated) {
    io.emit('chats', sortedChats());
    saveStore();
  }
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      for (const chat of Object.values(chatStore)) {
        chat.timestamp = toTimestamp(chat.timestamp);
      }
      for (const jid of Object.keys(messageStore)) {
        if (messageStore[jid].length > CONFIG.MAX_MESSAGES_PER_CHAT) {
          messageStore[jid] = messageStore[jid].slice(-CONFIG.MAX_MESSAGES_PER_CHAT);
        }
      }
      database.saveContacts(Object.values(contactStore).filter((contact) => contact?.id));
      database.saveChats(Object.values(chatStore).filter((chat) => chat?.id).map(normalizeChat));
    } catch (e) {
      console.error('[Bridge] Failed to save store:', e.message);
    }
  }, CONFIG.SAVE_DEBOUNCE_MS);
}

function broadcastOperators() {
  const list = Array.from(operators.values()).map((op) => ({
    id: op.id,
    name: op.name,
    connectedAt: op.connectedAt,
  }));
  io.emit('operators', list);
}

function addMessageToStore(msg) {
  const normalized = normalizeMessageRecord(msg);
  const jid = normalized.jid;
  if (!jid || !normalized.id) return normalized;
  if (!messageStore[jid]) messageStore[jid] = [];
  const existingIndex = messageStore[jid].findIndex((item) => item.id === normalized.id);
  if (existingIndex >= 0) messageStore[jid][existingIndex] = normalized;
  else messageStore[jid].push(normalized);
  messageStore[jid].sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
  if (messageStore[jid].length > CONFIG.MAX_MESSAGES_PER_CHAT) {
    messageStore[jid] = messageStore[jid].slice(-CONFIG.MAX_MESSAGES_PER_CHAT);
  }
  database.upsertMessage(normalized);
  return normalized;
}

function broadcastChats() {
  io.emit('chats', sortedChats());
}

function chatDisplayName(jid) {
  const resolvedName = resolveContactName(jid);
  if (resolvedName) return resolvedName;

  // Cross-reference: if JID is a LID JID, try to get the phone number JID.
  if (jid?.endsWith('@lid')) {
    const phoneJid = lidToJid[jid];
    if (phoneJid) {
      return '+' + phoneJid.split('@')[0];
    }
  }
  // If JID is a phone JID, prefix with '+' for clear display.
  if (jid?.endsWith('@s.whatsapp.net')) {
    return '+' + jid.split('@')[0];
  }

  return jid?.split('@')[0] || jid;
}

function ensureChatExists(jid) {
  if (!chatStore[jid]) {
    chatStore[jid] = normalizeChat({
      id: jid,
      name: chatDisplayName(jid),
      type: jid?.endsWith('@g.us') ? 'group' : 'personal',
      unreadCount: 0,
      timestamp: 0,
      lastMsg: '',
    });
  }
  return chatStore[jid];
}

function isAssignableChat(jid) {
  return Boolean(jid) && !jid.endsWith('@g.us');
}

function buildOperator(socketLike) {
  if (!socketLike) return null;
  return {
    id: socketLike.id,
    name: socketLike.name || socketLike.id,
  };
}

function getOperatorFromSocket(socket) {
  return buildOperator(operators.get(socket.id));
}

function getOperatorFromRequest(req) {
  const id = req.headers['x-operator-id'] || req.body.operatorId || req.query.operatorId;
  const name = req.headers['x-operator-name'] || req.body.operatorName || req.query.operatorName || id;
  if (!id) return null;
  return { id, name };
}

function assignChat(jid, operator, options = {}) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  if (!operator?.id) return { ok: false, status: 400, message: 'Operator identity missing' };
  const chat = ensureChatExists(jid);
  const alreadyOwnedByOther = chat.assignedOperatorId && chat.assignedOperatorId !== operator.id;
  if (alreadyOwnedByOther && !options.force) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  chat.assignedOperatorId = operator.id;
  chat.assignedOperatorName = operator.name || operator.id;
  chat.assignedAt = new Date().toISOString();
  saveStore();
  broadcastChats();
  io.emit('assignment_updated', { jid, chat, action: 'assigned' });
  return { ok: true, chat };
}

function releaseChat(jid, operator, options = {}) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  const chat = chatStore[jid];
  if (!chat) return { ok: false, status: 404, message: 'Chat not found' };
  if (
    chat.assignedOperatorId &&
    operator?.id &&
    chat.assignedOperatorId !== operator.id &&
    !options.force
  ) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  chat.assignedOperatorId = null;
  chat.assignedOperatorName = null;
  chat.assignedAt = null;
  saveStore();
  broadcastChats();
  io.emit('assignment_updated', { jid, chat, action: 'released' });
  return { ok: true, chat };
}

function ensureChatLockForOperator(jid, operator) {
  if (!isAssignableChat(jid)) return { ok: true, chat: ensureChatExists(jid) };
  const chat = ensureChatExists(jid);
  if (!chat.assignedOperatorId) return assignChat(jid, operator);
  if (chat.assignedOperatorId !== operator?.id) {
    return {
      ok: false,
      status: 409,
      message: `Conversation assigned to ${chat.assignedOperatorName || chat.assignedOperatorId}`,
      chat,
    };
  }
  return { ok: true, chat };
}

function updateChatPreview(jid, lastMsg, timestamp) {
  const chat = ensureChatExists(jid);
  const resolved = resolveContactName(jid);
  if (resolved) {
    chat.name = resolved;
  }
  chat.lastMsg = lastMsg || '';
  chat.timestamp = toTimestamp(timestamp);
  return chat;
}

async function recordOutboundMessage({ jid, operator, result, message }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sentMsg = addMessageToStore({
    id: result?.key?.id || `sent-${Date.now()}`,
    from: jid,
    jid,
    fromMe: true,
    participant: null,
    sender: operator?.name || operator?.id || 'Unknown',
    operatorId: operator?.id || null,
    operatorName: operator?.name || operator?.id || null,
    content: message.content || '',
    mediaType: message.mediaType || 'text',
    mediaUrl: message.mediaUrl || null,
    fileName: message.fileName || null,
    mimetype: message.mimetype || null,
    timestamp,
    isGroup: jid?.endsWith('@g.us'),
    editedAt: null,
    deleted: false,
    clientTempId: message.clientTempId || null,
  });
  updateChatPreview(jid, sentMsg.content, timestamp);
  saveStore();
  broadcastChats();
  io.emit('message', sentMsg);
  return sentMsg;
}

function sendLockError(target, result) {
  const payload = {
    message: result.message,
    jid: target?.jid || null,
    assignedOperatorId: result.chat?.assignedOperatorId || null,
    assignedOperatorName: result.chat?.assignedOperatorName || null,
  };
  if (typeof target?.emit === 'function') target.emit('error', payload);
  return payload;
}

loadStore();

let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 300000;
let reconnectTimer = null;
let isConnecting = false;

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[Bridge] Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

async function disconnectWhatsApp() {
  console.log('[Bridge] Disconnecting WhatsApp session...');
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      console.error('[Bridge] Error during sock.logout():', err.message);
      try {
        sock.end();
      } catch (e) {
        console.error('[Bridge] Error ending socket:', e.message);
      }
    }
    sock = null;
  }

  const authPaths = [
    path.join(ROOT_DIR, 'auth_info'),
    path.resolve('./auth_info')
  ];
  for (const authPath of authPaths) {
    if (fs.existsSync(authPath)) {
      try {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log(`[Bridge] Cleared credentials directory at ${authPath}`);
      } catch (e) {
        console.error(`[Bridge] Error clearing directory ${authPath}:`, e.message);
      }
    }
  }

  // Clear connector operator
  database.setMetadata('connector_operator_id', null);
  database.setMetadata('connector_operator_name', null);
  connectorOperatorId = null;
  connectorOperatorName = null;
  linkingOperator = null;

  connectionStatus = 'disconnected';
  qrCodeData = null;
  io.emit('status', { status: 'disconnected', connectorOperatorId, connectorOperatorName });
  io.emit('qr', null);

  console.log('[Bridge] Restarting connection after disconnect to prepare QR code...');
  await connectToWhatsApp();
}

// WhatsApp connection
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('[Bridge] Connection attempt already in progress.');
    return;
  }
  isConnecting = true;
  try {
    if (sock) {
      console.log('[Bridge] Closing existing socket before connecting...');
      try { sock.end(); } catch (e) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    let version;
    try {
      const waVersion = await fetchLatestWaWebVersion();
      version = waVersion.version;
    } catch (e) {
      console.warn('[Bridge] Failed to fetch latest WA web version, using fallback:', e.message);
      version = [2, 3000, 1015901307];
    }
    console.log(`[Bridge] Using WA version: ${version.join('.')}`);
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, syncFullHistory: true });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        connectionStatus = 'qr_ready';
        io.emit('qr', qrCodeData);
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        connectionStatus = 'disconnected';
        io.emit('status', { status: 'disconnected', reason, connectorOperatorId, connectorOperatorName });
        if (reason !== DisconnectReason.loggedOut) scheduleReconnect();
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        qrCodeData = null;
        reconnectDelay = 5000;
        
        if (linkingOperator) {
          database.setMetadata('connector_operator_id', linkingOperator.id);
          database.setMetadata('connector_operator_name', linkingOperator.name);
          connectorOperatorId = linkingOperator.id;
          connectorOperatorName = linkingOperator.name;
          linkingOperator = null;
        }

        io.emit('status', { status: 'connected', connectorOperatorId, connectorOperatorName });
        console.log('[Bridge] Connected to WhatsApp!');
        await loadGroups();
        backfillContactNames();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      const isHistory = type === 'append';
      if (type !== 'notify' && !isHistory) return;
      for (const msg of messages) {
        if (!msg.message) continue;
        const parsed = normalizeMessageRecord(await parseMessage(msg, isHistory));
        parsed.jid = getPreferredJid(parsed.jid);
        parsed.from = parsed.jid;
        const thread = messageStore[parsed.jid] || [];
        if (thread.some((existing) => existing.id === parsed.id)) continue;
        addMessageToStore(parsed);
        io.emit('message', parsed);
        const contact = contactStore[parsed.jid];
        const isGroup = parsed.jid?.endsWith('@g.us');
        if (msg.pushName && parsed.jid && !isGroup) {
          if (!contactStore[parsed.jid]) {
            contactStore[parsed.jid] = { id: parsed.jid };
          }
          if (!contactStore[parsed.jid].name && contactStore[parsed.jid].notify !== msg.pushName) {
            contactStore[parsed.jid].notify = msg.pushName;
            database.upsertContact(contactStore[parsed.jid]);
          }
        }
        if (!chatStore[parsed.jid]) {
          const resolved = resolveContactName(parsed.jid);
          chatStore[parsed.jid] = normalizeChat({
            id: parsed.jid,
            name: resolved || chatDisplayName(parsed.jid),
            type: isGroup ? 'group' : 'personal',
            unreadCount: 0,
            timestamp: parsed.timestamp,
            lastMsg: parsed.content,
          });
        } else {
          chatStore[parsed.jid].lastMsg = parsed.content;
          chatStore[parsed.jid].timestamp = parsed.timestamp;
          const resolved = resolveContactName(parsed.jid);
          if (resolved) {
            chatStore[parsed.jid].name = resolved;
          } else {
            const currentName = chatStore[parsed.jid].name;
            const cleanJid = parsed.jid?.split('@')[0];
            if (!currentName || currentName === cleanJid || currentName === '+' + cleanJid) {
              chatStore[parsed.jid].name = chatDisplayName(parsed.jid);
            }
          }
        }
        broadcastChats();
        saveStore();
      }
    });

    sock.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        if (groupStore[update.id]) groupStore[update.id] = { ...groupStore[update.id], ...update };
        io.emit('group_update', update);
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        contactStore[contact.id] = { ...contactStore[contact.id], ...contact };
        // Track @lid <-> phone JID cross-reference mappings.
        if (contact.lid && contact.id && !contact.id.endsWith('@lid')) {
          lidToJid[contact.lid] = contact.id;
          jidToLid[contact.id] = contact.lid;
        }
        database.upsertContact(contactStore[contact.id]);
      }
      backfillContactNames();
      saveStore();
    });

    sock.ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        if (contactStore[update.id]) Object.assign(contactStore[update.id], update);
        else contactStore[update.id] = update;
        // Track @lid <-> phone JID mappings from the lid field.
        if (update.lid && update.id && !update.id.endsWith('@lid')) {
          lidToJid[update.lid] = update.id;
          jidToLid[update.id] = update.lid;
        }
        database.upsertContact(contactStore[update.id]);
      }
      backfillContactNames();
      saveStore();
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
      // --- Process contacts and build lid<->jid map ---
      for (const contact of contacts || []) {
        contactStore[contact.id] = { ...contactStore[contact.id], ...contact };
        // Track @lid <-> phone JID cross-reference mappings.
        if (contact.lid && contact.id && !contact.id.endsWith('@lid')) {
          lidToJid[contact.lid] = contact.id;
          jidToLid[contact.id] = contact.lid;
        }
        database.upsertContact(contactStore[contact.id]);
      }
      // --- Process chats ---
      for (const chat of chats || []) {
        const isGroup = chat.id.endsWith('@g.us');
        const contact = contactStore[chat.id];
        const ts = toTimestamp(chat.conversationTimestamp);
        chatStore[chat.id] = normalizeChat({
          ...chatStore[chat.id],
          id: chat.id,
          name: chat.name || chatDisplayName(chat.id),
          type: isGroup ? 'group' : 'personal',
          unreadCount: chat.unreadCount || 0,
          timestamp: ts,
          lastMsg: chatStore[chat.id]?.lastMsg || '',
        });
        database.upsertChat(chatStore[chat.id]);
      }
      // --- Process history messages (this was the missing piece!) ---
      let historyMsgCount = 0;
      for (const rawMsg of messages || []) {
        try {
          // History messages arrive pre-parsed; they have a .message field like live messages.
          if (!rawMsg?.message) continue;
          const key = rawMsg.key || {};
          const rawJid = key.remoteJid;
          if (!rawJid) continue;
          const jid = getPreferredJid(rawJid);
          const m = rawMsg.message;
          let content = '';
          let mediaType = 'text';
          // Extract text content from the most common history message shapes.
          if (m.conversation) {
            content = m.conversation;
          } else if (m.extendedTextMessage?.text) {
            content = m.extendedTextMessage.text;
          } else if (m.imageMessage) {
            content = m.imageMessage.caption || '';
            mediaType = 'image';
          } else if (m.videoMessage) {
            content = m.videoMessage.caption || '';
            mediaType = 'video';
          } else if (m.audioMessage) {
            content = m.audioMessage.ptt ? 'Voice message' : 'Audio file';
            mediaType = m.audioMessage.ptt ? 'voice' : 'audio';
          } else if (m.documentMessage) {
            content = `Document: ${m.documentMessage.fileName || 'file'}`;
            mediaType = 'document';
          } else if (m.stickerMessage) {
            content = 'Sticker';
            mediaType = 'sticker';
          } else if (m.locationMessage) {
            content = m.locationMessage.name || 'Shared location';
            mediaType = 'location';
          } else {
            content = '[Unsupported message type]';
          }
          const msgRecord = {
            id: key.id,
            from: jid,
            jid,
            fromMe: Boolean(key.fromMe),
            participant: rawMsg.participant || key.participant || null,
            sender: rawMsg.pushName || rawMsg.participant || key.participant || null,
            operatorId: null,
            operatorName: null,
            content,
            mediaType,
            mediaUrl: null,
            fileName: m.documentMessage?.fileName || null,
            mimetype: m.imageMessage?.mimetype || m.videoMessage?.mimetype || m.audioMessage?.mimetype || m.documentMessage?.mimetype || null,
            timestamp: toTimestamp(rawMsg.messageTimestamp),
            isGroup: jid.endsWith('@g.us'),
            editedAt: null,
            deleted: Boolean(rawMsg.message?.protocolMessage?.type === 0),
            clientTempId: null,
          };
          if (!msgRecord.id || !msgRecord.jid) continue;
          // addMessageToStore deduplicates, sorts, trims, and persists to DB.
          addMessageToStore(msgRecord);
          historyMsgCount++;
        } catch (histErr) {
          // Don't let one bad history message crash the entire sync.
          console.warn('[Bridge] Skipping bad history message:', histErr.message);
        }
      }
      broadcastChats();
      backfillContactNames();
      saveStore();
      console.log(`[Bridge] History sync: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${historyMsgCount} messages (isLatest=${isLatest})`);
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        const isGroup = chat.id.endsWith('@g.us');
        chatStore[chat.id] = normalizeChat({
          ...chatStore[chat.id],
          id: chat.id,
          name: chat.name || chatDisplayName(chat.id),
          type: isGroup ? 'group' : 'personal',
          unreadCount: chat.unreadCount || 0,
          timestamp: toTimestamp(chat.conversationTimestamp),
        });
        database.upsertChat(chatStore[chat.id]);
      }
      broadcastChats();
      saveStore();
    });
  } catch (err) {
    console.error('[Bridge] Error in connectToWhatsApp:', err.message);
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

// Parse message with media
async function parseMessage(raw, skipMedia = false) {
  const m = raw.message;
  let content = '';
  let mediaUrl = null;
  let mediaType = 'text';
  let fileName = null;
  let mimetype = null;

  if (m.conversation || m.extendedTextMessage) {
    content = m.conversation || m.extendedTextMessage?.text;
    mediaType = 'text';
  } else if (m.imageMessage) {
    content = m.imageMessage.caption || '';
    mediaType = 'image';
    mimetype = m.imageMessage.mimetype;
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const ext = mime.extension(mimetype) || 'jpg';
        const filename = `${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Image download failed:', e.message);
      }
    }
  } else if (m.videoMessage) {
    content = m.videoMessage.caption || '';
    mediaType = 'video';
    mimetype = m.videoMessage.mimetype;
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const ext = mime.extension(mimetype) || 'mp4';
        const filename = `${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Video download failed:', e.message);
      }
    }
  } else if (m.audioMessage) {
    mediaType = m.audioMessage.ptt ? 'voice' : 'audio';
    mimetype = m.audioMessage.mimetype;
    content = m.audioMessage.ptt ? 'Voice message' : 'Audio file';
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const ext = mime.extension(mimetype) || 'ogg';
        const filename = `${Date.now()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Audio download failed:', e.message);
      }
    }
  } else if (m.documentMessage) {
    mediaType = 'document';
    mimetype = m.documentMessage.mimetype;
    fileName = m.documentMessage.fileName || 'document';
    content = `Document: ${fileName}`;
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${Date.now()}-${safeName}`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Document download failed:', e.message);
      }
    }
  } else if (m.stickerMessage) {
    mediaType = 'sticker';
    content = 'Sticker';
    if (!skipMedia) {
      try {
        const buffer = await downloadMediaMessage(raw, 'buffer', {});
        const filename = `${Date.now()}.webp`;
        fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
        mediaUrl = `/media/${filename}`;
      } catch (e) {
        console.error('[Bridge] Sticker download failed:', e.message);
      }
    }
  } else if (m.locationMessage) {
    mediaType = 'location';
    const { degreesLatitude: lat, degreesLongitude: lng, name } = m.locationMessage;
    content = name || 'Shared location';
    mediaUrl = `https://maps.google.com/?q=${lat},${lng}`;
  } else {
    content = '[Unsupported message type]';
  }

  return {
    id: raw.key.id,
    from: raw.key.remoteJid,
    jid: raw.key.remoteJid,
    fromMe: raw.key.fromMe,
    participant: raw.participant || raw.key.participant,
    sender: raw.participant || raw.key.participant || raw.pushName || null,
    operatorId: null,
    operatorName: null,
    content,
    mediaType,
    mediaUrl,
    fileName,
    mimetype,
    timestamp: raw.messageTimestamp,
    isGroup: raw.key.remoteJid?.endsWith('@g.us'),
  };
}

async function loadGroups() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [id, meta] of Object.entries(groups)) {
      groupStore[id] = meta;
      if (!chatStore[id]) {
        chatStore[id] = normalizeChat({
          id,
          name: meta.subject,
          type: 'group',
          unreadCount: 0,
          timestamp: meta.creation || 0,
          lastMsg: '',
        });
      } else {
        chatStore[id].name = meta.subject;
      }
      database.upsertChat(chatStore[id]);
    }
    io.emit('groups', Object.values(groupStore));
    broadcastChats();
    saveStore();
    console.log(`[Bridge] Loaded ${Object.keys(groupStore).length} groups`);
  } catch (e) {
    console.error('[Bridge] Failed to load groups:', e);
  }
}

const notConnected = (res) => res.status(503).json({ error: 'Not connected to WhatsApp' });

app.get('/api/status', (req, res) => res.json({ status: connectionStatus, qr: qrCodeData, connectorOperatorId, connectorOperatorName }));
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    const operator = getOperatorFromRequest(req);
    if (connectorOperatorId && (!operator || operator.id !== connectorOperatorId)) {
      return res.status(403).json({ error: 'Only the operator who connected WhatsApp first can disconnect it.' });
    }
    await disconnectWhatsApp();
    res.json({ success: true, message: 'WhatsApp session disconnected and reset.' });
  } catch (err) {
    console.error('[Bridge] Failed to disconnect WhatsApp:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/health', (req, res) =>
  res.json({ uptime: process.uptime(), status: connectionStatus, operators: operators.size, chats: Object.keys(chatStore).length })
);
app.get('/api/operators', (req, res) =>
  res.json(Array.from(operators.values()).map((op) => ({ id: op.id, name: op.name, connectedAt: op.connectedAt })))
);
app.get('/api/groups', (req, res) => res.json(Object.values(groupStore)));
app.get('/api/chats', (req, res) => res.json(sortedChats()));
app.get('/api/contacts/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json([]);
  const results = Object.values(contactStore)
    .filter((contact) => {
      const name = (contact.name || contact.notify || '').toLowerCase();
      const phone = (contact.id || '').split('@')[0];
      return name.includes(q) || phone.includes(q);
    })
    .slice(0, 20)
    .map((contact) => ({
      id: contact.id,
      name: contact.name || contact.notify || contact.id.split('@')[0],
      phone: contact.id.split('@')[0],
    }));
  res.json(results);
});

function parseVcfContacts(content) {
  const unfolded = content.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const contactsList = [];
  const cards = unfolded.split('BEGIN:VCARD');

  for (const card of cards) {
    if (!card.trim()) continue;

    const nameMatch = card.match(/^FN(?:;[^:]*)?:(.+)$/m);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const telMatches = card.matchAll(/^TEL[^:]*:([^\n]+)/gm);

    for (const match of telMatches) {
      let digits = match[1].replace(/\D/g, '');
      if (digits.length < 7) continue;

      if (digits.startsWith('00')) {
        digits = digits.slice(2);
      }

      if (!contactsList.some(c => c.phone === digits)) {
        contactsList.push({ phone: digits, name });
      }
    }
  }
  return contactsList;
}

app.get('/api/contacts', (req, res) => {
  try {
    const contacts = Object.values(contactStore)
      .map((c) => ({
        id: c.id,
        name: c.name || c.notify || c.verifiedName || c.id.split('@')[0],
        phone: c.id.split('@')[0],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(contacts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const vcfPath = req.file.path;
  try {
    const content = fs.readFileSync(vcfPath, 'utf8');
    const parsedContacts = parseVcfContacts(content);
    
    let imported = 0;
    let skipped = 0;

    for (const c of parsedContacts) {
      const jid = `${c.phone}@s.whatsapp.net`;
      
      const exists = contactStore[jid] || database.db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(jid);
      if (exists) {
        skipped++;
        if (chatStore[jid] && (!chatStore[jid].name || chatStore[jid].name === c.phone)) {
          chatStore[jid].name = c.name;
          database.upsertChat(chatStore[jid]);
        }
        continue;
      }

      const contactObj = { id: jid, name: c.name, notify: c.name };
      contactStore[jid] = contactObj;
      database.upsertContact(contactObj);
      imported++;
    }

    try { fs.unlinkSync(vcfPath); } catch {}

    io.emit('contacts_updated');
    broadcastChats();
    saveStore();

    res.json({ success: true, imported, skipped });
  } catch (err) {
    try { fs.unlinkSync(vcfPath); } catch {}
    console.error('[Bridge] Contact import failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/messages', (req, res) => {
  const { jid, limit = 50, before } = req.query;
  if (!jid) {
    const allMsgs = Object.values(messageStore)
      .flat()
      .sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
    return res.json(allMsgs.slice(-Number(limit)));
  }

  // Hydrate from DB if cold before returning combined list
  const altJid = jid.endsWith('@lid') ? lidToJid[jid] : jidToLid[jid];
  const hydrate = (targetJid) => {
    if (!messageStore[targetJid] || messageStore[targetJid].length === 0) {
      try {
        const dbMsgsStmt = database.db.prepare(
          'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
        );
        const rows = dbMsgsStmt.all(targetJid, CONFIG.MAX_MESSAGES_PER_CHAT);
        if (rows.length > 0) {
          messageStore[targetJid] = rows.map((row) => normalizeMessageRecord(JSON.parse(row.payload)));
        }
      } catch (dbErr) {
        console.warn(`[Bridge] API messages DB hydration error for ${targetJid}:`, dbErr.message);
      }
    }
  };
  hydrate(jid);
  if (altJid) hydrate(altJid);

  let msgs = getMessagesForJid(jid);
  if (before) {
    const beforeTs = Number(before);
    msgs = msgs.filter((msg) => toTimestamp(msg.timestamp) < beforeTs);
  }
  const total = msgs.length;
  const sliced = msgs.slice(-Number(limit));
  res.json({ messages: sliced, hasMore: total > sliced.length, total, chat: normalizeChat(chatStore[jid]) || null });
});

app.post('/api/chats/:jid/claim', (req, res) => {
  const operator = getOperatorFromRequest(req);
  const result = assignChat(req.params.jid, operator);
  if (!result.ok) return res.status(result.status).json({ error: result.message, chat: result.chat });
  res.json({ success: true, chat: result.chat });
});

app.post('/api/chats/:jid/release', (req, res) => {
  const operator = getOperatorFromRequest(req);
  const result = releaseChat(req.params.jid, operator);
  if (!result.ok) return res.status(result.status).json({ error: result.message, chat: result.chat });
  res.json({ success: true, chat: result.chat });
});

app.post('/api/send', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const lock = ensureChatLockForOperator(req.body.jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    const result = await sock.sendMessage(req.body.jid, { text: req.body.text });
    const message = await recordOutboundMessage({
      jid: req.body.jid,
      operator,
      result,
      message: {
        content: req.body.text,
        mediaType: 'text',
        clientTempId: req.body.clientTempId || null,
      },
    });
    res.json({ success: true, message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send/image', upload.single('file'), async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const lock = ensureChatLockForOperator(req.body.jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    const result = await sock.sendMessage(req.body.jid, {
      image: fs.readFileSync(req.file.path),
      caption: req.body.caption || '',
      mimetype: req.file.mimetype,
    });
    const message = await recordOutboundMessage({
      jid: req.body.jid,
      operator,
      result,
      message: {
        content: req.body.caption || '',
        mediaType: 'image',
        mediaUrl: `/media/${req.file.filename}`,
        fileName: req.file.originalname,
        mimetype: req.file.mimetype,
        clientTempId: req.body.clientTempId || null,
      },
    });
    res.json({ success: true, mediaUrl: `/media/${req.file.filename}`, message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send/video', upload.single('file'), async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const lock = ensureChatLockForOperator(req.body.jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    const result = await sock.sendMessage(req.body.jid, {
      video: fs.readFileSync(req.file.path),
      caption: req.body.caption || '',
      mimetype: req.file.mimetype,
    });
    const message = await recordOutboundMessage({
      jid: req.body.jid,
      operator,
      result,
      message: {
        content: req.body.caption || '',
        mediaType: 'video',
        mediaUrl: `/media/${req.file.filename}`,
        fileName: req.file.originalname,
        mimetype: req.file.mimetype,
        clientTempId: req.body.clientTempId || null,
      },
    });
    res.json({ success: true, mediaUrl: `/media/${req.file.filename}`, message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send/audio', upload.single('file'), async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const lock = ensureChatLockForOperator(req.body.jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    const ptt = req.body.ptt === 'true';
    const result = await sock.sendMessage(req.body.jid, {
      audio: fs.readFileSync(req.file.path),
      mimetype: req.file.mimetype || 'audio/ogg; codecs=opus',
      ptt,
    });
    const message = await recordOutboundMessage({
      jid: req.body.jid,
      operator,
      result,
      message: {
        content: ptt ? 'Voice message' : 'Audio file',
        mediaType: ptt ? 'voice' : 'audio',
        mediaUrl: `/media/${req.file.filename}`,
        fileName: req.file.originalname,
        mimetype: req.file.mimetype,
        clientTempId: req.body.clientTempId || null,
      },
    });
    res.json({ success: true, message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send/document', upload.single('file'), async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const lock = ensureChatLockForOperator(req.body.jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    const fileName = req.body.filename || req.file.originalname;
    const result = await sock.sendMessage(req.body.jid, {
      document: fs.readFileSync(req.file.path),
      fileName,
      mimetype: req.file.mimetype,
    });
    const message = await recordOutboundMessage({
      jid: req.body.jid,
      operator,
      result,
      message: {
        content: `Document: ${fileName}`,
        mediaType: 'document',
        mediaUrl: `/media/${req.file.filename}`,
        fileName,
        mimetype: req.file.mimetype,
        clientTempId: req.body.clientTempId || null,
      },
    });
    res.json({ success: true, mediaUrl: `/media/${req.file.filename}`, message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send/location', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const lock = ensureChatLockForOperator(req.body.jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    const latitude = parseFloat(req.body.latitude);
    const longitude = parseFloat(req.body.longitude);
    const result = await sock.sendMessage(req.body.jid, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name: req.body.name || '',
      },
    });
    const message = await recordOutboundMessage({
      jid: req.body.jid,
      operator,
      result,
      message: {
        content: req.body.name || 'Shared location',
        mediaType: 'location',
        mediaUrl: `https://maps.google.com/?q=${latitude},${longitude}`,
        clientTempId: req.body.clientTempId || null,
      },
    });
    res.json({ success: true, message });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/messages/:messageId', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const { messageId } = req.params;
  const { jid, newContent } = req.body;
  if (!jid || !newContent) return res.status(400).json({ error: 'jid and newContent required' });
  const lock = ensureChatLockForOperator(jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    await sock.sendMessage(jid, { edit: { id: messageId, remoteJid: jid, fromMe: true }, text: newContent });
    const msgs = messageStore[jid];
    if (msgs) {
      const found = msgs.find((msg) => msg.id === messageId);
      if (found) {
        found.content = newContent;
        found.editedAt = Date.now();
        database.upsertMessage(found);
      }
    }
    io.emit('message_edited', { jid, messageId, newContent, editedAt: Date.now() });
    saveStore();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/messages/:messageId', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  const operator = getOperatorFromRequest(req);
  const { messageId } = req.params;
  const jid = req.query.jid || req.body.jid;
  if (!jid) return res.status(400).json({ error: 'jid required' });
  const lock = ensureChatLockForOperator(jid, operator);
  if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
  try {
    await sock.sendMessage(jid, { delete: { id: messageId, remoteJid: jid, fromMe: true } });
    const msgs = messageStore[jid];
    if (msgs) {
      const found = msgs.find((msg) => msg.id === messageId);
      if (found) {
        found.deleted = true;
        found.content = '';
        database.upsertMessage(found);
      }
    }
    io.emit('message_deleted', { jid, messageId });
    saveStore();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/groups/create', async (req, res) => {
  if (!sock || connectionStatus !== 'connected') return notConnected(res);
  try {
    const result = await sock.groupCreate(req.body.name, req.body.participants);
    groupStore[result.id] = result;
    io.emit('group_created', result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// WebSocket
io.on('connection', (socket) => {
  console.log(`[Bridge] Operator connected: ${socket.id}`);

  let opId = socket.handshake.query.operatorId;
  let opName = socket.handshake.query.operatorName;

  if (!opId || opId === 'undefined' || opId === 'null') {
    opId = `OP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }
  if (!opName || opName === 'undefined' || opName === 'null') {
    opName = opId;
  }

  operators.set(socket.id, { id: opId, name: opName, connectedAt: new Date().toISOString(), socketId: socket.id });
  broadcastOperators();
  socket.emit('operator_id', { id: opId });

  socket.emit('status', { status: connectionStatus, connectorOperatorId, connectorOperatorName });
  if (qrCodeData) socket.emit('qr', qrCodeData);
  socket.emit('groups', Object.values(groupStore));
  socket.emit('chats', sortedChats());

  socket.on('set_operator_name', ({ name }) => {
    const op = operators.get(socket.id);
    if (op) {
      op.name = name || op.id;
      operators.set(socket.id, op);
    }
    broadcastOperators();
    socket.emit('chats', sortedChats());
  });

  socket.on('linking_whatsapp', ({ operatorId, operatorName }) => {
    linkingOperator = { id: operatorId, name: operatorName };
    console.log(`[Bridge] Operator ${operatorName || operatorId} is scanning/linking WhatsApp`);
  });

  socket.on('claim_chat', ({ jid }) => {
    const operator = getOperatorFromSocket(socket);
    const result = assignChat(jid, operator);
    if (!result.ok) return sendLockError(socket, result);
    socket.emit('chat_claimed', { jid, chat: result.chat });
  });

  socket.on('release_chat', ({ jid }) => {
    const operator = getOperatorFromSocket(socket);
    const result = releaseChat(jid, operator);
    if (!result.ok) return sendLockError(socket, result);
    socket.emit('chat_released', { jid, chat: result.chat });
  });

  socket.on('open_chat', ({ jid }) => {
    // If in-memory store is cold (e.g. after a server restart) but SQLite has
    // persisted messages, hydrate the in-memory store from the DB now so the
    // operator sees chat history immediately on click.
    const altJid = jid.endsWith('@lid') ? lidToJid[jid] : jidToLid[jid];

    const hydrate = (targetJid) => {
      if (!messageStore[targetJid] || messageStore[targetJid].length === 0) {
        try {
          const dbMsgsStmt = database.db.prepare(
            'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
          );
          const rows = dbMsgsStmt.all(targetJid, CONFIG.MAX_MESSAGES_PER_CHAT);
          if (rows.length > 0) {
            messageStore[targetJid] = rows.map((row) => normalizeMessageRecord(JSON.parse(row.payload)));
          }
        } catch (dbErr) {
          console.warn(`[Bridge] open_chat DB hydration error for ${targetJid}:`, dbErr.message);
        }
      }
    };

    hydrate(jid);
    if (altJid) hydrate(altJid);

    const msgs = getMessagesForJid(jid);
    const limit = 50;
    const sliced = msgs.slice(-limit);
    socket.emit('chat_messages', {
      jid,
      messages: sliced,
      hasMore: msgs.length > limit,
      total: msgs.length,
      chat: normalizeChat(chatStore[jid]) || null,
    });
  });

  socket.on('send_message', async ({ jid, text, clientTempId }) => {
    if (!sock || connectionStatus !== 'connected') return;
    const operator = getOperatorFromSocket(socket);
    const lock = ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return sendLockError(socket, lock);
    try {
      const result = await sock.sendMessage(jid, { text });
      const sentMsg = await recordOutboundMessage({
        jid,
        operator,
        result,
        message: {
          content: text,
          mediaType: 'text',
          clientTempId: clientTempId || null,
        },
      });
      socket.emit('message_ack', { clientTempId, serverId: sentMsg.id, timestamp: sentMsg.timestamp });
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('edit_message', async ({ jid, messageId, newContent }) => {
    if (!sock || connectionStatus !== 'connected') return;
    const operator = getOperatorFromSocket(socket);
    const lock = ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return sendLockError(socket, lock);
    try {
      await sock.sendMessage(jid, { edit: { id: messageId, remoteJid: jid, fromMe: true }, text: newContent });
      const altJid = jid.endsWith('@lid') ? lidToJid[jid] : jidToLid[jid];
      const targetJids = altJid ? [jid, altJid] : [jid];
      for (const tJid of targetJids) {
        const msgs = messageStore[tJid];
        if (msgs) {
          const found = msgs.find((msg) => msg.id === messageId);
          if (found) {
            found.content = newContent;
            found.editedAt = Date.now();
            database.upsertMessage(found);
          }
        }
      }
      io.emit('message_edited', { jid, messageId, newContent, editedAt: Date.now() });
      saveStore();
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('delete_message', async ({ jid, messageId }) => {
    if (!sock || connectionStatus !== 'connected') return;
    const operator = getOperatorFromSocket(socket);
    const lock = ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return sendLockError(socket, lock);
    try {
      await sock.sendMessage(jid, { delete: { id: messageId, remoteJid: jid, fromMe: true } });
      const altJid = jid.endsWith('@lid') ? lidToJid[jid] : jidToLid[jid];
      const targetJids = altJid ? [jid, altJid] : [jid];
      for (const tJid of targetJids) {
        const msgs = messageStore[tJid];
        if (msgs) {
          const found = msgs.find((msg) => msg.id === messageId);
          if (found) {
            found.deleted = true;
            found.content = '';
            database.upsertMessage(found);
          }
        }
      }
      io.emit('message_deleted', { jid, messageId });
      saveStore();
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Bridge] Operator disconnected: ${socket.id}`);
    const operator = getOperatorFromSocket(socket);
    operators.delete(socket.id);
    if (CONFIG.RELEASE_ASSIGNMENTS_ON_DISCONNECT && operator?.id) {
      for (const chat of Object.values(chatStore)) {
        if (chat.assignedOperatorId === operator.id) {
          releaseChat(chat.id, operator, { force: true });
        }
      }
    }
    broadcastOperators();
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`[Bridge] Server running on http://localhost:${PORT}`);
  connectToWhatsApp();
});
