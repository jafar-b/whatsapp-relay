/**
 * In-memory chat/message/contact state, JID<->LID resolution, and chat
 * assignment (locking) logic.
 *
 * `database`, `io`, and `sock` are injected via setters rather than
 * required directly, since this module is constructed before the
 * WhatsApp socket exists and would otherwise form a require() cycle
 * with db.js (db.js needs normalizeChat/normalizeMessageRecord from here).
 */

const fs = require('fs');
const path = require('path');

let ROOT_DIR = null;
let CONFIG = null;
let io = null;
let database = null;
let sock = null;

const messageStore = {};
const groupStore = {};
const contactStore = {};
const chatStore = {};
// Maps @lid JIDs to their corresponding @s.whatsapp.net JID and vice-versa.
// WhatsApp's multi-device protocol uses opaque @lid identifiers internally;
// we track both directions so resolveContactName() works regardless of format.
const lidToJid = {};  // "hex123@lid" -> "91987...@s.whatsapp.net"
const jidToLid = {};  // "91987...@s.whatsapp.net" -> "hex123@lid"

let connectorOperatorId = null;
let connectorOperatorName = null;
let linkingOperator = null;

let saveTimer = null;
const pendingResolutions = new Set();
const DEFAULT_EDIT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_DELETE_FOR_EVERYONE_WINDOW_SECONDS = 60 * 60 * 60;

function init({ rootDir, config }) {
  ROOT_DIR = rootDir;
  CONFIG = config;
}

function setIo(ioInstance) { io = ioInstance; }
function setDatabase(db) { database = db; }
function setSock(sockInstance) { sock = sockInstance; }
function getSock() { return sock; }

function getConnectorOperator() {
  return { id: connectorOperatorId, name: connectorOperatorName };
}
function setConnectorOperator(id, name) {
  connectorOperatorId = id;
  connectorOperatorName = name;
}
function getLinkingOperator() { return linkingOperator; }
function setLinkingOperator(operator) { linkingOperator = operator; }

function clearInMemoryStores() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  for (const key of Object.keys(messageStore)) delete messageStore[key];
  for (const key of Object.keys(groupStore)) delete groupStore[key];
  for (const key of Object.keys(contactStore)) delete contactStore[key];
  for (const key of Object.keys(chatStore)) delete chatStore[key];
  for (const key of Object.keys(lidToJid)) delete lidToJid[key];
  for (const key of Object.keys(jidToLid)) delete jidToLid[key];
}

function addLidMapping(contact) {
  if (!contact) return;
  const id = contact.id;
  if (id) {
    if (id.endsWith('@lid') && contact.phoneNumber) {
      lidToJid[id] = contact.phoneNumber;
      jidToLid[contact.phoneNumber] = id;
    } else if (!id.endsWith('@lid') && contact.lid) {
      lidToJid[contact.lid] = id;
      jidToLid[id] = contact.lid;
    }
  }
}

function cleanJidToPhone(jid) {
  if (!jid) return '';
  if (jid.includes('@')) {
    const parts = jid.split('@');
    const domain = parts[1];
    if (domain === 's.whatsapp.net' || domain === 'lid') {
      const num = parts[0].split(':')[0];
      return num.startsWith('+') ? num : '+' + num;
    }
    return parts[0];
  }
  if (jid.includes(':')) {
    const num = jid.split(':')[0];
    return num.startsWith('+') ? num : '+' + num;
  }
  return jid.startsWith('+') ? jid : '+' + jid;
}

function toTimestamp(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string' && ts.trim()) return Number(ts) || 0;
  if (typeof ts === 'object' && 'low' in ts) return ts.low + ts.high * 4294967296;
  return 0;
}

