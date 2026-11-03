/*
 * เนื้อหาของพาเนลประวัติและตั้งค่า
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { utils: U } = GQ;
  const $ = (id) => document.getElementById(id);

  let handlers = {};

  function renderHistory(items) {
    const list = $('history-list');
    list.replaceChildren();
    if (!items.length) {
      list.append(U.el('li', 'history-empty', 'ยังไม่มีประวัติการทายในรอบนี้'));
      return;
    }
    for (const item of items) {
      const li = U.el('li', 'history-item');
      if (item.type === 'video') {
        li.append(U.el('div', 'history-thumb history-thumb--video', '▶ Video'));
      } else {
        const img = document.createElement('img');
        img.className = 'history-thumb';
        img.alt = '';
        img.loading = 'lazy';
        img.src = item.url;
        img.addEventListener('error', () => img.replaceWith(U.el('div', 'history-thumb history-thumb--video', 'ภาพเสีย')));
        li.append(img);
      }
      const info = U.el('div', 'history-info');
      info.append(U.el('strong', '', item.name), U.el('small', '', item.game));
      li.append(info);
      list.append(li);
    }
  }

  function renderGames(games) {
    const list = $('settings-game-list');
    list.replaceChildren();
    for (const g of games) {
      const row = U.el('div', 'game-row');

      const label = U.el('label', 'game-row__label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = g.active;
      checkbox.addEventListener('change', () => handlers.onGameToggle(g.id, checkbox.checked));
      label.append(checkbox, U.el('span', '', g.name));
      row.append(label);

      if (!g.isDefault) {
        const del = U.el('button', 'game-row__delete', '×');
        del.type = 'button';
        del.title = 'ลบเกม';
        del.addEventListener('click', () => handlers.onGameDelete(g.id));
        row.append(del);
      }
      list.append(row);
    }
  }

  function init(options) {
    handlers = options;

    const settings = handlers.getSettings();
    const timer = $('toggle-timer');
    const animated = $('toggle-animated');
    timer.checked = settings.timer;
    animated.checked = settings.animated;
    timer.addEventListener('change', (e) => handlers.onSettingChange('timer', e.target.checked));
    animated.addEventListener('change', (e) => handlers.onSettingChange('animated', e.target.checked));

    $('add-game-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = $('new-game-name');
      const tagInput = $('new-game-tag');
      if (handlers.onGameAdd(nameInput.value, tagInput.value)) {
        nameInput.value = '';
        tagInput.value = '';
      }
    });
  }

  GQ.panels = { init, renderGames, renderHistory };
})();
