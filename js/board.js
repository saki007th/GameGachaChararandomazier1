/*
 * กระดานป้าย (grid 6x6) และพื้นที่แสดงภาพ/วิดีโอ
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { CONFIG: C, utils: U } = GQ;

  let gridEl, imgEl, videoEl, errorEl, errorText, loadingEl, loadingText;
  let tiles = [];
  let openCount = 0;
  let cancelPending = null;
  let currentMediaUrl = null;

  function init({ onTileClick }) {
    const $ = (id) => document.getElementById(id);
    gridEl = $('grid');
    imgEl = $('media-img');
    videoEl = $('media-video');
    errorEl = $('error-card');
    errorText = $('error-text');
    loadingEl = $('loading');
    loadingText = $('loading-text');

    gridEl.style.gridTemplateColumns = `repeat(${C.grid.cols}, 1fr)`;
    gridEl.style.gridTemplateRows = `repeat(${C.grid.rows}, 1fr)`;
    gridEl.addEventListener('click', (e) => {
      const node = e.target.closest('.grid-tile');
      if (node) onTileClick(tiles[Number(node.dataset.index)]);
    });
  }

  function build() {
    const total = C.grid.total;
    const lockedSet = new Set(U.shuffle(Array.from({ length: total }, (_, i) => i)).slice(0, C.grid.locked));
    const frag = document.createDocumentFragment();

    tiles = Array.from({ length: total }, (_, i) => {
      const el = U.el('div', 'grid-tile', String(i + 1));
      el.dataset.index = i;
      const locked = lockedSet.has(i);
      if (locked) el.classList.add('locked');
      frag.appendChild(el);
      return { index: i, el, locked, opened: false };
    });

    openCount = 0;
    gridEl.replaceChildren(frag);
    gridEl.hidden = false;
    errorEl.hidden = true;
  }

  function clear() {
    tiles = [];
    openCount = 0;
    gridEl.replaceChildren();
  }

  function isUnlocked() {
    return openCount >= C.grid.unlockAfter;
  }

  function unlockAll() {
    for (const t of tiles) {
      if (t.locked) {
        t.locked = false;
        t.el.classList.remove('locked');
      }
    }
  }

  function open(tile) {
    if (tile.opened) return;
    tile.opened = true;
    openCount++;
    tile.el.classList.add('opened');
    if (isUnlocked()) unlockAll();
  }

  function revealAll() {
    for (const t of tiles) {
      if (!t.opened) {
        t.opened = true;
        t.el.classList.add('opened');
      }
      t.el.classList.remove('locked');
    }
    openCount = tiles.length;
  }

  function pickAvailable() {
    const unlocked = isUnlocked();
    const candidates = tiles.filter((t) => !t.opened && (!t.locked || unlocked));
    return candidates.length ? U.pick(candidates) : null;
  }

  function getTile(index) {
    return tiles[Number(index)] || null;
  }

  function shake(tile) {
    if (!tile) return;
    const el = tile.el;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  function shakeIndex(index) {
    shake(getTile(index));
  }

  function exportState() {
    return {
      openCount,
      tiles: tiles.map((t) => ({ locked: Boolean(t.locked), opened: Boolean(t.opened) })),
    };
  }

  function importState(data) {
    if (!data || !Array.isArray(data.tiles) || !data.tiles.length) {
      clear();
      return;
    }

    if (tiles.length !== data.tiles.length) {
      const frag = document.createDocumentFragment();
      tiles = data.tiles.map((t, i) => {
        const el = U.el('div', 'grid-tile', String(i + 1));
        el.dataset.index = i;
        if (t.locked) el.classList.add('locked');
        if (t.opened) el.classList.add('opened');
        frag.appendChild(el);
        return { index: i, el, locked: Boolean(t.locked), opened: Boolean(t.opened) };
      });
      gridEl.replaceChildren(frag);
    } else {
      for (let i = 0; i < tiles.length; i++) {
        const cur = tiles[i];
        const next = data.tiles[i];
        cur.locked = Boolean(next.locked);
        cur.opened = Boolean(next.opened);
        cur.el.classList.toggle('locked', cur.locked);
        cur.el.classList.toggle('opened', cur.opened);
      }
    }

    openCount = typeof data.openCount === 'number'
      ? data.openCount
      : tiles.filter((t) => t.opened).length;
    gridEl.hidden = false;
    errorEl.hidden = true;
  }

  function openedCount() {
    return openCount;
  }

  function remaining() {
    return tiles.length - openCount;
  }

  function clearMedia() {
    if (cancelPending) cancelPending();
    currentMediaUrl = null;
    imgEl.hidden = true;
    videoEl.hidden = true;
    imgEl.removeAttribute('src');
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
  }

  // resolve เมื่อภาพ/วิดีโอพร้อมแสดง, reject เมื่อโหลดไม่สำเร็จ/หมดเวลา/ถูกยกเลิก
  function showMedia(candidate) {
    clearMedia();
    currentMediaUrl = candidate.url;
    const isVideo = candidate.type === 'video';
    const el = isVideo ? videoEl : imgEl;
    const readyEvent = isVideo ? 'loadeddata' : 'load';

    return new Promise((resolve, reject) => {
      let timer = null;

      const finish = (error) => {
        clearTimeout(timer);
        el.removeEventListener(readyEvent, onReady);
        el.removeEventListener('error', onError);
        cancelPending = null;
        if (error) reject(error);
        else resolve();
      };
      const onReady = () => {
        el.hidden = false;
        if (isVideo) el.play().catch(() => {});
        finish();
      };
      const onError = () => finish(new Error('ไฟล์ภาพ/วิดีโอโหลดไม่สำเร็จ'));

      cancelPending = () => finish(new Error('ยกเลิกการโหลด'));
      timer = setTimeout(() => finish(new Error('โหลดภาพเกินเวลา')), C.network.mediaTimeoutMs);
      el.addEventListener(readyEvent, onReady);
      el.addEventListener('error', onError);
      el.src = candidate.url;
    });
  }

  function ensureMedia(media) {
    if (!media || !media.url) {
      clearMedia();
      return Promise.resolve();
    }
    if (currentMediaUrl === media.url) return Promise.resolve();
    return showMedia(media).catch((err) => {
      console.warn('Client โหลดสื่อไม่สำเร็จ:', err.message);
    });
  }

  function reset() {
    clearMedia();
    clear();
    errorEl.hidden = true;
  }

  function showLoading(on, text) {
    if (text) loadingText.textContent = text;
    loadingEl.hidden = !on;
  }

  function showError(message) {
    gridEl.hidden = true;
    errorText.textContent = message;
    errorEl.hidden = false;
  }

  GQ.board = {
    init, build, clear, reset, open, revealAll, pickAvailable, getTile, shake, shakeIndex,
    exportState, importState, openedCount, remaining, showMedia, ensureMedia, clearMedia, showLoading, showError,
  };
})();