async function resolveLidToPhoneAsync(lid) {
  if (!lid || !lid.endsWith('@lid')) return null;
  if (lidToJid[lid]) return lidToJid[lid];
  if (pendingResolutions.has(lid)) return null;

  pendingResolutions.add(lid);
  console.log(`[Bridge] Starting resolution for LID: ${lid}`);

  try {
    if (!sock) {
      console.log(`[Bridge] Cannot resolve LID ${lid}: sock is not initialized.`);
      return null;
    }
    if (!sock.signalRepository) {
      console.log(`[Bridge] Cannot resolve LID ${lid}: sock.signalRepository is undefined.`);
      return null;
    }
    if (!sock.signalRepository.lidMapping) {
      console.log(`[Bridge] Cannot resolve LID ${lid}: sock.signalRepository.lidMapping is undefined.`);
      return null;
    }

    const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
    if (pn) {
      console.log(`[Bridge] Resolved LID ${lid} -> PN ${pn}`);
      lidToJid[lid] = pn;
      jidToLid[pn] = lid;

      // Persist to contacts
      const existing = contactStore[lid] || { id: lid };
      existing.phoneNumber = pn;
      contactStore[lid] = existing;
      database.upsertContact(existing);

      const existingPn = contactStore[pn] || { id: pn };
      existingPn.lid = lid;
      contactStore[pn] = existingPn;
      database.upsertContact(existingPn);

      return pn;
    } else {
      console.log(`[Bridge] Baileys getPNForLID returned null/undefined for LID ${lid}`);
    }
  } catch (e) {
    console.warn(`[Bridge] Error resolving LID ${lid}:`, e.message);
  } finally {
    pendingResolutions.delete(lid);
  }

  return null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveAllLidsFromStore() {
  console.log('[Bridge] Starting background resolution for all stored LIDs...');
  let resolvedCount = 0;
  for (const jid of Object.keys(chatStore)) {
    if (jid.endsWith('@lid') && !lidToJid[jid]) {
      const pn = await resolveLidToPhoneAsync(jid);
      if (pn) resolvedCount++;
      await delay(1000);
    }
  }
  for (const jid of Object.keys(contactStore)) {
    if (jid.endsWith('@lid') && !lidToJid[jid]) {
      const pn = await resolveLidToPhoneAsync(jid);
      if (pn) resolvedCount++;
      await delay(1000);
    }
  }
  if (resolvedCount > 0) {
    console.log(`[Bridge] Background resolution finished. Resolved ${resolvedCount} LIDs to phone numbers.`);
    backfillContactNames();
  }
}

function normalizeChat(chat = {}) {
  let phone = null;
  const id = chat.id;
  if (id) {
    if (id.endsWith('@s.whatsapp.net')) {
      phone = id.split('@')[0].split(':')[0];
    } else if (id.endsWith('@lid')) {
      const phoneJid = lidToJid[id];
      if (phoneJid) {
        phone = phoneJid.split('@')[0].split(':')[0];
      } else {
        // Trigger background resolution!
        resolveLidToPhoneAsync(id).then((pn) => {
          if (pn) backfillContactNames();
        });
      }
    }
  }

  // Resolve verifiedName from contactStore if not already set on chat
  let verifiedName = chat.verifiedName || null;
  if (id && !verifiedName) {
    const contact = contactStore[id];
    if (contact?.verifiedName) {
      verifiedName = contact.verifiedName;
    }
  }

  // Refresh name if it's currently numeric/ambiguous or missing
  let currentName = chat.name;
  const isAmbiguous = !currentName || /^\+?\d+$/.test(currentName) || currentName.includes('@');
  if (isAmbiguous && id) {
    currentName = chatDisplayName(id);
  }

  return {
    ...chat,
    phone: phone || chat.phone || null,
    unreadCount: Number(chat.unreadCount || 0),
    timestamp: toTimestamp(chat.timestamp),
    lastMsg: chat.lastMsg || '',
    name: currentName,
    verifiedName: verifiedName,
    assignedOperatorId: chat.assignedOperatorId || null,
    assignedOperatorName: chat.assignedOperatorName || null,
    assignedAt: chat.assignedAt || null,
  };
}

function normalizeMessageRecord(msg = {}) {
  const participantJid = msg.participant || msg.sender;
  let resolvedSender = msg.sender;
  if (participantJid) {
    resolvedSender = resolveContactName(participantJid) || msg.sender;
    if (!resolvedSender || resolvedSender === participantJid || resolvedSender.endsWith('@lid') || resolvedSender.endsWith('@s.whatsapp.net') || resolvedSender.includes(':')) {
      if (participantJid.endsWith('@lid')) {
        const phoneJid = lidToJid[participantJid];
        if (phoneJid) {
          resolvedSender = resolveContactName(phoneJid) || cleanJidToPhone(phoneJid);
        } else {
          // Trigger background resolution!
          resolveLidToPhoneAsync(participantJid);
        }
      } else if (participantJid.endsWith('@s.whatsapp.net')) {
        const lidJid = jidToLid[participantJid];
        if (lidJid) {
          resolvedSender = resolveContactName(lidJid);
        }
        if (!resolvedSender) {
          resolvedSender = cleanJidToPhone(participantJid);
        }
      }
    }
  }
  if (resolvedSender && (resolvedSender.endsWith('@lid') || resolvedSender.endsWith('@s.whatsapp.net') || resolvedSender.includes(':') || /^\+?\d+$/.test(resolvedSender))) {
    resolvedSender = cleanJidToPhone(resolvedSender);
  }

  return {
    ...msg,
    id: msg.id,
    from: msg.from || msg.jid,
    jid: msg.from || msg.jid,
    fromMe: Boolean(msg.fromMe),
    participant: msg.participant || null,
    sender: resolvedSender || msg.sender || null,
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
    quotedMessageId: msg.quotedMessageId || null,
    quotedContent: msg.quotedContent || null,
    quotedSender: msg.quotedSender || null,
    quotedMediaType: msg.quotedMediaType || null,
  };
}

function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

function parseInteractiveMessageText(m) {
  if (!m) return '';

  if (m.buttonsMessage) {
    let txt = m.buttonsMessage.contentText || '';
    const btns = (m.buttonsMessage.buttons || []).map(b => `[${b.buttonText?.displayText || ''}]`).join(' ');
    if (btns) txt += `\n\n${btns}`;
    return txt;
  }

  if (m.templateMessage) {
    let txt = m.templateMessage.hydratedTemplate?.hydratedContentText || '';
    const btns = (m.templateMessage.hydratedTemplate?.hydratedButtons || []).map(b => {
      const t = b.quickReplyButton?.displayText || b.urlButton?.displayText || b.callButton?.displayText || '';
      return t ? `[${t}]` : '';
    }).filter(Boolean).join(' ');
    if (btns) txt += `\n\n${btns}`;
    return txt;
  }

  if (m.interactiveMessage) {
    let txt = m.interactiveMessage.body?.text || '';
    let btnList = [];
    if (m.interactiveMessage.nativeFlowMessage?.buttons) {
      for (const btn of m.interactiveMessage.nativeFlowMessage.buttons) {
        try {
          const params = typeof btn.buttonParamsJson === 'string' ? JSON.parse(btn.buttonParamsJson) : btn.buttonParamsJson;
          const label = params?.display_text || btn.name;
          if (label) btnList.push(`[${label}]`);
        } catch {}
      }
    }
    if (btnList.length > 0) txt += `\n\n${btnList.join(' ')}`;
    return txt;
  }

  if (m.listMessage) {
    let txt = m.listMessage.description || m.listMessage.title || '';
    if (m.listMessage.buttonText) {
      txt += `\n\n[Menu: ${m.listMessage.buttonText}]`;
    }
    return txt;
  }

  if (m.highlyStructuredMessage) {
    // hydratedHsm carries the same shape as templateMessage.
    return parseInteractiveMessageText({ templateMessage: m.highlyStructuredMessage.hydratedHsm });
  }

  if (m.templateButtonReplyMessage) {
    return m.templateButtonReplyMessage.selectedDisplayText || m.templateButtonReplyMessage.selectedId || '';
  }

  return '';
}

function loadStore() {
  try {
    const STORE_FILE = path.join(ROOT_DIR, 'store.json');
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
        addLidMapping(contact);
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
    migrateChatTypes();
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
    else {
      // Trigger background resolution!
      resolveLidToPhoneAsync(jid);
    }
  } else {
    const lidJid = jidToLid[jid];
    if (lidJid && chatStore[lidJid] && !chatStore[jid]) {
      return lidJid;
    }
  }
  return jid;
}

function getChatType(jid) {
  if (!jid) return 'personal';
  if (jid.endsWith('@g.us')) {
    const groupMeta = groupStore[jid];
    if (groupMeta?.isCommunity || groupMeta?.isCommunityAnnounce) {
      return 'community';
    }
    return 'group';
  }
  if (jid.endsWith('@newsletter')) return 'channel';
  if (jid.endsWith('@broadcast')) return 'status';
  return 'personal';
}

function migrateChatTypes() {
  let updated = false;
  for (const [jid, chat] of Object.entries(chatStore)) {
    const correctType = getChatType(jid);
    if (chat.type !== correctType) {
      chat.type = correctType;
      database.upsertChat(chat);
      updated = true;
    }
  }
  if (updated) {
    console.log('[Bridge] Migrated/corrected types for some chats');
    broadcastChats();
  }
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

function toUnixSeconds(ts) {
  const normalized = toTimestamp(ts);
  if (!normalized) return 0;
  // Defensive normalization: some producers may emit milliseconds.
  if (normalized > 100000000000) return Math.floor(normalized / 1000);
  return normalized;
}

function getThreadJids(jid) {
  if (!jid) return [];
  const preferred = getPreferredJid(jid) || jid;
  const altJid = preferred.endsWith('@lid') ? lidToJid[preferred] : jidToLid[preferred];
  return altJid ? [preferred, altJid] : [preferred];
}

function findMessageInThread(jid, messageId) {
  if (!jid || !messageId) return null;
  const threadJids = getThreadJids(jid);
  for (const threadJid of threadJids) {
    const msgs = messageStore[threadJid];
    if (!msgs) continue;
    const found = msgs.find((msg) => msg.id === messageId);
    if (found) return found;
  }
  return null;
}

function canEditMessage(jid, messageId, options = {}) {
  const msg = findMessageInThread(jid, messageId);
  const windowSeconds = Number(options.windowSeconds) || DEFAULT_EDIT_WINDOW_SECONDS;
  const nowSeconds = toUnixSeconds(options.nowSeconds || Math.floor(Date.now() / 1000));

  if (!msg) {
    return {
      ok: false,
      status: 404,
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (!msg.fromMe) {
    return {
      ok: false,
      status: 403,
      code: 'ONLY_SENT_MESSAGES_EDITABLE',
      message: 'Only your sent messages can be edited',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (msg.deleted) {
    return {
      ok: false,
      status: 409,
      code: 'MESSAGE_ALREADY_DELETED',
      message: 'Cannot edit a deleted message',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if ((msg.mediaType || 'text') !== 'text') {
    return {
      ok: false,
      status: 400,
      code: 'ONLY_TEXT_MESSAGES_EDITABLE',
      message: 'Only text messages can be edited',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  const msgSeconds = toUnixSeconds(msg.timestamp);
  const ageSeconds = Math.max(0, nowSeconds - msgSeconds);
  const remainingSeconds = Math.max(0, windowSeconds - ageSeconds);
  if (!msgSeconds || ageSeconds > windowSeconds) {
    return {
      ok: false,
      status: 410,
      code: 'EDIT_WINDOW_EXPIRED',
      message: 'Edit window expired (15 minutes)',
      windowSeconds,
      remainingSeconds,
    };
  }

  return { ok: true, message: msg, windowSeconds, remainingSeconds };
}

function canDeleteForEveryone(jid, messageId, options = {}) {
  const msg = findMessageInThread(jid, messageId);
  const windowSeconds = Number(options.windowSeconds) || DEFAULT_DELETE_FOR_EVERYONE_WINDOW_SECONDS;
  const nowSeconds = toUnixSeconds(options.nowSeconds || Math.floor(Date.now() / 1000));

  if (!msg) {
    return {
      ok: false,
      status: 404,
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (!msg.fromMe) {
    return {
      ok: false,
      status: 403,
      code: 'ONLY_SENT_MESSAGES_DELETABLE',
      message: 'Only your sent messages can be deleted for everyone',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  if (msg.deleted) {
    return {
      ok: false,
      status: 409,
      code: 'MESSAGE_ALREADY_DELETED',
      message: 'Message is already deleted',
      windowSeconds,
      remainingSeconds: 0,
    };
  }

  const msgSeconds = toUnixSeconds(msg.timestamp);
  const ageSeconds = Math.max(0, nowSeconds - msgSeconds);
  const remainingSeconds = Math.max(0, windowSeconds - ageSeconds);
  if (!msgSeconds || ageSeconds > windowSeconds) {
    return {
      ok: false,
      status: 410,
      code: 'DELETE_WINDOW_EXPIRED',
      message: 'Delete for everyone window expired (60 hours)',
      windowSeconds,
      remainingSeconds,
    };
  }

  return { ok: true, message: msg, windowSeconds, remainingSeconds };
}

function backfillContactNames() {
  let updated = false;
  for (const [jid, chat] of Object.entries(chatStore)) {
    if (chat.type !== 'personal') continue;
    const name = resolveContactName(jid);
    if (name) {
      if (chat.name !== name) {
        chat.name = name;
        updated = true;
      }
    } else {
      const normalized = normalizeChat(chat);
      if (chat.name !== normalized.name || chat.phone !== normalized.phone) {
        chat.name = normalized.name;
        chat.phone = normalized.phone;
        updated = true;
      }
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

function addMessageToStore(msg, options = {}) {
  const normalized = normalizeMessageRecord(msg);
  const jid = normalized.jid;
  if (!jid || !normalized.id) return normalized;
  if (!messageStore[jid]) messageStore[jid] = [];
  const existingIndex = messageStore[jid].findIndex((item) => item.id === normalized.id);
  if (existingIndex >= 0) messageStore[jid][existingIndex] = normalized;
  else messageStore[jid].push(normalized);
  messageStore[jid].sort((a, b) => toTimestamp(a.timestamp) - toTimestamp(b.timestamp));
  // Skipped for on-demand history backfill ("load older messages"): trimming
  // to the most recent N here would discard the older messages immediately
  // after fetching them once a thread is already at the cap.
  if (!options.skipTrim && messageStore[jid].length > CONFIG.MAX_MESSAGES_PER_CHAT) {
    messageStore[jid] = messageStore[jid].slice(-CONFIG.MAX_MESSAGES_PER_CHAT);
  }
  database.upsertMessage(normalized);
  return normalized;
}

function broadcastChats() {
  io.emit('chats', sortedChats());
}

function chatDisplayName(jid) {
  let resolvedName = resolveContactName(jid);

  // Format numeric fallback
  let phoneFallback = jid.split('@')[0];
  let isUnresolvedLid = false;
  if (jid.endsWith('@lid')) {
    const phoneJid = lidToJid[jid];
    if (phoneJid) {
      phoneFallback = phoneJid.split('@')[0];
    } else {
      isUnresolvedLid = true;
    }
  }
  const formattedPhone = '+' + phoneFallback.split(':')[0];

  if (resolvedName) {
    const isAmbiguous = !resolvedName || resolvedName.length <= 2 || /^\+?\d+$/.test(resolvedName);
    if (isAmbiguous && jid && !jid.endsWith('@g.us')) {
      if (isUnresolvedLid) {
        return `${resolvedName} (LID: ${phoneFallback})`;
      }
      return `${resolvedName} (${formattedPhone})`;
    }
    return resolvedName;
  }

  if (jid.endsWith('@s.whatsapp.net')) {
    return formattedPhone;
  }

  if (jid.endsWith('@lid')) {
    return `LID: ${phoneFallback}`;
  }

  return jid?.split('@')[0]?.split(':')[0] || jid;
}

function ensureChatExists(jid) {
  if (!chatStore[jid]) {
    chatStore[jid] = normalizeChat({
      id: jid,
      name: chatDisplayName(jid),
      type: getChatType(jid),
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
    quotedMessageId: message.quotedMessageId || null,
    quotedContent: message.quotedContent || null,
    quotedSender: message.quotedSender || null,
    quotedMediaType: message.quotedMediaType || null,
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

module.exports = {
  init,
  setIo,
  setDatabase,
  setSock,
  getSock,
  getConnectorOperator,
  setConnectorOperator,
  getLinkingOperator,
  setLinkingOperator,

  messageStore,
  groupStore,
  contactStore,
  chatStore,
  lidToJid,
  jidToLid,

  clearInMemoryStores,
  addLidMapping,
  cleanJidToPhone,
  toTimestamp,
  resolveLidToPhoneAsync,
  resolveAllLidsFromStore,
  canEditMessage,
  canDeleteForEveryone,
  findMessageInThread,
  normalizeChat,
  normalizeMessageRecord,
  unwrapMessage,
  parseInteractiveMessageText,
  loadStore,
  sortedChats,
  resolveContactName,
  getPreferredJid,
  getChatType,
  migrateChatTypes,
  getMessagesForJid,
  backfillContactNames,
  saveStore,
  addMessageToStore,
  broadcastChats,
  chatDisplayName,
  ensureChatExists,
  isAssignableChat,
  assignChat,
  releaseChat,
  ensureChatLockForOperator,
  updateChatPreview,
  recordOutboundMessage,
  sendLockError,
};
