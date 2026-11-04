/*
 * ผู้เล่น คิวการเล่น และคะแนน
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { utils: U, store } = GQ;

  let players = [];
  let activeId = null;
  let awardBonus = null; // ถ้ามีค่า = อยู่ในช่วงให้โบนัส แสดงปุ่ม +N
  let listEl = null;
  let formEl = null;
  let shuffleBtn = null;
  let resetBtn = null;
  let handlers = {};
  let clientMode = false;
  let selfClientId = null;

  function init(options) {
    handlers = options || {};
    listEl = document.getElementById('players-list');
    formEl = document.getElementById('add-player-form');
    shuffleBtn = document.getElementById('btn-shuffle-turn');
    resetBtn = document.getElementById('btn-reset-scores');
    const input = document.getElementById('new-player-name');

    players = store.loadPlayers();
    ensureValidActive();

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      if (clientMode) return;
      if (add(input.value)) {
        input.value = '';
        handlers.onChange?.();
      }
    });

    if (shuffleBtn) {
      shuffleBtn.addEventListener('click', () => {
        if (clientMode) return;
        shuffleTurns();
        handlers.onShuffle?.();
      });
    }

    listEl.addEventListener('click', onListClick);
    render();
  }

  function createId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function isAvailable(p) {
    return !p.clientId || p.online !== false;
  }

  function availablePlayers() {
    const avail = players.filter(isAvailable);
    return avail.length ? avail : players;
  }

  function ensureValidActive() {
    if (!players.length) {
      activeId = null;
      return;
    }
    const current = find(activeId);
    if (current && isAvailable(current)) return;
    const avail = availablePlayers();
    activeId = avail.length ? avail[0].id : players[0].id;
  }

  function find(id) {
    return players.find((p) => p.id === id) || null;
  }

  function findByClient(clientId) {
    if (!clientId) return null;
    return players.find((p) => p.clientId === clientId) || null;
  }

  function persist() {
    if (!clientMode) store.savePlayers(players);
  }

  function add(rawName, clientId = null) {
    const name = rawName.trim();
    if (!name) return null;
    const player = {
      id: createId(),
      name: name.slice(0, 24),
      score: 0,
      clientId: clientId || null,
      online: true,
    };
    players.push(player);
    if (activeId === null) activeId = player.id;
    persist();
    render();
    return player;
  }

  function upsertRemote(clientId, rawName) {
    const name = (rawName || '').trim().slice(0, 24) || 'ผู้เล่น';
    let player = findByClient(clientId);
    if (!player) {
      // ถ้ารีเฟรชแท็บหรือเข้าใหม่ด้วยชื่อเดิมที่เคยหลุดไป ให้เชื่อมกลับเข้าคนเดิม
      player = players.find((p) => p.clientId && !p.online && p.name.toLowerCase() === name.toLowerCase());
    }
    if (player) {
      player.clientId = clientId;
      player.name = name;
      player.online = true;
    } else {
      player = { id: createId(), name, score: 0, clientId, online: true };
      players.push(player);
    }
    ensureValidActive();
    persist();
    render();
    return player;
  }

  function setOnline(clientId, online) {
    const player = findByClient(clientId);
    if (!player) return null;
    player.online = Boolean(online);
    const wasActive = activeId === player.id;
    ensureValidActive();
    persist();
    render();
    return { player, wasActive };
  }

  function remove(id) {
    if (clientMode) return;
    if (!find(id) || !confirm('ต้องการลบผู้เล่นนี้ใช่หรือไม่?')) return;
    const wasActive = activeId === id;
    players = players.filter((p) => p.id !== id);
    if (wasActive) ensureValidActive();
    persist();
    render();
    handlers.onRemove?.(wasActive);
    handlers.onChange?.();
  }

  function adjust(id, delta) {
    const player = find(id);
    if (!player) return null;
    player.score += delta;
    persist();
    render();
    return player;
  }

  function resetScores() {
    players.forEach((p) => { p.score = 0; });
    persist();
    render();
  }

  function shuffleTurns() {
    if (players.length < 2) return;
    U.shuffle(players);
    const avail = availablePlayers();
    activeId = avail[0]?.id || players[0].id;
    persist();
    render();
  }

  function select(id) {
    if (!find(id)) return;
    activeId = id;
    render();
    handlers.onSelect?.(find(id));
    handlers.onChange?.();
  }

  function nextTurn() {
    if (!players.length) {
      activeId = null;
      render();
      return null;
    }
    const pool = availablePlayers();
    if (!pool.length) return getActive();

    const curIdx = pool.findIndex((p) => p.id === activeId);
    const nextPlayer = pool[(curIdx + 1) % pool.length];
    activeId = nextPlayer.id;
    render();
    return nextPlayer;
  }

  function getActive() {
    ensureValidActive();
    return find(activeId);
  }

  function getNextPreview() {
    if (players.length < 2) return null;
    const pool = availablePlayers();
    if (pool.length < 2) return null;
    const curIdx = pool.findIndex((p) => p.id === activeId);
    return pool[(curIdx + 1) % pool.length] || null;
  }

  function count() {
    return players.length;
  }

  function setAwardBonus(value) {
    awardBonus = value;
    render();
  }

  function setClientMode(isClient, myClientId) {
    clientMode = Boolean(isClient);
    selfClientId = myClientId || selfClientId;
    if (formEl) formEl.hidden = clientMode;
    if (shuffleBtn) shuffleBtn.hidden = clientMode;
    if (resetBtn) resetBtn.hidden = clientMode;
    render();
  }

  function setSelfClientId(id) {
    selfClientId = id;
    render();
  }

  function exportState() {
    return {
      list: players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        clientId: p.clientId || null,
        online: p.online !== false,
      })),
      activeId,
      awardBonus,
    };
  }

  function importState(data) {
    if (!data || !Array.isArray(data.list)) return;
    players = data.list.map((p) => ({
      id: String(p.id),
      name: String(p.name),
      score: Number(p.score) || 0,
      clientId: p.clientId || null,
      online: p.online !== false,
    }));
    activeId = data.activeId || null;
    awardBonus = data.awardBonus ?? null;
    render();
  }

  function onListClick(e) {
    if (clientMode) return;
    const item = e.target.closest('.player-item');
    if (!item) return;
    const id = item.dataset.id;
    const action = e.target.closest('[data-action]')?.dataset.action;

    if (action === 'award') handlers.onAward?.(id);
    else if (action === 'remove') remove(id);
    else select(id);
  }

  function render() {
    if (!listEl) return;
    listEl.replaceChildren();
    if (!players.length) {
      const msg = clientMode ? 'รอผู้เล่นเข้าร่วมห้อง...' : 'เพิ่มชื่อผู้เล่นด้านล่าง หรือเปิดห้อง Co-op';
      listEl.append(U.el('li', 'empty-hint', msg));
      return;
    }

    const maxScore = Math.max(0, ...players.map((p) => p.score));

    players.forEach((p, idx) => {
      const isActive = p.id === activeId;
      const isSelf = Boolean(selfClientId && p.clientId === selfClientId);
      const isOffline = Boolean(p.clientId && p.online === false);
      const isLeader = maxScore > 0 && p.score === maxScore;

      let cls = 'player-item';
      if (isActive) cls += ' active';
      if (isSelf) cls += ' is-self';
      if (isOffline) cls += ' is-offline';

      const li = U.el('li', cls);
      li.dataset.id = p.id;

      const orderBadge = U.el('span', 'player-order', isActive ? '🎯' : String(idx + 1));
      orderBadge.title = isActive ? 'ถึงคิวเล่นตอนนี้' : `คิวลำดับที่ ${idx + 1}`;
      li.append(orderBadge);

      const nameWrap = U.el('span', 'player-name');
      if (p.clientId) {
        const dot = U.el('span', 'player-dot ' + (isOffline ? 'offline' : 'online'));
        dot.title = isOffline ? 'ออฟไลน์' : 'เชื่อมต่อออนไลน์';
        nameWrap.append(dot);
      }
      nameWrap.append(document.createTextNode(p.name));
      if (isSelf) {
        nameWrap.append(U.el('small', 'player-self-tag', ' (คุณ)'));
      }
      if (isLeader) {
        const crown = U.el('span', 'player-crown', ' 👑');
        crown.title = 'คะแนนสูงสุด';
        nameWrap.append(crown);
      }
      li.append(nameWrap);

      if (isActive) {
        li.append(U.el('span', 'turn-pill', 'ตาตอนนี้'));
      }

      li.append(U.el('span', 'player-score' + (p.score < 0 ? ' negative' : ''), String(p.score)));

      if (!clientMode) {
        if (awardBonus !== null) {
          const btn = U.el('button', 'award-btn', `+${awardBonus}`);
          btn.type = 'button';
          btn.dataset.action = 'award';
          li.append(btn);
        } else {
          const btn = U.el('button', 'delete-btn', '×');
          btn.type = 'button';
          btn.dataset.action = 'remove';
          btn.title = 'ลบผู้เล่น';
          li.append(btn);
        }
      }
      listEl.append(li);
    });
  }

  GQ.players = {
    init,
    add,
    upsertRemote,
    findByClient,
    setOnline,
    remove,
    adjust,
    resetScores,
    shuffleTurns,
    select,
    nextTurn,
    getActive,
    getNextPreview,
    count,
    setAwardBonus,
    setClientMode,
    setSelfClientId,
    exportState,
    importState,
    render,
  };
})();
