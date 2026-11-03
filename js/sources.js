/*
 * แหล่งตัวละคร: ฐานภายในเครื่อง (localStorage) และ Safebooru API
 * findCandidate() คืนค่า { name, game, url, type } หรือ throw error
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { CONFIG: C, utils: U } = GQ;
  const VIDEO_TYPES = ['mp4', 'webm'];
  const ANIMATED_TYPES = ['mp4', 'webm', 'gif'];

  let localPool = [];

  function init() {
    localPool = GQ.store.loadLocalCharacters();
  }

  function toCandidate(post, game, allowAnimated, seen) {
    if (!post.tag_string_character) return null;
    const url = post.large_file_url || post.file_url;
    if (!url || post.file_ext === 'zip') return null;
    if (!allowAnimated && ANIMATED_TYPES.includes(post.file_ext)) return null;

    const name = U.formatCharacterName(post.tag_string_character);
    if (!name || seen.has(name.toLowerCase())) return null;

    return {
      name,
      game: game.name,
      url,
      type: VIDEO_TYPES.includes(post.file_ext) ? 'video' : 'image',
      landscape: post.image_width > post.image_height,
    };
  }

  function choose(list) {
    const wantLandscape = Math.random() < C.random.landscapeChance;
    const landscape = list.filter((c) => c.landscape);
    const portrait = list.filter((c) => !c.landscape);
    const pool = wantLandscape && landscape.length ? landscape : portrait.length ? portrait : list;
    return U.pick(pool);
  }

  async function fetchRemote(game, allowAnimated, seen, signal) {
    const animated = allowAnimated && Math.random() < C.random.animatedChance;
    const page = animated
      ? U.randInt(C.safebooru.pagesAnimated) + 1
      : U.randInt(C.safebooru.pagesSolo) + 1;
    const tags = `${game.tag} ${animated ? 'animated' : 'solo'}`;
    const url = `${C.safebooru.endpoint}?limit=${C.safebooru.limit}&page=${page}&tags=${encodeURIComponent(tags)}`;

    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const posts = await res.json();
    if (!Array.isArray(posts)) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');

    const list = posts.map((p) => toCandidate(p, game, allowAnimated, seen)).filter(Boolean);
    if (!list.length) throw new Error('ไม่พบภาพที่ใช้งานได้ในหน้านี้');
    return choose(list);
  }

  function toLocal(c) {
    return {
      name: c.name,
      game: c.game,
      url: c.url,
      type: /\.(mp4|webm)(\?|$)/i.test(c.url) ? 'video' : 'image',
    };
  }

  async function findCandidate({ games, allowAnimated, seen, signal }) {
    const activeNames = new Set(games.map((g) => g.name));
    const local = localPool.filter((c) => activeNames.has(c.game) && !seen.has(c.name.toLowerCase()));

    if (local.length && Math.random() < C.random.localChance) {
      return toLocal(U.pick(local));
    }

    try {
      return await fetchRemote(U.pick(games), allowAnimated, seen, signal);
    } catch (err) {
      if (signal.aborted || !local.length) throw err;
      return toLocal(U.pick(local));
    }
  }

  GQ.sources = { init, findCandidate };
})();
