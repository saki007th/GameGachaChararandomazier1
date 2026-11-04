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

  function initTopbarToggle() {
    const shell = document.querySelector('.topbar-shell');
    const toggleBtn = document.getElementById('btn-topbar-toggle');
    if (!shell || !toggleBtn) return;

    let closeTimer = null;
    let pressWasOpen = null;

    const setOpen = (open) => {
      shell.classList.toggle('topbar-shell--open', open);
      toggleBtn.setAttribute('aria-expanded', String(open));
    };
    const cancelClose = () => {
      clearTimeout(closeTimer);
      closeTimer = null;
    };
    const openNow = () => {
      cancelClose();
      setOpen(true);
    };
    const closeSoon = () => {
      cancelClose();
      closeTimer = setTimeout(() => setOpen(false), 160);
    };
    const isMouse = (e) => e.pointerType !== 'touch';

    // hover: กางทันที / พับช้าเล็กน้อย กันกระพริบตอนเลื่อนเมาส์ผ่าน
    shell.addEventListener('pointerenter', (e) => isMouse(e) && openNow());
    shell.addEventListener('pointerleave', (e) => isMouse(e) && closeSoon());

    // คีย์บอร์ด: โฟกัสเข้าปุ่มในแถบ (ไม่ใช่ปุ่ม toggle) แล้วกางให้
    shell.addEventListener('focusin', (e) => {
      if (e.target !== toggleBtn) openNow();
    });
    shell.addEventListener('focusout', (e) => {
      if (e.relatedTarget && !shell.contains(e.relatedTarget)) closeSoon();
    });

    // จำสถานะก่อนกด เพื่อให้คลิก/แตะ toggle ได้ถูกต้องแม้ focus จะกางแถบไปแล้ว
    toggleBtn.addEventListener('pointerdown', () => {
      pressWasOpen = shell.classList.contains('topbar-shell--open');
    });
    toggleBtn.addEventListener('click', () => {
      const wasOpen = pressWasOpen ?? shell.classList.contains('topbar-shell--open');
      pressWasOpen = null;
      if (wasOpen) {
        cancelClose();
        setOpen(false);
      } else {
        openNow();
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!shell.contains(e.target)) {
        cancelClose();
        setOpen(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        cancelClose();
        if (shell.contains(document.activeElement) && document.activeElement !== toggleBtn) {
          toggleBtn.focus();
        }
        setOpen(false);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    GQ.layout.init();
    GQ.game.init();
    initTopbarToggle();
    document.addEventListener('keydown', onKeyDown);
  });
})();
