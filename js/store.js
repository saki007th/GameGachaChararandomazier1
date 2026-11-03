(function () {
  'use strict';
  const GQ = window.GQ;
  const K = GQ.CONFIG.storage;
  const isArray = Array.isArray;

  function read(key, fallback, validate) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback();
      const value = JSON.parse(raw);
      return validate(value) ? value : fallback();
    } catch (err) {
      localStorage.removeItem(key);
      return fallback();
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('บันทึกข้อมูลไม่สำเร็จ:', key, err);
    }
  }

  function sanitizeGame(g) {
    if (!g || typeof g.name !== 'string' || typeof g.tag !== 'string') return null;
    return {
      id: String(g.id ?? `custom_${Date.now()}`),
      name: g.name,
      tag: g.tag,
      active: g.active !== false,
      isDefault: Boolean(g.isDefault),
    };
  }

  function sanitizePlayer(p) {
    if (!p || typeof p.name !== 'string') return null;
    const clientId = typeof p.clientId === 'string' && p.clientId ? p.clientId : null;
    return {
      id: String(p.id),
      name: p.name,
      score: Number(p.score) || 0,
      clientId,
      online: clientId ? false : true,
    };
  }

  GQ.store = {
    loadGames() {
      const defaults = () => GQ.CONFIG.defaultGames.map((g) => ({ ...g }));
      return read(K.games, defaults, isArray).map(sanitizeGame).filter(Boolean);
    },
    saveGames(games) {
      write(K.games, games);
    },

    loadPlayers() {
      return read(K.players, () => [], isArray).map(sanitizePlayer).filter(Boolean);
    },
    savePlayers(players) {
      write(K.players, players);
    },

    loadSeen() {
      return read(K.seen, () => [], isArray).filter((s) => typeof s === 'string');
    },
    saveSeen(list) {
      write(K.seen, list);
    },

    loadLocalCharacters() {
      return read(K.local, () => [], isArray).filter((c) => c && c.name && c.game && c.url);
    },

    loadLayout() {
      return read(K.layout, () => null, (v) => v !== null && typeof v === 'object');
    },
    saveLayout(tree) {
      write(K.layout, tree);
    },

    loadFlag(key, fallback) {
      return read(K[key], () => fallback, (v) => typeof v === 'boolean');
    },
    saveFlag(key, value) {
      write(K[key], value);
    },
  };
})();
