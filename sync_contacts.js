#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT_DIR = __dirname;
const VCF_FILE = path.join(ROOT_DIR, 'contacts.vcf');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

function loadJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function unfoldVcf(content) {
  return content.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function parseVcf(filePath) {
  const content = unfoldVcf(fs.readFileSync(filePath, 'utf8'));
  const contacts = new Map();
  const cards = content.split('BEGIN:VCARD');

  for (const card of cards) {
    if (!card.trim()) continue;

    const nameMatch = card.match(/^FN(?:;[^:]*)?:(.+)$/m);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const telMatches = card.matchAll(/^TEL[^:]*:([^\n]+)/gm);

    for (const match of telMatches) {
      const digits = digitsOnly(match[1]);
      if (digits.length < 7) continue;
      contacts.set(digits, name);
      if (digits.length >= 10) contacts.set(digits.slice(-10), name);
    }
  }

  return contacts;
}

function initDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
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
  `);
  return db;
}

function main() {
  const config = loadJson(CONFIG_FILE);
  const dbPath = path.resolve(ROOT_DIR, config.DB_PATH || './relay.sqlite');
  const vcfPath = path.resolve(ROOT_DIR, process.argv[2] || VCF_FILE);

  if (!fs.existsSync(vcfPath)) {
    console.error(`Error: ${vcfPath} not found. Export your contacts from contacts.google.com first.`);
    process.exitCode = 1;
    return;
  }

  const vcfContacts = parseVcf(vcfPath);
  const db = initDatabase(dbPath);

  const selectChatsStmt = db.prepare('SELECT id, name, type, payload FROM chats');
  const selectContactStmt = db.prepare('SELECT payload FROM contacts WHERE id = ?');
  const selectAllContactsStmt = db.prepare('SELECT payload FROM contacts');
  const upsertContactStmt = db.prepare(`
    INSERT INTO contacts (id, payload, updated_at)
    VALUES (@id, @payload, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);
  const updateChatStmt = db.prepare('UPDATE chats SET name = ?, payload = ?, updated_at = ? WHERE id = ?');

  const lidToJid = new Map();
  for (const row of selectAllContactsStmt.iterate()) {
    try {
      const contact = JSON.parse(row.payload);
      if (contact.lid && contact.id && !contact.id.endsWith('@lid')) {
        lidToJid.set(contact.lid, contact.id);
      }
    } catch {}
  }

  let updatedChats = 0;
  let updatedContacts = 0;

  const tx = db.transaction(() => {
    for (const chat of selectChatsStmt.iterate()) {
      if (chat.type !== 'personal') continue;

      const jid = chat.id;
      let phone = jid.split('@')[0];
      if (jid.endsWith('@lid')) {
        const phoneJid = lidToJid.get(jid);
        if (phoneJid) {
          phone = phoneJid.split('@')[0];
        }
      }
      if (chat.name && chat.name !== phone && chat.name !== '+' + phone && chat.name !== jid.split('@')[0]) continue;

      const name = vcfContacts.get(phone) || (phone.length >= 10 ? vcfContacts.get(phone.slice(-10)) : null);
      if (!name) continue;

      const chatPayload = JSON.parse(chat.payload);
      chatPayload.name = name;

      const contactRow = selectContactStmt.get(jid);
      const contactPayload = contactRow ? JSON.parse(contactRow.payload) : { id: jid };
      contactPayload.id = jid;
      contactPayload.name = name;

      updateChatStmt.run(name, JSON.stringify(chatPayload), Date.now(), jid);
      upsertContactStmt.run({
        id: jid,
        payload: JSON.stringify(contactPayload),
        updated_at: Date.now(),
      });

      updatedChats += 1;
      updatedContacts += 1;
    }
  });

  tx();
  db.close();

  console.log(`Parsed ${vcfContacts.size} phone numbers from VCF`);
  console.log(`Updated ${updatedChats} chats and ${updatedContacts} contacts in ${path.basename(dbPath)}`);
  console.log('Done - restart the bridge: pm2 restart wa-relay');
}

if (require.main === module) {
  main();
}