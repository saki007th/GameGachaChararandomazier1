/*
 * ระบบจัดผัง: พาเนลถูกเก็บเป็นต้นไม้ของการแบ่ง
 *   leaf  = { pane }                       พาเนลหนึ่งช่อง
 *   split = { dir, ratio, a, b }           dir: 'row' = ซ้าย/ขวา, 'col' = บน/ล่าง
 * ลาก splitter เพื่อปรับสัดส่วน, เข้าใกล้จุดสัดส่วนจะ snap, กด Shift ค้างเพื่อปิด snap,
 * ดับเบิลคลิก splitter เพื่อกลับไป 50%, ใช้ลูกศรเมื่อ focus splitter เพื่อปรับด้วยคีย์บอร์ด
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { utils: U, store } = GQ;
  const $ = (id) => document.getElementById(id);

  const PANES = [
    { id: 'stage', label: '🖼 ภาพ', locked: true },
    { id: 'control', label: '🎯 ควบคุม', locked: true },
    { id: 'players', label: '👥 ผู้เล่น' },
    { id: 'history', label: '🕒 ประวัติ' },
    { id: 'settings', label: '⚙️ ตั้งค่า' },
  ];
  const PANE_IDS = PANES.map((p) => p.id);
  const LOCKED_IDS = PANES.filter((p) => p.locked).map((p) => p.id);

  const SPLITTER_PX = 6;
  const RATIO_MIN = 0.12;
  const RATIO_MAX = 0.88;
  const SNAP_POINTS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
  const SNAP_RANGE = 0.015;
  const KEY_STEP = 0.02;

  const leaf = (pane) => ({ pane });
  const split = (dir, ratio, a, b) => ({ dir, ratio, a, b });
  const isLeaf = (node) => typeof node.pane === 'string';
  const clampRatio = (r) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));

  const PRESETS = {
    play: {
      label: '🎮 เล่นเกม',
      build: () => split('row', 0.72, split('col', 0.8, leaf('stage'), leaf('control')), leaf('players')),
    },
    manage: {
      label: '📊 จัดการคะแนน',
      build: () => split('row', 0.45,
        split('col', 0.72, leaf('stage'), leaf('control')),
        split('col', 0.5, leaf('players'), leaf('history'))),
    },
    focus: {
      label: '🖼 โฟกัสภาพ',
      build: () => split('col', 0.85, leaf('stage'), leaf('control')),
    },
  };
  const DEFAULT_PRESET = 'play';

  let tree = null;
  let workspace = null;
  let pool = null;
  const paneEls = {};

  function panesIn(node, out = []) {
    if (isLeaf(node)) out.push(node.pane);
    else { panesIn(node.a, out); panesIn(node.b, out); }
    return out;
  }

  // ตรวจข้อมูลที่โหลดจาก localStorage: ตัดพาเนลที่ไม่รู้จักออก และคืน null ถ้าใช้ไม่ได้
  function sanitize(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 32) return null;
    if (typeof node.pane === 'string') return PANE_IDS.includes(node.pane) ? leaf(node.pane) : null;
    if ((node.dir !== 'row' && node.dir !== 'col') || typeof node.ratio !== 'number') return null;
    const a = sanitize(node.a, depth + 1);
    const b = sanitize(node.b, depth + 1);
    if (!a) return b;
    if (!b) return a;
    return split(node.dir, clampRatio(node.ratio), a, b);
  }

  function loadTree() {
    const saved = sanitize(store.loadLayout());
    if (!saved) return PRESETS[DEFAULT_PRESET].build();
    const names = panesIn(saved);
    const unique = new Set(names).size === names.length;
    const hasLocked = LOCKED_IDS.every((id) => names.includes(id));
    return unique && hasLocked ? saved : PRESETS[DEFAULT_PRESET].build();
  }

  function save() {
    store.saveLayout(tree);
  }

  function isVisible(name) {
    return panesIn(tree).includes(name);
  }

  function removePane(node, name) {
    if (isLeaf(node)) return node.pane === name ? null : node;
    const a = removePane(node.a, name);
    const b = removePane(node.b, name);
    if (!a) return b;
    if (!b) return a;
    return split(node.dir, node.ratio, a, b);
  }

  function setVisible(name, visible) {
    if (LOCKED_IDS.includes(name) && !visible) return;
    if (visible === isVisible(name)) return;
    if (visible) {
      tree = split('row', 0.8, tree, leaf(name));
    } else {
      const next = removePane(tree, name);
      if (!next) return; // ต้องเหลืออย่างน้อย 1 พาเนล
      tree = next;
    }
    render();
    save();
  }

  function setPreset(key) {
    tree = PRESETS[key].build();
    render();
    save();
  }

  // ---------- การสร้าง DOM ----------

  function applyTemplate(wrap, node) {
    const a = Math.round(node.ratio * 1000);
    const track = `${a}fr ${SPLITTER_PX}px ${1000 - a}fr`;
    if (node.dir === 'row') wrap.style.gridTemplateColumns = track;
    else wrap.style.gridTemplateRows = track;
  }

  function build(node) {
    if (isLeaf(node)) {
      const slot = U.el('div', 'slot');
      slot.append(paneEls[node.pane]);
      return slot;
    }

    const wrap = U.el('div', `split split--${node.dir}`);
    const handle = U.el('div', 'splitter');
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', node.dir === 'row' ? 'vertical' : 'horizontal');
    wrap.append(build(node.a), handle, build(node.b));
    applyTemplate(wrap, node);
    bindSplitter(handle, wrap, node);
    return wrap;
  }

  function render() {
    for (const p of PANES) pool.append(paneEls[p.id]);
    workspace.replaceChildren(build(tree));
    syncToggles();
  }

  // ---------- splitter: ลาก / snap / คีย์บอร์ด ----------

  function nearestSnap(ratio) {
    for (const point of SNAP_POINTS) {
      if (Math.abs(ratio - point) < SNAP_RANGE) return point;
    }
    return null;
  }

  function bindSplitter(handle, wrap, node) {
    const horizontal = node.dir === 'row';

    const ratioAt = (ev) => {
      const rect = wrap.getBoundingClientRect();
      return horizontal ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
    };

    const setRatio = (ratio, snapped = false) => {
      node.ratio = ratio;
      applyTemplate(wrap, node);
      handle.classList.toggle('snapping', snapped);
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing');

      const onMove = (ev) => {
        const raw = ratioAt(ev);
        const snap = ev.shiftKey ? null : nearestSnap(raw);
        setRatio(snap ?? clampRatio(raw), snap !== null);
      };
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        handle.classList.remove('dragging', 'snapping');
        document.body.classList.remove('resizing');
        save();
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    });

    handle.addEventListener('dblclick', () => {
      setRatio(0.5);
      save();
    });

    handle.addEventListener('keydown', (e) => {
      const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== back && e.key !== forward) return;
      e.preventDefault();
      const step = (e.shiftKey ? 5 : 1) * KEY_STEP;
      setRatio(clampRatio(node.ratio + (e.key === forward ? step : -step)));
      save();
    });
  }

  // ---------- แถบควบคุมด้านบน ----------

  function buildToggles() {
    const box = $('pane-toggles');
    for (const p of PANES) {
      const btn = U.el('button', 'toggle-chip', p.label);
      btn.type = 'button';
      btn.dataset.pane = p.id;
      btn.disabled = Boolean(p.locked);
      btn.title = p.locked ? 'พาเนลหลัก ปิดไม่ได้' : '';
      btn.addEventListener('click', () => setVisible(p.id, !isVisible(p.id)));
      box.append(btn);
    }
  }

  function syncToggles() {
    const visible = new Set(panesIn(tree));
    document.querySelectorAll('#pane-toggles .toggle-chip').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(visible.has(btn.dataset.pane)));
    });
  }

  function buildPresets() {
    const box = $('presets');
    for (const [key, preset] of Object.entries(PRESETS)) {
      const btn = U.el('button', 'btn-ghost', preset.label);
      btn.type = 'button';
      btn.addEventListener('click', () => setPreset(key));
      box.append(btn);
    }
  }

  function init() {
    workspace = $('workspace');
    pool = $('pane-pool');

    for (const p of PANES) {
      const pane = document.querySelector(`.pane[data-pane="${p.id}"]`);
      paneEls[p.id] = pane;
      const closeBtn = pane.querySelector('[data-hide]');
      if (closeBtn) closeBtn.addEventListener('click', () => setVisible(p.id, false));
    }

    buildPresets();
    buildToggles();
    tree = loadTree();
    render();
  }

  GQ.layout = { init };
})();
