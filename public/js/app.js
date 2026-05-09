/* ══════════════════════════════════════════════════════════
   CHICAGO CARD GAME — Client Application
   ══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────
  const SUITS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
  const SUIT_COLORS = { hearts: 'red', diamonds: 'red', clubs: 'black', spades: 'black' };

  // ── State ───────────────────────────────────────────────
  let socket = null;
  let currentUser = null;
  let token = localStorage.getItem('token');
  let currentView = 'lobby';
  let currentLobbyId = null;
  let isHost = false;
  let matchmakingTimer = null;
  let matchmakingSeconds = 0;

  let gameState = {
    id: null,
    players: [],
    myIndex: -1,
    phase: null,
    currentTrick: { cards: [], leadSuit: null },
    currentPlayerIndex: -1,
    currentPlayerId: null,
    myHand: [],
    round: 0,
    tricksPlayed: 0,
    totalTricks: 0,
    winner: null,
    dealerIndex: 0,
    discardPhase: 0
  };

  // Discard UI state
  let discardSelectedIndices = new Set();
  let discardSubmitted = false;

  // ── DOM References ──────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const authSection = $('#auth-section');
  const menuSection = $('#menu-section');
  const gameSection = $('#game-section');

  // ══════════════════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════════════════

  function showAuthMessage(msg, type) {
    const el = $('#auth-message');
    el.textContent = msg;
    el.className = `message ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
  }

  $('#show-register').addEventListener('click', (e) => {
    e.preventDefault();
    $('#login-form').classList.remove('active');
    $('#register-form').classList.add('active');
  });
  $('#show-login').addEventListener('click', (e) => {
    e.preventDefault();
    $('#register-form').classList.remove('active');
    $('#login-form').classList.add('active');
  });

  // Login
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (!username || !password) return;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      token = data.token;
      localStorage.setItem('token', token);
      currentUser = data.user;
      onAuthenticated();
    } catch (err) {
      showAuthMessage(err.message, 'error');
    }
  });

  // Register
  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#register-username').value.trim();
    const password = $('#register-password').value;
    const confirm = $('#register-confirm').value;

    if (password !== confirm) {
      showAuthMessage('Passwords do not match', 'error');
      return;
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      token = data.token;
      localStorage.setItem('token', token);
      currentUser = data.user;
      onAuthenticated();
    } catch (err) {
      showAuthMessage(err.message, 'error');
    }
  });

  // Logout
  $('#logout-btn').addEventListener('click', () => {
    localStorage.removeItem('token');
    token = null;
    currentUser = null;
    if (socket) { socket.disconnect(); socket = null; }
    showSection('auth');
  });

  // Auto-login on page load
  async function tryAutoLogin() {
    if (!token) return;
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Token expired');
      const data = await res.json();
      currentUser = data.user;
      onAuthenticated();
    } catch {
      localStorage.removeItem('token');
      token = null;
    }
  }

  function onAuthenticated() {
    updateUserUI();
    showSection('menu');
    connectSocket();
    fetchLeaderboard();
  }

  function updateUserUI() {
    if (!currentUser) return;
    const u = currentUser;
    $('#user-display-name').textContent = u.username;
    setEloBadge($('#user-badge'), u.elo);
    $('#profile-username').textContent = u.username;
    setEloBadge($('#profile-elo-badge'), u.elo);
    $('#profile-wins').textContent = u.wins || 0;
    $('#profile-losses').textContent = u.losses || 0;
    const total = (u.wins || 0) + (u.losses || 0);
    $('#profile-winrate').textContent = total > 0 ? Math.round((u.wins / total) * 100) + '%' : '0%';
    $('#profile-games').textContent = u.games_played || total;
    setEloBadge($('#mm-elo-badge'), u.elo);
  }

  // ══════════════════════════════════════════════════════════
  // SECTION / VIEW NAVIGATION
  // ══════════════════════════════════════════════════════════

  function showSection(name) {
    $$('.section').forEach(s => s.classList.remove('active'));
    if (name === 'auth') authSection.classList.add('active');
    else if (name === 'menu') menuSection.classList.add('active');
    else if (name === 'game') gameSection.classList.add('active');
  }

  function showView(name) {
    currentView = name;
    $$('.view').forEach(v => v.classList.remove('active'));
    const view = $(`#${name}-view`);
    if (view) view.classList.add('active');
    $$('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === name);
    });
  }

  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      showView(btn.dataset.view);
      if (btn.dataset.view === 'leaderboard') fetchLeaderboard();
    });
  });

  // ══════════════════════════════════════════════════════════
  // SOCKET.IO CONNECTION
  // ══════════════════════════════════════════════════════════

  function connectSocket() {
    if (socket && socket.connected) return;

    socket = io({ auth: { token: token } });

    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket.id);
      showToast('Connected to server', 'success');
      socket.emit('lobby:list');
      // Try to reconnect to active game
      socket.emit('game:reconnect', {});
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      showToast('Disconnected from server', 'warning');
    });

    socket.on('connect_error', (err) => {
      console.error('[Socket] Connection error:', err.message);
      showToast('Connection error', 'error');
    });

    // Online count — server sends {count: N}
    socket.on('online:count', (data) => {
      const count = typeof data === 'object' ? data.count : data;
      $('#online-count').textContent = count;
    });

    // ── Lobby Events ─────────────────────────────────────
    socket.on('lobby:list', (lobbies) => {
      renderLobbyList(lobbies);
    });

    socket.on('lobby:created', (lobby) => {
      currentLobbyId = lobby.id;
      isHost = true;
      renderLobbyDetail(lobby);
      showToast('Lobby created!', 'success');
    });

    socket.on('lobby:updated', (lobby) => {
      if (lobby && lobby.id === currentLobbyId) {
        renderLobbyDetail(lobby);
      }
      socket.emit('lobby:list');
    });

    socket.on('lobby:destroyed', (data) => {
      if (data && data.lobbyId === currentLobbyId) {
        showToast('Lobby was disbanded', 'info');
        currentLobbyId = null;
        isHost = false;
        hideLobbyDetail();
      }
      socket.emit('lobby:list');
    });

    socket.on('lobby:game_starting', (data) => {
      currentLobbyId = null;
      isHost = false;
      showToast('Game starting!', 'success');
      startGameFromData(data);
    });

    socket.on('lobby:error', (data) => {
      const msg = typeof data === 'object' ? data.error : data;
      showToast(msg || 'Lobby error', 'error');
    });

    // ── Matchmaking Events ───────────────────────────────
    socket.on('matchmaking:queued', () => {
      showMatchmakingSearching();
    });

    socket.on('matchmaking:cancelled', () => {
      showMatchmakingIdle();
    });

    socket.on('matchmaking:found', (data) => {
      showMatchmakingIdle();
      showToast('Match found!', 'success');
      startGameFromData(data);
    });

    socket.on('matchmaking:error', (data) => {
      const msg = typeof data === 'object' ? data.error : data;
      showToast(msg || 'Matchmaking error', 'error');
      showMatchmakingIdle();
    });

    // ── Game Events ──────────────────────────────────────
    socket.on('game:state', (data) => {
      updateGameState(data);
      renderGameBoard();
    });

    socket.on('game:chicago_prompt', (data) => {
      showChicagoPrompt(data);
    });

    socket.on('game:chicago_declared', (data) => {
      showToast(`${data.username} declared Chicago!`, 'warning');
    });

    socket.on('game:card_played', (data) => {
      handleCardPlayed(data);
    });

    socket.on('game:trick_result', (data) => {
      showTrickResult(data);
    });

    socket.on('game:round_end', (data) => {
      showRoundEnd(data);
    });

    socket.on('game:four_of_a_kind', (data) => {
      showToast(data.message || `${data.username} has Four of a Kind!`, 'warning');
    });

    socket.on('game:four_of_a_kind_prompt', (data) => {
      showFourOfAKindPrompt(data);
    });

    socket.on('game:four_of_a_kind_result', (data) => {
      showToast(data.message || 'Four of a kind resolved', 'info');
    });

    socket.on('game:finished', (data) => {
      showGameOver(data);
    });

    socket.on('game:your_hand', (data) => {
      if (data && data.hand) {
        gameState.myHand = data.hand;
        // Re-render if in discard phase
        if (gameState.phase === 'discard_1' || gameState.phase === 'discard_2') {
          renderDiscardUI();
        }
      }
    });

    socket.on('game:hand_updated', (data) => {
      if (data && data.hand) {
        gameState.myHand = data.hand;
        renderDiscardUI();
      }
    });

    socket.on('game:player_discarded', (data) => {
      showToast(`${data.username} discarded ${data.discardCount} card(s)`, 'info');
    });

    socket.on('game:poker_scoring', (data) => {
      showPokerScoringResults(data.results);
    });

    socket.on('game:instant_win', (data) => {
      showBanner(`🏆 ${data.username} wins instantly with ${data.hand}!`, 'gold');
    });

    socket.on('game:error', (data) => {
      const msg = typeof data === 'object' ? (data.error || data.message) : data;
      showToast(msg || 'Game error', 'error');
    });

    socket.on('game:player_disconnected', (data) => {
      showToast(`${data.username} disconnected`, 'warning');
    });

    socket.on('game:player_reconnected', (data) => {
      showToast(`${data.username} reconnected`, 'success');
    });

    socket.on('game:no_active_game', () => {
      // No active game to reconnect to, stay in menu
    });
  }

  // ══════════════════════════════════════════════════════════
  // LOBBY
  // ══════════════════════════════════════════════════════════

  $('#create-lobby-btn').addEventListener('click', () => {
    const maxPlayers = parseInt($('#create-player-count').value, 10);
    socket.emit('lobby:create', { maxPlayers });
  });

  $('#leave-lobby-btn').addEventListener('click', () => {
    if (currentLobbyId) {
      socket.emit('lobby:leave', { lobbyId: currentLobbyId });
      currentLobbyId = null;
      isHost = false;
      hideLobbyDetail();
      socket.emit('lobby:list');
    }
  });

  $('#start-game-btn').addEventListener('click', () => {
    if (currentLobbyId) {
      socket.emit('lobby:start', { lobbyId: currentLobbyId });
    }
  });

  function renderLobbyList(lobbies) {
    const container = $('#lobby-list');
    if (!lobbies || lobbies.length === 0) {
      container.innerHTML = '<p class="empty-state">No open lobbies. Create one to get started!</p>';
      return;
    }

    container.innerHTML = lobbies.map(lobby => {
      const hostName = lobby.host ? (lobby.host.username || lobby.host) : 'Unknown';
      const current = lobby.playerCount || (lobby.players ? lobby.players.length : 0);
      const max = lobby.maxPlayers || 4;
      const isFull = current >= max;
      const isMyLobby = lobby.id === currentLobbyId;

      return `
        <div class="lobby-card">
          <div class="lobby-card-header">
            <span class="lobby-card-host">${escapeHtml(typeof hostName === 'string' ? hostName : hostName.username || 'Unknown')}'s Game</span>
            <span class="lobby-card-count">${current}/${max} players</span>
          </div>
          <button class="btn ${isFull ? 'btn-secondary' : 'btn-primary'} btn-sm"
                  ${isFull || isMyLobby ? 'disabled' : ''}
                  onclick="window.__joinLobby('${lobby.id}')">
            ${isMyLobby ? 'Joined' : isFull ? 'Full' : 'Join'}
          </button>
        </div>
      `;
    }).join('');
  }

  window.__joinLobby = function (lobbyId) {
    socket.emit('lobby:join', { lobbyId });
    currentLobbyId = lobbyId;
  };

  function renderLobbyDetail(lobby) {
    const detail = $('#lobby-detail');
    detail.classList.remove('hidden');
    $('#lobby-detail-id').textContent = lobby.name || 'Game Lobby';

    const players = lobby.players || [];
    const max = lobby.maxPlayers || 4;
    // Check if we're host: lobby.host can be {id, username}
    const hostId = lobby.host ? (lobby.host.id || lobby.host) : null;
    isHost = hostId === currentUser.id;
    currentLobbyId = lobby.id;

    const slotsHtml = [];
    for (let i = 0; i < max; i++) {
      const p = players[i];
      if (p) {
        slotsHtml.push(`
          <div class="lobby-player-slot">
            <span class="player-name">${escapeHtml(p.username || 'Player')}</span>
            <span class="badge badge-sm ${getEloBadgeClass(p.elo)}">${p.elo || 1200}</span>
          </div>
        `);
      } else {
        slotsHtml.push(`
          <div class="lobby-player-slot empty">
            <span class="player-name">Waiting…</span>
          </div>
        `);
      }
    }
    $('#lobby-players').innerHTML = slotsHtml.join('');

    const startBtn = $('#start-game-btn');
    const waitMsg = $('#lobby-wait-msg');
    const canStart = isHost && players.length >= 2;

    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = !canStart;
      waitMsg.textContent = canStart ? 'Ready to start!' : 'Need at least 2 players';
    } else {
      startBtn.classList.add('hidden');
      waitMsg.textContent = 'Waiting for host to start…';
    }
  }

  function hideLobbyDetail() {
    $('#lobby-detail').classList.add('hidden');
  }

  // ══════════════════════════════════════════════════════════
  // MATCHMAKING
  // ══════════════════════════════════════════════════════════

  $('#find-match-btn').addEventListener('click', () => {
    socket.emit('matchmaking:queue');
    // Start timer immediately (server will confirm with matchmaking:queued)
    showMatchmakingSearching();
  });

  $('#cancel-match-btn').addEventListener('click', () => {
    socket.emit('matchmaking:cancel');
    showMatchmakingIdle();
  });

  function showMatchmakingSearching() {
    $('#mm-idle').classList.remove('active');
    $('#mm-searching').classList.add('active');
    matchmakingSeconds = 0;
    updateSearchTimer();
    if (matchmakingTimer) clearInterval(matchmakingTimer);
    matchmakingTimer = setInterval(() => {
      matchmakingSeconds++;
      updateSearchTimer();
    }, 1000);
  }

  function showMatchmakingIdle() {
    $('#mm-searching').classList.remove('active');
    $('#mm-idle').classList.add('active');
    if (matchmakingTimer) { clearInterval(matchmakingTimer); matchmakingTimer = null; }
  }

  function updateSearchTimer() {
    const m = Math.floor(matchmakingSeconds / 60);
    const s = matchmakingSeconds % 60;
    $('#search-time').textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  // ══════════════════════════════════════════════════════════
  // LEADERBOARD
  // ══════════════════════════════════════════════════════════

  async function fetchLeaderboard() {
    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/leaderboard', { headers });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      renderLeaderboard(data.leaderboard || data);
    } catch (err) {
      console.error('Leaderboard error:', err);
    }
  }

  function renderLeaderboard(players) {
    const tbody = $('#leaderboard-body');
    if (!players || players.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No players yet</td></tr>';
      return;
    }

    tbody.innerHTML = players.map((p, i) => {
      const rank = i + 1;
      const isMe = currentUser && (p.id === currentUser.id || p.username === currentUser.username);
      const total = (p.wins || 0) + (p.losses || 0);
      const winRate = total > 0 ? Math.round((p.wins / total) * 100) : 0;

      let rankHtml;
      if (rank <= 3) {
        rankHtml = `<span class="rank-badge rank-${rank}">${rank}</span>`;
      } else {
        rankHtml = `${rank}`;
      }

      return `
        <tr class="${isMe ? 'highlight' : ''}">
          <td>${rankHtml}</td>
          <td>${escapeHtml(p.username)}</td>
          <td><span class="badge badge-sm ${getEloBadgeClass(p.elo)}">${p.elo || 1200}</span></td>
          <td>${p.wins || 0}</td>
          <td>${p.losses || 0}</td>
          <td>${winRate}%</td>
          <td>${total}</td>
        </tr>
      `;
    }).join('');
  }

  // ══════════════════════════════════════════════════════════
  // GAME — STATE & RENDERING
  // ══════════════════════════════════════════════════════════

  function startGameFromData(data) {
    showSection('game');
    if (data) {
      gameState.id = data.gameId || data.id;
      if (data.players) {
        gameState.players = data.players;
        if (currentUser) {
          gameState.myIndex = data.players.findIndex(p => p.id === currentUser.id);
        }
      }
    }
    renderGameBoard();
  }

  function updateGameState(data) {
    if (!data) return;

    // Reset discard state when phase changes to a new discard phase
    const prevPhase = gameState.phase;
    const newPhase = data.phase || gameState.phase;
    if (newPhase !== prevPhase && (newPhase === 'discard_1' || newPhase === 'discard_2')) {
      resetDiscardState();
    }

    gameState.id = data.id || data.gameId || gameState.id;
    gameState.phase = data.phase || gameState.phase;
    gameState.round = data.round ?? gameState.round;
    gameState.tricksPlayed = data.tricksPlayed ?? gameState.tricksPlayed;
    gameState.totalTricks = data.totalTricks ?? gameState.totalTricks;
    gameState.currentPlayerIndex = data.currentPlayerIndex ?? gameState.currentPlayerIndex;
    gameState.currentPlayerId = data.currentPlayerId ?? gameState.currentPlayerId;
    gameState.winner = data.winner ?? gameState.winner;
    gameState.dealerIndex = data.dealerIndex ?? gameState.dealerIndex;
    gameState.discardPhase = data.discardPhase ?? gameState.discardPhase;

    if (data.currentTrick) {
      gameState.currentTrick = data.currentTrick;
    }

    if (data.players) {
      gameState.players = data.players;
    }

    if (data.myIndex !== undefined) {
      gameState.myIndex = data.myIndex;
    } else if (gameState.myIndex === -1 && gameState.players && currentUser) {
      gameState.myIndex = gameState.players.findIndex(p => p.id === currentUser.id);
    }

    // Extract hand from players array (server puts hand only on your player object)
    if (gameState.players && gameState.myIndex >= 0 && gameState.players[gameState.myIndex]) {
      const myPlayer = gameState.players[gameState.myIndex];
      if (myPlayer.hand && myPlayer.hand.length > 0) {
        gameState.myHand = myPlayer.hand;
      }
    }

    // If server sent hand directly (some events might)
    if (data.hand) gameState.myHand = data.hand;
    if (data.myHand) gameState.myHand = data.myHand;
  }

  function isMyTurn() {
    return gameState.phase === 'playing' && gameState.currentPlayerIndex === gameState.myIndex;
  }

  function renderGameBoard() {
    const players = gameState.players;
    if (!players || players.length === 0) return;

    const myIdx = gameState.myIndex;
    const numPlayers = players.length;
    const positions = getPlayerPositions(numPlayers);
    const slots = ['bottom', 'left', 'top', 'right'];

    // Hide all player spots first
    slots.forEach(slot => {
      const el = $(`#player-${slot}`);
      if (el) el.classList.add('hidden-player');
    });

    // Assign players to positions
    for (let offset = 0; offset < numPlayers; offset++) {
      const pIdx = (myIdx + offset) % numPlayers;
      const player = players[pIdx];
      const pos = positions[offset];
      const el = $(`#player-${pos}`);
      if (!el) continue;

      el.classList.remove('hidden-player');
      el.classList.toggle('active', pIdx === gameState.currentPlayerIndex);

      const nameEl = el.querySelector('.player-name');
      const eloEl = el.querySelector('.player-elo');
      const scoreEl = el.querySelector('.player-score');

      // Dealer and first-to-lead badges
      const isDealer = pIdx === gameState.dealerIndex;
      const numP = gameState.players.length;
      const firstLeadIdx = (gameState.dealerIndex + 1) % numP;
      const isFirstLead = pIdx === firstLeadIdx && (gameState.phase === 'discard_1' || gameState.phase === 'discard_2');
      const onTheWayOut = (player.score ?? 0) >= 52;

      const dealerBadge = isDealer ? ' <span class="badge badge-dealer" title="Dealer">🃏 Deals</span>' : '';
      const leadBadge = isFirstLead ? ' <span class="badge badge-lead" title="Leads first trick">▶ Leads</span>' : '';
      const warnBadge = onTheWayOut ? ' <span class="badge badge-warning" title="On the way out!">🎯</span>' : '';

      if (nameEl) nameEl.innerHTML = escapeHtml(player.username || `Player ${pIdx + 1}`) + dealerBadge + leadBadge + warnBadge;
      if (eloEl) setEloBadge(eloEl, player.elo);
      if (scoreEl) scoreEl.textContent = `${player.score ?? 0} pts`;

      // Opponent cards (face-down)
      if (pos !== 'bottom') {
        const cardsEl = el.querySelector('.player-cards');
        if (cardsEl) {
          const cardCount = player.cardCount ?? 0;
          let cardsHtml = '';
          for (let c = 0; c < Math.min(cardCount, 13); c++) {
            cardsHtml += '<div class="card-back small"></div>';
          }
          cardsEl.innerHTML = cardsHtml;
        }
      }
    }

    // Show/hide panels based on phase
    const discardPanel = $('#discard-panel');
    const pokerPanel = $('#poker-scoring-panel');
    const trickArea = $('#trick-area');
    const handEl = $('#my-hand');

    const isDiscardPhase = gameState.phase === 'discard_1' || gameState.phase === 'discard_2';
    const isPokerPhase = gameState.phase === 'poker_scoring';

    if (discardPanel) discardPanel.classList.toggle('hidden', !isDiscardPhase);
    if (pokerPanel) pokerPanel.classList.toggle('hidden', !isPokerPhase);
    if (trickArea) trickArea.classList.toggle('hidden', isDiscardPhase || isPokerPhase);
    if (handEl) handEl.classList.toggle('hidden', isDiscardPhase);

    if (isDiscardPhase) {
      renderDiscardUI();
    } else if (!isPokerPhase) {
      // Render trick area and hand for normal phases
      renderTrickArea();
      renderMyHand();
    }

    // Update top bar info
    const roundInfo = $('#game-round-info');
    const trickInfo = $('#game-trick-info');
    if (roundInfo) roundInfo.textContent = `Round ${gameState.round || 1}`;
    if (trickInfo) {
      if (isDiscardPhase) {
        trickInfo.textContent = `Discard Phase ${gameState.phase === 'discard_1' ? '1' : '2'}/2`;
      } else {
        trickInfo.textContent = `Trick ${gameState.tricksPlayed || 0}/${gameState.totalTricks || 0}`;
      }
    }

    // Bottom bar
    if (myIdx >= 0 && players[myIdx]) {
      const me = players[myIdx];
      const myScoreEl = $('#game-my-score');
      const myNameEl = $('#game-my-name');
      if (myScoreEl) myScoreEl.textContent = `Score: ${me.score ?? 0}`;
      if (myNameEl) myNameEl.textContent = `${me.username || 'You'}`;
    }

    // Scores panel
    renderScoresPanel();
  }

  function getPlayerPositions(numPlayers) {
    switch (numPlayers) {
      case 2: return ['bottom', 'top'];
      case 3: return ['bottom', 'left', 'right'];
      case 4: return ['bottom', 'left', 'top', 'right'];
      default: return ['bottom', 'left', 'top', 'right'];
    }
  }

  function renderTrickArea() {
    const trick = gameState.currentTrick;
    const area = $('#trick-area');
    if (!area) return;
    if (!trick || !trick.cards || trick.cards.length === 0) {
      area.innerHTML = '<div class="trick-empty">Play a card</div>';
      return;
    }

    area.innerHTML = trick.cards.map(tc => {
      const card = tc.card || tc;
      // Find player by playerId
      const player = gameState.players.find(p => p.id === tc.playerId);
      const label = player ? player.username : '';

      return `
        <div class="trick-card-wrapper card-animate-in">
          ${renderCard(card, true)}
          <span class="trick-card-label">${escapeHtml(label)}</span>
        </div>
      `;
    }).join('');
  }

  function renderMyHand() {
    const hand = gameState.myHand;
    const handEl = $('#my-hand');
    if (!handEl) return;

    if (!hand || hand.length === 0) {
      handEl.innerHTML = '<div class="hand-empty">No cards</div>';
      return;
    }

    const myTurn = isMyTurn();
    const leadSuit = gameState.currentTrick && gameState.currentTrick.leadSuit;
    const hasLeadSuit = leadSuit ? hand.some(c => c.suit === leadSuit) : false;

    handEl.innerHTML = hand.map((card, idx) => {
      const suit = card.suit;
      const rank = card.rank;
      const color = SUIT_COLORS[suit] || 'black';

      let playable = false;
      let dimmed = false;

      if (myTurn) {
        if (leadSuit && hasLeadSuit) {
          playable = suit === leadSuit;
          dimmed = !playable;
        } else {
          playable = true;
        }
      }

      const classes = ['card', color, playable ? 'playable' : '', dimmed ? 'dimmed' : ''].filter(Boolean).join(' ');

      return `
        <div class="${classes}" data-index="${idx}" data-suit="${suit}" data-rank="${rank}"
             ${playable ? `onclick="window.__playCard(${idx})"` : ''}>
          <span class="card-corner top">${rank}<br>${SUITS[suit] || suit}</span>
          <span class="card-center">${SUITS[suit] || suit}</span>
          <span class="card-corner bottom">${rank}<br>${SUITS[suit] || suit}</span>
        </div>
      `;
    }).join('');
  }

  function renderCard(card, faceUp) {
    if (!faceUp) return '<div class="card-back"></div>';
    const suit = card.suit;
    const rank = card.rank;
    const color = SUIT_COLORS[suit] || 'black';
    const symbol = SUITS[suit] || suit;

    return `
      <div class="card ${color}" data-suit="${suit}" data-rank="${rank}">
        <span class="card-corner top">${rank}<br>${symbol}</span>
        <span class="card-center">${symbol}</span>
        <span class="card-corner bottom">${rank}<br>${symbol}</span>
      </div>
    `;
  }

  function renderScoresPanel() {
    const list = $('#scores-list');
    if (!list || !gameState.players) return;

    list.innerHTML = gameState.players.map(p => {
      return `
        <div class="score-row">
          <span>${escapeHtml(p.username || 'Player')}</span>
          <span class="score-val">${p.score ?? 0}</span>
        </div>
      `;
    }).join('');
  }

  // Scores panel toggle
  const scoreBtn = $('#game-scores-btn');
  if (scoreBtn) {
    scoreBtn.addEventListener('click', () => {
      $('#scores-panel').classList.toggle('hidden');
    });
  }

  // ══════════════════════════════════════════════════════════
  // GAME — DISCARD UI
  // ══════════════════════════════════════════════════════════

  function renderDiscardUI() {
    const panel = $('#discard-panel');
    if (!panel) return;

    const isPhase1 = gameState.phase === 'discard_1';
    const titleEl = $('#discard-phase-title');
    const subtitleEl = $('#discard-phase-subtitle');
    const handContainer = $('#discard-hand');
    const waitingEl = $('#discard-waiting');
    const confirmBtn = $('#confirm-discard-btn');

    if (titleEl) titleEl.textContent = isPhase1
      ? 'Discard Phase 1 of 2'
      : 'Discard Phase 2 of 2 — Tricks begin after this!';
    if (subtitleEl) subtitleEl.textContent = 'Click cards to select them for discard (0–5 cards)';

    if (discardSubmitted) {
      if (handContainer) handContainer.innerHTML = '<p class="muted">Waiting for other players…</p>';
      if (confirmBtn) confirmBtn.classList.add('hidden');
      if (waitingEl) waitingEl.classList.remove('hidden');
      return;
    }

    if (waitingEl) waitingEl.classList.add('hidden');
    if (confirmBtn) confirmBtn.classList.remove('hidden');

    const hand = gameState.myHand || [];
    if (!handContainer) return;

    handContainer.innerHTML = hand.map((card, idx) => {
      const suit = card.suit;
      const rank = card.rank;
      const color = SUIT_COLORS[suit] || 'black';
      const selected = discardSelectedIndices.has(idx);
      const symbol = SUITS[suit] || suit;

      return `
        <div class="card ${color}${selected ? ' card-selected' : ''}" data-index="${idx}"
             onclick="window.__toggleDiscard(${idx})" style="cursor:pointer;">
          <span class="card-corner top">${rank}<br>${symbol}</span>
          <span class="card-center">${symbol}</span>
          <span class="card-corner bottom">${rank}<br>${symbol}</span>
        </div>
      `;
    }).join('');

    if (confirmBtn) {
      confirmBtn.textContent = discardSelectedIndices.size > 0
        ? `Discard ${discardSelectedIndices.size} card(s)`
        : 'Keep All Cards';
    }
  }

  window.__toggleDiscard = function (idx) {
    if (discardSubmitted) return;
    if (discardSelectedIndices.has(idx)) {
      discardSelectedIndices.delete(idx);
    } else {
      discardSelectedIndices.add(idx);
    }
    renderDiscardUI();
  };

  window.__confirmDiscard = function () {
    if (discardSubmitted) return;
    discardSubmitted = true;
    const indices = Array.from(discardSelectedIndices);
    socket.emit('game:discard', {
      gameId: gameState.id,
      cardIndices: indices
    });
    discardSelectedIndices = new Set();
    renderDiscardUI();
  };

  function resetDiscardState() {
    discardSelectedIndices = new Set();
    discardSubmitted = false;
  }

  function showPokerScoringResults(results) {
    const panel = $('#poker-scoring-panel');
    const list = $('#poker-results-list');
    if (!panel || !list) return;

    panel.classList.remove('hidden');
    if ($('#discard-panel')) $('#discard-panel').classList.add('hidden');

    list.innerHTML = (results || []).map(r => {
      const handName = r.pokerHand ? r.pokerHand.name : 'High Card';
      const points = r.points || 0;
      const isWinner = points > 0;

      return `
        <div class="round-player-result${isWinner ? ' scoring-winner' : ''}">
          <div class="rpr-header">
            <span class="rpr-name">${escapeHtml(r.username)}${isWinner ? ' 🏆' : ''}</span>
            <span class="rpr-points">${points > 0 ? '+' : ''}${points} pts</span>
          </div>
          <div class="rpr-hand">${escapeHtml(handName)}</div>
        </div>
      `;
    }).join('');
  }

  function showBanner(message, type) {
    showToast(message, type === 'gold' ? 'success' : type);
  }

  // (discard reset is handled inside updateGameState)

  // ══════════════════════════════════════════════════════════
  // GAME — ACTIONS
  // ══════════════════════════════════════════════════════════

  window.__playCard = function (cardIndex) {
    if (!isMyTurn()) return;

    socket.emit('game:play_card', {
      gameId: gameState.id,
      cardIndex: cardIndex
    });

    // Remove card from local hand optimistically
    if (gameState.myHand && gameState.myHand[cardIndex]) {
      gameState.myHand.splice(cardIndex, 1);
    }
    renderGameBoard();
  };

  function handleCardPlayed(data) {
    // Update trick with the card played
    if (data.trickCards) {
      gameState.currentTrick.cards = data.trickCards;
    }
    if (data.card && data.playerId !== undefined) {
      // Add to current trick if not already there
      const existing = gameState.currentTrick.cards.find(tc =>
        tc.playerId === data.playerId && tc.card.suit === data.card.suit && tc.card.rank === data.card.rank);
      if (!existing) {
        gameState.currentTrick.cards.push({ playerId: data.playerId, card: data.card });
      }
    }
    if (data.leadSuit) {
      gameState.currentTrick.leadSuit = data.leadSuit;
    }

    // Update card counts
    if (data.playerId !== undefined) {
      const player = gameState.players.find(p => p.id === data.playerId);
      if (player && data.cardsRemaining !== undefined) {
        player.cardCount = data.cardsRemaining;
      }
    }

    renderGameBoard();
  }

  // ══════════════════════════════════════════════════════════
  // GAME — MODALS / PROMPTS
  // ══════════════════════════════════════════════════════════

  function showChicagoPrompt(data) {
    const me = gameState.myIndex >= 0 ? gameState.players[gameState.myIndex] : null;
    const myScore = me ? (me.score ?? 0) : 0;

    // Render the player's current hand so they can decide wisely
    const hand = gameState.myHand || [];
    const cardsHtml = hand.length > 0
      ? `<div class="chicago-preview-hand">${hand.map(c => renderCard(c, true)).join('')}</div>`
      : '';

    const html = `
      <h2>♠ Declare Chicago? ♠</h2>
      <p>You have <strong>${myScore}</strong> points.<br>
      Declare Chicago: win <strong>all tricks</strong> this round for <strong>+15 points</strong>.<br>
      But lose <strong>any trick</strong> and get <strong>-15 points</strong>!</p>
      ${cardsHtml}
      <div class="modal-actions">
        <button class="btn btn-gold" onclick="window.__chicagoDeclare(true)">Declare Chicago!</button>
        <button class="btn btn-secondary" onclick="window.__chicagoDeclare(false)">Pass</button>
      </div>
    `;
    showModal(html);
  }

  window.__chicagoDeclare = function (declare) {
    hideModal();
    socket.emit('game:declare_chicago', {
      gameId: gameState.id,
      declares: declare
    });
  };

  function showFourOfAKindPrompt(data) {
    const html = `
      <h2>🎰 Four of a Kind!</h2>
      <p>Incredible! You got <strong>Four of a Kind</strong>!<br>
      Choose your reward:</p>
      <div class="modal-actions">
        <button class="btn btn-primary" onclick="window.__fourOfAKindChoice('points')">Take 8 Points</button>
        <button class="btn btn-danger" onclick="window.__fourOfAKindChoice('remove')">Remove All Opponents' Points</button>
      </div>
    `;
    showModal(html);
  }

  window.__fourOfAKindChoice = function (choice) {
    hideModal();
    socket.emit('game:four_of_a_kind_choice', {
      gameId: gameState.id,
      choice: choice
    });
  };

  function showTrickResult(data) {
    const winnerName = data.winnerName || 'Unknown';
    const isLastTrick = data.trickNumber === gameState.totalTricks;
    if (isLastTrick) {
      showToast(`🏆 ${winnerName} won the LAST trick! +5 points`, 'success');
    } else {
      showToast(`${winnerName} won trick ${data.trickNumber || ''}`, 'info');
    }

    // Clear trick area after brief delay
    setTimeout(() => {
      gameState.currentTrick = { cards: [], leadSuit: null };
      renderGameBoard();
    }, 1500);
  }

  function showRoundEnd(data) {
    // Show bonus toast for winning last trick with a 2
    if (data.lastTrickBonus2) {
      showToast('🃏 Last trick won with a 2! Bonus +5 pts!', 'success');
    }

    let html = `<h2>Round ${data.round || gameState.round} Complete!</h2>`;

    if (data.instantWin) {
      html += `
        <div class="instant-win-banner">
          <h3>🎉 ${escapeHtml(data.instantWin.username)} got ${escapeHtml(data.instantWin.hand)}!</h3>
          <p>Instant win!</p>
        </div>
      `;
    }

    if (data.results) {
      html += '<div class="round-results">';
      data.results.forEach(r => {
        const playerName = r.username || 'Player';
        const points = r.points ?? 0;
        const chicagoInfo = r.chicagoDeclared
          ? (r.chicagoSuccess ? ' 🏆 Chicago SUCCESS!' : ' ❌ Chicago FAILED')
          : '';
        const lastTrickNote = r.lastTrickWon ? (data.lastTrickBonus2 ? ' 🃏 Last trick (2 bonus!)' : ' ⭐ Last trick') : '';
        const pointStr = points >= 0 ? `+${points}` : `${points}`;

        html += `
          <div class="round-player-result">
            <div class="rpr-header">
              <span class="rpr-name">${escapeHtml(playerName)}${chicagoInfo}${lastTrickNote}</span>
              <span class="rpr-points">${pointStr} pts</span>
            </div>
          </div>
        `;
      });
      html += '</div>';
    }

    // Show updated scores
    if (data.scores) {
      html += '<h3>Total Scores</h3><div class="round-scores">';
      const scores = Array.isArray(data.scores) ? data.scores : [];
      scores.forEach(s => {
        const onTheWayOut = (s.score ?? 0) >= 52;
        html += `
          <div class="score-row" style="padding: 8px 0;${onTheWayOut ? ' font-weight:bold; color: #f5c518;' : ''}">
            <span>${escapeHtml(s.username || 'Player')}${onTheWayOut ? ' 🎯' : ''}</span>
            <span class="score-val">${s.score ?? 0}${onTheWayOut ? ' — On the way out!' : ''}</span>
          </div>
        `;
      });
      html += '</div>';

      // Update player scores in local state
      for (const s of scores) {
        const player = gameState.players.find(p => p.id === s.playerId);
        if (player) player.score = s.score;
      }
    }

    html += `
      <div class="modal-actions" style="margin-top: var(--space-lg, 24px);">
        <button class="btn btn-primary" onclick="window.__closeRoundEnd()">Continue</button>
      </div>
    `;

    showModal(html);
  }

  window.__closeRoundEnd = function () {
    hideModal();
    gameState.currentTrick = { cards: [], leadSuit: null };
    // Do NOT clear myHand here — server already sent the new hand via game:state
    // Clearing it causes the discard UI to show blank cards
    renderGameBoard();
  };

  function showGameOver(data) {
    const winner = data.winner || {};
    const winnerName = winner.username || 'Unknown';
    const isMe = currentUser && winnerName === currentUser.username;

    let eloHtml = '';
    if (data.eloChanges && data.eloChanges.length > 0) {
      eloHtml = '<div class="elo-changes"><h3>ELO Changes</h3>';
      data.eloChanges.forEach(ec => {
        const name = ec.username || 'Player';
        const change = ec.eloChange || 0;
        const newElo = ec.newElo || 0;
        const cls = change >= 0 ? 'elo-positive' : 'elo-negative';
        eloHtml += `
          <div class="elo-change-row">
            <span>${escapeHtml(name)}</span>
            <span class="${cls}">${change >= 0 ? '+' : ''}${change} → ${newElo}</span>
          </div>
        `;
      });
      eloHtml += '</div>';
    }

    let scoresHtml = '';
    if (data.finalScores) {
      scoresHtml = '<div class="final-scores"><h3>Final Scores</h3>';
      data.finalScores.forEach(s => {
        scoresHtml += `
          <div class="score-row">
            <span>${escapeHtml(s.username)} ${s.playerId === winner.id ? '👑' : ''}</span>
            <span class="score-val">${s.score ?? 0}</span>
          </div>
        `;
      });
      scoresHtml += '</div>';
    }

    // Final round poker results
    let pokerHtml = '';
    if (data.finalPokerResults && data.finalPokerResults.length > 0) {
      pokerHtml = '<div class="final-scores"><h3>🃏 Final Poker Hand</h3>';
      data.finalPokerResults.forEach(r => {
        const pts = r.points || 0;
        pokerHtml += `
          <div class="score-row${pts > 0 ? ' scoring-winner' : ''}">
            <span>${escapeHtml(r.username)}${pts > 0 ? ' 🏆' : ''} — ${escapeHtml(r.handName || 'High Card')}</span>
            <span class="score-val">${pts > 0 ? '+' + pts + ' pts' : ''}</span>
          </div>
        `;
      });
      pokerHtml += '</div>';
    }

    const html = `
      <div class="game-over-overlay">
        <h1>${isMe ? '🏆 You Win!' : '🏆 Game Over!'}</h1>
        <p class="winner-name">${escapeHtml(winnerName)} wins!</p>
        <p class="win-condition">${escapeHtml(winner.condition || '')}</p>
        ${pokerHtml}
        ${scoresHtml}
        ${eloHtml}
        <div class="modal-actions" style="margin-top: var(--space-xl, 32px);">
          <button class="btn btn-primary btn-lg" onclick="window.__backToLobby()">Back to Lobby</button>
        </div>
      </div>
    `;

    showModal(html);
    startConfetti();

    // Update local user data
    if (data.eloChanges && currentUser) {
      const myChange = data.eloChanges.find(ec => ec.playerId === currentUser.id || ec.username === currentUser.username);
      if (myChange) {
        currentUser.elo = myChange.newElo || currentUser.elo;
        if (isMe) {
          currentUser.wins = (currentUser.wins || 0) + 1;
        } else {
          currentUser.losses = (currentUser.losses || 0) + 1;
        }
        updateUserUI();
      }
    }
  }

  window.__backToLobby = function () {
    hideModal();
    stopConfetti();
    gameState = {
      id: null, players: [], myIndex: -1, phase: null,
      currentTrick: { cards: [], leadSuit: null },
      currentPlayerIndex: -1, currentPlayerId: null,
      myHand: [], round: 0,
      tricksPlayed: 0, totalTricks: 0, winner: null
    };
    showSection('menu');
    showView('lobby');
    socket.emit('lobby:list');
  };

  // ══════════════════════════════════════════════════════════
  // UI HELPERS
  // ══════════════════════════════════════════════════════════

  function showModal(html) {
    const overlay = $('#modal-overlay');
    const content = $('#modal-content');
    if (content) content.innerHTML = html;
    if (overlay) overlay.classList.remove('hidden');
  }

  function hideModal() {
    const overlay = $('#modal-overlay');
    const content = $('#modal-content');
    if (overlay) overlay.classList.add('hidden');
    if (content) content.innerHTML = '';
  }

  const modalOverlay = $('#modal-overlay');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        // Don't close game modals by clicking outside
      }
    });
  }

  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4000);
  }

  function setEloBadge(el, elo) {
    if (!el) return;
    elo = elo || 1200;
    const badgeClass = getEloBadgeClass(elo);
    const label = getEloLabel(elo);
    const sizeClass = el.classList.contains('badge-sm') ? 'badge-sm' : el.classList.contains('badge-lg') ? 'badge-lg' : '';
    el.className = `badge ${sizeClass} ${badgeClass}`.trim();
    el.textContent = `${elo} ${label}`;
  }

  function getEloBadgeClass(elo) {
    elo = elo || 1200;
    if (elo >= 2200) return 'badge-master';
    if (elo >= 1800) return 'badge-diamond';
    if (elo >= 1500) return 'badge-gold';
    if (elo >= 1300) return 'badge-silver';
    return 'badge-bronze';
  }

  function getEloLabel(elo) {
    elo = elo || 1200;
    if (elo >= 2200) return 'Master';
    if (elo >= 1800) return 'Diamond';
    if (elo >= 1500) return 'Gold';
    if (elo >= 1300) return 'Silver';
    return 'Bronze';
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ══════════════════════════════════════════════════════════
  // CONFETTI
  // ══════════════════════════════════════════════════════════

  let confettiAnimFrame = null;

  function startConfetti() {
    const canvas = $('#confetti-canvas');
    if (!canvas) return;
    canvas.classList.remove('hidden');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    const pieces = [];
    const colors = ['#ffd700', '#e74c3c', '#2ecc71', '#3498db', '#f39c12', '#9b59b6', '#fff'];
    for (let i = 0; i < 150; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        w: Math.random() * 10 + 5,
        h: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 3,
        vy: Math.random() * 3 + 2,
        rot: Math.random() * Math.PI * 2,
        rv: (Math.random() - 0.5) * 0.1
      });
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      pieces.forEach(p => {
        if (p.y < canvas.height + 50) alive = true;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.rv;
        p.vy += 0.02;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      if (alive) {
        confettiAnimFrame = requestAnimationFrame(draw);
      } else {
        stopConfetti();
      }
    }
    draw();
  }

  function stopConfetti() {
    if (confettiAnimFrame) {
      cancelAnimationFrame(confettiAnimFrame);
      confettiAnimFrame = null;
    }
    const canvas = $('#confetti-canvas');
    if (!canvas) return;
    canvas.classList.add('hidden');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ══════════════════════════════════════════════════════════
  // INIT
  // ══════════════════════════════════════════════════════════

  tryAutoLogin();

})();
