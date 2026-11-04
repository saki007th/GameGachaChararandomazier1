/*
 * กระดานป้าย (grid 6x6), การปรับสัดส่วนตามภาพจริง (แนวตั้ง/แนวนอน), และระบบซูม/เลื่อนดูภาพ
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { CONFIG: C, utils: U } = GQ;

  const DEFAULT_RATIO = 0.8; // 4:5 เริ่มต้นขณะรอโหลด
  const MIN_RATIO = 0.42;
  const MAX_RATIO = 2.4;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 5;
  const ZOOM_STEP = 0.35;

  let stageEl, canvasEl, gridEl, imgEl, videoEl, errorEl, errorText, loadingEl, loadingText;
  let zoomInBtn, zoomOutBtn, zoomResetBtn;
  let tiles = [];
  let openCount = 0;
  let cancelPending = null;
  let currentMediaUrl = null;
  let currentRatio = DEFAULT_RATIO;

  // สถานะการซูมและลากเลื่อนภาพ
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let suppressNextClick = false;
  const activePointers = new Map();
  let panSession = null;
  let pinchDist = 0;

  function init({ onTileClick }) {
    const $ = (id) => document.getElementById(id);
    stageEl = $('stage');
    canvasEl = $('stage-canvas');
    gridEl = $('grid');
    imgEl = $('media-img');
    videoEl = $('media-video');
    errorEl = $('error-card');
    errorText = $('error-text');
    loadingEl = $('loading');
    loadingText = $('loading-text');
    zoomInBtn = $('btn-zoom-in');
    zoomOutBtn = $('btn-zoom-out');
    zoomResetBtn = $('btn-zoom-reset');

    gridEl.style.gridTemplateColumns = `repeat(${C.grid.cols}, 1fr)`;
    gridEl.style.gridTemplateRows = `repeat(${C.grid.rows}, 1fr)`;
    gridEl.addEventListener('click', (e) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const node = e.target.closest('.grid-tile');
      if (node) onTileClick(tiles[Number(node.dataset.index)]);
    });

    initZoomAndPan();
    renderZoomUI();
  }

  function setMediaRatio(rawRatio) {
    const num = Number(rawRatio);
    currentRatio = Number.isFinite(num) && num > 0
      ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, num))
      : DEFAULT_RATIO;
    if (stageEl) {
      stageEl.style.setProperty('--media-ratio', currentRatio.toFixed(4));
    }
    clampPan();
    applyTransform();
  }

  function clampPan() {
    if (!stageEl || zoom <= 1.001) {
      zoom = 1;
      panX = 0;
      panY = 0;
      return;
    }
    const rect = stageEl.getBoundingClientRect();
    const baseW = rect.width || 300;
    const baseH = rect.height || 300;
    const maxX = Math.max(0, (baseW * (zoom - 1)) / 2);
    const maxY = Math.max(0, (baseH * (zoom - 1)) / 2);
    panX = Math.min(maxX, Math.max(-maxX, panX));
    panY = Math.min(maxY, Math.max(-maxY, panY));
  }

  function applyTransform() {
    if (!canvasEl) return;
    if (zoom <= 1.001) {
      canvasEl.style.transform = '';
    } else {
      canvasEl.style.transform = `translate3d(${panX.toFixed(1)}px, ${panY.toFixed(1)}px, 0) scale(${zoom.toFixed(3)})`;
    }
    if (stageEl) {
      stageEl.classList.toggle('is-zoomed', zoom > 1.001);
    }
    renderZoomUI();
  }

  function renderZoomUI() {
    const pct = Math.round(zoom * 100);
    if (zoomResetBtn) {
      zoomResetBtn.textContent = `🔍 ${pct}%`;
      zoomResetBtn.classList.toggle('is-active', zoom > 1.001);
    }
    if (zoomOutBtn) zoomOutBtn.disabled = zoom <= MIN_ZOOM + 0.001;
    if (zoomInBtn) zoomInBtn.disabled = zoom >= MAX_ZOOM - 0.001;
  }

  function setZoomAt(nextZoom, clientX, clientY) {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    if (Math.abs(clamped - zoom) < 0.001) return;

    if (stageEl && Number.isFinite(clientX) && Number.isFinite(clientY) && clamped > 1.001) {
      const rect = stageEl.getBoundingClientRect();
      const cx = clientX - (rect.left + rect.width / 2);
      const cy = clientY - (rect.top + rect.height / 2);
      const scaleRatio = clamped / zoom;
      panX = cx - (cx - panX) * scaleRatio;
      panY = cy - (cy - panY) * scaleRatio;
    }

    zoom = clamped;
    clampPan();
    applyTransform();
  }

  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  }

  function initZoomAndPan() {
    zoomInBtn?.addEventListener('click', () => setZoomAt(zoom + ZOOM_STEP));
    zoomOutBtn?.addEventListener('click', () => setZoomAt(zoom - ZOOM_STEP));
    zoomResetBtn?.addEventListener('click', () => resetZoom());

    if (!stageEl) return;

    const stageBody = stageEl.closest('.pane__body--stage') || stageEl;
    stageBody.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      setZoomAt(zoom * factor, e.clientX, e.clientY);
    }, { passive: false });

    stageEl.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0 && e.button !== 1) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        panSession = null;
        return;
      }

      if (zoom <= 1.001 && e.button !== 1) return;

      panSession = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origPanX: panX,
        origPanY: panY,
        moved: false,
      };
    });

    window.addEventListener('pointermove', (e) => {
      if (activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchDist > 10 && dist > 10) {
          const midX = (pts[0].x + pts[1].x) / 2;
          const midY = (pts[0].y + pts[1].y) / 2;
          setZoomAt(zoom * (dist / pinchDist), midX, midY);
        }
        pinchDist = dist;
        suppressNextClick = true;
        return;
      }

      if (!panSession || panSession.pointerId !== e.pointerId) return;
      const dx = e.clientX - panSession.startX;
      const dy = e.clientY - panSession.startY;

      if (!panSession.moved && Math.hypot(dx, dy) > 5) {
        panSession.moved = true;
        stageEl.classList.add('is-panning');
      }

      if (panSession.moved) {
        panX = panSession.origPanX + dx;
        panY = panSession.origPanY + dy;
        clampPan();
        applyTransform();
      }
    });

    const endPointer = (e) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) pinchDist = 0;

      if (panSession && panSession.pointerId === e.pointerId) {
        if (panSession.moved) {
          suppressNextClick = true;
          setTimeout(() => { suppressNextClick = false; }, 80);
        }
        panSession = null;
        stageEl.classList.remove('is-panning');
      }
    };

    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
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
      ratio: currentRatio,
      tiles: tiles.map((t) => ({ locked: Boolean(t.locked), opened: Boolean(t.opened) })),
    };
  }

  function importState(data) {
    if (!data || !Array.isArray(data.tiles) || !data.tiles.length) {
      clear();
      return;
    }

    if (typeof data.ratio === 'number' && data.ratio > 0) {
      setMediaRatio(data.ratio);
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
    resetZoom();
    setMediaRatio(DEFAULT_RATIO);
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
        const w = isVideo ? videoEl.videoWidth : imgEl.naturalWidth;
        const h = isVideo ? videoEl.videoHeight : imgEl.naturalHeight;
        if (w > 0 && h > 0) {
          setMediaRatio(w / h);
        }
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
    resetZoom,
  };
})();
