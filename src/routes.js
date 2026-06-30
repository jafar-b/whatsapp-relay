/**
 * Express REST API and Socket.IO operator-facing events.
 * Owns the connected-operator registry (who's at the dashboard right now),
 * separate from stores.js which owns chat/message/contact data.
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mime = require('mime-types');

function registerRoutes({ app, io, stores, database, whatsapp, CONFIG, MEDIA_DIR }) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = path.extname(file.originalname) || `.${mime.extension(file.mimetype) || 'bin'}`;
      cb(null, unique + ext);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

  // Operator registry (connected dashboard sockets)
  const operators = new Map(); // socketId -> { id, name, connectedAt, socketId }

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

  function broadcastOperators() {
    const list = Array.from(operators.values()).map((op) => ({
      id: op.id,
      name: op.name,
      connectedAt: op.connectedAt,
    }));
    io.emit('operators', list);
  }

  const notConnected = (res) => res.status(503).json({ error: 'Not connected to WhatsApp' });

  app.get('/api/status', (req, res) => {
    const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
    res.json({ status: whatsapp.getStatus(), qr: whatsapp.getQrCodeData(), connectorOperatorId, connectorOperatorName });
  });

  app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
      const operator = getOperatorFromRequest(req);
      const { id: connectorOperatorId } = stores.getConnectorOperator();
      if (connectorOperatorId && (!operator || operator.id !== connectorOperatorId)) {
        return res.status(403).json({ error: 'Only the operator who connected WhatsApp first can disconnect it.' });
      }
      await whatsapp.disconnectWhatsApp();
      res.json({ success: true, message: 'WhatsApp session disconnected and reset.' });
    } catch (err) {
      console.error('[Bridge] Failed to disconnect WhatsApp:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/health', (req, res) =>
    res.json({ uptime: process.uptime(), status: whatsapp.getStatus(), operators: operators.size, chats: Object.keys(stores.chatStore).length })
  );
  app.get('/api/operators', (req, res) =>
    res.json(Array.from(operators.values()).map((op) => ({ id: op.id, name: op.name, connectedAt: op.connectedAt })))
  );
  app.get('/api/groups', (req, res) => res.json(Object.values(stores.groupStore)));
  app.get('/api/chats', (req, res) => res.json(stores.sortedChats()));
  app.get('/api/contacts/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json([]);
    const results = Object.values(stores.contactStore)
      .filter((contact) => {
        const name = (contact.name || contact.notify || '').toLowerCase();
        const phone = (contact.id || '').split('@')[0].split(':')[0];
        return name.includes(q) || phone.includes(q);
      })
      .slice(0, 20)
      .map((contact) => ({
        id: contact.id,
        name: contact.name || contact.notify || contact.id.split('@')[0].split(':')[0],
        phone: contact.id.split('@')[0].split(':')[0],
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
      const contacts = Object.values(stores.contactStore)
        .map((c) => ({
          id: c.id,
          name: c.name || c.notify || c.verifiedName || c.id.split('@')[0].split(':')[0],
          phone: c.id.split('@')[0].split(':')[0],
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

        const exists = stores.contactStore[jid] || database.db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(jid);
        if (exists) {
          skipped++;
          if (stores.chatStore[jid] && (!stores.chatStore[jid].name || stores.chatStore[jid].name === c.phone)) {
            stores.chatStore[jid].name = c.name;
            database.upsertChat(stores.chatStore[jid]);
          }
          continue;
        }

        const contactObj = { id: jid, name: c.name, notify: c.name };
        stores.contactStore[jid] = contactObj;
        database.upsertContact(contactObj);
        imported++;
      }

      try { fs.unlinkSync(vcfPath); } catch { }

      io.emit('contacts_updated');
      stores.broadcastChats();
      stores.saveStore();

      res.json({ success: true, imported, skipped });
    } catch (err) {
      try { fs.unlinkSync(vcfPath); } catch { }
      console.error('[Bridge] Contact import failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/messages', async (req, res) => {
    const { jid, limit = 50, before } = req.query;
    if (!jid) {
      const allMsgs = Object.values(stores.messageStore)
        .flat()
        .sort((a, b) => stores.toTimestamp(a.timestamp) - stores.toTimestamp(b.timestamp));
      return res.json(allMsgs.slice(-Number(limit)));
    }

    // Hydrate from DB if cold before returning combined list
    const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
    const hydrate = (targetJid) => {
      if (!stores.messageStore[targetJid] || stores.messageStore[targetJid].length === 0) {
        try {
          const dbMsgsStmt = database.db.prepare(
            'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
          );
          const rows = dbMsgsStmt.all(targetJid, CONFIG.MAX_MESSAGES_PER_CHAT);
          if (rows.length > 0) {
            stores.messageStore[targetJid] = rows.map((row) => stores.normalizeMessageRecord(JSON.parse(row.payload)));
          }
        } catch (dbErr) {
          console.warn(`[Bridge] API messages DB hydration error for ${targetJid}:`, dbErr.message);
        }
      }
    };
    hydrate(jid);
    if (altJid) hydrate(altJid);

    const filterToBefore = (list) => {
      if (!before) return list;
      const beforeTs = Number(before);
      return list.filter((msg) => stores.toTimestamp(msg.timestamp) < beforeTs);
    };

    let msgs = filterToBefore(stores.getMessagesForJid(jid));

    // Local store had nothing older than the requested cursor — ask WhatsApp
    // itself for more history (on-demand sync) before giving up, since the
    // local cache only ever holds what's already been synced/received.
    if (before && msgs.length === 0) {
      try {
        const result = await whatsapp.requestOlderHistory(jid, Number(limit));
        if (result.ok && result.added > 0) {
          msgs = filterToBefore(stores.getMessagesForJid(jid));
        }
      } catch (e) {
        console.warn(`[Bridge] On-demand history fetch failed for ${jid}:`, e.message);
      }
    }

    const total = msgs.length;
    const sliced = msgs.slice(-Number(limit));
    res.json({ messages: sliced, hasMore: total > sliced.length, total, chat: stores.normalizeChat(stores.chatStore[jid]) || null });
  });

  app.post('/api/chats/:jid/claim', (req, res) => {
    const operator = getOperatorFromRequest(req);
    const result = stores.assignChat(req.params.jid, operator);
    if (!result.ok) return res.status(result.status).json({ error: result.message, chat: result.chat });
    res.json({ success: true, chat: result.chat });
  });

  app.post('/api/chats/:jid/release', (req, res) => {
    const operator = getOperatorFromRequest(req);
    const result = stores.releaseChat(req.params.jid, operator);
    if (!result.ok) return res.status(result.status).json({ error: result.message, chat: result.chat });
    res.json({ success: true, chat: result.chat });
  });

  app.post('/api/send', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const result = await sock.sendMessage(req.body.jid, { text: req.body.text });
      const message = await stores.recordOutboundMessage({
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
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const result = await sock.sendMessage(req.body.jid, {
        image: fs.readFileSync(req.file.path),
        caption: req.body.caption || '',
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
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
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const result = await sock.sendMessage(req.body.jid, {
        video: fs.readFileSync(req.file.path),
        caption: req.body.caption || '',
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
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
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const ptt = req.body.ptt === 'true';
      const result = await sock.sendMessage(req.body.jid, {
        audio: fs.readFileSync(req.file.path),
        mimetype: req.file.mimetype || 'audio/ogg; codecs=opus',
        ptt,
      });
      const message = await stores.recordOutboundMessage({
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
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      const fileName = req.body.filename || req.file.originalname;
      const result = await sock.sendMessage(req.body.jid, {
        document: fs.readFileSync(req.file.path),
        fileName,
        mimetype: req.file.mimetype,
      });
      const message = await stores.recordOutboundMessage({
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
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const lock = stores.ensureChatLockForOperator(req.body.jid, operator);
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
      const message = await stores.recordOutboundMessage({
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
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const { messageId } = req.params;
    const { jid, newContent } = req.body;
    if (!jid || !newContent) return res.status(400).json({ error: 'jid and newContent required' });
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      await sock.sendMessage(jid, { edit: { id: messageId, remoteJid: jid, fromMe: true }, text: newContent });
      const msgs = stores.messageStore[jid];
      if (msgs) {
        const found = msgs.find((msg) => msg.id === messageId);
        if (found) {
          found.content = newContent;
          found.editedAt = Date.now();
          database.upsertMessage(found);
        }
      }
      io.emit('message_edited', { jid, messageId, newContent, editedAt: Date.now() });
      stores.saveStore();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/messages/:messageId', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    const operator = getOperatorFromRequest(req);
    const { messageId } = req.params;
    const jid = req.query.jid || req.body.jid;
    if (!jid) return res.status(400).json({ error: 'jid required' });
    const lock = stores.ensureChatLockForOperator(jid, operator);
    if (!lock.ok) return res.status(lock.status).json({ error: lock.message, chat: lock.chat });
    try {
      await sock.sendMessage(jid, { delete: { id: messageId, remoteJid: jid, fromMe: true } });
      const msgs = stores.messageStore[jid];
      if (msgs) {
        const found = msgs.find((msg) => msg.id === messageId);
        if (found) {
          found.deleted = true;
          found.content = '';
          database.upsertMessage(found);
        }
      }
      io.emit('message_deleted', { jid, messageId });
      stores.saveStore();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/groups/create', async (req, res) => {
    const sock = whatsapp.getSock();
    if (!sock || whatsapp.getStatus() !== 'connected') return notConnected(res);
    try {
      const result = await sock.groupCreate(req.body.name, req.body.participants);
      stores.groupStore[result.id] = result;
      io.emit('group_created', result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // WebSocket (operator dashboard <-> server)
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

    const { id: connectorOperatorId, name: connectorOperatorName } = stores.getConnectorOperator();
    socket.emit('status', { status: whatsapp.getStatus(), connectorOperatorId, connectorOperatorName });
    if (whatsapp.getQrCodeData()) socket.emit('qr', whatsapp.getQrCodeData());
    socket.emit('groups', Object.values(stores.groupStore));
    socket.emit('chats', stores.sortedChats());

    socket.on('set_operator_name', ({ name }) => {
      const op = operators.get(socket.id);
      if (op) {
        op.name = name || op.id;
        operators.set(socket.id, op);
      }
      broadcastOperators();
      socket.emit('chats', stores.sortedChats());
    });

    socket.on('linking_whatsapp', ({ operatorId, operatorName }) => {
      stores.setLinkingOperator({ id: operatorId, name: operatorName });
      console.log(`[Bridge] Operator ${operatorName || operatorId} is scanning/linking WhatsApp`);
    });

    socket.on('claim_chat', ({ jid }) => {
      const operator = getOperatorFromSocket(socket);
      const result = stores.assignChat(jid, operator);
      if (!result.ok) return stores.sendLockError(socket, result);
      socket.emit('chat_claimed', { jid, chat: result.chat });
    });

    socket.on('release_chat', ({ jid }) => {
      const operator = getOperatorFromSocket(socket);
      const result = stores.releaseChat(jid, operator);
      if (!result.ok) return stores.sendLockError(socket, result);
      socket.emit('chat_released', { jid, chat: result.chat });
    });

    socket.on('open_chat', ({ jid }) => {
      console.log(`[Bridge] open_chat event received for JID: ${jid}`);
      if (jid.endsWith('@lid') && !stores.lidToJid[jid]) {
        stores.resolveLidToPhoneAsync(jid).then((pn) => {
          if (pn) {
            io.emit('chats', stores.sortedChats());
          }
        });
      }

      // If in-memory store is cold (e.g. after a server restart) but SQLite has
      // persisted messages, hydrate the in-memory store from the DB now so the
      // operator sees chat history immediately on click.
      const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];

      const hydrate = (targetJid) => {
        if (!stores.messageStore[targetJid] || stores.messageStore[targetJid].length === 0) {
          try {
            const dbMsgsStmt = database.db.prepare(
              'SELECT payload FROM messages WHERE jid = ? ORDER BY timestamp ASC, id ASC LIMIT ?'
            );
            const rows = dbMsgsStmt.all(targetJid, CONFIG.MAX_MESSAGES_PER_CHAT);
            if (rows.length > 0) {
              stores.messageStore[targetJid] = rows.map((row) => stores.normalizeMessageRecord(JSON.parse(row.payload)));
            }
          } catch (dbErr) {
            console.warn(`[Bridge] open_chat DB hydration error for ${targetJid}:`, dbErr.message);
          }
        }
      };

      hydrate(jid);
      if (altJid) hydrate(altJid);

      const msgs = stores.getMessagesForJid(jid);
      const limit = 50;
      const sliced = msgs.slice(-limit);
      socket.emit('chat_messages', {
        jid,
        messages: sliced,
        hasMore: msgs.length > limit,
        total: msgs.length,
        chat: stores.normalizeChat(stores.chatStore[jid]) || null,
      });
    });

    socket.on('send_message', async ({ jid, text, clientTempId }) => {
      const sock = whatsapp.getSock();
      if (!sock || whatsapp.getStatus() !== 'connected') return;
      const operator = getOperatorFromSocket(socket);
      const lock = stores.ensureChatLockForOperator(jid, operator);
      if (!lock.ok) return stores.sendLockError(socket, lock);
      try {
        const result = await sock.sendMessage(jid, { text });
        const sentMsg = await stores.recordOutboundMessage({
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
      const sock = whatsapp.getSock();
      if (!sock || whatsapp.getStatus() !== 'connected') return;
      const operator = getOperatorFromSocket(socket);
      const lock = stores.ensureChatLockForOperator(jid, operator);
      if (!lock.ok) return stores.sendLockError(socket, lock);
      try {
        await sock.sendMessage(jid, { edit: { id: messageId, remoteJid: jid, fromMe: true }, text: newContent });
        const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
        const targetJids = altJid ? [jid, altJid] : [jid];
        for (const tJid of targetJids) {
          const msgs = stores.messageStore[tJid];
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
        stores.saveStore();
      } catch (e) {
        socket.emit('error', { message: e.message });
      }
    });

    socket.on('delete_message', async ({ jid, messageId }) => {
      const sock = whatsapp.getSock();
      if (!sock || whatsapp.getStatus() !== 'connected') return;
      const operator = getOperatorFromSocket(socket);
      const lock = stores.ensureChatLockForOperator(jid, operator);
      if (!lock.ok) return stores.sendLockError(socket, lock);
      try {
        await sock.sendMessage(jid, { delete: { id: messageId, remoteJid: jid, fromMe: true } });
        const altJid = jid.endsWith('@lid') ? stores.lidToJid[jid] : stores.jidToLid[jid];
        const targetJids = altJid ? [jid, altJid] : [jid];
        for (const tJid of targetJids) {
          const msgs = stores.messageStore[tJid];
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
        stores.saveStore();
      } catch (e) {
        socket.emit('error', { message: e.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Bridge] Operator disconnected: ${socket.id}`);
      const operator = getOperatorFromSocket(socket);
      operators.delete(socket.id);
      if (CONFIG.RELEASE_ASSIGNMENTS_ON_DISCONNECT && operator?.id) {
        for (const chat of Object.values(stores.chatStore)) {
          if (chat.assignedOperatorId === operator.id) {
            stores.releaseChat(chat.id, operator, { force: true });
          }
        }
      }
      broadcastOperators();
    });
  });
}

module.exports = { registerRoutes };
