/**
 * Chicago Card Game — Main Server
 * Express + Socket.io server with lobby, matchmaking, and real-time gameplay.
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

const { router: authRouter, authenticateToken, authenticateSocket } = require('./src/auth');
const { query } = require('./src/db');
const GameManager = require('./src/gameManager');
const MatchmakingManager = require('./src/matchmaking');

// ==================== EXPRESS SETUP ====================

const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // Allow inline scripts for game UI
}));
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Auth routes
app.use('/api/auth', authRouter);

// ==================== API ROUTES ====================

/**
 * GET /api/leaderboard — Top 100 players by ELO.
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, elo, wins, losses, games_played
       FROM users
       ORDER BY elo DESC
       LIMIT 100`
    );
    res.json({ leaderboard: result.rows });
  } catch (err) {
    console.error('[API] Leaderboard error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/profile/:username — User profile and recent games.
 */
app.get('/api/profile/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const userResult = await query(
      `SELECT id, username, elo, wins, losses, games_played, created_at
       FROM users WHERE LOWER(username) = LOWER($1)`,
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get recent games
    const gamesResult = await query(
      `SELECT g.id, g.status, g.win_condition, g.rounds_played, g.finished_at,
              gp.final_score, gp.elo_before, gp.elo_after, gp.elo_change,
              u.username AS winner_name
       FROM game_players gp
       JOIN games g ON g.id = gp.game_id
       LEFT JOIN users u ON u.id = g.winner_id
       WHERE gp.user_id = $1
       ORDER BY g.finished_at DESC
       LIMIT 20`,
      [user.id]
    );

    res.json({
      profile: {
        id: user.id,
        username: user.username,
        elo: user.elo,
        wins: user.wins,
        losses: user.losses,
        gamesPlayed: user.games_played,
        winRate: user.games_played > 0
          ? Math.round((user.wins / user.games_played) * 100)
          : 0,
        createdAt: user.created_at
      },
      recentGames: gamesResult.rows
    });
  } catch (err) {
    console.error('[API] Profile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/online — Count of online users.
 */
app.get('/api/online', (req, res) => {
  const count = io.sockets.sockets.size;
  res.json({ online: count });
});

// ==================== SOCKET.IO SETUP ====================

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Socket authentication middleware
io.use(authenticateSocket);

// Initialize managers
const gameManager = new GameManager(io);
const matchmakingManager = new MatchmakingManager(io, gameManager);

// ==================== LOBBY SYSTEM ====================

const lobbies = new Map();

function getLobbyList() {
  return Array.from(lobbies.values())
    .filter(l => l.status === 'waiting')
    .map(l => ({
      id: l.id,
      host: l.host,
      players: l.players.map(p => ({ id: p.id, username: p.username, elo: p.elo })),
      maxPlayers: l.maxPlayers,
      playerCount: l.players.length,
      createdAt: l.createdAt
    }));
}

// ==================== SOCKET EVENTS ====================

io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`[Socket] ${user.username} connected (ID: ${user.id}, Socket: ${socket.id})`);

  // Broadcast updated online count
  io.emit('online:count', { count: io.sockets.sockets.size });

  // ---- LOBBY EVENTS ----

  /**
   * Create a new lobby.
   */
  socket.on('lobby:create', async (data) => {
    try {
      const maxPlayers = data && [2, 3, 4].includes(data.maxPlayers) ? data.maxPlayers : 4;

      // Check if player is already in a lobby
      for (const [id, lobby] of lobbies.entries()) {
        if (lobby.players.some(p => p.id === user.id)) {
          return socket.emit('lobby:error', { error: 'Already in a lobby' });
        }
      }

      // Fetch user ELO
      let elo = 1200;
      try {
        const result = await query('SELECT elo FROM users WHERE id = $1', [user.id]);
        if (result.rows.length > 0) elo = result.rows[0].elo;
      } catch (e) { /* use default */ }

      const lobbyId = crypto.randomUUID();
      const lobby = {
        id: lobbyId,
        host: { id: user.id, username: user.username },
        players: [{
          id: user.id,
          username: user.username,
          socketId: socket.id,
          elo
        }],
        maxPlayers,
        status: 'waiting',
        createdAt: new Date()
      };

      lobbies.set(lobbyId, lobby);
      socket.join(`lobby:${lobbyId}`);

      console.log(`[Lobby ${lobbyId}] Created by ${user.username} (max ${maxPlayers})`);

      socket.emit('lobby:created', {
        id: lobbyId,
        host: lobby.host,
        players: lobby.players.map(p => ({ id: p.id, username: p.username, elo: p.elo })),
        maxPlayers
      });

      // Broadcast updated lobby list
      io.emit('lobby:list', getLobbyList());
    } catch (err) {
      console.error('[Lobby] Create error:', err.message);
      socket.emit('lobby:error', { error: 'Failed to create lobby' });
    }
  });

  /**
   * Join an existing lobby.
   */
  socket.on('lobby:join', async (data) => {
    try {
      const { lobbyId } = data || {};
      const lobby = lobbies.get(lobbyId);

      if (!lobby) {
        return socket.emit('lobby:error', { error: 'Lobby not found' });
      }
      if (lobby.status !== 'waiting') {
        return socket.emit('lobby:error', { error: 'Lobby is no longer accepting players' });
      }
      if (lobby.players.length >= lobby.maxPlayers) {
        return socket.emit('lobby:error', { error: 'Lobby is full' });
      }
      if (lobby.players.some(p => p.id === user.id)) {
        return socket.emit('lobby:error', { error: 'Already in this lobby' });
      }

      // Fetch user ELO
      let elo = 1200;
      try {
        const result = await query('SELECT elo FROM users WHERE id = $1', [user.id]);
        if (result.rows.length > 0) elo = result.rows[0].elo;
      } catch (e) { /* use default */ }

      lobby.players.push({
        id: user.id,
        username: user.username,
        socketId: socket.id,
        elo
      });

      socket.join(`lobby:${lobbyId}`);

      console.log(`[Lobby ${lobbyId}] ${user.username} joined (${lobby.players.length}/${lobby.maxPlayers})`);

      // Notify lobby
      io.to(`lobby:${lobbyId}`).emit('lobby:updated', {
        id: lobbyId,
        host: lobby.host,
        players: lobby.players.map(p => ({ id: p.id, username: p.username, elo: p.elo })),
        maxPlayers: lobby.maxPlayers
      });

      // Auto-start if lobby is full
      if (lobby.players.length >= lobby.maxPlayers) {
        startLobbyGame(lobbyId);
      }

      // Broadcast updated lobby list
      io.emit('lobby:list', getLobbyList());
    } catch (err) {
      console.error('[Lobby] Join error:', err.message);
      socket.emit('lobby:error', { error: 'Failed to join lobby' });
    }
  });

  /**
   * Leave a lobby.
   */
  socket.on('lobby:leave', (data) => {
    try {
      const { lobbyId } = data || {};
      const lobby = lobbies.get(lobbyId);
      if (!lobby) return;

      const playerIndex = lobby.players.findIndex(p => p.id === user.id);
      if (playerIndex === -1) return;

      lobby.players.splice(playerIndex, 1);
      socket.leave(`lobby:${lobbyId}`);

      console.log(`[Lobby ${lobbyId}] ${user.username} left`);

      // If host left or lobby empty, destroy it
      if (lobby.host.id === user.id || lobby.players.length === 0) {
        lobbies.delete(lobbyId);
        io.to(`lobby:${lobbyId}`).emit('lobby:destroyed', { lobbyId });
        console.log(`[Lobby ${lobbyId}] Destroyed`);
      } else {
        io.to(`lobby:${lobbyId}`).emit('lobby:updated', {
          id: lobbyId,
          host: lobby.host,
          players: lobby.players.map(p => ({ id: p.id, username: p.username, elo: p.elo })),
          maxPlayers: lobby.maxPlayers
        });
      }

      io.emit('lobby:list', getLobbyList());
    } catch (err) {
      console.error('[Lobby] Leave error:', err.message);
    }
  });

  /**
   * Start game from lobby (host only, ≥2 players).
   */
  socket.on('lobby:start', (data) => {
    try {
      const { lobbyId } = data || {};
      const lobby = lobbies.get(lobbyId);
      if (!lobby) {
        return socket.emit('lobby:error', { error: 'Lobby not found' });
      }
      if (lobby.host.id !== user.id) {
        return socket.emit('lobby:error', { error: 'Only the host can start the game' });
      }
      if (lobby.players.length < 2) {
        return socket.emit('lobby:error', { error: 'Need at least 2 players to start' });
      }

      startLobbyGame(lobbyId);
    } catch (err) {
      console.error('[Lobby] Start error:', err.message);
      socket.emit('lobby:error', { error: 'Failed to start game' });
    }
  });

  /**
   * Request list of open lobbies.
   */
  socket.on('lobby:list', () => {
    socket.emit('lobby:list', getLobbyList());
  });

  // ---- MATCHMAKING EVENTS ----

  /**
   * Join ranked matchmaking queue.
   */
  socket.on('matchmaking:queue', async () => {
    try {
      let elo = 1200;
      try {
        const result = await query('SELECT elo FROM users WHERE id = $1', [user.id]);
        if (result.rows.length > 0) elo = result.rows[0].elo;
      } catch (e) { /* use default */ }

      const success = matchmakingManager.addToQueue({
        userId: user.id,
        username: user.username,
        elo,
        socketId: socket.id
      });

      if (!success) {
        socket.emit('matchmaking:error', { error: 'Already in queue or in a game' });
      }
    } catch (err) {
      console.error('[Matchmaking] Queue error:', err.message);
      socket.emit('matchmaking:error', { error: 'Failed to join queue' });
    }
  });

  /**
   * Leave matchmaking queue.
   */
  socket.on('matchmaking:cancel', () => {
    matchmakingManager.removeFromQueue(user.id);
    socket.emit('matchmaking:cancelled');
  });

  // ---- GAME EVENTS ----

  /**
   * Play a card.
   */
  socket.on('game:play_card', (data) => {
    try {
      const { gameId, cardIndex } = data || {};
      if (!gameId || cardIndex === undefined) {
        return socket.emit('game:error', { error: 'Missing gameId or cardIndex' });
      }

      const result = gameManager.playCard(gameId, user.id, cardIndex);
      if (result.error) {
        socket.emit('game:error', { error: result.error });
      }
    } catch (err) {
      console.error('[Game] Play card error:', err.message);
      socket.emit('game:error', { error: 'Failed to play card' });
    }
  });

  /**
   * Discard cards (discard phase 1 or 2).
   */
  socket.on('game:discard', ({ gameId, cardIndices } = {}) => {
    try {
      const sessionData = gameManager.socketToGame.get(socket.id);
      if (!sessionData || sessionData.gameId !== gameId) return;
      const result = gameManager.handleDiscard(gameId, sessionData.playerId, cardIndices || []);
      if (result && result.error) {
        socket.emit('game:error', { message: result.error });
      }
    } catch (err) {
      console.error('[Game] Discard error:', err.message);
      socket.emit('game:error', { error: 'Failed to process discard' });
    }
  });

  /**
   * Declare Chicago.
   */
  socket.on('game:declare_chicago', (data) => {
    try {
      const { gameId, declares } = data || {};
      if (!gameId) return;
      gameManager.handleChicagoDeclaration(gameId, user.id, !!declares);
    } catch (err) {
      console.error('[Game] Chicago declaration error:', err.message);
    }
  });

  /**
   * Four of a kind choice.
   */
  socket.on('game:four_of_a_kind_choice', (data) => {
    try {
      const { gameId, choice } = data || {};
      if (!gameId || !['points', 'remove'].includes(choice)) return;
      gameManager.handleFourOfAKindChoice(gameId, user.id, choice);
    } catch (err) {
      console.error('[Game] Four of a kind choice error:', err.message);
    }
  });

  /**
   * Reconnect to active game.
   */
  socket.on('game:reconnect', (data) => {
    try {
      const { gameId } = data || {};

      // If no gameId provided, try to find active game
      let targetGameId = gameId;
      if (!targetGameId) {
        targetGameId = gameManager.findGameByPlayerId(user.id);
      }

      if (!targetGameId) {
        return socket.emit('game:no_active_game');
      }

      const view = gameManager.reconnectPlayer(targetGameId, user.id, socket.id);
      if (view) {
        socket.emit('game:state', view);
      } else {
        socket.emit('game:error', { error: 'Failed to reconnect' });
      }
    } catch (err) {
      console.error('[Game] Reconnect error:', err.message);
      socket.emit('game:error', { error: 'Failed to reconnect' });
    }
  });

  // ---- DISCONNECT ----

  socket.on('disconnect', () => {
    console.log(`[Socket] ${user.username} disconnected`);

    // Remove from matchmaking queue
    matchmakingManager.removeBySocketId(socket.id);

    // Handle game disconnect
    gameManager.handleDisconnect(socket.id);

    // Remove from any lobbies
    for (const [lobbyId, lobby] of lobbies.entries()) {
      const idx = lobby.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        lobby.players.splice(idx, 1);
        if (lobby.host.id === user.id || lobby.players.length === 0) {
          lobbies.delete(lobbyId);
          io.to(`lobby:${lobbyId}`).emit('lobby:destroyed', { lobbyId });
        } else {
          io.to(`lobby:${lobbyId}`).emit('lobby:updated', {
            id: lobbyId,
            host: lobby.host,
            players: lobby.players.map(p => ({ id: p.id, username: p.username, elo: p.elo })),
            maxPlayers: lobby.maxPlayers
          });
        }
      }
    }

    // Broadcast updated online count
    io.emit('online:count', { count: io.sockets.sockets.size });
    io.emit('lobby:list', getLobbyList());
  });
});

// ==================== LOBBY GAME START ====================

function startLobbyGame(lobbyId) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || lobby.status !== 'waiting') return;

  lobby.status = 'starting';

  const players = lobby.players.map(p => ({
    id: p.id,
    username: p.username,
    socketId: p.socketId
  }));

  console.log(`[Lobby ${lobbyId}] Starting game with ${players.length} players`);

  // Create game
  const game = gameManager.createGame(players);

  // Notify all lobby players
  io.to(`lobby:${lobbyId}`).emit('lobby:game_starting', {
    gameId: game.id,
    players: players.map(p => ({ id: p.id, username: p.username }))
  });

  // Remove lobby
  lobbies.delete(lobbyId);
  io.emit('lobby:list', getLobbyList());

  // Start the first round after a brief delay
  setTimeout(() => {
    gameManager.startRound(game.id);
  }, 2000);
}

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  Chicago Card Game Server`);
  console.log(`  Running on port ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`========================================\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  matchmakingManager.destroy();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  matchmakingManager.destroy();
  server.close(() => {
    process.exit(0);
  });
});

module.exports = { app, server, io };
