/**
 * Baileys WhatsApp connection lifecycle: connect/reconnect, event wiring,
 * inbound message parsing (including media download), and group sync.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

let stores = null;
let database = null;
let io = null;
let ROOT_DIR = null;
let MEDIA_DIR = null;

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';

let reconnectDelay = 5000;
const MAX_RECONNECT_DELAY = 300000;
let reconnectTimer = null;
let isConnecting = false;

// Retries unresolved @lid mappings periodically since Baileys' lid<->phone
// mapping store fills in lazily and a single attempt at connect time often
// misses LIDs that resolve only after more contact/history sync traffic.
const LID_RETRY_INTERVAL_MS = 10 * 60 * 1000;
let lidRetryTimer = null;

function stopLidRetryTimer() {
  if (lidRetryTimer) {
    clearInterval(lidRetryTimer);
    lidRetryTimer = null;
  }
}

function startLidRetryTimer() {
  stopLidRetryTimer();
  lidRetryTimer = setInterval(() => {
    stores.resolveAllLidsFromStore();
  }, LID_RETRY_INTERVAL_MS);
}

// Tracks in-flight on-demand history requests (sock.fetchMessageHistory) keyed
// by jid, so the 'messaging-history.set' handler can resolve the matching
// caller once WhatsApp sends the older messages back, instead of the caller
// having no way to know when/if the response arrived.
const pendingHistoryRequests = new Map(); // jid -> { resolve, timer }
const HISTORY_REQUEST_TIMEOUT_MS = 15000;
// Jids WhatsApp has told us (via an empty on-demand response) have no more
// history before our oldest known message. Avoids re-asking on every click.
const exhaustedHistoryJids = new Set();

function resolvePendingHistoryRequest(jid) {
  const pending = pendingHistoryRequests.get(jid);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingHistoryRequests.delete(jid);
  pending.resolve(true);
}

// Asks WhatsApp itself for older messages of `jid`, anchored on the oldest
// message we currently have locally. WhatsApp streams the result back through
// the same 'messaging-history.set' event used for the initial sync, which
// already persists everything it receives via addMessageToStore.
async function requestOlderHistory(jid, count = 50) {
  if (!sock || connectionStatus !== 'connected') {
    return { ok: false, message: 'Not connected to WhatsApp' };
  }
  if (exhaustedHistoryJids.has(jid)) {
    return { ok: true, added: 0, hasMore: false, exhausted: true };
  }
  if (pendingHistoryRequests.has(jid)) {
    return { ok: false, message: 'A history request for this chat is already in progress' };
  }
  const existing = stores.getMessagesForJid(jid);
  const oldest = existing[0];
  if (!oldest) {
    return { ok: false, message: 'No anchor message available for this chat' };
  }

  const countBefore = existing.length;
  const key = { remoteJid: jid, fromMe: Boolean(oldest.fromMe), id: oldest.id };
  const timestampMs = stores.toTimestamp(oldest.timestamp) * 1000;

  try {
    await sock.fetchMessageHistory(Math.min(count, 50), key, timestampMs);
  } catch (e) {
    console.error(`[Bridge] fetchMessageHistory request failed for ${jid}:`, e.message);
    return { ok: false, message: e.message };
  }

  const arrived = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingHistoryRequests.delete(jid);
      resolve(false);
    }, HISTORY_REQUEST_TIMEOUT_MS);
    pendingHistoryRequests.set(jid, { resolve, timer });
  });

  const countAfter = stores.getMessagesForJid(jid).length;
  const added = Math.max(0, countAfter - countBefore);
  if (added === 0) exhaustedHistoryJids.add(jid);
  return { ok: true, timedOut: !arrived, added, hasMore: added > 0 };
}

function init(deps) {
  ({ stores, database, io, ROOT_DIR, MEDIA_DIR } = deps);
}

function setSock(newSock) {
  sock = newSock;
  stores.setSock(newSock);
}

function getSock() { return sock; }
function getStatus() { return connectionStatus; }
function getQrCodeData() { return qrCodeData; }

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
  stopLidRetryTimer();
  exhaustedHistoryJids.clear();
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
    setSock(null);
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

  // Clear database and in-memory caches
  database.clearAllData();
  stores.clearInMemoryStores();

  // Clear connector operator
  stores.setConnectorOperator(null, null);
  stores.setLinkingOperator(null);

  connectionStatus = 'disconnected';
  qrCodeData = null;
  const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
  io.emit('status', { status: 'disconnected', connectorOperatorId, connectorOperatorName });
  io.emit('qr', null);
  io.emit('chats', []);
  io.emit('groups', []);

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
      try { sock.end(); } catch (e) { }
      setSock(null);
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
    setSock(makeWASocket({ version, auth: state, printQRInTerminal: false, syncFullHistory: true }));
    sock.ev.on('creds.update', saveCreds);

    const { messageStore, groupStore, contactStore, chatStore } = stores;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        connectionStatus = 'qr_ready';
        io.emit('qr', qrCodeData);
      }

      if (connection === 'close') {
        stopLidRetryTimer();
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        connectionStatus = 'disconnected';
        const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
        io.emit('status', { status: 'disconnected', reason, connectorOperatorId, connectorOperatorName });
        if (reason === DisconnectReason.loggedOut) {
          console.log('[Bridge] Connection closed due to logout. Cleaning up session...');
          await disconnectWhatsApp();
        } else {
          scheduleReconnect();
        }
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        qrCodeData = null;
        reconnectDelay = 5000;

        const currentLoggedJid = sock.user?.id ? stores.cleanJidToPhone(sock.user.id) : null;
        if (currentLoggedJid) {
          const storedJid = database.getMetadata('current_logged_jid');
          if (storedJid && storedJid !== currentLoggedJid) {
            console.log(`[Bridge] Detected number change! Stored: ${storedJid}, New: ${currentLoggedJid}. Clearing all old data.`);
            database.clearAllData();
            stores.clearInMemoryStores();
            io.emit('chats', []);
            io.emit('groups', []);
          }
          database.setMetadata('current_logged_jid', currentLoggedJid);
        }

        const linkingOperator = stores.getLinkingOperator();
        if (linkingOperator) {
          database.setMetadata('connector_operator_id', linkingOperator.id);
          database.setMetadata('connector_operator_name', linkingOperator.name);
          stores.setConnectorOperator(linkingOperator.id, linkingOperator.name);
          stores.setLinkingOperator(null);
        }

        const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
        io.emit('status', { status: 'connected', connectorOperatorId, connectorOperatorName });
        console.log('[Bridge] Connected to WhatsApp!');
        await loadGroups();
        stores.backfillContactNames();
        stores.resolveAllLidsFromStore();
        startLidRetryTimer();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      const isHistory = type === 'append';
      if (type !== 'notify' && !isHistory) return;
      for (const msg of messages) {
        if (!msg.message) continue;
        const parsedRaw = await parseMessage(msg, isHistory);
        if (!parsedRaw) continue;

        // Upsert verified name and push name into contactStore BEFORE normalizing
        const isGroup = parsedRaw.jid?.endsWith('@g.us');
        if (parsedRaw.jid && !isGroup) {
          const verifiedName = msg.verifiedBizName || msg.verifiedName || parsedRaw.verifiedBizName || parsedRaw.verifiedName;
          const pushName = msg.pushName || parsedRaw.pushName;
          if (verifiedName || pushName) {
            if (!contactStore[parsedRaw.jid]) {
              contactStore[parsedRaw.jid] = { id: parsedRaw.jid };
            }
            let contactUpdated = false;
            if (verifiedName && contactStore[parsedRaw.jid] && contactStore[parsedRaw.jid].verifiedName !== verifiedName) {
              contactStore[parsedRaw.jid].verifiedName = verifiedName;
              contactUpdated = true;
            }
            if (pushName && !contactStore[parsedRaw.jid].name && contactStore[parsedRaw.jid].notify !== pushName) {
              contactStore[parsedRaw.jid].notify = pushName;
              contactUpdated = true;
            }
            if (contactUpdated) {
              database.upsertContact(contactStore[parsedRaw.jid]);
            }
          }
        }

        const parsed = stores.normalizeMessageRecord(parsedRaw);
        parsed.jid = stores.getPreferredJid(parsed.jid);
        parsed.from = parsed.jid;
        const thread = messageStore[parsed.jid] || [];
        if (thread.some((existing) => existing.id === parsed.id)) continue;
        stores.addMessageToStore(parsed);
        io.emit('message', parsed);
        if (!chatStore[parsed.jid]) {
          const resolved = stores.resolveContactName(parsed.jid);
          chatStore[parsed.jid] = stores.normalizeChat({
            id: parsed.jid,
            name: resolved || stores.chatDisplayName(parsed.jid),
            type: stores.getChatType(parsed.jid),
            unreadCount: 0,
            timestamp: parsed.timestamp,
            lastMsg: parsed.content,
          });
        } else {
          chatStore[parsed.jid].lastMsg = parsed.content;
          chatStore[parsed.jid].timestamp = parsed.timestamp;
          const resolved = stores.resolveContactName(parsed.jid);
          if (resolved) {
            chatStore[parsed.jid].name = resolved;
          } else {
            const currentName = chatStore[parsed.jid].name;
            const cleanJid = parsed.jid?.split('@')[0];
            if (!currentName || currentName === cleanJid || currentName === '+' + cleanJid) {
              chatStore[parsed.jid].name = stores.chatDisplayName(parsed.jid);
            }
          }
        }
        stores.broadcastChats();
        stores.saveStore();
      }
    });

    sock.ev.on('groups.update', (updates) => {
      for (const update of updates) {
        if (groupStore[update.id]) groupStore[update.id] = { ...groupStore[update.id], ...update };
        const meta = groupStore[update.id];
        if (meta && chatStore[update.id]) {
          const type = (meta.isCommunity || meta.isCommunityAnnounce) ? 'community' : 'group';
          if (chatStore[update.id].type !== type) {
            chatStore[update.id].type = type;
            database.upsertChat(chatStore[update.id]);
            stores.broadcastChats();
          }
        }
        io.emit('group_update', update);
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        contactStore[contact.id] = { ...contactStore[contact.id], ...contact };
        // Track @lid <-> phone JID cross-reference mappings.
        stores.addLidMapping(contactStore[contact.id]);
        database.upsertContact(contactStore[contact.id]);
      }
      stores.backfillContactNames();
      stores.saveStore();
    });

    sock.ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        if (contactStore[update.id]) Object.assign(contactStore[update.id], update);
        else contactStore[update.id] = update;
        // Track @lid <-> phone JID mappings from the lid field.
        stores.addLidMapping(contactStore[update.id]);
        database.upsertContact(contactStore[update.id]);
      }
      stores.backfillContactNames();
      stores.saveStore();
    });

    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
      // On-demand responses (from requestOlderHistory / "load older messages")
      // are flagged by Baileys with isLatest === undefined, unlike regular
      // connect-time syncs which always pass a boolean. Use that to keep the
      // MAX_MESSAGES_PER_CHAT cap for bulk initial sync while not discarding
      // history a user explicitly asked to backfill.
      const isOnDemand = isLatest === undefined;
      // --- Process contacts and build lid<->jid map ---
      for (const contact of contacts || []) {
        contactStore[contact.id] = { ...contactStore[contact.id], ...contact };
        // Track @lid <-> phone JID cross-reference mappings.
        stores.addLidMapping(contactStore[contact.id]);
        database.upsertContact(contactStore[contact.id]);
      }
      // --- Process chats ---
      for (const chat of chats || []) {
        const ts = stores.toTimestamp(chat.conversationTimestamp);
        chatStore[chat.id] = stores.normalizeChat({
          ...chatStore[chat.id],
          id: chat.id,
          name: chat.name || stores.chatDisplayName(chat.id),
          type: stores.getChatType(chat.id),
          unreadCount: chat.unreadCount || 0,
          timestamp: ts,
          lastMsg: chatStore[chat.id]?.lastMsg || '',
        });
        database.upsertChat(chatStore[chat.id]);
      }
      // --- Process history messages (this was the missing piece!) ---
      let historyMsgCount = 0;
      const touchedJids = new Set();
      for (const rawMsg of messages || []) {
        try {
          // History messages arrive pre-parsed; they have a .message field like live messages.
          if (!rawMsg?.message) continue;
          const key = rawMsg.key || {};
          const rawJid = key.remoteJid;
          if (!rawJid) continue;
          const jid = stores.getPreferredJid(rawJid);
          let m = stores.unwrapMessage(rawMsg.message);
          if (!m) continue;

          // History messages can also carry verified business name certs;
          // capture them the same way the live messages.upsert handler does,
          // otherwise business contacts backfilled via history never get a name.
          if (!jid.endsWith('@g.us')) {
            const verifiedName = rawMsg.verifiedBizName || rawMsg.verifiedName;
            const pushName = rawMsg.pushName;
            if (verifiedName || pushName) {
              if (!contactStore[jid]) contactStore[jid] = { id: jid };
              let contactUpdated = false;
              if (verifiedName && contactStore[jid].verifiedName !== verifiedName) {
                contactStore[jid].verifiedName = verifiedName;
                contactUpdated = true;
              }
              if (pushName && !contactStore[jid].name && contactStore[jid].notify !== pushName) {
                contactStore[jid].notify = pushName;
                contactUpdated = true;
              }
              if (contactUpdated) database.upsertContact(contactStore[jid]);
            }
          }

          // Check if this is an ignored message type
          const keys = Object.keys(m);
          if (keys.length === 0) continue;
          const isIgnored = keys.length === 1 && (
            keys[0] === 'senderKeyDistributionMessage' ||
            keys[0] === 'protocolMessage' ||
            keys[0] === 'reactionMessage' ||
            keys[0] === 'peerDataOperationRequestMessage' ||
            keys[0] === 'emptyMessage'
          );
          if (isIgnored) continue;

          let content = '';
          let mediaType = 'text';
          let mediaUrl = null;
          // Extract text content from the most common history message shapes.
          // Media is only downloaded for on-demand requests (user clicked "load
          // older messages") - the bulk initial sync can cover thousands of
          // messages and would be too slow/heavy to fetch media for.
          if (m.conversation) {
            content = m.conversation;
          } else if (m.extendedTextMessage?.text) {
            content = m.extendedTextMessage.text;
          } else if (m.imageMessage) {
            content = m.imageMessage.caption || '';
            mediaType = 'image';
            if (isOnDemand) {
              try {
                const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                const ext = mime.extension(m.imageMessage.mimetype) || 'jpg';
                const filename = `${Date.now()}.${ext}`;
                fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                mediaUrl = `/media/${filename}`;
              } catch (e) {
                console.error('[Bridge] History image download failed:', e.message);
              }
            }
          } else if (m.videoMessage) {
            content = m.videoMessage.caption || '';
            mediaType = 'video';
            if (isOnDemand) {
              try {
                const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                const ext = mime.extension(m.videoMessage.mimetype) || 'mp4';
                const filename = `${Date.now()}.${ext}`;
                fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                mediaUrl = `/media/${filename}`;
              } catch (e) {
                console.error('[Bridge] History video download failed:', e.message);
              }
            }
          } else if (m.audioMessage) {
            content = m.audioMessage.ptt ? 'Voice message' : 'Audio file';
            mediaType = m.audioMessage.ptt ? 'voice' : 'audio';
            if (isOnDemand) {
              try {
                const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                const ext = mime.extension(m.audioMessage.mimetype) || 'ogg';
                const filename = `${Date.now()}.${ext}`;
                fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                mediaUrl = `/media/${filename}`;
              } catch (e) {
                console.error('[Bridge] History audio download failed:', e.message);
              }
            }
          } else if (m.documentMessage) {
            content = `Document: ${m.documentMessage.fileName || 'file'}`;
            mediaType = 'document';
            if (isOnDemand) {
              try {
                const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                const safeName = (m.documentMessage.fileName || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
                const filename = `${Date.now()}-${safeName}`;
                fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                mediaUrl = `/media/${filename}`;
              } catch (e) {
                console.error('[Bridge] History document download failed:', e.message);
              }
            }
          } else if (m.stickerMessage) {
            content = 'Sticker';
            mediaType = 'sticker';
            if (isOnDemand) {
              try {
                const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                const filename = `${Date.now()}.webp`;
                fs.writeFileSync(path.join(MEDIA_DIR, filename), buffer);
                mediaUrl = `/media/${filename}`;
              } catch (e) {
                console.error('[Bridge] History sticker download failed:', e.message);
              }
            }
          } else if (m.locationMessage) {
            content = m.locationMessage.name || 'Shared location';
            mediaType = 'location';
          } else if (m.contactMessage) {
            content = `[Contact Card] ${m.contactMessage.displayName || 'Contact'}`;
          } else if (m.contactsArrayMessage) {
            const names = (m.contactsArrayMessage.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
            content = `[Contacts] ${names || 'multiple contacts'}`;
          } else if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
            const pollName = m.pollCreationMessage?.name || m.pollCreationMessageV2?.name || m.pollCreationMessageV3?.name || 'Poll';
            content = `[Poll] Question: ${pollName}`;
          } else if (m.groupInviteMessage) {
            content = `[Group Invite] Group: ${m.groupInviteMessage.groupName || 'invite link'}`;
          } else if (m.buttonsMessage || m.templateMessage || m.interactiveMessage || m.listMessage || m.highlyStructuredMessage || m.templateButtonReplyMessage) {
            content = stores.parseInteractiveMessageText(m);
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
            mediaUrl,
            fileName: m.documentMessage?.fileName || null,
            mimetype: m.imageMessage?.mimetype || m.videoMessage?.mimetype || m.audioMessage?.mimetype || m.documentMessage?.mimetype || null,
            timestamp: stores.toTimestamp(rawMsg.messageTimestamp),
            isGroup: jid.endsWith('@g.us'),
            editedAt: null,
            deleted: Boolean(rawMsg.message?.protocolMessage?.type === 0),
            clientTempId: null,
          };
          if (!msgRecord.id || !msgRecord.jid) continue;
          // addMessageToStore deduplicates, sorts, trims, and persists to DB.
          stores.addMessageToStore(msgRecord, { skipTrim: isOnDemand });
          touchedJids.add(jid);
          historyMsgCount++;
        } catch (histErr) {
          // Don't let one bad history message crash the entire sync.
          console.warn('[Bridge] Skipping bad history message:', histErr.message);
        }
      }
      stores.broadcastChats();
      stores.backfillContactNames();
      stores.saveStore();
      console.log(`[Bridge] History sync: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${historyMsgCount} messages (isLatest=${isLatest})`);
      // Resolve any on-demand history requests (from "load older messages")
      // waiting on one of the jids that just received new messages.
      for (const jid of touchedJids) {
        resolvePendingHistoryRequest(jid);
      }
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        chatStore[chat.id] = stores.normalizeChat({
          ...chatStore[chat.id],
          id: chat.id,
          name: chat.name || stores.chatDisplayName(chat.id),
          type: stores.getChatType(chat.id),
          unreadCount: chat.unreadCount || 0,
          timestamp: stores.toTimestamp(chat.conversationTimestamp),
        });
        database.upsertChat(chatStore[chat.id]);
      }
      stores.broadcastChats();
      stores.saveStore();
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
  let m = stores.unwrapMessage(raw.message);
  if (!m) return null;

  const keys = Object.keys(m);
  if (keys.length === 0) return null;
  const isIgnored = keys.length === 1 && (
    keys[0] === 'senderKeyDistributionMessage' ||
    keys[0] === 'protocolMessage' ||
    keys[0] === 'reactionMessage' ||
    keys[0] === 'peerDataOperationRequestMessage' ||
    keys[0] === 'emptyMessage'
  );
  if (isIgnored) return null;

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
  } else if (m.contactMessage) {
    content = `[Contact Card] ${m.contactMessage.displayName || 'Contact'}`;
  } else if (m.contactsArrayMessage) {
    const names = (m.contactsArrayMessage.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
    content = `[Contacts] ${names || 'multiple contacts'}`;
  } else if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
    const pollName = m.pollCreationMessage?.name || m.pollCreationMessageV2?.name || m.pollCreationMessageV3?.name || 'Poll';
    content = `[Poll] Question: ${pollName}`;
  } else if (m.groupInviteMessage) {
    content = `[Group Invite] Group: ${m.groupInviteMessage.groupName || 'invite link'}`;
  } else if (m.buttonsMessage || m.templateMessage || m.interactiveMessage || m.listMessage || m.highlyStructuredMessage || m.templateButtonReplyMessage) {
    content = stores.parseInteractiveMessageText(m);
  } else {
    content = '[Unsupported message type]';
  }

  return {
    id: raw.key.id,
    from: raw.key.remoteJid,
    jid: raw.key.remoteJid,
    fromMe: raw.key.fromMe,
    participant: raw.participant || raw.key.participant,
    sender: raw.verifiedBizName || raw.verifiedName || raw.pushName || raw.participant || raw.key.participant || null,
    verifiedBizName: raw.verifiedBizName || null,
    verifiedName: raw.verifiedName || null,
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
  const { groupStore, chatStore } = stores;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [id, meta] of Object.entries(groups)) {
      groupStore[id] = meta;
      const type = (meta.isCommunity || meta.isCommunityAnnounce) ? 'community' : 'group';
      if (!chatStore[id]) {
        chatStore[id] = stores.normalizeChat({
          id,
          name: meta.subject,
          type: type,
          unreadCount: 0,
          timestamp: meta.creation || 0,
          lastMsg: '',
        });
      } else {
        chatStore[id].name = meta.subject;
        chatStore[id].type = type;
      }
      database.upsertChat(chatStore[id]);
    }
    io.emit('groups', Object.values(groupStore));
    stores.migrateChatTypes();
    stores.broadcastChats();
    stores.saveStore();
    console.log(`[Bridge] Loaded ${Object.keys(groupStore).length} groups`);
  } catch (e) {
    console.error('[Bridge] Failed to load groups:', e);
  }
}

module.exports = {
  init,
  getSock,
  getStatus,
  getQrCodeData,
  connectToWhatsApp,
  disconnectWhatsApp,
  loadGroups,
  requestOlderHistory,
};
