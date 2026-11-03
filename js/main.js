/*
 * จุดเริ่มต้นของแอป และคีย์ลัด
 *   Space        เปิดป้ายแบบสุ่ม
 *   Enter        เฉลย (ตอนเล่นอยู่) / สุ่มรอบถัดไป (หลังเฉลยหรือ error)
 *   Shift + R    เฉลยทันที
 */
(function () {
  'use strict';
  const GQ = window.GQ;

  function isTyping(target) {
    return target.matches?.('input, textarea, select') || target.isContentEditable;
  }

  function onKeyDown(e) {
    if (GQ.coop && !GQ.coop.isInGame()) return;
    if (isTyping(e.target)) return;
    if (e.target.tagName === 'BUTTON') e.target.blur();

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (!e.repeat) GQ.game.openRandom();
        break;
      case 'Enter':
        e.preventDefault();
        GQ.game.onEnter();
        break;
      case 'KeyR':
        if (e.shiftKey) {
          e.preventDefault();
          GQ.game.reveal();
        }
        break;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    GQ.layout.init();
    GQ.game.init();
    document.addEventListener('keydown', onKeyDown);
  });
})();
