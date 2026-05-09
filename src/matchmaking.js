/**
 * MatchmakingManager — handles ranked matchmaking queue.
 * Matches players by ELO rating with expanding range over time.
 */

class MatchmakingManager {
  constructor(io, gameManager) {
    this.queue = [];
    this.io = io;
    this.gameManager = gameManager;

    // Periodically check for matches
    this.matchInterval = setInterval(() => this.checkForMatch(), 5000);
  }

  /**
   * Add a player to the matchmaking queue.
   * @param {{userId: number, username: string, elo: number, socketId: string}} player
   * @returns {boolean} success
   */
  addToQueue(player) {
    // Check if already in queue
    if (this.queue.some(p => p.userId === player.userId)) {
      return false;
    }

    // Check if already in a game
    const existingGame = this.gameManager.findGameByPlayerId(player.userId);
    if (existingGame) {
      return false;
    }

    this.queue.push({
      userId: player.userId,
      username: player.username,
      elo: player.elo,
      socketId: player.socketId,
      queuedAt: Date.now()
    });

    console.log(`[Matchmaking] ${player.username} (ELO: ${player.elo}) joined queue. Queue size: ${this.queue.length}`);

    // Notify player
    const socket = this.io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.emit('matchmaking:queued', {
        position: this.queue.length,
        estimatedWait: this.estimateWait()
      });
    }

    // Immediately try to match
    this.checkForMatch();
    return true;
  }

  /**
   * Remove a player from the matchmaking queue.
   * @param {number} userId
   */
  removeFromQueue(userId) {
    const index = this.queue.findIndex(p => p.userId === userId);
    if (index !== -1) {
      const removed = this.queue.splice(index, 1)[0];
      console.log(`[Matchmaking] ${removed.username} left queue. Queue size: ${this.queue.length}`);
      return true;
    }
    return false;
  }

  /**
   * Remove by socket ID (for disconnects).
   */
  removeBySocketId(socketId) {
    const index = this.queue.findIndex(p => p.socketId === socketId);
    if (index !== -1) {
      const removed = this.queue.splice(index, 1)[0];
      console.log(`[Matchmaking] ${removed.username} removed from queue (disconnect). Queue size: ${this.queue.length}`);
      return true;
    }
    return false;
  }

  /**
   * Try to find a match among queued players.
   * - Start with ±100 ELO range
   * - After 15s: expand to ±200
   * - After 30s: expand to ±400
   * - After 60s: match with anyone
   * - Prefer 4 players, fall back to 3 then 2
   */
  checkForMatch() {
    if (this.queue.length < 2) return;

    const now = Date.now();

    // Sort queue by time in queue (oldest first)
    this.queue.sort((a, b) => a.queuedAt - b.queuedAt);

    // Try to form groups starting from the oldest player
    for (let i = 0; i < this.queue.length; i++) {
      const anchor = this.queue[i];
      const waitTime = now - anchor.queuedAt;

      // Determine ELO range based on wait time
      let eloRange;
      if (waitTime < 15000) {
        eloRange = 100;
      } else if (waitTime < 30000) {
        eloRange = 200;
      } else if (waitTime < 60000) {
        eloRange = 400;
      } else {
        eloRange = Infinity;
      }

      // Find compatible players
      const compatible = this.queue.filter(p => {
        if (p.userId === anchor.userId) return false;
        const diff = Math.abs(p.elo - anchor.elo);
        return diff <= eloRange;
      });

      // Need at least 1 more player (2 total minimum)
      if (compatible.length < 1) continue;

      // Determine group size: prefer 4, then 3, then 2
      let matchGroup;

      if (compatible.length >= 3 && this.queue.length >= 4) {
        // Try for 4 players
        // Pick the 3 closest by ELO
        const sorted = compatible.sort((a, b) =>
          Math.abs(a.elo - anchor.elo) - Math.abs(b.elo - anchor.elo)
        );
        matchGroup = [anchor, sorted[0], sorted[1], sorted[2]];
      } else if (compatible.length >= 2 && this.queue.length >= 3) {
        // Try for 3 players
        const sorted = compatible.sort((a, b) =>
          Math.abs(a.elo - anchor.elo) - Math.abs(b.elo - anchor.elo)
        );
        matchGroup = [anchor, sorted[0], sorted[1]];
      } else if (waitTime >= 30000 || this.queue.length === 2) {
        // Fall back to 2 players (only after 30s wait or if only 2 in queue)
        matchGroup = [anchor, compatible[0]];
      } else {
        continue;
      }

      // Found a match!
      this.createMatch(matchGroup);
      return;
    }
  }

  /**
   * Create a match from the selected players.
   */
  createMatch(matchPlayers) {
    // Remove matched players from queue
    for (const mp of matchPlayers) {
      const idx = this.queue.findIndex(p => p.userId === mp.userId);
      if (idx !== -1) this.queue.splice(idx, 1);
    }

    const players = matchPlayers.map(mp => ({
      id: mp.userId,
      username: mp.username,
      socketId: mp.socketId
    }));

    console.log(`[Matchmaking] Match found! Players: ${players.map(p => p.username).join(', ')}`);

    // Create the game
    const game = this.gameManager.createGame(players);

    // Notify all matched players
    for (const mp of matchPlayers) {
      const socket = this.io.sockets.sockets.get(mp.socketId);
      if (socket) {
        socket.emit('matchmaking:found', {
          gameId: game.id,
          players: players.map(p => ({ id: p.id, username: p.username }))
        });
      }
    }

    // Start the game after a brief delay
    setTimeout(() => {
      this.gameManager.startRound(game.id);
    }, 2000);
  }

  /**
   * Estimate wait time based on queue size.
   */
  estimateWait() {
    if (this.queue.length >= 4) return 'Starting soon...';
    if (this.queue.length >= 2) return 'Waiting for more players...';
    return 'Searching for opponents...';
  }

  /**
   * Get current queue info.
   */
  getQueueInfo() {
    return {
      size: this.queue.length,
      players: this.queue.map(p => ({
        username: p.username,
        waitTime: Math.round((Date.now() - p.queuedAt) / 1000)
      }))
    };
  }

  /**
   * Clean up on server shutdown.
   */
  destroy() {
    if (this.matchInterval) {
      clearInterval(this.matchInterval);
    }
  }
}

module.exports = MatchmakingManager;
