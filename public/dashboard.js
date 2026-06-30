    // ─── State ───────────────────────────────────────────────────────────────────
    let socket = null;
    let bridgeUrl = 'http://localhost:3001';
    let activeChat = null;         // { id, name, type, ... }
    let currentTab = 'operators';
    let operatorId = localStorage.getItem('whatsapp_relay_operator_id') || '';
    let operatorName = localStorage.getItem('whatsapp_relay_operator_name') || '';
    let connectorOperatorId = null;
    let connectorOperatorName = null;
    let pendingMedia = null;
    let allChats = [];
    let allContacts = [];
    let searchTimer = null;
    let editingMessageId = null;
    let editingMessageJid = null;
    let confirmCallback = null;
    let chatMessageCounts = {};    // jid -> total message count
    let chatHasMore = {};          // jid -> boolean
    let sentTempIds = new Set();   // track locally-sent message IDs to avoid dupes

    function currentOperator() {
      return { id: operatorId, name: operatorName || operatorId || 'Unknown' };
    }

    function operatorHeaders() {
      return {
        'x-operator-id': operatorId,
        'x-operator-name': operatorName || operatorId,
      };
    }

    function isAssignedChat(chat) {
      return Boolean(chat?.assignedOperatorId);
    }

    function isAssignedToMe(chat) {
      return Boolean(chat?.assignedOperatorId && chat.assignedOperatorId === operatorId);
    }

    function isAssignedToOther(chat) {
      return Boolean(chat?.assignedOperatorId && chat.assignedOperatorId !== operatorId);
    }

    function assignmentText(chat) {
      if (!chat || chat.type === 'group') return 'Shared';
      if (!chat.assignedOperatorId) return 'Unassigned';
      return isAssignedToMe(chat) ? `Mine · ${chat.assignedOperatorName || chat.assignedOperatorId}` : `Locked · ${chat.assignedOperatorName || chat.assignedOperatorId}`;
    }

    function upsertChatRecord(chat) {
      if (!chat?.id) return;
      const idx = allChats.findIndex(c => c.id === chat.id);
      if (idx >= 0) allChats[idx] = { ...allChats[idx], ...chat };
      else allChats.push(chat);
      allChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    function syncActiveChat() {
      if (!activeChat?.id) return;
      const latest = allChats.find(c => c.id === activeChat.id);
      if (latest) activeChat = { ...activeChat, ...latest };
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────────
    function updateStatus(status, text) {
      const pill = document.getElementById('statusPill');
      pill.className = 'status-pill ' + status;
      document.getElementById('statusText').textContent = text;
    }

    function showToast(msg, type = 'success') {
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    function normalizeBridgeUrl(input) {
      const raw = String(input || '').trim();
      if (!raw) return null;
      const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
      try {
        const parsed = new URL(candidate);
        return parsed.origin;
      } catch {
        return null;
      }
    }

    async function parseJsonResponse(res) {
      const text = await res.text();
      const contentType = (res.headers.get('content-type') || '').toLowerCase();

      if (contentType.includes('application/json')) {
        try {
          return text ? JSON.parse(text) : {};
        } catch {
          throw new Error('Invalid JSON response from bridge');
        }
      }

      const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ');
      throw new Error(`Bridge returned non-JSON response (${res.status}): ${snippet || 'empty body'}`);
    }

    function autoResize(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    function handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    }

    function formatTime(d) {
      if (!d) return '';
      const dt = d instanceof Date ? d : new Date(d);
      return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDate(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + formatTime(d);
    }

    function cleanJid(val) {
      if (!val) return '';
      val = String(val).trim();
      if (val.startsWith('LID: ')) return val;
      if (val.includes('@')) {
        const parts = val.split('@');
        const domain = parts[1];
        if (domain === 's.whatsapp.net') {
          const num = parts[0].split(':')[0];
          return num.startsWith('+') ? num : '+' + num;
        }
        if (domain === 'lid') {
          return 'LID: ' + parts[0];
        }
        return parts[0];
      }
      if (val.includes(':')) {
        if (/^[a-zA-Z]/.test(val)) return val;
        const num = val.split(':')[0];
        if (/^\d{8,}$/.test(num)) {
          return '+' + num;
        }
        return num;
      }
      if (/^\d{8,}$/.test(val)) {
        return '+' + val;
      }
      return val;
    }

    function renderChatHeader() {
      const assignmentPill = document.getElementById('assignmentPill');
      const claimBtn = document.getElementById('claimChatBtn');
      const releaseBtn = document.getElementById('releaseChatBtn');
      const lockNote = document.getElementById('lockNote');
      if (!activeChat) {
        assignmentPill.textContent = 'Unassigned';
        assignmentPill.className = 'assignment-pill';
        claimBtn.style.display = 'none';
        releaseBtn.style.display = 'none';
        lockNote.classList.remove('visible');
        lockNote.textContent = '';
        return;
      }

      let meta = (activeChat.type === 'group' || activeChat.type === 'community')
        ? `${activeChat.participants || '?'} participants`
        : cleanJid(activeChat.phone || activeChat.id || '');
      let topDisplayName = cleanJid(activeChat.verifiedName || activeChat.name || activeChat.id);

      if (activeChat.type === 'personal') {
        const cleanId = cleanJid(activeChat.id);
        const cleanPhone = activeChat.phone ? cleanJid(activeChat.phone) : '';
        const isLidOrJidDisplayName = (topDisplayName === cleanId || topDisplayName.startsWith('LID: ') || /^\+?1\d{14}$/.test(topDisplayName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(topDisplayName.replace(/\s+/g, '')));
        if (isLidOrJidDisplayName && cleanPhone && cleanPhone !== topDisplayName) {
          const originalDisplayName = topDisplayName;
          topDisplayName = cleanPhone;
          meta = originalDisplayName;
        } else if (topDisplayName === cleanPhone && cleanId && cleanId !== cleanPhone) {
          meta = cleanId;
        }
      }
      const isVerified = Boolean(activeChat.verifiedName);
      const verifiedBadge = isVerified ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="#0095f6" viewBox="0 0 16 16" style="margin-left:6px;vertical-align:middle;flex-shrink:0;" title="Verified Business"><path d="M10.067.87a2.89 2.89 0 0 0-4.134 0l-.622.622-2.08-.02a2.89 2.89 0 0 0-2.91 2.91l.02 2.08-.622.622a2.89 2.89 0 0 0 0 4.134l.622.622-.02 2.08a2.89 2.89 0 0 0 2.91 2.91l2.08-.02.622.622a2.89 2.89 0 0 0 4.134 0l.622-.622 2.08.02a2.89 2.89 0 0 0 2.91-2.91l-.02-2.08.622-.622a2.89 2.89 0 0 0 0-4.134l-.622-.622.02-2.08a2.89 2.89 0 0 0-2.91-2.91l-2.08.02-.622-.622zM8.14 10.146a.75.75 0 0 1-1.079-.02L4.697 7.731a.75.75 0 1 1 1.071-1.05l1.829 1.828L11.83 4.5a.75.75 0 1 1 1.06 1.06L8.14 10.147z"/></svg>` : '';

      const topAvatarInitial = (topDisplayName.startsWith('+') ? topDisplayName.slice(1) : topDisplayName || '?')[0].toUpperCase();
      document.getElementById('chatTopAvatar').textContent = topAvatarInitial;
      document.getElementById('chatTopName').innerHTML = `<span style="display:inline-flex;align-items:center;">${topDisplayName}${verifiedBadge}</span>`;
      document.getElementById('chatTopMeta').textContent = meta;

      assignmentPill.textContent = assignmentText(activeChat);
      assignmentPill.className = 'assignment-pill';
      if (isAssignedToMe(activeChat)) assignmentPill.classList.add('mine');
      else if (isAssignedToOther(activeChat)) assignmentPill.classList.add('locked');

      if (activeChat.type === 'group' || activeChat.type === 'community') {
        claimBtn.style.display = 'none';
        releaseBtn.style.display = 'none';
        lockNote.classList.remove('visible');
        lockNote.textContent = '';
      } else if (isAssignedToOther(activeChat)) {
        claimBtn.style.display = 'none';
        releaseBtn.style.display = 'none';
        lockNote.textContent = `Replies locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`;
        lockNote.classList.add('visible');
      } else {
        claimBtn.style.display = isAssignedToMe(activeChat) ? 'none' : 'inline-flex';
        releaseBtn.style.display = isAssignedToMe(activeChat) ? 'inline-flex' : 'none';
        lockNote.classList.remove('visible');
        lockNote.textContent = '';
      }

      refreshComposerState();
    }

    function refreshComposerState() {
      const isGroup = activeChat && (activeChat.type === 'group' || activeChat.type === 'community');
      const disabled = Boolean(activeChat && !isGroup && isAssignedToOther(activeChat));
      const input = document.getElementById('messageInput');
      const sendBtn = document.getElementById('sendBtn');
      const attachBtn = document.getElementById('attachBtn');
      input.disabled = disabled;
      sendBtn.disabled = disabled;
      attachBtn.disabled = disabled;
      input.placeholder = disabled
        ? `Locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`
        : 'Type a message… (Enter to send)';
    }

    function getDocIcon(name = '') {
      const ext = (name || '').split('.').pop().toLowerCase();
      if (['pdf'].includes(ext)) return '📕';
      if (['doc', 'docx'].includes(ext)) return '📘';
      if (['xls', 'xlsx'].includes(ext)) return '📗';
      if (['ppt', 'pptx'].includes(ext)) return '📙';
      if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
      return '📄';
    }

    function genTempId() { return 'temp-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6); }

    // ─── Confirm Dialog ───────────────────────────────────────────────────────────
    function showConfirm(msg, cb) {
      document.getElementById('confirmMsg').textContent = msg;
      document.getElementById('confirmOverlay').classList.remove('hidden');
      confirmCallback = cb;
      document.getElementById('confirmOk').onclick = () => {
        dismissConfirm();
        if (cb) cb();
      };
    }
    function dismissConfirm() {
      document.getElementById('confirmOverlay').classList.add('hidden');
      confirmCallback = null;
    }

    // ─── Operator Name ────────────────────────────────────────────────────────────
    function promptOperatorName() {
      document.getElementById('namePrompt').classList.remove('hidden');
      document.getElementById('operatorNameInput').focus();
    }
    function saveOperatorName() {
      const name = document.getElementById('operatorNameInput').value.trim();
      operatorName = name || operatorId;
      localStorage.setItem('whatsapp_relay_operator_name', operatorName);
      document.getElementById('namePrompt').classList.add('hidden');
      document.getElementById('operatorBadge').textContent = 'op://' + operatorName.toLowerCase().replace(/\s+/g, '-');
      if (socket?.connected) {
        socket.emit('set_operator_name', { name: operatorName });
      }
    }

    // ─── Lightbox ─────────────────────────────────────────────────────────────────
    function openLightbox(src) {
      document.getElementById('lightboxImg').src = src;
      document.getElementById('lightbox').classList.remove('hidden');
    }
    function closeLightbox() { document.getElementById('lightbox').classList.add('hidden'); }

    // ─── Chat List ────────────────────────────────────────────────────────────────
    let activeSidebarTab = 'chats';

    function switchSidebarTab(tab) {
      activeSidebarTab = tab;
      document.querySelectorAll('.sidebar-tabs .tab-btn').forEach(btn => {
        btn.classList.remove('active');
      });
      const btnId = 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1);
      const activeBtn = document.getElementById(btnId);
      if (activeBtn) activeBtn.classList.add('active');

      if (tab === 'contacts') {
        renderContactsList();
        loadContacts();
      } else {
        renderChatList(allChats);
      }
    }

    function initSidebarResize() {
      const resizer = document.getElementById('sidebarResizer');
      const main = document.querySelector('.main');
      if (!resizer || !main) return;

      let isResizing = false;

      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizer.classList.add('resizing');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const mainRect = main.getBoundingClientRect();
        let newWidth = e.clientX - mainRect.left;
        if (newWidth < 180) newWidth = 180;
        if (newWidth > 450) newWidth = 450;
        main.style.gridTemplateColumns = `${newWidth}px 1fr 300px`;
      });

      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          resizer.classList.remove('resizing');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    function renderChatList(chats) {
      allChats = chats || [];
      const list = document.getElementById('chatList');
      list.innerHTML = '';

      let filteredChats = allChats;
      if (activeSidebarTab === 'chats') {
        filteredChats = allChats.filter(c => c.type !== 'group' && c.type !== 'community' && !c.id.endsWith('@g.us') && !c.id.endsWith('@newsletter') && !c.id.endsWith('@broadcast'));
      } else if (activeSidebarTab === 'groups') {
        filteredChats = allChats.filter(c => (c.type === 'group' || c.id.endsWith('@g.us')) && c.type !== 'community');
      } else if (activeSidebarTab === 'communities') {
        filteredChats = allChats.filter(c => c.type === 'community');
      } else if (activeSidebarTab === 'channels') {
        filteredChats = allChats.filter(c => c.type === 'channel' || c.id.endsWith('@newsletter'));
      } else if (activeSidebarTab === 'status') {
        filteredChats = allChats.filter(c => c.type === 'status' || c.id.endsWith('@broadcast'));
      }

      document.getElementById('chatCount').textContent = filteredChats.length;
      document.getElementById('statGroups').textContent = allChats.filter(c => (c.type === 'group' || c.id.endsWith('@g.us')) && c.type !== 'community').length;

      filteredChats.forEach(chat => {
        const assigneeClass = isAssignedToMe(chat) ? 'chat-assignee mine' : (isAssignedToOther(chat) ? 'chat-assignee locked' : 'chat-assignee');
        const isGroupChat = chat.type === 'group' || chat.type === 'community' || chat.id.endsWith('@g.us');
        const assigneeLabel = isGroupChat ? '' : `<div class="${assigneeClass}">${!chat.assignedOperatorId ? 'Open' : (isAssignedToMe(chat) ? 'Mine' : (chat.assignedOperatorName || 'Locked'))}</div>`;
        const item = document.createElement('div');
        item.className = 'chat-item' + (activeChat?.id === chat.id ? ' active' : '');
        item.setAttribute('data-jid', chat.id);
        item.onclick = () => openChat(chat, item);

        let displayName = cleanJid(chat.verifiedName || chat.name || chat.id);
        if (chat.id === 'status@broadcast') {
          displayName = 'Status Updates';
        } else if (chat.id.endsWith('@newsletter') && !chat.name) {
          displayName = 'Channel: ' + cleanJid(chat.id);
        } else if (chat.type === 'personal') {
          const cleanId = cleanJid(chat.id);
          const cleanPhone = chat.phone ? cleanJid(chat.phone) : '';
          const isLidOrJidDisplayName = (displayName === cleanId || displayName.startsWith('LID: ') || /^\+?1\d{14}$/.test(displayName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(displayName.replace(/\s+/g, '')));
          if (isLidOrJidDisplayName && cleanPhone && cleanPhone !== displayName) {
            displayName = cleanPhone;
          }
        }

        const isVerified = Boolean(chat.verifiedName);
        const verifiedBadge = isVerified ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="#0095f6" viewBox="0 0 16 16" style="margin-left:4px;vertical-align:middle;flex-shrink:0;" title="Verified Business"><path d="M10.067.87a2.89 2.89 0 0 0-4.134 0l-.622.622-2.08-.02a2.89 2.89 0 0 0-2.91 2.91l.02 2.08-.622.622a2.89 2.89 0 0 0 0 4.134l.622.622-.02 2.08a2.89 2.89 0 0 0 2.91 2.91l2.08-.02.622.622a2.89 2.89 0 0 0 4.134 0l.622-.622 2.08.02a2.89 2.89 0 0 0 2.91-2.91l-.02-2.08.622-.622a2.89 2.89 0 0 0 0-4.134l-.622-.622.02-2.08a2.89 2.89 0 0 0-2.91-2.91l-2.08.02-.622-.622zM8.14 10.146a.75.75 0 0 1-1.079-.02L4.697 7.731a.75.75 0 1 1 1.071-1.05l1.829 1.828L11.83 4.5a.75.75 0 1 1 1.06 1.06L8.14 10.147z"/></svg>` : '';

        let avatarType = 'personal';
        if (chat.type === 'community') {
          avatarType = 'community';
        } else if (chat.type === 'channel' || chat.id.endsWith('@newsletter')) {
          avatarType = 'channel';
        } else if (chat.type === 'status' || chat.id.endsWith('@broadcast')) {
          avatarType = 'status';
        } else if (isGroupChat) {
          avatarType = 'group';
        }

        const avatarInitial = (displayName.startsWith('+') ? displayName.slice(1) : displayName || '?')[0].toUpperCase();

        item.innerHTML = `
      <div class="chat-avatar ${avatarType}">${avatarInitial}</div>
      <div class="chat-info">
        <div class="chat-name-row">
          <div class="chat-name" style="display:flex;align-items:center;min-width:0;width:100%;">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${displayName}</span>
            ${verifiedBadge}
          </div>
          ${assigneeLabel}
        </div>
        <div class="chat-preview">${chat.lastMsg || chat.preview || ''}</div>
      </div>
      ${chat.unread || chat.unreadCount ? '<div class="unread-dot"></div>' : ''}
    `;
        list.appendChild(item);
      });
    }

    function renderContactsList() {
      const list = document.getElementById('chatList');
      list.innerHTML = '';

      document.getElementById('chatCount').textContent = allContacts.length;

      if (allContacts.length === 0) {
        list.innerHTML = `
      <div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">
        No contacts found.<br>Use "Import Contacts" to add VCF contacts.
      </div>
    `;
        return;
      }

      allContacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'chat-item';
        item.onclick = () => openContactChat(contact);

        let cleanName = cleanJid(contact.name);
        const cleanPhone = contact.phone ? cleanJid(contact.phone) : '';
        const isLidOrJidName = (cleanName === cleanJid(contact.id) || cleanName.startsWith('LID: ') || /^\+?1\d{14}$/.test(cleanName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(cleanName.replace(/\s+/g, '')));
        if (isLidOrJidName && cleanPhone && cleanPhone !== cleanName) {
          cleanName = cleanPhone;
        }
        const avatarInitial = (cleanName.startsWith('+') ? cleanName.slice(1) : cleanName || '?')[0].toUpperCase();
        item.innerHTML = `
      <div class="chat-avatar personal">${avatarInitial}</div>
      <div class="chat-info">
        <div class="chat-name-row">
          <div class="chat-name">${cleanName}</div>
        </div>
        <div class="chat-preview">+${contact.phone.split(':')[0]}</div>
      </div>
    `;
        list.appendChild(item);
      });
    }

    async function loadContacts() {
      if (!socket) return;
      try {
        const res = await fetch(`${bridgeUrl}/api/contacts`);
        allContacts = await res.json();
        if (activeSidebarTab === 'contacts') {
          renderContactsList();
        }
      } catch (e) {
        console.error('Failed to load contacts:', e);
      }
    }

    function openContactChat(contact) {
      let chat = allChats.find(c => c.id === contact.id);
      if (!chat) {
        chat = {
          id: contact.id,
          name: contact.name,
          type: 'personal',
          lastMsg: '',
          timestamp: Math.floor(Date.now() / 1000),
          unreadCount: 0,
          phone: contact.phone
        };
        allChats.unshift(chat);
      }
      switchSidebarTab('chats');
      openChat(chat, null);
    }

    function triggerImportContacts() {
      document.getElementById('fileInputContacts').click();
    }

    async function handleImportContacts(input) {
      const file = input.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      try {
        showToast('Importing contacts...', 'info');
        const res = await fetch(`${bridgeUrl}/api/contacts/import`, {
          method: 'POST',
          body: formData
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Import failed');
        }
        const data = await res.json();
        showToast(`Imported ${data.imported} contacts (skipped ${data.skipped} duplicates).`);
        loadContacts();
      } catch (e) {
        showToast('Import failed: ' + e.message, 'error');
      } finally {
        input.value = '';
      }
    }

    // ─── Search ───────────────────────────────────────────────────────────────────
    function onSearch(q) {
      clearTimeout(searchTimer);
      const resultsEl = document.getElementById('searchResults');
      if (!q.trim()) { resultsEl.classList.remove('visible'); return; }

      const localMatches = allChats.filter(c => (c.name || '').toLowerCase().includes(q.toLowerCase()));
      if (localMatches.length) {
        renderSearchResults(localMatches.map(c => ({ id: c.id, name: c.name, phone: c.id.split('@')[0].split(':')[0] })));
      }

      if (socket) {
        searchTimer = setTimeout(async () => {
          try {
            const res = await fetch(`${bridgeUrl}/api/contacts/search?q=${encodeURIComponent(q)}`);
            const contacts = await res.json();
            if (contacts.length) renderSearchResults(contacts);
          } catch (e) { }
        }, 300);
      }
    }

    function renderSearchResults(results) {
      const el = document.getElementById('searchResults');
      if (!results.length) { el.classList.remove('visible'); return; }
      el.innerHTML = results.map(r => {
        let cleanName = cleanJid(r.name || r.phone);
        const cleanPhone = cleanJid(r.phone);
        const isLidOrJidName = (cleanName === cleanJid(r.id) || /^\+?1\d{14}$/.test(cleanName.replace(/\s+/g, '')) || /^\+?\d{10,}$/.test(cleanName.replace(/\s+/g, '')));
        if (isLidOrJidName && cleanPhone && cleanPhone !== cleanName) {
          cleanName = cleanPhone;
        }
        const avatarInitial = (cleanName.startsWith('+') ? cleanName.slice(1) : cleanName || '?')[0].toUpperCase();
        return `
      <div class="search-result-item" onclick="openChatById('${r.id}','${cleanName.replace(/'/g, "\\'")}')">
        <div class="chat-avatar personal" style="width:28px;height:28px;font-size:11px;flex-shrink:0">${avatarInitial}</div>
        <div>
          <div style="font-weight:600">${cleanName}</div>
          <div class="search-result-phone">${cleanPhone}</div>
        </div>
      </div>`;
      }).join('');
      el.classList.add('visible');
    }

    function openChatById(id, name) {
      document.getElementById('searchInput').value = '';
      document.getElementById('searchResults').classList.remove('visible');
      const existing = allChats.find(c => c.id === id);
      let type = 'personal';
      if (id.endsWith('@g.us')) type = 'group';
      else if (id.endsWith('@newsletter')) type = 'channel';
      else if (id.endsWith('@broadcast')) type = 'status';

      if (existing && existing.type) {
        type = existing.type;
      }

      if (type === 'community') {
        switchSidebarTab('communities');
      } else if (type === 'group') {
        switchSidebarTab('groups');
      } else if (type === 'channel') {
        switchSidebarTab('channels');
      } else if (type === 'status') {
        switchSidebarTab('status');
      } else {
        switchSidebarTab('chats');
      }

      const chat = existing || { id, name, type, lastMsg: '' };
      openChat(chat, null);
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap') && !e.target.closest('.search-results')) {
        document.getElementById('searchResults').classList.remove('visible');
      }
    });

    function openChat(chat, itemEl) {
      activeChat = chat;
      cancelEdit();
      updateChatItemHighlight();
      document.getElementById('emptyState').style.display = 'none';
      const cv = document.getElementById('chatView');
      cv.style.display = 'flex';
      renderChatHeader();
      clearMessages();
      document.getElementById('loadMoreIndicator').style.display = 'none';

      // Request messages from server
      if (socket?.connected) {
        socket.emit('open_chat', { jid: chat.id });
      }
    }

    function updateChatItemHighlight() {
      document.querySelectorAll('.chat-item').forEach(el => {
        if (activeChat && el.getAttribute('data-jid') === activeChat.id) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });
    }

    function clearMessages() {
      const area = document.getElementById('messagesArea');
      area.innerHTML = '';
      // Re-add load-more indicator
      const div = document.createElement('div');
      div.className = 'load-more-indicator';
      div.id = 'loadMoreIndicator';
      div.style.display = 'none';
      div.innerHTML = '<button class="load-more-btn" onclick="loadMoreMessages()">↑ Load older messages</button>';
      area.appendChild(div);
    }

    async function claimActiveChat() {
      if (!activeChat || !socket?.connected) return;
      try {
        const res = await fetch(`${bridgeUrl}/api/chats/${encodeURIComponent(activeChat.id)}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
          body: JSON.stringify({ operatorId, operatorName }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error || 'Unable to claim conversation');
        upsertChatRecord(data.chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
        showToast('Conversation claimed');
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    async function releaseActiveChat() {
      if (!activeChat || !socket?.connected) return;
      try {
        const res = await fetch(`${bridgeUrl}/api/chats/${encodeURIComponent(activeChat.id)}/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
          body: JSON.stringify({ operatorId, operatorName }),
        });
        const data = await parseJsonResponse(res);
        if (!res.ok) throw new Error(data.error || 'Unable to release conversation');
        upsertChatRecord(data.chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
        showToast('Conversation released');
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    // ─── Message Rendering ────────────────────────────────────────────────────────
    function buildMediaContent(msg) {
      switch (msg.mediaType) {
        case 'image':
          return `<img class="msg-image" src="${msg.mediaUrl}" alt="Image" onclick="openLightbox('${msg.mediaUrl}')">
              ${msg.content ? `<div>${msg.content}</div>` : ''}`;
        case 'video':
          return `<video class="msg-video" controls><source src="${msg.mediaUrl}"></video>
              ${msg.content ? `<div>${msg.content}</div>` : ''}`;
        case 'voice':
        case 'audio':
          return `<div style="margin-bottom:4px;font-size:11px;opacity:0.7">${msg.mediaType === 'voice' ? '🎤 Voice Message' : '🎵 Audio'}</div>
              <audio class="msg-audio" controls><source src="${msg.mediaUrl}"></audio>`;
        case 'document':
          return `<a class="msg-document" href="${msg.mediaUrl}" target="_blank" download>
        <div class="doc-icon">${getDocIcon(msg.fileName || msg.content)}</div>
        <div>
          <div class="doc-name">${msg.fileName || msg.content || 'Document'}</div>
          <div class="doc-size">Tap to download</div>
        </div>
      </a>`;
        case 'sticker':
          return `<img class="msg-sticker" src="${msg.mediaUrl}" alt="Sticker">`;
        case 'location':
          return `<a class="msg-location" href="${msg.mediaUrl}" target="_blank">
        <div style="font-size:24px">📍</div>
        <div><div style="font-size:13px;font-weight:600">${msg.content || 'Location'}</div><div style="font-size:11px;opacity:0.6">Open in Maps</div></div>
      </a>`;
        default:
          return `<div>${msg.content || ''}</div>`;
      }
    }

    function appendMessage(msg, scroll = true, prepend = false) {
      const area = document.getElementById('messagesArea');
      // Check for duplicate
      if (document.getElementById('msg-' + msg.id)) return;

      // Filter deleted messages
      if (msg.deleted) {
        // Only show deletion placeholder
      }

      const outgoing = msg.fromMe || msg.outgoing || false;
      const row = document.createElement('div');
      row.id = 'msg-' + msg.id;
      row.className = 'message-row ' + (outgoing ? 'outgoing' : 'incoming');
      row.dataset.timestamp = msg.timestamp || '';
      let resolvedSender = cleanJid(msg.sender);
      const senderName = outgoing
        ? (msg.operatorName || resolvedSender || 'Unknown')
        : (resolvedSender || (msg.participant ? cleanJid(msg.participant) : 'Unknown'));

      const initialName = outgoing
        ? (msg.operatorName || operatorName || '?')
        : (activeChat && activeChat.type !== 'group' && activeChat.type !== 'community' && activeChat.name
          ? activeChat.name
          : (msg.sender || msg.participant || '?'));
      const cleanInitialName = cleanJid(initialName).replace('+', '');
      const initial = (cleanInitialName || '?')[0].toUpperCase();
      const timeStr = msg.time || (msg.timestamp ? formatTime(new Date(msg.timestamp * 1000)) : '');
      const isGroup = activeChat?.type === 'group' || activeChat?.type === 'community';
      const editedMark = msg.editedAt ? '<div class="msg-edited">(edited)</div>' : '';
      const showSender = (!outgoing && isGroup) || (outgoing && Boolean(msg.operatorName));

      let contentHtml;
      if (msg.deleted) {
        contentHtml = '<div class="msg-deleted">This message was deleted</div>';
      } else {
        contentHtml = buildMediaContent(msg);
      }

      row.innerHTML = `
    <div class="msg-avatar">${initial}</div>
    <div class="msg-bubble">
      ${showSender ? `<div class="msg-sender">${senderName}</div>` : ''}
      ${contentHtml}
      ${msg.deleted ? '' : `<div class="msg-time">${timeStr}${editedMark}</div>`}
      ${outgoing && !msg.deleted ? `
        <div class="msg-actions">
          ${msg.mediaType === 'text' ? `<button class="btn-ghost-sm" onclick="startEdit('${msg.id}','${(msg.content || '').replace(/'/g, "\\'").replace(/"/g, '"')}')">✎ Edit</button>` : ''}
          <button class="btn-ghost-sm" style="color:var(--danger)" onclick="startDelete('${msg.id}')">🗑 Delete</button>
        </div>` : ''}
    </div>
  `;

      if (prepend) {
        area.insertBefore(row, area.children[1]); // after load-more indicator
      } else {
        area.appendChild(row);
      }
      if (scroll) area.scrollTop = area.scrollHeight;
    }

    function updateMessageInPlace(messageId, newContent, editedAt) {
      const row = document.getElementById('msg-' + messageId);
      if (!row) return;
      const bubble = row.querySelector('.msg-bubble');
      if (!bubble) return;
      // Update content
      const contentDiv = bubble.querySelector('div:first-of-type');
      if (contentDiv && !contentDiv.classList.contains('msg-sender') && !contentDiv.classList.contains('msg-time') && !contentDiv.classList.contains('msg-edited') && !contentDiv.classList.contains('msg-actions') && !contentDiv.classList.contains('msg-deleted')) {
        contentDiv.textContent = newContent;
      }
      // Add/update edited mark
      const timeDiv = bubble.querySelector('.msg-time');
      if (timeDiv) {
        const existing = timeDiv.querySelector('.msg-edited');
        if (existing) existing.remove();
        timeDiv.insertAdjacentHTML('beforeend', '<span class="msg-edited"> (edited)</span>');
      }
    }

    function markMessageDeleted(messageId) {
      const row = document.getElementById('msg-' + messageId);
      if (!row) return;
      const bubble = row.querySelector('.msg-bubble');
      if (!bubble) return;
      bubble.innerHTML = '<div class="msg-deleted">This message was deleted</div>';
    }

    // ─── Chat Messages Loaded ────────────────────────────────────────────────────
    function onChatMessagesLoaded(data) {
      if (!activeChat || data.jid !== activeChat.id) return;
      if (data.chat) {
        upsertChatRecord(data.chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
      }
      chatMessageCounts[data.jid] = data.total;
      chatHasMore[data.jid] = data.hasMore;

      clearMessages();
      document.getElementById('loadMoreIndicator').style.display = data.hasMore ? 'block' : 'none';

      (data.messages || []).forEach(m => {
        appendMessage(normalizeMessage(m), false);
      });

      const area = document.getElementById('messagesArea');
      area.scrollTop = area.scrollHeight;
      document.getElementById('statMessages').textContent = data.total;
      // Update chat list preview
      if (data.messages.length) {
        const last = data.messages[data.messages.length - 1];
        const existing = allChats.find(c => c.id === activeChat.id);
        if (existing && last) {
          existing.lastMsg = last.content || '';
          existing.timestamp = last.timestamp;
        }
      }
    }

    function normalizeMessage(m) {
      let sender = cleanJid(m.sender || '');
      if (!sender) {
        const part = m.participant || m.from;
        if (part) {
          sender = cleanJid(part);
        }
      }
      return {
        id: m.id,
        sender: sender || 'Unknown',
        participant: m.participant,
        content: m.content,
        time: m.timestamp ? formatTime(new Date(m.timestamp * 1000)) : '',
        timestamp: m.timestamp,
        outgoing: m.fromMe || false,
        fromMe: m.fromMe || false,
        operatorId: m.operatorId || null,
        operatorName: m.operatorName || null,
        mediaType: m.mediaType || 'text',
        mediaUrl: m.mediaUrl ? (m.mediaUrl.startsWith('http') ? m.mediaUrl : `${bridgeUrl}${m.mediaUrl}`) : null,
        fileName: m.fileName,
        mimetype: m.mimetype,
        editedAt: m.editedAt,
        deleted: m.deleted || false,
      };
    }

    function loadMoreMessages() {
      if (!activeChat || !socket) return;
      const jid = activeChat.id;
      const area = document.getElementById('messagesArea');
      const firstMsgRow = area.querySelector('.message-row');
      const before = firstMsgRow?.dataset.timestamp || null;

      (async () => {
        try {
          if (chatHasMore[jid] === false) {
            showToast('No more messages to load', 'error');
            return;
          }
          let url = `${bridgeUrl}/api/messages?jid=${encodeURIComponent(jid)}&limit=30`;
          if (before) url += `&before=${encodeURIComponent(before)}`;
          const res = await fetch(url);
          const data = await res.json();
          const msgs = data.messages || data;
          if (!msgs.length) {
            chatHasMore[jid] = false;
            document.getElementById('loadMoreIndicator').style.display = 'none';
            return;
          }
          chatHasMore[jid] = data.hasMore !== false;
          document.getElementById('loadMoreIndicator').style.display = chatHasMore[jid] ? 'block' : 'none';

          // Prepend each message (oldest first in response, prepend to maintain order)
          msgs.reverse().forEach(m => {
            appendMessage(normalizeMessage(m), false, true);
          });
        } catch (e) { showToast('Failed to load messages', 'error'); }
      })();
    }

    // ─── Message Actions (Edit / Delete) ──────────────────────────────────────────
    function startEdit(messageId, currentContent) {
      if (!activeChat) return;
      editingMessageId = messageId;
      editingMessageJid = activeChat.id;
      document.getElementById('editingBar').classList.add('visible');
      document.getElementById('editingBarText').textContent = 'Editing: ' + (currentContent.length > 40 ? currentContent.substring(0, 40) + '…' : currentContent);
      document.getElementById('messageInput').value = currentContent;
      document.getElementById('messageInput').focus();
      document.getElementById('sendBtn').querySelector('svg').innerHTML = '<path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>';
      autoResize(document.getElementById('messageInput'));
    }

    function cancelEdit() {
      editingMessageId = null;
      editingMessageJid = null;
      document.getElementById('editingBar').classList.remove('visible');
      document.getElementById('messageInput').value = '';
      document.getElementById('sendBtn').querySelector('svg').innerHTML = '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>';
    }

    function startDelete(messageId) {
      showConfirm('Delete this message for everyone?', () => {
        deleteMessage(messageId);
      });
    }

    function deleteMessage(messageId) {
      if (!socket?.connected || !activeChat) return;
      socket.emit('delete_message', { jid: activeChat.id, messageId });
    }

    // ─── Send ─────────────────────────────────────────────────────────────────────
    async function sendMessage() {
      if (!activeChat) return;
      if (isAssignedToOther(activeChat)) {
        showToast(`Conversation locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`, 'error');
        return;
      }

      // If editing
      if (editingMessageId) {
        await sendEdit();
        return;
      }

      // Send media if pending
      if (pendingMedia) {
        await sendMedia();
        return;
      }

      const input = document.getElementById('messageInput');
      const text = input.value.trim();
      if (!text) return;

      const tempId = genTempId();
      if (socket?.connected) {
        socket.emit('send_message', { jid: activeChat.id, text, clientTempId: tempId });
      } else {
        showToast('Not connected to bridge', 'error');
        return;
      }

      // Optimistic local append (will be deduped when server broadcast arrives)
      const now = new Date();
      appendMessage({
        id: tempId,
        sender: operatorName,
        operatorName,
        content: text,
        time: formatTime(now),
        outgoing: true,
        fromMe: true,
        mediaType: 'text',
        deleted: false,
      });
      sentTempIds.add(tempId);

      input.value = '';
      input.style.height = 'auto';
    }

    async function sendEdit() {
      if (!socket?.connected || !editingMessageId || !editingMessageJid) return;
      const text = document.getElementById('messageInput').value.trim();
      if (!text) return;

      socket.emit('edit_message', {
        jid: editingMessageJid,
        messageId: editingMessageId,
        newContent: text,
      });

      // Optimistic update
      updateMessageInPlace(editingMessageId, text, Date.now());
      cancelEdit();
      document.getElementById('messageInput').value = '';
    }

    async function sendMedia() {
      if (isAssignedToOther(activeChat)) {
        showToast(`Conversation locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`, 'error');
        return;
      }
      const { file, type } = pendingMedia;
      const caption = document.getElementById('captionInput').value || document.getElementById('messageInput').value || '';
      const tempId = genTempId();

      const previewMsg = {
        id: tempId,
        sender: operatorName,
        operatorName,
        content: caption,
        time: formatTime(new Date()),
        outgoing: true,
        fromMe: true,
        mediaType: type,
        mediaUrl: pendingMedia.previewUrl || null,
        fileName: file.name,
      };
      appendMessage(previewMsg);
      sentTempIds.add(tempId);
      clearMedia();
      document.getElementById('messageInput').value = '';

      if (socket) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('jid', activeChat.id);
        formData.append('clientTempId', tempId);
        if (caption) formData.append('caption', caption);
        if (type === 'document') formData.append('filename', file.name);

        try {
          const res = await fetch(`${bridgeUrl}/api/send/${type}`, { method: 'POST', headers: operatorHeaders(), body: formData });
          const data = await res.json();
          if (data.success) showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} sent!`);
          else showToast(data.error, 'error');
        } catch (e) {
          showToast('Send failed: ' + e.message, 'error');
        }
      } else {
        showToast(`${type} ready to send (connect bridge first)`);
      }
    }

    // ─── Attach Menu ──────────────────────────────────────────────────────────────
    function toggleAttachMenu() {
      document.getElementById('attachMenu').classList.toggle('open');
    }

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.attach-wrap')) {
        document.getElementById('attachMenu').classList.remove('open');
      }
    });

    function triggerFileInput(type) {
      document.getElementById('attachMenu').classList.remove('open');
      document.getElementById('fileInput' + type.charAt(0).toUpperCase() + type.slice(1)).click();
    }

    function handleFileSelected(type, input) {
      const file = input.files[0];
      if (!file) return;
      pendingMedia = { file, type };

      const strip = document.getElementById('mediaPreviewStrip');
      const thumb = document.getElementById('previewThumb');
      thumb.innerHTML = '';

      if (type === 'image') {
        const url = URL.createObjectURL(file);
        pendingMedia.previewUrl = url;
        thumb.innerHTML = `<img src="${url}" alt="preview"><button class="remove-btn" onclick="clearMedia()">✕</button>`;
      } else if (type === 'video') {
        const url = URL.createObjectURL(file);
        pendingMedia.previewUrl = url;
        thumb.innerHTML = `<video src="${url}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;"></video><button class="remove-btn" onclick="clearMedia()">✕</button>`;
      } else {
        thumb.innerHTML = `<div class="preview-doc-chip">${getDocIcon(file.name)} ${file.name}</div>`;
      }

      strip.classList.add('visible');
      document.getElementById('messageInput').placeholder = type === 'document' ? 'Document ready to send…' : 'Add a caption…';
      input.value = '';
    }

    function clearMedia() {
      pendingMedia = null;
      document.getElementById('mediaPreviewStrip').classList.remove('visible');
      document.getElementById('previewThumb').innerHTML = '';
      document.getElementById('captionInput').value = '';
      refreshComposerState();
    }

    // ─── Location Dialog ──────────────────────────────────────────────────────────
    function showLocationDialog() {
      document.getElementById('attachMenu').classList.remove('open');
      if (activeChat && isAssignedToOther(activeChat)) {
        showToast(`Conversation locked by ${activeChat.assignedOperatorName || activeChat.assignedOperatorId}`, 'error');
        return;
      }
      const lat = prompt('Latitude (e.g. 19.0760):');
      if (!lat) return;
      const lng = prompt('Longitude (e.g. 72.8777):');
      if (!lng) return;
      const name = prompt('Location name (optional):') || '';

      if (socket) {
        const tempId = genTempId();
        fetch(`${bridgeUrl}/api/send/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...operatorHeaders() },
          body: JSON.stringify({ jid: activeChat.id, latitude: lat, longitude: lng, name, clientTempId: tempId, operatorId, operatorName }),
        }).then(() => showToast('Location sent!')).catch(e => showToast(e.message, 'error'));
        appendMessage({
          id: tempId, sender: operatorName, operatorName, content: name || 'Shared location',
          time: formatTime(new Date()), outgoing: true, fromMe: true,
          mediaType: 'location', mediaUrl: `https://maps.google.com/?q=${lat},${lng}`,
        });
        sentTempIds.add(tempId);
      }
    }

    // ─── Tabs ─────────────────────────────────────────────────────────────────────
    let liveOperators = [];
    let liveGroups = [];

    function switchTab(tab, el) {
      currentTab = tab;
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      renderPanel();
    }

    function switchToCreate() {
      currentTab = 'create';
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('createTab').classList.add('active');
      renderPanel();
    }

    function renderPanel() {
      const c = document.getElementById('panelContent');

      if (currentTab === 'operators') {
        c.innerHTML = `
      <div style="margin-bottom:12px"><div class="form-label">Live Operators (${liveOperators.length})</div></div>
      ${liveOperators.map(op => `
        <div class="operator-item">
          <div class="operator-dot"></div>
          <div style="flex:1">
            <div class="operator-name">${op.name || op.id}</div>
            <div class="operator-since">Since ${formatDate(op.connectedAt)}</div>
          </div>
          ${op.id === operatorId ? '<span style="font-size:10px;color:var(--accent);font-family:monospace">YOU</span>' : ''}
        </div>`).join('')}
      <div style="margin-top:16px;padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
        <div class="form-label">Media Support</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px">
          ${['🖼️ Images', '🎥 Videos', '🎵 Audio', '📄 Documents', '📍 Location', '🪄 Stickers'].map(m => `
            <div style="font-size:11px;color:var(--muted);padding:4px 8px;background:var(--bg);border-radius:6px">${m}</div>`).join('')}
        </div>
      </div>`;
        document.getElementById('statOperators').textContent = liveOperators.length;
      }

      else if (currentTab === 'groups') {
        c.innerHTML = `
      <div style="margin-bottom:12px"><div class="form-label">Groups (${liveGroups.length})</div></div>
      ${liveGroups.length ? liveGroups.map(g => `
        <div class="operator-item" style="cursor:pointer" onclick='openChatFromPanel(${JSON.stringify(g)})'>
          <div class="chat-avatar group" style="width:32px;height:32px;font-size:12px">${(g.name || g.subject || '?')[0]}</div>
          <div style="flex:1">
            <div class="operator-name">${g.name || g.subject || g.id}</div>
            <div class="operator-since">${g.participants?.length || 0} participants</div>
          </div>
        </div>`).join('') : '<div style="color:var(--muted);font-size:13px">No groups loaded</div>'}`;
      }

      else if (currentTab === 'create') {
        c.innerHTML = `
      <div class="form-label" style="margin-bottom:14px">Create New Group</div>
      <div class="form-group">
        <label class="form-label">Group Name</label>
        <input class="form-input" id="newGroupName" placeholder="e.g. Sales Team Q2">
      </div>
      <div class="form-group">
        <label class="form-label">Participants</label>
        <textarea class="form-textarea" id="newGroupParticipants" placeholder="919876543210&#10;918765432109"></textarea>
        <div class="form-hint">One phone number per line (with country code, no +)</div>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-bottom:12px" onclick="createGroup()">Create Group</button>
      <div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">
        <div class="form-label">Media API Endpoints</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted);line-height:2">
          POST /api/send<br>
          POST /api/send/image<br>
          POST /api/send/video<br>
          POST /api/send/audio<br>
          POST /api/send/document<br>
          POST /api/send/location<br>
          POST /api/groups/create<br>
          PUT /api/messages/:id<br>
          DELETE /api/messages/:id
        </div>
      </div>`;
      }
    }

    function openChatFromPanel(chat) {
      openChat({
        ...chat,
        name: chat.name || chat.subject || chat.id,
        type: 'group',
        participants: chat.participants?.length || chat.participants || 0,
      }, null);
    }

    async function createGroup() {
      const name = document.getElementById('newGroupName').value.trim();
      const raw = document.getElementById('newGroupParticipants').value.trim();
      if (!name) { showToast('Enter a group name', 'error'); return; }
      const participants = raw.split('\n').map(p => p.trim()).filter(Boolean).map(p => `${p}@s.whatsapp.net`);
      if (!participants.length) { showToast('Add at least one participant', 'error'); return; }

      if (socket) {
        try {
          const res = await fetch(`${bridgeUrl}/api/groups/create`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, participants }),
          });
          const data = await res.json();
          if (data.id) {
            showToast(`Group "${name}" created!`);
          } else {
            showToast(data.error || 'Failed to create group', 'error');
          }
        } catch (e) { showToast(e.message, 'error'); return; }
      } else {
        showToast('Connect bridge first', 'error'); return;
      }
      document.getElementById('newGroupName').value = '';
      document.getElementById('newGroupParticipants').value = '';
    }

    // ─── Bridge Connection ────────────────────────────────────────────────────────
    let connectionStatus = 'disconnected';
    let latestQrData = null;

    function updateTopbarButtons() {
      const container = document.getElementById('whatsappControlContainer');
      if (!container) return;

      if (!socket || !socket.connected) {
        container.innerHTML = '';
        return;
      }

      if (connectionStatus === 'connected') {
        const isConnector = !connectorOperatorId || (connectorOperatorId === operatorId);
        if (isConnector) {
          container.innerHTML = `<button class="btn btn-danger" onclick="confirmDisconnectWhatsApp()">Disconnect WA</button>`;
        } else {
          container.innerHTML = `<span style="font-size:12px;color:var(--muted);padding:6px 12px;background:var(--surface2);border-radius:6px;border:1px solid var(--border)">Connected by ${connectorOperatorName || 'another operator'}</span>`;
        }
      } else {
        container.innerHTML = `<button class="btn btn-primary" onclick="linkWhatsApp()">Link WhatsApp</button>`;
      }
    }

    function confirmDisconnectWhatsApp() {
      showConfirm('Are you sure you want to disconnect WhatsApp? This will log you out and require scanning a new QR code to reconnect.', async () => {
        try {
          const res = await fetch(`${bridgeUrl}/api/whatsapp/disconnect`, {
            method: 'POST',
            headers: operatorHeaders()
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to disconnect WhatsApp');
          }
          showToast('Disconnect request sent.');
        } catch (e) {
          showToast(e.message, 'error');
        }
      });
    }

    function linkWhatsApp() {
      document.getElementById('qrOverlay').classList.remove('hidden');
      if (socket?.connected) {
        socket.emit('linking_whatsapp', { operatorId, operatorName });
      }
      if (!latestQrData) {
        showToast('Waiting for QR code to generate...', 'info');
      }
    }

    function hideQrOverlay() {
      document.getElementById('qrOverlay').classList.add('hidden');
    }

    async function connectBridge() {
      const url = prompt('Bridge server URL:', bridgeUrl);
      if (!url) return;
      const normalized = normalizeBridgeUrl(url);
      if (!normalized) {
        showToast('Invalid bridge URL. Example: http://localhost:3001', 'error');
        return;
      }

      const isCurrentWaConnected = (connectionStatus === 'connected');
      let isNewBridgeWaConnected = false;

      try {
        const res = await fetch(`${normalized}/api/status`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'connected') {
            isNewBridgeWaConnected = true;
          }
        }
      } catch (err) {
        console.error('Error querying status of new bridge:', err);
      }

      if (isCurrentWaConnected && isNewBridgeWaConnected && normalized !== bridgeUrl) {
        try {
          showToast('Disconnecting current WhatsApp login...', 'info');
          const res = await fetch(`${bridgeUrl}/api/whatsapp/disconnect`, {
            method: 'POST',
            headers: operatorHeaders()
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to disconnect WhatsApp');
          }
          showToast('Current WhatsApp login disconnected.');
        } catch (e) {
          console.error('Error disconnecting current WhatsApp:', e);
          showToast('Failed to disconnect current WhatsApp login, connecting to new bridge anyway.', 'warn');
        }
      }

      connectBridgeDirect(normalized);
    }

    function connectBridgeDirect(normalized) {
      bridgeUrl = normalized;

      if (socket) { socket.disconnect(); }

      // Load operator info from localStorage if available
      const savedId = localStorage.getItem('whatsapp_relay_operator_id');
      const savedName = localStorage.getItem('whatsapp_relay_operator_name');
      if (savedId) operatorId = savedId;
      if (savedName) operatorName = savedName;

      socket = io(bridgeUrl, {
        transports: ['websocket'],
        query: {
          operatorId: operatorId || '',
          operatorName: operatorName || ''
        }
      });

      socket.on('connect', () => {
        updateStatus('connecting', 'Bridge Connected');
        showToast('Bridge server connected!');
        if (!operatorName) {
          promptOperatorName();
        } else {
          document.getElementById('operatorBadge').textContent = 'op://' + operatorName.toLowerCase().replace(/\s+/g, '-');
          socket.emit('set_operator_name', { name: operatorName });
        }
        updateTopbarButtons();
      });

      socket.on('operator_id', ({ id }) => {
        operatorId = id;
        localStorage.setItem('whatsapp_relay_operator_id', id);
        if (!operatorName) {
          document.getElementById('operatorBadge').textContent = 'op://' + id.toLowerCase();
        }
      });

      socket.on('status', ({ status, connectorOperatorId: connId, connectorOperatorName: connName }) => {
        connectionStatus = status;
        if (connId !== undefined) connectorOperatorId = connId;
        if (connName !== undefined) connectorOperatorName = connName;
        if (status === 'connected') { updateStatus('connected', 'WhatsApp Live'); document.getElementById('qrOverlay').classList.add('hidden'); }
        else if (status === 'connecting' || status === 'qr_ready') updateStatus('connecting', 'Connecting...');
        else updateStatus('disconnected', 'WA Disconnected');
        updateTopbarButtons();
      });

      socket.on('qr', qrData => {
        latestQrData = qrData;
        document.getElementById('qrImage').src = qrData || '';
      });

      socket.on('operators', (ops) => {
        liveOperators = ops || [];
        document.getElementById('statOperators').textContent = liveOperators.length;
        if (currentTab === 'operators') renderPanel();
      });

      socket.on('groups', groups => {
        liveGroups = groups || [];
        for (const g of groups) {
          upsertChatRecord({ id: g.id, name: g.subject, type: 'group', lastMsg: '', participants: g.participants?.length || 0, unread: 0, timestamp: 0 });
        }
        renderChatList(allChats);
        if (currentTab === 'groups') renderPanel();
      });

      socket.on('chats', chats => {
        allChats = chats || [];
        syncActiveChat();
        if (activeChat) renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('message', msg => {
        // Deduplicate: skip if we sent this via temp ID
        if (msg.clientTempId && sentTempIds.has(msg.clientTempId)) {
          // Replace the temp message with the real one
          const tempRow = document.getElementById('msg-' + msg.clientTempId);
          if (tempRow) {
            tempRow.id = 'msg-' + msg.id;
            const timeEl = tempRow.querySelector('.msg-time');
            if (timeEl) timeEl.textContent = formatTime(new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000));
          }
          sentTempIds.delete(msg.clientTempId);
          return;
        }

        if (activeChat && (msg.from === activeChat.id || msg.jid === activeChat.id)) {
          appendMessage(normalizeMessage(msg));
        }

        // Update chat list preview
        const jid = msg.from || msg.jid;
        if (jid) {
          upsertChatRecord({
            ...(allChats.find(c => c.id === jid) || {}),
            id: jid,
            lastMsg: msg.content || '',
            timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : 0,
          });
          syncActiveChat();
          if (activeChat) renderChatHeader();
          renderChatList(allChats);
        }
      });

      socket.on('chat_messages', onChatMessagesLoaded);

      socket.on('message_ack', ({ clientTempId, serverId, timestamp }) => {
        if (clientTempId && sentTempIds.has(clientTempId)) {
          const tempRow = document.getElementById('msg-' + clientTempId);
          if (tempRow) {
            tempRow.id = 'msg-' + serverId;
            const timeEl = tempRow.querySelector('.msg-time');
            if (timeEl) timeEl.textContent = formatTime(new Date(timestamp * 1000));
          }
          sentTempIds.delete(clientTempId);
        }
      });

      socket.on('message_edited', ({ jid, messageId, newContent, editedAt }) => {
        if (activeChat && activeChat.id === jid) {
          updateMessageInPlace(messageId, newContent, editedAt);
        }
      });

      socket.on('message_deleted', ({ jid, messageId }) => {
        if (activeChat && activeChat.id === jid) {
          markMessageDeleted(messageId);
        }
      });

      socket.on('group_created', (result) => {
        showToast(`Group "${result.subject}" created!`);
        if (currentTab === 'groups') renderPanel();
      });

      socket.on('group_update', (update) => {
        const existing = liveGroups.find(g => g.id === update.id);
        if (existing) Object.assign(existing, update);
        if (currentTab === 'groups') renderPanel();
      });

      socket.on('assignment_updated', ({ jid, chat, action }) => {
        upsertChatRecord(chat);
        syncActiveChat();
        if (activeChat?.id === jid) renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('chat_claimed', ({ chat }) => {
        upsertChatRecord(chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('chat_released', ({ chat }) => {
        upsertChatRecord(chat);
        syncActiveChat();
        renderChatHeader();
        renderChatList(allChats);
      });

      socket.on('error', ({ message, assignedOperatorId, assignedOperatorName, jid }) => {
        if (jid) {
          upsertChatRecord({ ...(allChats.find(c => c.id === jid) || {}), id: jid, assignedOperatorId, assignedOperatorName });
          syncActiveChat();
          if (activeChat?.id === jid) renderChatHeader();
          renderChatList(allChats);
        }
        showToast('Error: ' + message, 'error');
      });

      socket.on('contacts_updated', () => {
        loadContacts();
      });

      socket.on('disconnect', () => {
        updateStatus('disconnected', 'Disconnected');
        showToast('Bridge disconnected', 'error');
        connectionStatus = 'disconnected';
        updateTopbarButtons();
      });
    }

    // ─── Init ─────────────────────────────────────────────────────────────────────
    document.getElementById('operatorBadge').textContent = 'op://offline';
    // Show empty state initially
    document.getElementById('chatList').innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">Click "Connect Bridge" to start</div>';
    renderPanel();
    renderChatHeader();

    // Auto-connect to bridge on load
    const currentOrigin = window.location.protocol.startsWith('http') ? window.location.origin : bridgeUrl;
    connectBridgeDirect(currentOrigin);
    initSidebarResize();
