/*
 * ตัวควบคุมเกมหลัก:
 *   - วงจรรอบ (โหลด -> เล่น -> เฉลย)
 *   - ระบบคิว Turn-based Co-op (1. เปิดป้าย 1 ช่อง -> 2. ทายภายใน 15 วิ -> ส่งต่อคิวเมื่อตอบผิด/หมดเวลา/ข้ามเทิร์น)
 *   - ซิงค์สถานะแบบเรียลไทม์กับระบบ Co-op หลายหน้าจอ / ออนไลน์ P2P
 */
(function () {
  'use strict';
  const GQ = window.GQ;
  const { CONFIG: C, utils: U, store, sources, board, players, panels } = GQ;
  const $ = (id) => document.getElementById(id);

  const state = {
    status: 'idle',        // 'idle' | 'loading' | 'playing' | 'revealed' | 'error'
    turnPhase: 'open',     // 'open' (ต้องเปิดป้าย 1 ช่อง) | 'guess' (เปิดป้ายแล้ว มีเวลา 15 วิในการทาย)
    attempt: 0,            // รหัสรอบ ใช้ทิ้งผลลัพธ์ของการโหลดเก่า
    controller: null,      // AbortController ของการ fetch ที่กำลังทำงาน
    current: null,         // { name, game, url, type }
    games: [],
    seen: [],
    history: [],
    allowAnimated: true,
    timerEnabled: true,
    hintLevel: 0,
    hintPenalty: 0,
    hintText: '',
    peekArmed: false,
    awarded: false,
    bonus: 0,              // โบนัสที่ล็อกไว้ตอนเฉลย
    roundWinner: null,     // ชื่อผู้เล่นที่ตอบถูกในรอบนี้
    rotateNextRound: false,
    timerId: null,
    timeLeft: C.timer.seconds,
    timedOut: false,
    feedbackTimer: null,
    feedback: { text: '', tone: 'info', seq: 0 },
    loadingText: 'กำลังค้นหาตัวละครแบบสุ่ม...',
    errorText: '',
  };

  let lastClientFeedbackSeq = 0;
  const dom = {};
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;

  function cacheDom() {
    Object.assign(dom, {
      bonus: $('bonus-value'),
      timer: $('timer'),
      turnBadge: $('turn-badge'),
      turnBanner: $('turn-banner'),
      turnBannerTitle: $('turn-banner-title'),
      turnBannerStep: $('turn-banner-step'),
      guessPanel: $('guess-panel'),
      guessForm: $('guess-form'),
      guessInput: $('guess-input'),
      guessSubmitBtn: $('btn-guess-submit'),
      btnRandomTile: $('btn-random-tile'),
      btnHint: $('btn-hint'),
      btnPeek: $('btn-peek'),
      btnPassTurn: $('btn-pass-turn'),
      btnGiveUp: $('btn-give-up'),
      hintDisplay: $('hint-display'),
      feedback: $('feedback'),
      answer: $('answer'),
      answerName: $('answer-name'),
      answerGame: $('answer-game'),
      answerWinner: $('answer-winner'),
      btnNextRound: $('btn-next-round'),
      resetBtn: $('btn-reset-scores'),
    });
  }

  function isClient() {
    return Boolean(GQ.coop && GQ.coop.isClient());
  }

  function myClientId() {
    return GQ.coop ? GQ.coop.getClientId() : null;
  }

  // ตรวจสอบว่าผู้เล่นที่มีคิวตอนนี้ คือคนที่ควบคุมจากหน้าจอนี้หรือไม่
  function canLocalScreenActForActive() {
    const active = players.getActive();
    if (!active) return true; // ถ้ายังไม่ได้เพิ่มรายชื่อผู้เล่น ให้หน้าจอเล่นได้ทันที
    const myId = myClientId();
    if (isClient()) {
      return active.clientId === myId;
    }
    // บนหน้าจอ Host: เล่นได้ถ้าเป็นผู้เล่น Local (ไม่มี clientId) หรือเป็นตัว Host เอง
    return !active.clientId || active.clientId === myId;
  }

  // ตรวจสอบสิทธิ์เมื่อมีคำสั่งจากผู้เล่น (ทั้งจากหน้าจอตัวเองและจาก Client ออนไลน์)
  function isAuthorizedActor(actorClientId) {
    const active = players.getActive();
    if (!active) return true;
    if (actorClientId) {
      return active.clientId === actorClientId;
    }
    return !active.clientId || active.clientId === myClientId();
  }

  function syncToClients() {
    if (GQ.coop && GQ.coop.isHost()) {
      GQ.coop.broadcastState();
    }
  }

  // ---------- การคำนวณและแสดงผล ----------

  function bonusValue() {
    if (state.status === 'playing') {
      const rem = board.remaining();
      // ถ้าเปิดครบทุกป้ายแล้วยังทายถูก ให้ได้อย่างน้อย 1 คะแนน (เว้นแต่โดนหักจนติดลบ)
      const base = rem > 0 ? rem : 1;
      return Math.max(rem > 0 ? 0 : 1, base - state.hintPenalty);
    }
    if (state.status === 'revealed') return state.bonus;
    return 0;
  }

  function refreshPlayers() {
    players.setAwardBonus(state.status === 'revealed' && !state.awarded && state.bonus > 0 ? state.bonus : null);
  }

  function renderTimer() {
    const el = dom.timer;
    if (!el) return;
    el.hidden = !state.timerEnabled;

    const active = players.getActive();
    const activeName = active ? active.name : '';

    let text = activeName ? `⏳ รอ ${activeName} เปิดป้าย...` : '⏳ รอเปิดป้าย...';
    let tone = 'default';

    if (state.status === 'revealed') {
      text = '🏁 เฉลยแล้ว!';
      tone = 'info';
    } else if (state.status === 'loading') {
      text = '⏳ กำลังสุ่มโจทย์...';
      tone = 'default';
    } else if (state.timedOut) {
      text = '⏰ หมดเวลา! เปิดช่องใหม่เพื่อเริ่มนับใหม่';
      tone = 'danger';
    } else if (state.status === 'playing' && state.turnPhase === 'guess' && (state.timerId !== null || isClient())) {
      text = `⏱️ เวลาทาย: ${state.timeLeft} วิ`;
      tone = state.timeLeft <= 5 ? 'danger' : 'warn';
    }
    el.textContent = text;
    el.dataset.tone = tone;
  }

  function renderTurnStatus() {
    const playing = state.status === 'playing';
    const active = players.getActive();
    const nextP = players.getNextPreview();
    const myTurn = canLocalScreenActForActive();

    // Badge บน Topbar
    if (dom.turnBadge) {
      if (!active) {
        dom.turnBadge.textContent = '👥 โหมดอิสระ (ยังไม่มีคิว)';
        dom.turnBadge.dataset.tone = 'info';
      } else if (state.status === 'revealed') {
        dom.turnBadge.textContent = state.roundWinner
          ? `🏆 ผู้ชนะรอบนี้: ${state.roundWinner}`
          : `🎯 คิวถัดไป: ${active.name}`;
        dom.turnBadge.dataset.tone = 'success';
      } else {
        const stepShort = state.turnPhase === 'open' ? 'เปิด 1 ป้าย' : `ทายคำตอบ (${state.timeLeft}s)`;
        dom.turnBadge.textContent = `🎯 คิว: ${active.name} • ${stepShort}`;
        dom.turnBadge.dataset.tone = myTurn ? 'success' : 'warn';
      }
    }

    // แบนเนอร์บอกคิวในแผงควบคุม
    if (dom.turnBanner) {
      dom.turnBanner.hidden = !playing;
      if (playing) {
        dom.turnBanner.classList.toggle('is-my-turn', myTurn);
        dom.turnBanner.classList.toggle('is-waiting', !myTurn);
        dom.turnBanner.dataset.phase = state.turnPhase;

        if (!active) {
          dom.turnBannerTitle.textContent = state.turnPhase === 'open'
            ? '👆 ขั้นที่ 1: คลิกเปิดป้าย 1 ช่อง (หรือกด Space)'
            : '⌨️ ขั้นที่ 2: พิมพ์ทายชื่อตัวละคร!';
          dom.turnBannerStep.textContent = 'เพิ่มชื่อผู้เล่นด้านขวา หรือเปิดห้อง Co-op เพื่อเริ่มระบบรันคิวผลัดกันเล่นอัตโนมัติ';
        } else if (myTurn) {
          const selfTag = isClient() ? ' (ตาของคุณ!)' : '';
          if (state.turnPhase === 'open') {
            dom.turnBannerTitle.textContent = `🎯 ตาของ ${active.name}${selfTag} — ขั้นที่ 1: เปิดป้าย 1 ช่อง`;
            dom.turnBannerStep.textContent = 'คลิกเลือกแผ่นป้ายบนภาพ 1 ช่อง หรือกดปุ่ม "🎲 สุ่มเปิด 1 ช่อง" เพื่อเริ่มจับเวลา 15 วิ';
          } else {
            dom.turnBannerTitle.textContent = `⌨️ ตาของ ${active.name}${selfTag} — ขั้นที่ 2: ทายชื่อตัวละคร!`;
            const nextHint = nextP ? ` (คิวถัดไป: ${nextP.name})` : '';
            dom.turnBannerStep.textContent = `มีเวลา ${state.timeLeft} วินาที — ถ้าตอบผิด (-${C.penalty.wrongGuess} แต้ม) หรือหมดเวลา สิทธิ์จะส่งต่อให้เพื่อนทันที${nextHint}`;
          }
        } else {
          if (state.turnPhase === 'open') {
            dom.turnBannerTitle.textContent = `⏳ รอคิวของ "${active.name}" เปิดป้าย 1 ช่อง...`;
          } else {
            dom.turnBannerTitle.textContent = `⏳ "${active.name}" กำลังทายคำตอบ... (เหลือ ${state.timeLeft} วิ)`;
          }
          dom.turnBannerStep.textContent = nextP
            ? `คิวถัดไปต่อจากนี้: ${nextP.name}`
            : 'เตรียมตัวช่วยดูภาพและรอรอบคิวของคุณ';
        }
      }
    }
  }

  function renderAll() {
    const playing = state.status === 'playing';
    const revealed = state.status === 'revealed';
    const active = players.getActive();
    const hasQueue = Boolean(active);
    const myTurn = canLocalScreenActForActive();
    const inOpenPhase = state.turnPhase === 'open';
    const inGuessPhase = state.turnPhase === 'guess';

    // ตารางภาพ: ไฮไลต์เมื่อถึงตาต้องเปิดป้าย
    const stageEl = $('stage');
    if (stageEl) {
      stageEl.classList.toggle('can-open-tile', playing && myTurn && inOpenPhase);
      stageEl.classList.toggle('locked-for-turn', playing && (!myTurn || (hasQueue && inGuessPhase)));
    }

    dom.guessPanel.hidden = !playing;
    dom.answer.hidden = !revealed;
    if (revealed && state.current) {
      dom.answerName.textContent = state.current.name;
      dom.answerGame.textContent = state.current.game;
      if (dom.answerWinner) {
        dom.answerWinner.hidden = !state.roundWinner;
        dom.answerWinner.textContent = state.roundWinner
          ? `🏆 ตอบถูกโดย: ${state.roundWinner} (+${state.bonus} คะแนน)`
          : '';
      }
    }
    if (dom.btnNextRound) {
      dom.btnNextRound.hidden = !revealed || isClient();
    }

    // ช่องพิมพ์คำตอบ: ในโหมดมีคิว ต้องเปิดป้าย 1 ช่องก่อนจึงจะพิมพ์ตอบได้
    const canTypeGuess = playing && myTurn && (inGuessPhase || !hasQueue);
    dom.guessInput.disabled = !canTypeGuess;
    if ( dom.guessSubmitBtn ) dom.guessSubmitBtn.disabled = !canTypeGuess;

    if (!myTurn && active) {
      dom.guessInput.placeholder = `รอคิวของ ${active.name}...`;
    } else if (hasQueue && inOpenPhase) {
      dom.guessInput.placeholder = `👆 เปิดป้าย 1 ช่องก่อนเพื่อปลดล็อกช่องคำตอบ...`;
    } else if (active) {
      dom.guessInput.placeholder = `ตาของ ${active.name}: พิมพ์ชื่อตัวละครที่นี่...`;
    } else {
      dom.guessInput.placeholder = 'พิมพ์ชื่อตัวละครที่นี่...';
    }

    // ปุ่มตัวช่วยและการคุมเทิร์น
    if (dom.btnRandomTile) {
      dom.btnRandomTile.disabled = !playing || !myTurn || !inOpenPhase || board.remaining() === 0;
    }
    dom.hintDisplay.hidden = !(playing && state.hintLevel > 0 && state.hintText);
    dom.hintDisplay.textContent = state.hintText;

    dom.btnHint.disabled = !playing || !myTurn || state.hintLevel >= C.hints.max;
    dom.btnPeek.disabled = !playing || !myTurn || !inOpenPhase || board.remaining() === 0;
    dom.btnPeek.classList.toggle('armed', state.peekArmed);

    if (dom.btnPassTurn) {
      // ปุ่มข้ามเทิร์น: กดได้เมื่อเป็นตาตัวเอง หรือถ้าเป็น Host สามารถกดเพื่อบังคับข้ามคิวคนที่ค้างได้
      const canPass = playing && hasQueue && (myTurn || !isClient());
      dom.btnPassTurn.hidden = !hasQueue;
      dom.btnPassTurn.disabled = !canPass;
      dom.btnPassTurn.textContent = (!myTurn && !isClient()) ? '⏭️ บังคับข้ามคิว' : '⏭️ ข้ามเทิร์น';
    }

    if (dom.btnGiveUp) {
      dom.btnGiveUp.hidden = isClient();
      dom.btnGiveUp.disabled = !playing;
    }

    dom.bonus.textContent = bonusValue();
    renderTimer();
    renderTurnStatus();
  }

  function flash(text, tone = 'info', ms = 3200) {
    clearTimeout(state.feedbackTimer);
    state.feedback = { text, tone, seq: state.feedback.seq + 1 };
    dom.feedback.textContent = text;
    dom.feedback.dataset.tone = tone;
    if (ms > 0 && !isClient()) {
      state.feedbackTimer = setTimeout(() => {
        clearFeedback();
        syncToClients();
      }, ms);
    }
  }

  function clearFeedback() {
    clearTimeout(state.feedbackTimer);
    state.feedback = { text: '', tone: 'info', seq: state.feedback.seq + 1 };
    dom.feedback.textContent = '';
    delete dom.feedback.dataset.tone;
  }

  function wiggle(el) {
    if (!el) return;
    el.classList.remove('wiggle');
    void el.offsetWidth;
    el.classList.add('wiggle');
  }

  // ---------- จับเวลา 15 วินาที ----------

  function stopTimer() {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  function startTimer() {
    if (isClient()) return;
    if (state.status !== 'playing' || !state.timerEnabled) return;
    stopTimer();
    state.timedOut = false;
    state.timeLeft = C.timer.seconds;
    state.timerId = setInterval(tick, 1000);
    renderTimer();
    renderTurnStatus();
  }

  function tick() {
    state.timeLeft -= 1;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      stopTimer();
      onTurnTimeout();
      return;
    }
    renderTimer();
    renderTurnStatus();
    syncToClients();
  }

  function onTurnTimeout() {
    const active = players.getActive();
    if (active && players.count() > 0) {
      advanceTurn('timeout', active);
    } else {
      state.timedOut = true;
      state.turnPhase = board.remaining() > 0 ? 'open' : 'guess';
      flash('⏰ หมดเวลา 15 วินาที! เปิดป้ายช่องใหม่เพื่อทายต่อ', 'danger', 3500);
      renderAll();
      syncToClients();
    }
  }

  // ---------- ระบบสลับคิวผู้เล่น (Turn Queue) ----------

  function beginTurnPhaseForCurrentPlayer() {
    stopTimer();
    state.timedOut = false;
    state.peekArmed = false;

    if (board.remaining() > 0) {
      state.turnPhase = 'open';
      state.timeLeft = C.timer.seconds;
    } else {
      // กรณีเปิดครบ 36 ช่องแล้ว ให้ผู้เล่นคนถัดไปเข้าสู่ช่วงทาย 15 วิทันที
      state.turnPhase = 'guess';
      startTimer();
    }
  }

  function advanceTurn(reason, prevPlayer) {
    if (state.status !== 'playing') return;
    const prevName = prevPlayer ? prevPlayer.name : 'ผู้เล่น';
    const nextPlayer = players.nextTurn();
    const nextName = nextPlayer ? nextPlayer.name : 'คิวถัดไป';

    beginTurnPhaseForCurrentPlayer();

    if (reason === 'wrong') {
      flash(`❌ ${prevName} ตอบผิด (-${C.penalty.wrongGuess} แต้ม)! ➡️ ส่งต่อคิวให้ "${nextName}" เปิดป้าย`, 'danger', 4000);
      wiggle(dom.feedback);
    } else if (reason === 'timeout') {
      flash(`⏰ หมดเวลาของ ${prevName}! ➡️ ส่งต่อคิวให้ "${nextName}" เปิดป้าย`, 'warn', 4000);
    } else if (reason === 'pass') {
      flash(`⏭️ ${prevName} ข้ามเทิร์น ➡️ ตาของ "${nextName}" เปิดป้าย`, 'info', 3000);
    } else if (reason === 'disconnect') {
      flash(`🔌 ${prevName} ออกจากห้อง ➡️ เลื่อนคิวเป็นตาของ "${nextName}"`, 'warn', 3500);
    }

    dom.guessInput.value = '';
    renderAll();
    syncToClients();
  }

  // ---------- วงจรรอบ ----------

  function resetRound() {
    stopTimer();
    state.timedOut = false;
    state.current = null;
    state.turnPhase = 'open';
    state.hintLevel = 0;
    state.hintPenalty = 0;
    state.hintText = '';
    state.peekArmed = false;
    state.awarded = false;
    state.bonus = 0;
    state.roundWinner = null;
    state.errorText = '';
    board.reset();
    dom.guessInput.value = '';
    dom.hintDisplay.textContent = '';
    clearFeedback();
  }

  function rememberSeen(name) {
    const key = name.toLowerCase();
    state.seen = [...state.seen.filter((s) => s !== key), key].slice(-C.memory.size);
    store.saveSeen(state.seen);
  }

  function forgetHalfOfMemory() {
    state.seen = state.seen.slice(Math.floor(state.seen.length / 2));
    store.saveSeen(state.seen);
  }

  function beginPlaying(candidate) {
    if (state.rotateNextRound && players.count() > 1) {
      players.nextTurn();
    }
    state.rotateNextRound = false;

    state.current = candidate;
    state.status = 'playing';
    state.turnPhase = 'open';
    state.timeLeft = C.timer.seconds;
    rememberSeen(candidate.name);
    board.showLoading(false);
    board.build();
    renderAll();
    refreshPlayers();
    syncToClients();
  }

  function failRound(message) {
    state.status = 'error';
    state.current = null;
    state.errorText = message;
    board.clear();
    board.clearMedia();
    board.showLoading(false);
    board.showError(message);
    renderAll();
    refreshPlayers();
    syncToClients();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function startRound() {
    if (isClient()) return;

    const games = state.games.filter((g) => g.active);
    if (!games.length) {
      alert('กรุณาเลือกเกมอย่างน้อย 1 เกมในหน้าต่างการตั้งค่าครับ!');
      return;
    }

    state.controller?.abort();
    const attemptId = ++state.attempt;
    resetRound();
    state.status = 'loading';
    state.loadingText = 'กำลังค้นหาตัวละครแบบสุ่ม...';
    board.showLoading(true, state.loadingText);
    renderAll();
    refreshPlayers();
    syncToClients();

    for (let i = 1; i <= C.network.attempts; i++) {
      const controller = new AbortController();
      state.controller = controller;
      const timeout = setTimeout(() => controller.abort(), C.network.fetchTimeoutMs);

      try {
        const candidate = await sources.findCandidate({
          games,
          allowAnimated: state.allowAnimated,
          seen: new Set(state.seen),
          signal: controller.signal,
        });
        if (attemptId !== state.attempt) return;

        await board.showMedia(candidate);
        if (attemptId !== state.attempt) return;

        beginPlaying(candidate);
        return;
      } catch (err) {
        if (attemptId !== state.attempt) return;
        console.warn('ลองใหม่:', err.message);
        state.loadingText = `กำลังหาภาพใหม่... (ครั้งที่ ${i})`;
        board.showLoading(true, state.loadingText);
        syncToClients();
        await sleep(C.network.retryDelayMs);
        if (attemptId !== state.attempt) return;
      } finally {
        clearTimeout(timeout);
      }
    }

    forgetHalfOfMemory();
    failRound('ไม่สามารถโหลดภาพได้ (ข้ามภาพอัตโนมัติเกินขีดจำกัด)');
  }

  function reveal(options = {}) {
    if (isClient()) return;
    if (state.status !== 'playing') return;

    const { giveUp = false, winner = null } = options;
    state.bonus = giveUp ? 0 : bonusValue();
    state.status = 'revealed';
    state.peekArmed = false;
    state.rotateNextRound = true;
    stopTimer();

    if (giveUp) {
      state.awarded = true;
      state.roundWinner = null;
      flash('🏳️ เฉลยคำตอบ! (ไม่มีผู้ได้รับโบนัสในรอบนี้)', 'info', 0);
    } else if (!winner) {
      clearFeedback();
    }

    board.revealAll();
    addHistory();
    refreshPlayers();
    renderAll();
    syncToClients();
  }

  function addHistory() {
    const c = state.current;
    if (!c || state.history[0]?.url === c.url) return;
    state.history.unshift({ name: c.name, game: c.game, url: c.url, type: c.type });
    if (state.history.length > C.history.max) state.history.length = C.history.max;
    panels.renderHistory(state.history);
  }

  function awardTo(id) {
    if (isClient()) return;
    if (state.status !== 'revealed' || state.awarded) return;
    const player = players.adjust(id, state.bonus);
    if (!player) return;
    state.awarded = true;
    state.roundWinner = player.name;
    refreshPlayers();
    flash(`🏆 ${player.name} ได้รับ +${state.bonus} คะแนน!`, 'success', 0);
    renderAll();
    syncToClients();
  }

  // ---------- การเปิดป้าย (1 ป้ายต่อเทิร์น) ----------

  function openTile(tile) {
    const before = board.openedCount();
    board.open(tile);

    // เปลี่ยนสถานะเทิร์นจาก 'open' -> 'guess' และเริ่มจับเวลา 15 วินาทีทันที
    state.turnPhase = 'guess';
    startTimer();

    if (before < C.grid.unlockAfter && board.openedCount() >= C.grid.unlockAfter) {
      flash('🔓 ปลดล็อกแผ่นป้ายพิเศษแล้ว! ทายคำตอบได้ภายใน 15 วิ', 'success', 3000);
    } else if (board.remaining() === 0) {
      flash('🖼 เปิดป้ายครบทุกช่องแล้ว! โอกาสทายครั้งสุดท้าย', 'warn', 3500);
    }

    renderAll();
    if (canLocalScreenActForActive()) {
      setTimeout(() => dom.guessInput?.focus(), 30);
    }
    syncToClients();
  }

  function handleTileOpenRequest(tile, actorClientId = null) {
    if (state.status !== 'playing' || !tile || tile.opened) return;

    if (!isAuthorizedActor(actorClientId)) {
      const active = players.getActive();
      if (!actorClientId) {
        flash(`⏳ ตอนนี้เป็นคิวของ "${active?.name || 'เพื่อน'}"!`, 'warn', 2000);
      }
      return;
    }

    // กติกา: เปิดได้ 1 ป้ายต่อ 1 คิว แล้วต้องทายหรือกดข้ามเทิร์น
    if (state.turnPhase === 'guess' && players.count() > 0) {
      if (!actorClientId) {
        flash('🎯 คุณเปิดป้ายครบ 1 ช่องในเทิร์นนี้แล้ว! พิมพ์คำตอบหรือกด "ข้ามเทิร์น"', 'warn', 2500);
      }
      return;
    }

    if (state.peekArmed) {
      state.peekArmed = false;
      state.hintPenalty += C.penalty.peek;
      flash(`👁️ แอบดูสำเร็จ! (-${C.penalty.peek} โบนัส) มีเวลาทาย 15 วิ`, 'peek', 2500);
      openTile(tile);
      return;
    }

    if (tile.locked && board.openedCount() < C.grid.unlockAfter) {
      board.shake(tile);
      GQ.coop?.broadcastShake(tile.index);
      flash(`🔒 ต้องเปิดป้ายปกติอีก ${C.grid.unlockAfter - board.openedCount()} แผ่น เพื่อปลดล็อก!`, 'warn', 2500);
      syncToClients();
      return;
    }

    openTile(tile);
  }

  function onTileClick(tile) {
    if (!tile) return;
    if (isClient()) {
      if (!canLocalScreenActForActive()) {
        const active = players.getActive();
        flash(`⏳ รอให้ถึงคิวของคุณก่อน (ตอนนี้ตาของ ${active?.name || 'เพื่อน'})`, 'warn', 2000);
        return;
      }
      if (state.turnPhase !== 'open') {
        flash('🎯 คุณเปิดป้ายในเทิร์นนี้แล้ว! กรุณาพิมพ์ทายคำตอบหรือกดข้ามเทิร์น', 'warn', 2500);
        return;
      }
      GQ.coop.sendAction('OPEN_TILE', { index: tile.index });
      return;
    }
    handleTileOpenRequest(tile, null);
  }

  function openRandom(actorClientId = null) {
    if (state.status !== 'playing') return;
    if (isClient() && !actorClientId) {
      if (!canLocalScreenActForActive() || state.turnPhase !== 'open') return;
      GQ.coop.sendAction('OPEN_RANDOM');
      return;
    }
    if (!isAuthorizedActor(actorClientId)) return;
    if (state.turnPhase === 'guess' && players.count() > 0) {
      if (!actorClientId) {
        flash('🎯 เปิดป้ายครบ 1 ช่องแล้ว! กรุณาทายคำตอบหรือกดข้ามเทิร์น', 'warn', 2500);
      }
      return;
    }
    const tile = board.pickAvailable();
    if (tile) openTile(tile);
  }

  // ---------- คำใบ้ / แอบดู / ข้ามเทิร์น ----------

  function splitGraphemes(text) {
    return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
  }

  function hintMask(name, level) {
    let shown = 0;
    return splitGraphemes(name)
      .map((ch) => {
        if (ch === ' ') return '   ';
        if (shown < level) {
          shown++;
          return ch + ' ';
        }
        return '_ ';
      })
      .join('')
      .trimEnd();
  }

  function requestHint(actorClientId = null) {
    if (state.status !== 'playing') return;
    if (isClient() && !actorClientId) {
      if (!canLocalScreenActForActive()) return;
      GQ.coop.sendAction('HINT');
      return;
    }
    if (!isAuthorizedActor(actorClientId)) return;
    if (state.hintLevel >= C.hints.max) {
      flash(`⚠️ ใช้คำใบ้ครบ ${C.hints.max} ครั้งแล้ว!`, 'warn');
      syncToClients();
      return;
    }
    state.hintLevel += 1;
    state.hintPenalty += C.penalty.hint;
    state.hintText = hintMask(state.current.name, state.hintLevel);
    flash(`💡 เปิดคำใบ้ระดับ ${state.hintLevel} (-${C.penalty.hint} โบนัส)`, 'warn', 2500);
    renderAll();
    syncToClients();
  }

  function togglePeek(actorClientId = null) {
    if (state.status !== 'playing') return;
    if (isClient() && !actorClientId) {
      if (!canLocalScreenActForActive() || state.turnPhase !== 'open') return;
      GQ.coop.sendAction('PEEK');
      return;
    }
    if (!isAuthorizedActor(actorClientId)) return;
    if (state.turnPhase !== 'open' && players.count() > 0) return;

    state.peekArmed = !state.peekArmed;
    if (state.peekArmed) flash('👁️ โหมดแอบดู: คลิกป้าย 1 ช่อง (แม้ติดล็อกก็เปิดได้)', 'peek', 0);
    else clearFeedback();
    renderAll();
    syncToClients();
  }

  function passTurn(actorClientId = null) {
    if (state.status !== 'playing') return;
    if (isClient() && !actorClientId) {
      if (!canLocalScreenActForActive()) return;
      GQ.coop.sendAction('PASS_TURN');
      return;
    }
    // บนจอ Host อนุญาตให้กดบังคับข้ามคิวได้แม้เป็นคิวของ Client ที่ค้างอยู่
    if (actorClientId && !isAuthorizedActor(actorClientId)) return;

    const active = players.getActive();
    if (!active) return;
    advanceTurn('pass', active);
  }

  // ---------- คำตอบ / คะแนน ----------

  function processGuess(rawGuess, actorClientId = null) {
    if (state.status !== 'playing' || !state.current) return;
    const guess = (rawGuess || '').trim();
    if (!guess) return;

    if (!isAuthorizedActor(actorClientId)) return;

    const active = players.getActive();
    if (active && state.turnPhase === 'open' && board.remaining() > 0) {
      flash('👆 กรุณาเปิดป้าย 1 ช่องก่อนทายคำตอบ!', 'warn', 2500);
      wiggle(dom.feedback);
      syncToClients();
      return;
    }

    if (U.isCorrectAnswer(guess, state.current.name)) {
      const winner = active;
      reveal({ giveUp: false, winner });
      if (winner) {
        awardTo(winner.id);
        flash(`✅ ถูกต้องยอดเยี่ยม! ${winner.name} ตอบถูก ได้รับ +${state.bonus} คะแนน`, 'success', 0);
      } else {
        flash(`✅ ถูกต้องยอดเยี่ยม! คำตอบคือ ${state.current.name}`, 'success', 0);
      }
      renderAll();
      syncToClients();
      return;
    }

    // กรณีตอบผิด: หักคะแนนและส่งต่อคิวให้เพื่อนคนถัดไปทันที
    if (active) {
      players.adjust(active.id, -C.penalty.wrongGuess);
      advanceTurn('wrong', active);
    } else {
      state.hintPenalty += C.penalty.wrongGuess;
      flash(`❌ ยังไม่ถูก! หักโบนัสรอบนี้ -${C.penalty.wrongGuess} แต้ม`, 'danger', 2500);
      dom.guessInput.value = '';
      dom.guessInput.focus();
      wiggle(dom.feedback);
      renderAll();
      syncToClients();
    }
  }

  function onGuessSubmit(e) {
    e.preventDefault();
    if (state.status !== 'playing') return;
    const guess = dom.guessInput.value.trim();
    if (!guess) return;

    if (isClient()) {
      if (!canLocalScreenActForActive()) return;
      GQ.coop.sendAction('GUESS', { guess });
      dom.guessInput.value = '';
      return;
    }

    processGuess(guess, null);
  }

  // ---------- ซิงค์สถานะ Host <-> Client ----------

  function getRoomSummary() {
    const pState = players.exportState();
    const onlinePlayers = pState.list.filter((p) => !p.clientId || p.online !== false);
    return {
      playerCount: onlinePlayers.length,
      playerNames: onlinePlayers.map((p) => p.name).slice(0, 6),
      status: state.status,
      games: state.games.filter((g) => g.active).map((g) => g.name),
    };
  }

  function onReturnHome() {
    state.controller?.abort();
    state.attempt += 1;
    resetRound();
    state.status = 'idle';
    board.showLoading(false);
    renderAll();
  }

  function getStateSnapshot() {
    return {
      status: state.status,
      turnPhase: state.turnPhase,
      bonus: bonusValue(),
      lockedBonus: state.bonus,
      awarded: state.awarded,
      roundWinner: state.roundWinner,
      timerEnabled: state.timerEnabled,
      timeLeft: state.timeLeft,
      timedOut: state.timedOut,
      hintLevel: state.hintLevel,
      hintPenalty: state.hintPenalty,
      hintText: state.hintText,
      peekArmed: state.peekArmed,
      loadingText: state.loadingText,
      errorText: state.errorText,
      feedback: state.feedback,
      media: state.current
        ? { url: state.current.url, type: state.current.type }
        : null,
      answer: state.status === 'revealed' && state.current
        ? { name: state.current.name, game: state.current.game }
        : null,
      board: board.exportState(),
      players: players.exportState(),
      history: state.history.slice(0, 30),
    };
  }

  function applyStateSnapshot(snap) {
    if (!snap || !isClient()) return;

    const prevTurnPhase = state.turnPhase;
    const prevActiveId = players.getActive()?.id;

    state.status = snap.status || 'idle';
    state.turnPhase = snap.turnPhase || 'open';
    state.bonus = snap.lockedBonus ?? 0;
    state.awarded = Boolean(snap.awarded);
    state.roundWinner = snap.roundWinner || null;
    state.timerEnabled = Boolean(snap.timerEnabled);
    state.timeLeft = Number(snap.timeLeft) || 0;
    state.timedOut = Boolean(snap.timedOut);
    state.hintLevel = Number(snap.hintLevel) || 0;
    state.hintPenalty = Number(snap.hintPenalty) || 0;
    state.hintText = snap.hintText || '';
    state.peekArmed = Boolean(snap.peekArmed);

    players.importState(snap.players);

    if (snap.status === 'loading') {
      board.clear();
      board.clearMedia();
      board.showLoading(true, snap.loadingText || 'กำลังค้นหาตัวละคร...');
    } else if (snap.status === 'error') {
      board.clear();
      board.clearMedia();
      board.showLoading(false);
      board.showError(snap.errorText || 'เกิดข้อผิดพลาด');
    } else {
      board.showLoading(false);
      // สร้างป้ายปิดภาพก่อนโหลดสื่อเพื่อไม่ให้เห็นภาพเฉลยแวบขึ้นมา
      board.importState(snap.board);
      board.ensureMedia(snap.media);
    }

    if (snap.status === 'revealed' && snap.answer) {
      state.current = {
        name: snap.answer.name,
        game: snap.answer.game,
        url: snap.media?.url || '',
        type: snap.media?.type || 'image',
      };
    } else if (snap.media) {
      state.current = { name: '', game: '', url: snap.media.url, type: snap.media.type };
    } else {
      state.current = null;
    }

    if (Array.isArray(snap.history)) {
      state.history = snap.history;
      panels.renderHistory(state.history);
    }

    if (snap.feedback && snap.feedback.seq !== lastClientFeedbackSeq) {
      lastClientFeedbackSeq = snap.feedback.seq;
      dom.feedback.textContent = snap.feedback.text || '';
      if (snap.feedback.tone) dom.feedback.dataset.tone = snap.feedback.tone;
      else delete dom.feedback.dataset.tone;
      if (snap.feedback.tone === 'danger' && snap.feedback.text) {
        wiggle(dom.feedback);
      }
    }

    renderAll();
    dom.bonus.textContent = snap.bonus ?? bonusValue();

    // ถ้าเพิ่งเปลี่ยนเข้าสู่ช่วงทายของตัวเอง ให้โฟกัสช่องพิมพ์คำตอบอัตโนมัติ
    const newActiveId = players.getActive()?.id;
    if (
      state.status === 'playing' &&
      canLocalScreenActForActive() &&
      state.turnPhase === 'guess' &&
      (prevTurnPhase !== 'guess' || prevActiveId !== newActiveId)
    ) {
      setTimeout(() => dom.guessInput?.focus(), 40);
    }
  }

  function onClientAction(clientId, payload) {
    if (isClient()) return;
    const action = payload.action;
    switch (action) {
      case 'OPEN_TILE': {
        const tile = board.getTile(payload.index);
        if (tile) handleTileOpenRequest(tile, clientId);
        break;
      }
      case 'OPEN_RANDOM':
        openRandom(clientId);
        break;
      case 'GUESS':
        processGuess(payload.guess, clientId);
        break;
      case 'HINT':
        requestHint(clientId);
        break;
      case 'PEEK':
        togglePeek(clientId);
        break;
      case 'PASS_TURN':
        passTurn(clientId);
        break;
    }
  }

  // ---------- คีย์ลัด ----------

  // Enter: กำลังเล่นอยู่ = เฉลย (เฉพาะ Host), ถ้าเฉลยแล้วหรือไม่มีรอบ = สุ่มตัวถัดไป
  function onEnter() {
    if (isClient()) return;
    if (state.status === 'playing') reveal({ giveUp: true });
    else startRound();
  }

  function onGiveUpClick() {
    if (isClient() || state.status !== 'playing') return;
    reveal({ giveUp: true });
  }

  // ---------- ตั้งค่า / เกม ----------

  function onSettingChange(key, value) {
    if (isClient()) return;
    if (key === 'timer') {
      state.timerEnabled = value;
      store.saveFlag('timer', value);
      if (!value) {
        stopTimer();
        state.timedOut = false;
      } else if (state.status === 'playing' && state.turnPhase === 'guess') {
        startTimer();
      }
      renderTimer();
      syncToClients();
    } else if (key === 'animated') {
      state.allowAnimated = value;
      store.saveFlag('animated', value);
    }
  }

  function onGameToggle(id, active) {
    if (isClient()) return;
    const game = state.games.find((g) => g.id === id);
    if (!game) return;
    game.active = active;
    store.saveGames(state.games);
  }

  function onGameDelete(id) {
    if (isClient()) return;
    const game = state.games.find((g) => g.id === id);
    if (!game || !confirm(`ต้องการลบเกม "${game.name}" ออกจากระบบใช่หรือไม่?`)) return;
    state.games = state.games.filter((g) => g.id !== id);
    store.saveGames(state.games);
    panels.renderGames(state.games);
  }

  function onGameAdd(name, tag) {
    if (isClient()) return false;
    const cleanName = name.trim();
    const cleanTag = tag.trim().toLowerCase().replace(/\s+/g, '_');
    if (!cleanName || !cleanTag) {
      alert('⚠️ กรุณากรอกทั้งชื่อเกมและ Tag ให้ครบถ้วน');
      return false;
    }
    state.games.push({ id: `custom_${Date.now()}`, name: cleanName, tag: cleanTag, active: true, isDefault: false });
    store.saveGames(state.games);
    panels.renderGames(state.games);
    return true;
  }

  function onResetScores() {
    if (isClient()) return;
    if (!confirm('ต้องการรีเซ็ตคะแนนทุกคนเป็น 0 ใช่หรือไม่?')) return;
    players.resetScores();
    state.history = [];
    panels.renderHistory(state.history);
    refreshPlayers();
    renderAll();
    syncToClients();
  }

  function init() {
    cacheDom();
    state.games = store.loadGames();
    state.seen = store.loadSeen();
    state.allowAnimated = store.loadFlag('animated', true);
    state.timerEnabled = store.loadFlag('timer', true);

    sources.init();
    board.init({ onTileClick });
    players.init({
      onAward: awardTo,
      onSelect: () => {
        if (state.status === 'playing') {
          beginTurnPhaseForCurrentPlayer();
          renderAll();
          syncToClients();
        }
      },
      onRemove: (wasActive) => {
        if (wasActive && state.status === 'playing') {
          beginTurnPhaseForCurrentPlayer();
        }
        renderAll();
        syncToClients();
      },
      onShuffle: () => {
        if (state.status === 'playing') {
          beginTurnPhaseForCurrentPlayer();
          flash('🔀 สุ่มลำดับคิวผู้เล่นใหม่แล้ว!', 'info', 2500);
        }
        renderAll();
        syncToClients();
      },
      onChange: () => {
        renderAll();
        syncToClients();
      },
    });

    panels.init({
      getSettings: () => ({ timer: state.timerEnabled, animated: state.allowAnimated }),
      onSettingChange,
      onGameToggle,
      onGameDelete,
      onGameAdd,
    });
    panels.renderGames(state.games);
    panels.renderHistory(state.history);

    if (GQ.coop) {
      GQ.coop.init({
        getRoomSummary,
        getStateSnapshot,
        onStateSync: applyStateSnapshot,
        onRemoteShake: (index) => board.shakeIndex(index),
        onClientJoin: (clientId, name) => {
          const p = players.upsertRemote(clientId, name);
          flash(`👋 "${p.name}" เข้าร่วมห้อง Co-op แล้ว!`, 'success', 3000);
          renderAll();
        },
        onHostJoinSelf: (clientId, name) => {
          const p = players.upsertRemote(clientId, name);
          players.setSelfClientId(clientId);
          flash(`🎮 เพิ่ม "${p.name}" เข้าคิวผู้เล่นแล้ว!`, 'success', 2500);
          renderAll();
        },
        onClientLeave: (clientId) => {
          const res = players.setOnline(clientId, false);
          if (res && res.wasActive && state.status === 'playing') {
            advanceTurn('disconnect', res.player);
          } else {
            renderAll();
          }
        },
        onClientAction,
        onReturnHome,
        onRoleChange: (newRole) => {
          const client = newRole === 'client';
          players.setClientMode(client, GQ.coop.getClientId());
          if (client) {
            stopTimer();
            state.controller?.abort();
          } else if (GQ.coop.isInGame() && state.status === 'idle') {
            startRound();
          }
          renderAll();
        },
      });
      players.setSelfClientId(GQ.coop.getClientId());
    }

    dom.guessForm.addEventListener('submit', onGuessSubmit);
    dom.btnRandomTile?.addEventListener('click', () => openRandom());
    dom.btnHint.addEventListener('click', () => requestHint());
    dom.btnPeek.addEventListener('click', () => togglePeek());
    dom.btnPassTurn?.addEventListener('click', () => passTurn());
    dom.btnGiveUp?.addEventListener('click', onGiveUpClick);
    dom.btnNextRound?.addEventListener('click', () => startRound());
    dom.resetBtn.addEventListener('click', onResetScores);

    renderAll();
    if ((!GQ.coop || GQ.coop.isInGame()) && !isClient() && state.status === 'idle') {
      startRound();
    }
  }

  GQ.game = {
    init,
    openRandom: () => openRandom(),
    reveal: () => reveal({ giveUp: true }),
    onEnter,
  };
})();
