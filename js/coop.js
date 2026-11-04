/*
 * ระบบหน้าหลัก (Lobby), รายการห้องที่เปิดอยู่ (Room Browser), และระบบ Co-op หลายหน้าจอ / ออนไลน์ P2P
 * รองรับ:
 *   1. หน้าหลักก่อนเข้าเกม: ตั้งชื่อผู้เล่น, ดูรายการห้องที่เปิดอยู่แบบเรียลไทม์, สร้างห้อง, เข้าด้วยรหัส, หรือเล่นจอเดียว
 *   2. ระบบค้นหาห้องอัตโนมัติ (BroadcastChannel + localStorage registry + PeerJS Public Lobby Hub)
 *   3. ซิงค์สถานะเกมและคิวผู้เล่นแบบเรียลไทม์ระหว่าง Host และ Client
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { CONFIG: C, utils: U } = GQ;
  const $ = (id) => document.getElementById(id);

  const SESSION_ID_KEY = 'gq_client_id';
  const SESSION_NAME_KEY = 'gq_player_name';
  const SESSION_ROLE_KEY = 'gq_room_role';
  const SESSION_ROOM_KEY = 'gq_room_code';
  const SESSION_TITLE_KEY = 'gq_room_title';
  const SESSION_INGAME_KEY = 'gq_in_game';
  const LOCAL_NAME_KEY = 'gq_saved_player_name';

  let myClientId = null;
  let myName = '';
  let role = 'standalone'; // 'standalone' | 'host' | 'client'
  let inGame = false;      // false = อยู่หน้าหลัก (Home Lobby), true = อยู่ในหน้าเกม
  let roomCode = '';
  let roomTitle = '';
  let handlers = {};

  // ช่องทางสื่อสารภายในห้อง
  let bc = null;
  let peer = null;
  let hostConn = null;          // สำหรับ client เชื่อมไปหา host
  const peerConns = new Map();  // สำหรับ host เก็บการเชื่อมต่อของ client
  const seenMsgIds = new Set();
  let msgSeq = 0;
  let p2pStatus = 'idle';       // 'idle' | 'connecting' | 'ready' | 'local-only'
  let clientConnected = false;
  let joinRetryTimer = null;

  // ระบบค้นหาและแสดงรายการห้อง (Lobby Discovery)
  let lobbyBc = null;
  let heartbeatTimer = null;
  let lobbyPollTimer = null;
  let hubPeer = null;           // PeerJS สำหรับเป็นตัวกลางกระจายรายการห้องออนไลน์
  let hubClientPeer = null;
  const hubConns = new Set();
  const discoveredRooms = new Map(); // code -> roomMeta

  const dom = {};

  function getOrCreateClientId() {
    try {
      let id = sessionStorage.getItem(SESSION_ID_KEY);
      if (!id) {
        id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem(SESSION_ID_KEY, id);
      }
      return id;
    } catch (_) {
      return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }
  }

  function loadSessionPref() {
    try {
      myName = sessionStorage.getItem(SESSION_NAME_KEY) || localStorage.getItem(LOCAL_NAME_KEY) || '';
    } catch (_) {
      myName = '';
    }
  }

  function savePlayerName(name) {
    const clean = (name || '').trim().slice(0, 24);
    if (!clean) return;
    myName = clean;
    try {
      sessionStorage.setItem(SESSION_NAME_KEY, clean);
      localStorage.setItem(LOCAL_NAME_KEY, clean);
    } catch (_) {}
    if (dom.lobbyNameInput && dom.lobbyNameInput.value !== clean) dom.lobbyNameInput.value = clean;
    if (dom.joinNameInput && dom.joinNameInput.value !== clean) dom.joinNameInput.value = clean;
    if (dom.hostPlayerName && !dom.hostPlayerName.value) dom.hostPlayerName.value = clean;
    if (dom.hostSelfNameInput && !dom.hostSelfNameInput.value) dom.hostSelfNameInput.value = clean;
  }

  function saveSessionState() {
    try {
      sessionStorage.setItem(SESSION_ROLE_KEY, role);
      sessionStorage.setItem(SESSION_ROOM_KEY, roomCode);
      sessionStorage.setItem(SESSION_TITLE_KEY, roomTitle);
      sessionStorage.setItem(SESSION_INGAME_KEY, inGame ? '1' : '0');
      if (myName) sessionStorage.setItem(SESSION_NAME_KEY, myName);
    } catch (_) {}
  }

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }

  function nextMsgId() {
    msgSeq += 1;
    return `${myClientId}_${Date.now()}_${msgSeq}`;
  }

  function markSeen(id) {
    if (!id || seenMsgIds.has(id)) return false;
    seenMsgIds.add(id);
    if (seenMsgIds.size > 500) {
      const first = seenMsgIds.values().next().value;
      seenMsgIds.delete(first);
    }
    return true;
  }

  // ---------- ระบบรายการห้อง (Room Directory & Discovery) ----------

  function readLocalRegistry() {
    try {
      const raw = localStorage.getItem(C.storage.roomsRegistry);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeLocalRegistry(mapObj) {
    try {
      localStorage.setItem(C.storage.roomsRegistry, JSON.stringify(mapObj));
    } catch (_) {}
  }

  function pruneExpiredRooms() {
    const now = Date.now();
    for (const [code, info] of discoveredRooms.entries()) {
      if (!info || now - (info.updatedAt || 0) > C.coop.roomTtlMs) {
        discoveredRooms.delete(code);
      }
    }
    const reg = readLocalRegistry();
    let changed = false;
    for (const [code, info] of Object.entries(reg)) {
      if (!info || now - (info.updatedAt || 0) > C.coop.roomTtlMs) {
        delete reg[code];
        changed = true;
      } else {
        discoveredRooms.set(code, info);
      }
    }
    if (changed) writeLocalRegistry(reg);
  }

  function buildMyRoomMeta() {
    if (role !== 'host' || !roomCode) return null;
    const summary = handlers.getRoomSummary?.() || {};
    return {
      code: roomCode,
      title: roomTitle || `ห้องของ ${myName || 'Host'}`,
      hostName: myName || 'Host',
      hostId: myClientId,
      playerCount: summary.playerCount ?? 0,
      playerNames: summary.playerNames || [],
      status: summary.status || 'playing',
      games: summary.games || [],
      updatedAt: Date.now(),
    };
  }

  function sendLobbySignal(packet) {
    const full = {
      ...packet,
      sender: myClientId,
      msgId: packet.msgId || nextMsgId(),
      ts: Date.now(),
    };
    markSeen(full.msgId);

    if (lobbyBc) {
      try { lobbyBc.postMessage(full); } catch (_) {}
    }
    try {
      localStorage.setItem(C.storage.lobbyBus, JSON.stringify(full));
    } catch (_) {}

    // กระจายผ่าน PeerJS Lobby Hub ถ้ามี
    for (const conn of hubConns) {
      if (conn && conn.open) {
        try { conn.send(full); } catch (_) {}
      }
    }
  }

  function publishMyRoom() {
    if (role !== 'host' || !roomCode) return;
    const meta = buildMyRoomMeta();
    if (!meta) return;

    discoveredRooms.set(roomCode, meta);
    const reg = readLocalRegistry();
    reg[roomCode] = meta;
    writeLocalRegistry(reg);

    sendLobbySignal({ type: 'ROOM_UPDATE', room: meta });
    reportRoomToOnlineHub(meta);
    renderRoomList();
  }

  function unpublishMyRoom(codeToRemove) {
    const code = codeToRemove || roomCode;
    if (!code) return;
    discoveredRooms.delete(code);
    const reg = readLocalRegistry();
    if (reg[code]) {
      delete reg[code];
      writeLocalRegistry(reg);
    }
    sendLobbySignal({ type: 'ROOM_REMOVE', code });
    renderRoomList();
  }

  function onLobbyPacket(packet) {
    if (!packet || typeof packet !== 'object') return;
    if (packet.sender === myClientId) return;
    if (!markSeen(packet.msgId)) return;

    if (packet.type === 'ROOM_UPDATE' && packet.room?.code) {
      discoveredRooms.set(packet.room.code, { ...packet.room, updatedAt: Date.now() });
      renderRoomList();
    } else if (packet.type === 'ROOM_LIST' && Array.isArray(packet.rooms)) {
      for (const r of packet.rooms) {
        if (r && r.code) discoveredRooms.set(r.code, { ...r, updatedAt: Date.now() });
      }
      renderRoomList();
    } else if (packet.type === 'ROOM_REMOVE' && packet.code) {
      discoveredRooms.delete(packet.code);
      renderRoomList();
    } else if (packet.type === 'LOBBY_DISCOVER') {
      if (role === 'host' && roomCode) {
        const meta = buildMyRoomMeta();
        if (meta) sendLobbySignal({ type: 'ROOM_UPDATE', room: meta });
      }
    }
  }

  // PeerJS Lobby Hub: ช่วยให้เครื่องอื่นเห็นห้องในหน้าหลักโดยไม่ต้องมี Backend
  function ensureOnlineLobbyHub() {
    if (typeof window.Peer !== 'function' || hubPeer) return;
    try {
      const candidateHub = new window.Peer(C.coop.lobbyHubId);
      candidateHub.on('open', () => {
        hubPeer = candidateHub;
        candidateHub.on('connection', (conn) => {
          hubConns.add(conn);
          conn.on('open', () => {
            pruneExpiredRooms();
            conn.send({
              type: 'ROOM_LIST',
              rooms: Array.from(discoveredRooms.values()),
              msgId: nextMsgId(),
            });
          });
          conn.on('data', (data) => {
            onLobbyPacket(data);
            if (data?.type === 'ROOM_UPDATE' || data?.type === 'ROOM_REMOVE') {
              for (const other of hubConns) {
                if (other !== conn && other.open) {
                  try { other.send(data); } catch (_) {}
                }
              }
            } else if (data?.type === 'LOBBY_DISCOVER') {
              pruneExpiredRooms();
              try {
                conn.send({
                  type: 'ROOM_LIST',
                  rooms: Array.from(discoveredRooms.values()),
                  msgId: nextMsgId(),
                });
              } catch (_) {}
            }
          });
          conn.on('close', () => hubConns.delete(conn));
        });
      });
      candidateHub.on('error', () => {
        try { candidateHub.destroy(); } catch (_) {}
      });
    } catch (_) {}
  }

  function reportRoomToOnlineHub(meta) {
    if (typeof window.Peer !== 'function') return;
    ensureOnlineLobbyHub();
    if (hubPeer) return; // ตัวเองเป็น Hub อยู่แล้ว
    if (!peer || !peer.open) return;

    try {
      const conn = peer.connect(C.coop.lobbyHubId, { reliable: true });
      conn.on('open', () => {
        conn.send({ type: 'ROOM_UPDATE', room: meta, sender: myClientId, msgId: nextMsgId() });
        setTimeout(() => { try { conn.close(); } catch (_) {} }, 1500);
      });
    } catch (_) {}
  }

  function queryOnlineHubForRooms() {
    if (typeof window.Peer !== 'function' || hubPeer) return;
    try {
      if (!hubClientPeer || hubClientPeer.destroyed) {
        hubClientPeer = new window.Peer();
        hubClientPeer.on('open', () => connectAndAskHub(hubClientPeer));
        hubClientPeer.on('error', () => {});
      } else if (hubClientPeer.open) {
        connectAndAskHub(hubClientPeer);
      }
    } catch (_) {}
  }

  function connectAndAskHub(activePeer) {
    try {
      const conn = activePeer.connect(C.coop.lobbyHubId, { reliable: true });
      conn.on('open', () => {
        conn.send({ type: 'LOBBY_DISCOVER', sender: myClientId, msgId: nextMsgId() });
      });
      conn.on('data', (data) => {
        onLobbyPacket(data);
        setTimeout(() => { try { conn.close(); } catch (_) {} }, 800);
      });
    } catch (_) {}
  }

  function refreshRooms() {
    pruneExpiredRooms();
    sendLobbySignal({ type: 'LOBBY_DISCOVER' });
    queryOnlineHubForRooms();
    renderRoomList();
  }

  function renderRoomList() {
    if (!dom.roomListEl) return;
    pruneExpiredRooms();

    const rooms = Array.from(discoveredRooms.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (dom.roomCountBadge) {
      dom.roomCountBadge.textContent = `${rooms.length} ห้องที่เปิดอยู่`;
    }

    dom.roomListEl.replaceChildren();

    if (!rooms.length) {
      const empty = U.el('div', 'room-empty');
      empty.append(
        U.el('div', 'room-empty__icon', '📡'),
        U.el('strong', '', 'ยังไม่มีห้องที่เปิดอยู่ในขณะนี้'),
        U.el('p', '', 'กดปุ่ม "🚀 สร้างห้อง Co-op" ทางด้านขวาเพื่อเปิดห้องใหม่ หรือใส่รหัสห้อง 6 หลักจากเพื่อน')
      );
      dom.roomListEl.append(empty);
      return;
    }

    const statusLabels = {
      playing: { text: '🟢 กำลังเปิดป้ายทาย', cls: 'playing' },
      revealed: { text: '🏁 ช่วงเฉลยคำตอบ', cls: 'revealed' },
      loading: { text: '⏳ กำลังสุ่มตัวละคร', cls: 'loading' },
      idle: { text: '🟢 รอผู้เล่น', cls: 'playing' },
    };

    for (const r of rooms) {
      const card = U.el('div', 'room-card');
      const isMyOwnRoom = r.code === roomCode && role === 'host';

      const info = U.el('div', 'room-card__main');

      const topRow = U.el('div', 'room-card__top');
      topRow.append(
        U.el('span', 'room-card__code', `#${r.code}`),
        U.el('strong', 'room-card__title', r.title || `ห้องของ ${r.hostName || 'Host'}`)
      );
      const st = statusLabels[r.status] || statusLabels.playing;
      topRow.append(U.el('span', `room-card__status status--${st.cls}`, st.text));
      info.append(topRow);

      const metaRow = U.el('div', 'room-card__meta');
      metaRow.append(U.el('span', '', `👑 Host: ${r.hostName || 'ไม่ระบุ'}`));
      const pNames = Array.isArray(r.playerNames) && r.playerNames.length
        ? ` (${r.playerNames.join(', ')})`
        : '';
      metaRow.append(U.el('span', '', `👥 ผู้เล่นในคิว: ${r.playerCount || 0} คน${pNames}`));
      info.append(metaRow);

      if (Array.isArray(r.games) && r.games.length) {
        const gamesPreview = r.games.slice(0, 4).join(' • ') + (r.games.length > 4 ? ` +${r.games.length - 4}` : '');
        info.append(U.el('small', 'room-card__games', `🎮 เกม: ${gamesPreview}`));
      }

      const actions = U.el('div', 'room-card__actions');
      const joinBtn = U.el('button', 'btn-join-room', isMyOwnRoom ? 'ห้องของคุณ' : 'เข้าร่วมห้อง ➡️');
      joinBtn.type = 'button';
      joinBtn.disabled = isMyOwnRoom;
      joinBtn.addEventListener('click', () => {
        const nameVal = dom.lobbyNameInput?.value.trim() || myName;
        if (!nameVal) {
          alert('⚠️ กรุณาตั้งชื่อผู้เล่นของคุณที่ช่องด้านบนก่อนเข้าร่วมห้องครับ!');
          dom.lobbyNameInput?.focus();
          return;
        }
        savePlayerName(nameVal);
        joinRoom(r.code, nameVal);
      });
      actions.append(joinBtn);

      card.append(info, actions);
      dom.roomListEl.append(card);
    }
  }

  // ---------- ช่องทางรับ-ส่งข้อความภายในห้อง ----------

  function closeTransports() {
    clearInterval(joinRetryTimer);
    joinRetryTimer = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (bc) {
      try { bc.close(); } catch (_) {}
      bc = null;
    }
    if (hostConn) {
      try { hostConn.close(); } catch (_) {}
      hostConn = null;
    }
    for (const conn of peerConns.values()) {
      try { conn.close(); } catch (_) {}
    }
    peerConns.clear();
    if (peer) {
      try { peer.destroy(); } catch (_) {}
      peer = null;
    }
  }

  function openLocalChannel(code) {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        bc = new BroadcastChannel(C.coop.channelPrefix + code);
        bc.onmessage = (ev) => onRawPacket(ev.data);
      } catch (_) {
        bc = null;
      }
    }
  }

  function sendLocalPacket(packet) {
    if (bc) {
      try { bc.postMessage(packet); } catch (_) {}
    }
    try {
      localStorage.setItem(C.storage.coopBus, JSON.stringify(packet));
    } catch (_) {}
  }

  function sendPacket(packet, targetClientId = null) {
    const full = {
      ...packet,
      room: roomCode,
      sender: myClientId,
      target: targetClientId,
      msgId: packet.msgId || nextMsgId(),
      ts: Date.now(),
    };
    markSeen(full.msgId);

    sendLocalPacket(full);

    if (role === 'host') {
      for (const [cid, conn] of peerConns.entries()) {
        if (targetClientId && cid && cid !== targetClientId) continue;
        if (conn && conn.open) {
          try { conn.send(full); } catch (_) {}
        }
      }
    } else if (role === 'client') {
      if (hostConn && hostConn.open) {
        try { hostConn.send(full); } catch (_) {}
      }
    }
  }

  function onRawPacket(packet) {
    if (!packet || typeof packet !== 'object') return;
    if (!roomCode || packet.room !== roomCode) return;
    if (packet.sender === myClientId) return;
    if (packet.target && packet.target !== myClientId) return;
    if (!markSeen(packet.msgId)) return;

    if (role === 'host') {
      handleHostReceive(packet);
    } else if (role === 'client') {
      handleClientReceive(packet);
    }
  }

  // ---------- การสลับหน้าหลัก (Lobby) <-> หน้าเกม (App) ----------

  function showGameScreen() {
    inGame = true;
    saveSessionState();
    if (dom.homeScreen) dom.homeScreen.hidden = true;
    if (dom.appScreen) dom.appScreen.hidden = false;
    renderUI();
  }

  function showHomeScreen() {
    if (role === 'client' && roomCode) {
      sendPacket({ type: 'CLIENT_LEAVE', payload: {} });
    } else if (role === 'host' && roomCode) {
      const oldCode = roomCode;
      sendPacket({ type: 'ROOM_CLOSED', payload: {} });
      unpublishMyRoom(oldCode);
    }
    closeTransports();
    role = 'standalone';
    roomCode = '';
    roomTitle = '';
    inGame = false;
    clientConnected = false;
    p2pStatus = 'idle';
    saveSessionState();

    if (window.location.search.includes('room=')) {
      window.history.replaceState({}, '', window.location.pathname);
    }

    if (dom.modal) dom.modal.hidden = true;
    if (dom.appScreen) dom.appScreen.hidden = true;
    if (dom.homeScreen) dom.homeScreen.hidden = false;

    handlers.onReturnHome?.();
    refreshRooms();
    renderUI();
  }

  // ---------- ฝั่ง Host ----------

  function startHost(options = {}) {
    const customCode = options.code || '';
    const customTitle = options.title || '';
    const hostPlays = options.hostPlays !== false;
    const hostNameVal = (options.hostName ?? dom.lobbyNameInput?.value ?? dom.hostPlayerName?.value ?? myName).trim();

    if (hostNameVal) savePlayerName(hostNameVal);

    closeTransports();
    roomCode = (customCode || generateRoomCode()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || generateRoomCode();
    roomTitle = customTitle.trim() || `ห้องของ ${myName || 'Host'}`;
    role = 'host';
    p2pStatus = 'connecting';

    showGameScreen();
    openLocalChannel(roomCode);
    initHostPeer(roomCode);

    if (hostPlays) {
      const effectiveName = myName || 'Host';
      savePlayerName(effectiveName);
      handlers.onHostJoinSelf?.(myClientId, effectiveName);
    }

    handlers.onRoleChange?.(role, roomCode);
    publishMyRoom();
    heartbeatTimer = setInterval(publishMyRoom, C.coop.heartbeatMs);

    renderUI();
    broadcastState();
  }

  function initHostPeer(code) {
    if (typeof window.Peer !== 'function') {
      p2pStatus = 'local-only';
      renderUI();
      return;
    }
    try {
      peer = new window.Peer(C.coop.peerPrefix + code);
      peer.on('open', () => {
        p2pStatus = 'ready';
        publishMyRoom();
        renderUI();
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          peerConns.set(conn.peer, conn);
          renderUI();
        });
        conn.on('data', (data) => {
          if (data && data.sender) {
            peerConns.set(data.sender, conn);
          }
          onRawPacket(data);
        });
        conn.on('close', () => {
          for (const [key, val] of peerConns.entries()) {
            if (val === conn) {
              peerConns.delete(key);
              if (key.startsWith('c_')) {
                handlers.onClientLeave?.(key);
              }
            }
          }
          publishMyRoom();
          renderUI();
        });
      });
      peer.on('error', (err) => {
        console.warn('PeerJS Host notice:', err.type || err.message);
        p2pStatus = 'local-only';
        renderUI();
      });
    } catch (_) {
      p2pStatus = 'local-only';
      renderUI();
    }
  }

  function handleHostReceive(packet) {
    const { type, sender, payload } = packet;
    if (type === 'CLIENT_JOIN') {
      handlers.onClientJoin?.(sender, payload?.name || 'ผู้เล่น');
      broadcastState();
      publishMyRoom();
      renderUI();
    } else if (type === 'CLIENT_LEAVE') {
      handlers.onClientLeave?.(sender);
      broadcastState();
      publishMyRoom();
      renderUI();
    } else if (type === 'CLIENT_ACTION') {
      handlers.onClientAction?.(sender, payload || {});
    } else if (type === 'CLIENT_PING') {
      broadcastState(sender);
    }
  }

  function broadcastState(targetClientId = null) {
    if (role !== 'host') return;
    const snapshot = handlers.getStateSnapshot?.();
    if (!snapshot) return;
    sendPacket({ type: 'STATE_SYNC', payload: snapshot }, targetClientId);
    publishMyRoom();
  }

  function broadcastShake(index) {
    if (role !== 'host') return;
    sendPacket({ type: 'TILE_SHAKE', payload: { index } });
  }

  // ---------- ฝั่ง Client (ผู้เล่นที่จอยเข้าห้อง) ----------

  function joinRoom(rawCode, rawName) {
    const code = (rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = (rawName || myName || '').trim().slice(0, 24);
    if (!code) {
      alert('⚠️ กรุณากรอกรหัสห้อง 6 หลัก');
      return false;
    }
    if (!name) {
      alert('⚠️ กรุณาตั้งชื่อผู้เล่นของคุณก่อนเข้าห้อง');
      dom.lobbyNameInput?.focus();
      return false;
    }

    savePlayerName(name);
    closeTransports();
    roomCode = code;
    const found = discoveredRooms.get(code);
    // ป้องกันกรณีผู้ใช้กด Duplicate Tab จากหน้าจอ Host แล้วมาเข้าห้องเดียวกัน
    if (found && found.hostId === myClientId) {
      myClientId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      try { sessionStorage.setItem(SESSION_ID_KEY, myClientId); } catch (_) {}
    }
    roomTitle = found?.title || `ห้อง #${code}`;
    role = 'client';
    clientConnected = false;
    p2pStatus = 'connecting';

    showGameScreen();
    openLocalChannel(roomCode);
    initClientPeer(roomCode);

    handlers.onRoleChange?.(role, roomCode);
    sendJoinPacket();

    let attempts = 0;
    joinRetryTimer = setInterval(() => {
      attempts += 1;
      if (clientConnected || role !== 'client' || attempts > 15) {
        clearInterval(joinRetryTimer);
        joinRetryTimer = null;
        return;
      }
      sendJoinPacket();
    }, 1000);

    renderUI();
    return true;
  }

  function sendJoinPacket() {
    if (role !== 'client') return;
    sendPacket({
      type: 'CLIENT_JOIN',
      payload: { name: myName },
    });
  }

  function initClientPeer(code) {
    if (typeof window.Peer !== 'function') {
      p2pStatus = 'local-only';
      renderUI();
      return;
    }
    try {
      peer = new window.Peer();
      peer.on('open', () => {
        const conn = peer.connect(C.coop.peerPrefix + code, { reliable: true });
        hostConn = conn;
        conn.on('open', () => {
          p2pStatus = 'ready';
          sendJoinPacket();
          renderUI();
        });
        conn.on('data', (data) => onRawPacket(data));
        conn.on('close', () => renderUI());
        conn.on('error', () => {
          p2pStatus = 'local-only';
          renderUI();
        });
      });
      peer.on('error', () => {
        p2pStatus = 'local-only';
        renderUI();
      });
    } catch (_) {
      p2pStatus = 'local-only';
      renderUI();
    }
  }

  function handleClientReceive(packet) {
    const { type, payload } = packet;
    if (type === 'STATE_SYNC') {
      if (!clientConnected) {
        clientConnected = true;
        closeModal();
      }
      handlers.onStateSync?.(payload);
      renderUI();
    } else if (type === 'TILE_SHAKE') {
      handlers.onRemoteShake?.(payload?.index);
    } else if (type === 'ROOM_CLOSED') {
      alert('เจ้าของห้องปิดห้อง Co-op แล้ว ระบบจะพากลับไปยังหน้าหลัก');
      showHomeScreen();
    }
  }

  function sendAction(actionType, data = {}) {
    if (role !== 'client') return;
    sendPacket({
      type: 'CLIENT_ACTION',
      payload: { action: actionType, ...data },
    });
  }

  function startLocalPlay() {
    const nameVal = dom.lobbyNameInput?.value.trim() || myName;
    if (nameVal) {
      savePlayerName(nameVal);
    }
    closeTransports();
    role = 'standalone';
    roomCode = '';
    roomTitle = '';
    showGameScreen();
    if (nameVal) {
      handlers.onHostJoinSelf?.(myClientId, nameVal);
    }
    handlers.onRoleChange?.('standalone', '');
    renderUI();
  }

  // ---------- UI ห้อง Co-op & หน้าหลัก ----------

  function getInviteUrl() {
    const base = window.location.href.split('?')[0].split('#')[0];
    return `${base}?room=${encodeURIComponent(roomCode)}`;
  }

  function copyInviteLink() {
    if (!roomCode) return;
    const url = getInviteUrl();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        if (dom.copyBtn) {
          const orig = dom.copyBtn.textContent;
          dom.copyBtn.textContent = '✅ คัดลอกลิงก์แล้ว!';
          setTimeout(() => { dom.copyBtn.textContent = orig; }, 2000);
        }
      }).catch(() => prompt('คัดลอกลิงก์เชิญด้านล่าง:', url));
    } else {
      prompt('คัดลอกลิงก์เชิญด้านล่าง:', url);
    }
  }

  function openPlayerWindow() {
    if (!roomCode) return;
    const url = getInviteUrl();
    window.open(url, '_blank', 'width=1024,height=760');
  }

  function openModal() {
    if (dom.modal) dom.modal.hidden = false;
    renderUI();
  }

  function closeModal() {
    if (dom.modal) dom.modal.hidden = true;
  }

  function renderUI() {
    if (dom.coopBtn) {
      if (role === 'host') {
        dom.coopBtn.textContent = `🌐 ห้อง: ${roomCode} (Host)`;
        dom.coopBtn.dataset.active = 'host';
      } else if (role === 'client') {
        dom.coopBtn.textContent = clientConnected
          ? `🟢 ห้อง: ${roomCode} (${myName})`
          : `⏳ กำลังเข้าห้อง ${roomCode}...`;
        dom.coopBtn.dataset.active = 'client';
      } else {
        dom.coopBtn.textContent = '🌐 เปิดห้องออนไลน์ / หลายจอ';
        delete dom.coopBtn.dataset.active;
      }
    }
    if (dom.coopQuickBtn) {
      dom.coopQuickBtn.textContent = roomCode ? `🌐 #${roomCode}` : '🌐 ห้อง';
    }

    if (dom.setupSection) dom.setupSection.hidden = role !== 'standalone';
    if (dom.hostActiveSection) dom.hostActiveSection.hidden = role !== 'host';
    if (dom.clientActiveSection) dom.clientActiveSection.hidden = role !== 'client';

    if (role === 'host') {
      if (dom.roomCodeDisplay) dom.roomCodeDisplay.textContent = roomCode;
      if (dom.inviteUrlInput) dom.inviteUrlInput.value = getInviteUrl();
      if (dom.hostStatusText) {
        dom.hostStatusText.textContent = p2pStatus === 'ready'
          ? `🟢 ${roomTitle} — ออนไลน์ P2P + แสดงในรายการห้องแล้ว`
          : `🟢 ${roomTitle} — ซิงค์หลายหน้าจอและแสดงในรายการห้องแล้ว`;
      }
    } else if (role === 'client') {
      if (dom.clientRoomDisplay) dom.clientRoomDisplay.textContent = roomCode;
      if (dom.clientNameDisplay) dom.clientNameDisplay.textContent = myName;
      if (dom.clientStatusText) {
        dom.clientStatusText.textContent = clientConnected
          ? '🟢 เชื่อมต่อกับห้องสำเร็จ! รอเปิดป้ายและทายตามคิว'
          : '⏳ กำลังค้นหาและเชื่อมต่อกับเครื่อง Host...';
      }
    }
  }

  function cacheDom() {
    Object.assign(dom, {
      homeScreen: $('home-screen'),
      appScreen: $('app-screen'),
      btnHome: $('btn-home'),
      lobbyInviteBanner: $('lobby-invite-banner'),
      lobbyInviteCode: $('lobby-invite-code'),
      btnAcceptInvite: $('btn-accept-invite'),
      lobbyNameInput: $('lobby-player-name'),
      roomCountBadge: $('lobby-room-count'),
      refreshRoomsBtn: $('btn-refresh-rooms'),
      roomListEl: $('lobby-room-list'),
      lobbyCreateForm: $('lobby-create-form'),
      lobbyRoomTitle: $('lobby-room-title'),
      lobbyHostPlay: $('lobby-host-play'),
      lobbyCodeForm: $('lobby-code-form'),
      lobbyCodeInput: $('lobby-code-input'),
      btnLobbyLocal: $('btn-lobby-local'),

      coopBtn: $('btn-coop'),
      coopQuickBtn: $('btn-coop-quick'),
      modal: $('coop-modal'),
      closeBtn: $('btn-close-coop'),
      setupSection: $('coop-setup-section'),
      hostActiveSection: $('coop-host-active'),
      clientActiveSection: $('coop-client-active'),
      hostPlayerName: $('coop-host-name'),
      createRoomBtn: $('btn-create-room'),
      joinForm: $('coop-join-form'),
      joinCodeInput: $('coop-join-code'),
      joinNameInput: $('coop-join-name'),
      roomCodeDisplay: $('coop-room-code'),
      inviteUrlInput: $('coop-invite-url'),
      hostStatusText: $('coop-host-status'),
      copyBtn: $('btn-copy-invite'),
      openWinBtn: $('btn-open-player-win'),
      hostAddSelfForm: $('coop-host-self-form'),
      hostSelfNameInput: $('coop-host-self-name'),
      stopHostBtn: $('btn-stop-host'),
      clientRoomDisplay: $('coop-client-room'),
      clientNameDisplay: $('coop-client-name'),
      clientStatusText: $('coop-client-status'),
      leaveRoomBtn: $('btn-leave-room'),
    });
  }

  function init(options) {
    handlers = options || {};
    myClientId = getOrCreateClientId();
    loadSessionPref();
    cacheDom();

    if (myName) savePlayerName(myName);

    // เปิดช่องทางรับสัญญาณ Lobby
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        lobbyBc = new BroadcastChannel(C.coop.lobbyChannel);
        lobbyBc.onmessage = (ev) => onLobbyPacket(ev.data);
      } catch (_) {
        lobbyBc = null;
      }
    }

    // เหตุการณ์บนหน้าหลัก (Home Screen)
    dom.lobbyNameInput?.addEventListener('input', (e) => {
      savePlayerName(e.target.value);
    });

    dom.refreshRoomsBtn?.addEventListener('click', () => {
      refreshRooms();
    });

    dom.lobbyCreateForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameVal = dom.lobbyNameInput?.value.trim() || myName || 'Host';
      savePlayerName(nameVal);
      startHost({
        title: dom.lobbyRoomTitle?.value.trim() || `ห้องของ ${nameVal}`,
        hostPlays: dom.lobbyHostPlay ? dom.lobbyHostPlay.checked : true,
        hostName: nameVal,
      });
    });

    dom.lobbyCodeForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const codeVal = dom.lobbyCodeInput?.value.trim();
      const nameVal = dom.lobbyNameInput?.value.trim() || myName;
      joinRoom(codeVal, nameVal);
    });

    dom.btnLobbyLocal?.addEventListener('click', () => {
      startLocalPlay();
    });

    dom.btnHome?.addEventListener('click', () => {
      if (role === 'host') {
        if (!confirm('ต้องการปิดห้อง Co-op และกลับสู่หน้าหลักใช่หรือไม่?')) return;
      } else if (role === 'client') {
        if (!confirm('ต้องการออกจากห้องและกลับสู่หน้าหลักใช่หรือไม่?')) return;
      }
      showHomeScreen();
    });

    // เหตุการณ์ใน Modal Co-op (เมื่ออยู่ในหน้าเกมแล้ว)
    dom.coopBtn?.addEventListener('click', openModal);
    dom.coopQuickBtn?.addEventListener('click', openModal);
    dom.closeBtn?.addEventListener('click', closeModal);
    dom.modal?.addEventListener('click', (e) => {
      if (e.target === dom.modal) closeModal();
    });

    dom.createRoomBtn?.addEventListener('click', () => {
      const nameVal = dom.hostPlayerName?.value.trim() || myName || 'Host';
      startHost({
        title: `ห้องของ ${nameVal}`,
        hostPlays: Boolean(dom.hostPlayerName?.value.trim()),
        hostName: nameVal,
      });
      closeModal();
    });

    dom.joinForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (joinRoom(dom.joinCodeInput.value, dom.joinNameInput.value)) {
        closeModal();
      }
    });

    dom.copyBtn?.addEventListener('click', copyInviteLink);
    dom.openWinBtn?.addEventListener('click', openPlayerWindow);

    dom.hostAddSelfForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = dom.hostSelfNameInput.value.trim();
      if (!name) return;
      savePlayerName(name);
      handlers.onHostJoinSelf?.(myClientId, myName);
      broadcastState();
    });

    dom.stopHostBtn?.addEventListener('click', () => {
      if (confirm('ต้องการปิดห้อง Co-op และกลับไปหน้าหลักใช่หรือไม่?')) {
        showHomeScreen();
      }
    });

    dom.leaveRoomBtn?.addEventListener('click', () => {
      showHomeScreen();
    });

    // รับข้อความสำรองผ่าน localStorage event
    window.addEventListener('storage', (e) => {
      if (e.key === C.storage.coopBus && e.newValue) {
        try { onRawPacket(JSON.parse(e.newValue)); } catch (_) {}
      } else if (e.key === C.storage.lobbyBus && e.newValue) {
        try { onLobbyPacket(JSON.parse(e.newValue)); } catch (_) {}
      } else if (e.key === C.storage.roomsRegistry) {
        renderRoomList();
      }
    });

    window.addEventListener('beforeunload', () => {
      if (role === 'client' && roomCode) {
        sendPacket({ type: 'CLIENT_LEAVE', payload: {} });
      } else if (role === 'host' && roomCode) {
        unpublishMyRoom(roomCode);
      }
    });

    // อัปเดตรายการห้องบนหน้าหลักอัตโนมัติ
    refreshRooms();
    lobbyPollTimer = setInterval(() => {
      if (!inGame) refreshRooms();
    }, 3500);

    // ตรวจสอบพารามิเตอร์ ?room=XXXX หรือการเชื่อมต่อเดิมในแท็บนี้
    const params = new URLSearchParams(window.location.search);
    const urlRoom = (params.get('room') || '').trim().toUpperCase();
    const savedRole = sessionStorage.getItem(SESSION_ROLE_KEY);
    const savedRoom = sessionStorage.getItem(SESSION_ROOM_KEY);
    const savedTitle = sessionStorage.getItem(SESSION_TITLE_KEY) || '';
    const wasInGame = sessionStorage.getItem(SESSION_INGAME_KEY) === '1';

    if (urlRoom) {
      if (dom.lobbyCodeInput) dom.lobbyCodeInput.value = urlRoom;
      if (dom.joinCodeInput) dom.joinCodeInput.value = urlRoom;
      if (dom.lobbyInviteBanner && dom.lobbyInviteCode) {
        dom.lobbyInviteBanner.hidden = false;
        dom.lobbyInviteCode.textContent = `#${urlRoom}`;
        dom.btnAcceptInvite?.addEventListener('click', () => {
          const nameVal = dom.lobbyNameInput?.value.trim() || myName;
          joinRoom(urlRoom, nameVal);
        });
      }
      if (wasInGame && savedRole === 'client' && savedRoom === urlRoom && myName) {
        joinRoom(urlRoom, myName);
      } else {
        setTimeout(() => dom.lobbyNameInput?.focus(), 50);
      }
    } else if (wasInGame && savedRole === 'host' && savedRoom) {
      startHost({ code: savedRoom, title: savedTitle, hostPlays: false });
    } else if (wasInGame && savedRole === 'client' && savedRoom && myName) {
      joinRoom(savedRoom, myName);
    } else if (wasInGame && savedRole === 'standalone') {
      startLocalPlay();
    } else {
      // เริ่มต้นที่หน้าหลัก (Home Lobby)
      if (dom.homeScreen) dom.homeScreen.hidden = false;
      if (dom.appScreen) dom.appScreen.hidden = true;
      renderUI();
    }
  }

  GQ.coop = {
    init,
    getRole: () => role,
    getRoomCode: () => roomCode,
    getClientId: () => myClientId,
    getPlayerName: () => myName,
    isInGame: () => inGame,
    isClient: () => role === 'client',
    isHost: () => role === 'host',
    broadcastState,
    broadcastShake,
    sendAction,
    openModal,
    refreshRooms,
    showHomeScreen,
  };
})();
