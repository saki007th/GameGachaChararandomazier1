/*
 * ค่าตั้งค่าทั้งหมดของเกมอยู่ที่นี่ที่เดียว
 * แก้ตัวเลขด้านล่างเพื่อปรับเกมได้ทันที
 */
(function () {
  'use strict';
  window.GQ = window.GQ || {};

  const grid = { rows: 6, cols: 6, locked: 6, unlockAfter: 12 };
  grid.total = grid.rows * grid.cols;

  window.GQ.CONFIG = Object.freeze({
    grid,
    timer: { seconds: 15 },
    penalty: { wrongGuess: 5, hint: 10, peek: 15 },
    hints: { max: 3 },
    random: {
      localChance: 0.15,      // โอกาสหยิบตัวละครจากฐานภายในเครื่อง
      animatedChance: 0.35,   // โอกาสหยิบภาพเคลื่อนไหว (เมื่อเปิดใช้)
      landscapeChance: 0.4,   // โอกาสเลือกภาพแนวนอน
    },
    network: {
      attempts: 15,           // จำนวนครั้งที่ลองหาภาพใหม่ก่อนยอมแพ้
      fetchTimeoutMs: 8000,
      mediaTimeoutMs: 15000,
      retryDelayMs: 500,
    },
    memory: { size: 50 },     // จำนวนตัวละครล่าสุดที่จำไว้เพื่อไม่ให้ซ้ำ
    history: { max: 200 },
    safebooru: {
      endpoint: 'https://safebooru.donmai.us/posts.json',
      limit: 50,
      pagesSolo: 100,
      pagesAnimated: 2,
    },
    storage: {
      games: 'gachaGamesDb',
      players: 'gachaPlayers',
      seen: 'gachaSeenCharacters',
      local: 'gachaGameData',
      animated: 'gachaAllowAnimated',
      timer: 'gachaTimerEnabled',
      layout: 'gachaLayout',
      coopBus: 'gachaCoopBus',
      roomsRegistry: 'gachaActiveRooms',
      lobbyBus: 'gachaLobbyBus',
    },
    coop: {
      channelPrefix: 'gq_coop_room_',
      lobbyChannel: 'gq_coop_lobby_v9',
      peerPrefix: 'gq-coop-v9-',
      lobbyHubId: 'gq-coop-v9-lobby-hub',
      roomTtlMs: 10000,
      heartbeatMs: 3000,
    },
    defaultGames: [
      { id: 'def_1', name: 'Genshin Impact', tag: 'genshin_impact', active: true, isDefault: true },
      { id: 'def_2', name: 'Honkai: Star Rail', tag: 'honkai:_star_rail', active: true, isDefault: true },
      { id: 'def_3', name: 'Arknights', tag: 'arknights', active: true, isDefault: true },
      { id: 'def_4', name: 'Blue Archive', tag: 'blue_archive', active: true, isDefault: true },
      { id: 'def_5', name: 'Zenless Zone Zero', tag: 'zenless_zone_zero', active: true, isDefault: true },
    ],
  });
})();
