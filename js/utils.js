(function () {
  'use strict';
  const GQ = window.GQ;

  const randInt = (n) => Math.floor(Math.random() * n);
  const pick = (arr) => arr[randInt(arr.length)];

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // แปลง tag เช่น "kiana_kaslana_(herrscher_of_finality)" เป็น "Kiana Kaslana"
  function formatCharacterName(tagString) {
    if (!tagString) return '';
    const first = tagString.trim().split(/\s+/)[0] || '';
    const name = first.replace(/_?\([^)]*\)/g, '').replace(/_/g, ' ').trim();
    return name.replace(/(^|\s)(\p{L})/gu, (_, space, ch) => space + ch.toUpperCase());
  }

  // เก็บเฉพาะตัวอักษร/ตัวเลข (รองรับไทยและภาษาอื่น) และตัดช่องว่าง/สัญลักษณ์
  function normalize(text) {
    return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // ยอมให้พิมพ์ผิดได้ตามความยาวชื่อ และยอมรับชื่อจริงบางส่วน (เช่น "Kiana" ของ "Kiana Kaslana")
  function allowedErrors(length) {
    if (length >= 10) return 2;
    if (length >= 5) return 1;
    return 0;
  }

  function isCorrectAnswer(guess, answer) {
    const g = normalize(guess);
    const full = normalize(answer);
    if (!g || !full) return false;

    const candidates = [full, ...answer.split(/\s+/).map(normalize).filter((p) => p.length >= 3)];
    return candidates.some((target) => levenshtein(g, target) <= allowedErrors(target.length));
  }

  GQ.utils = { randInt, pick, shuffle, el, formatCharacterName, normalize, levenshtein, isCorrectAnswer };
})();
