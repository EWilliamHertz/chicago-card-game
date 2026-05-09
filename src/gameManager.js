/**
 * GameManager — manages all active Chicago card games in memory.
 * Handles real-time game state, trick play, scoring, and lifecycle.
 */

const crypto = require('crypto');
const gameLogic = require('./gameLogic');
const elo = require('./elo');
const { query } = require('./db');

class GameManager {
  constructor(io) {
    this.games = new Map();
    this.io = io;
    // Map socketId → { gameId, playerId } for quick lookup
    this.socketToGame = new Map();
    // Auto-play timers for disconnected players
    this.autoPlayTimers = new Map();
  }

  /**
   * Create a new game with the given players.
   * @param {Array<{id: number, username: string, socketId: string}>} players
   * @returns {object} game state
   */
  createGame(players) {
    const gameId = crypto.randomUUID();

    const game = {
      id: gameId,
      players: players.map((p, index) => ({
        id: p.id,
        username: p.username,
        socketId: p.socketId,
        hand: [],
        collectedCards: [],
        score: 0,
        chicagoDeclared: false,
        connected: true
      })),
      phase: 'waiting',
      round: 0,
      dealerIndex: 0,
      deck: [],
      discardPhase: 0,
      discardsDone: new Set(),
      pokerScoresDone: false,
      currentTrick: {
        cards: [],
        leadSuit: null,
        leadPlayerIndex: 0
      },
      currentPlayerIndex: 0,
      tricksPlayed: 0,
      totalTricks: 0,
      trickResults: [],
      winner: null,
      createdAt: new Date(),
      chicagoResponses: new Set(),
      fourOfAKindPending: null
    };

    this.games.set(gameId, game);

    // Join all player sockets to the game room
    for (const player of players) {
      const socket = this.io.sockets.sockets.get(player.socketId);
      if (socket) {
        socket.join(gameId);
      }
      this.socketToGame.set(player.socketId, { gameId, playerId: player.id });
    }

    console.log(`[Game ${gameId}] Created with ${players.length} players: ${players.map(p => p.username).join(', ')}`);
    return game;
  }

  /**
   * Start a new round of play.
   */
  startRound(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    game.round++;
    game.phase = 'dealing';
    game.trickResults = [];
    game.tricksPlayed = 0;
    game.totalTricks = 5;
    game.discardsDone = new Set();
    game.discardPhase = 0;
    game.pokerScoresDone = false;

    // Rotate dealer each round (after round 1)
    if (game.round > 1) {
      game.dealerIndex = (game.dealerIndex + 1) % game.players.length;
    }

    // Create deck and deal 5 cards to each player
    game.deck = gameLogic.createDeck();
    const hands = gameLogic.dealCards(game.deck, game.players.length);

    for (let i = 0; i < game.players.length; i++) {
      game.players[i].hand = hands[i];
      game.players[i].collectedCards = [];
      game.players[i].chicagoDeclared = false;
    }

    // Player after dealer leads first trick
    const firstPlayerIndex = (game.dealerIndex + 1) % game.players.length;
    game.currentPlayerIndex = firstPlayerIndex;
    game.currentTrick = { cards: [], leadSuit: null, leadPlayerIndex: firstPlayerIndex };

    console.log(`[Game ${gameId}] Round ${game.round} starting. Dealer: ${game.players[game.dealerIndex].username}`);

    // Go to discard phase 1
    game.phase = 'discard_1';
    this.emitGameState(gameId);

    // Auto-discard after 30 seconds for players who haven't responded
    setTimeout(() => {
      if (game.phase === 'discard_1') {
        for (const player of game.players) {
          if (!game.discardsDone.has(player.id)) {
            this.handleDiscard(gameId, player.id, []);
          }
        }
      }
    }, 30000);
  }

  /**
   * Handle a player's discard selection during discard_1 or discard_2.
   */
  handleDiscard(gameId, playerId, cardIndices) {
    const game = this.games.get(gameId);
    if (!game) return { error: 'Game not found' };
    if (game.phase !== 'discard_1' && game.phase !== 'discard_2') return { error: 'Not in discard phase' };
    if (game.discardsDone.has(playerId)) return { error: 'Already discarded' };

    const player = game.players.find(p => p.id === playerId);
    if (!player) return { error: 'Player not found' };

    // Remove discarded cards (sort descending to avoid index shift issues)
    const sortedIndices = [...new Set(cardIndices)]
      .filter(i => i >= 0 && i < player.hand.length)
      .sort((a, b) => b - a);
    for (const idx of sortedIndices) {
      player.hand.splice(idx, 1);
    }

    // Deal replacement cards back up to 5
    const needed = 5 - player.hand.length;
    const replacements = gameLogic.dealReplacementCards(game.deck, needed);
    player.hand.push(...replacements);

    game.discardsDone.add(playerId);

    this.io.to(gameId).emit('game:player_discarded', {
      playerId,
      username: player.username,
      discardCount: sortedIndices.length
    });

    // Notify the player of their new hand
    const socket = this.io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.emit('game:hand_updated', { hand: player.hand });
    }

    // Check if all players have discarded
    if (game.discardsDone.size >= game.players.length) {
      if (game.phase === 'discard_1') {
        this.completeDiscard1(gameId);
      } else {
        this.completeDiscard2(gameId);
      }
    }

    return { success: true };
  }

  /**
   * Complete discard phase 1 — evaluate poker hands.
   * In Chicago, ONLY the player with the best hand scores.
   * If two players tie exactly, no one scores.
   * Cards are NOT revealed to opponents — only the winner's hand is shown.
   */
  completeDiscard1(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    game.phase = 'poker_scoring';
    game.discardsDone = new Set();

    // Evaluate all hands privately
    const evaluations = game.players.map(player => ({
      player,
      result: gameLogic.evaluatePokerHand(player.hand)
    }));

    // 1. Check for instant wins (Royal Flush / Straight Flush)
    const instantWinner = evaluations.find(e => e.result && gameLogic.isInstantWin(e.result.rank));
    if (instantWinner) {
      const { player, result } = instantWinner;
      console.log(`[Game ${gameId}] INSTANT WIN: ${player.username} with ${result.name}!`);
      this.io.to(gameId).emit('game:instant_win', {
        playerId: player.id,
        username: player.username,
        hand: result.name
      });
      this.endGame(gameId, player.id, result.name);
      return;
    }

    // 2. Check for Four of a Kind (prompt player for choice)
    const fourOfAKindEval = evaluations.find(e => e.result && gameLogic.isFourOfAKind(e.result.rank));
    if (fourOfAKindEval) {
      const { player } = fourOfAKindEval;
      game.fourOfAKindPending = { playerId: player.id };
      game.phase = 'four_of_a_kind_choice';

      this.io.to(gameId).emit('game:four_of_a_kind', {
        playerId: player.id,
        username: player.username,
        message: `${player.username} has Four of a Kind!`
      });

      const socket = this.io.sockets.sockets.get(player.socketId);
      if (socket) {
        socket.emit('game:four_of_a_kind_prompt', {
          gameId,
          options: ['points', 'remove'],
          message: "You have Four of a Kind! Take 8 points or remove all opponents' points?",
          timeLimit: 15000
        });
      }

      setTimeout(() => {
        if (game.phase === 'four_of_a_kind_choice' && game.fourOfAKindPending) {
          this.handleFourOfAKindChoice(gameId, player.id, 'points');
        }
      }, 15000);
      return;
    }

    // 3. Find the single best hand — only that player scores.
    //    High Card (rank 0) does NOT qualify for points.
    const validEvals = evaluations.filter(e => e.result && e.result.rank >= 1);

    // Build result list — cards are hidden (only hand name + points shown)
    const pokerResults = game.players.map(p => {
      const ev = evaluations.find(e => e.player.id === p.id);
      return {
        playerId: p.id,
        username: p.username,
        pokerHand: ev && ev.result
          ? { rank: ev.result.rank, name: ev.result.rank >= 1 ? ev.result.name : 'High Card' }
          : { rank: 0, name: 'High Card' },
        points: 0
      };
    });

    if (validEvals.length > 0) {
      // Sort descending by hand quality
      validEvals.sort((a, b) => gameLogic.compareHands(b.result, a.result));

      const best = validEvals[0];
      const second = validEvals[1];

      // Check for exact tie
      const isTied = second && gameLogic.compareHands(best.result, second.result) === 0;

      if (!isTied) {
        const points = gameLogic.getHandPoints(best.result.rank);
        best.player.score += points;
        const entry = pokerResults.find(r => r.playerId === best.player.id);
        if (entry) {
          entry.points = points;
        }
        console.log(`[Game ${gameId}] Poker scoring: ${best.player.username} wins with ${best.result.name} (+${points} pts)`);
      } else {
        console.log(`[Game ${gameId}] Poker scoring: Tie between top hands — no one scores`);
      }
    }

    this.io.to(gameId).emit('game:poker_scoring', {
      results: pokerResults,
      scores: game.players.map(p => ({ playerId: p.id, username: p.username, score: p.score }))
    });

    // Proceed to discard phase 2
    setTimeout(() => this.startDiscard2(gameId), 3000);
  }

  /**
   * Start discard phase 2.
   */
  startDiscard2(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    game.phase = 'discard_2';
    game.discardsDone = new Set();
    this.emitGameState(gameId);

    // Auto-discard after 30 seconds
    setTimeout(() => {
      if (game.phase === 'discard_2') {
        for (const player of game.players) {
          if (!game.discardsDone.has(player.id)) {
            this.handleDiscard(gameId, player.id, []);
          }
        }
      }
    }, 30000);
  }

  /**
   * Complete discard phase 2 — check for Chicago declarations then start playing.
   */
  completeDiscard2(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    // Snapshot hands before tricks begin — used for final poker scoring in endGame
    for (const p of game.players) {
      p.savedHand = [...p.hand];
    }

    // Check for Chicago-eligible players
    const eligible = game.players.filter(p => p.score >= 15);

    if (eligible.length > 0) {
      game.phase = 'chicago_declaration';
      game.chicagoResponses = new Set();

      for (const player of eligible) {
        const socket = this.io.sockets.sockets.get(player.socketId);
        if (socket) {
          socket.emit('game:chicago_prompt', {
            gameId,
            message: 'You have 15+ points. Declare Chicago? (Win all tricks → +15, lose any → -15)',
            timeLimit: 15000
          });
        }
      }

      setTimeout(() => {
        if (game.phase === 'chicago_declaration') {
          for (const player of eligible) {
            if (!game.chicagoResponses.has(player.id)) {
              this.handleChicagoDeclaration(gameId, player.id, false);
            }
          }
        }
      }, 15000);

      this.emitGameState(gameId);
    } else {
      game.phase = 'playing';
      this.emitGameState(gameId);
      this.scheduleAutoPlay(gameId);
    }
  }

  /**
   * Handle a player's Chicago declaration.
   */
  handleChicagoDeclaration(gameId, playerId, declares) {
    const game = this.games.get(gameId);
    if (!game || game.phase !== 'chicago_declaration') return;

    const player = game.players.find(p => p.id === playerId);
    if (!player) return;

    if (declares) {
      player.chicagoDeclared = true;
      console.log(`[Game ${gameId}] ${player.username} declared Chicago!`);
      this.io.to(gameId).emit('game:chicago_declared', {
        playerId: player.id,
        username: player.username
      });
    }

    game.chicagoResponses.add(playerId);

    // Check if all eligible players have responded
    const eligible = game.players.filter(p => p.score >= 15);
    const allResponded = eligible.every(p => game.chicagoResponses.has(p.id));

    if (allResponded) {
      game.phase = 'playing';
      this.emitGameState(gameId);
      this.scheduleAutoPlay(gameId);
    }
  }

  /**
   * Play a card from a player's hand.
   */
  playCard(gameId, playerId, cardIndex) {
    const game = this.games.get(gameId);
    if (!game) return { error: 'Game not found' };
    if (game.phase !== 'playing') return { error: 'Not in playing phase' };

    const playerIndex = game.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return { error: 'Player not in this game' };
    if (playerIndex !== game.currentPlayerIndex) return { error: 'Not your turn' };

    const player = game.players[playerIndex];
    if (cardIndex < 0 || cardIndex >= player.hand.length) return { error: 'Invalid card index' };

    const card = player.hand[cardIndex];

    // Validate: must follow lead suit if possible
    if (game.currentTrick.cards.length > 0 && game.currentTrick.leadSuit) {
      const hasLeadSuit = player.hand.some(c => c.suit === game.currentTrick.leadSuit);
      if (hasLeadSuit && card.suit !== game.currentTrick.leadSuit) {
        return { error: 'Must follow lead suit' };
      }
    }

    // Remove card from hand
    player.hand.splice(cardIndex, 1);

    // Set lead suit if first card of trick
    if (game.currentTrick.cards.length === 0) {
      game.currentTrick.leadSuit = card.suit;
      game.currentTrick.leadPlayerIndex = playerIndex;
    }

    // Add to trick
    game.currentTrick.cards.push({ playerId: player.id, card });

    // Clear any auto-play timer for this player
    const timerKey = `${gameId}_${playerId}`;
    if (this.autoPlayTimers.has(timerKey)) {
      clearTimeout(this.autoPlayTimers.get(timerKey));
      this.autoPlayTimers.delete(timerKey);
    }

    // Emit card played event
    this.io.to(gameId).emit('game:card_played', {
      playerId: player.id,
      username: player.username,
      card,
      trickCards: game.currentTrick.cards,
      cardsRemaining: player.hand.length
    });

    // Check if trick is complete
    if (game.currentTrick.cards.length === game.players.length) {
      this.completeTrick(gameId);
    } else {
      // Advance to next player
      game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
      this.emitGameState(gameId);
      this.scheduleAutoPlay(gameId);
    }

    return { success: true };
  }

  /**
   * Complete a trick: determine winner, collect cards, check for round end.
   */
  completeTrick(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    const winnerId = gameLogic.determineTrickWinner(
      game.currentTrick.cards,
      game.currentTrick.leadSuit
    );

    const winnerIndex = game.players.findIndex(p => p.id === winnerId);
    const winner = game.players[winnerIndex];

    // Collect cards (placed face-up in front of player, not a center pile)
    const trickCards = game.currentTrick.cards.map(tc => tc.card);
    winner.collectedCards.push(...trickCards);

    game.tricksPlayed++;

    const trickResult = {
      trickNumber: game.tricksPlayed,
      winnerId: winner.id,
      winnerName: winner.username,
      cards: game.currentTrick.cards,
      leadSuit: game.currentTrick.leadSuit
    };
    game.trickResults.push(trickResult);

    game.phase = 'trick_result';

    // Emit trick result
    this.io.to(gameId).emit('game:trick_result', trickResult);

    console.log(`[Game ${gameId}] Trick ${game.tricksPlayed}/${game.totalTricks} won by ${winner.username}`);

    // Check if all tricks are done
    if (game.tricksPlayed >= game.totalTricks) {
      // Short delay before scoring
      setTimeout(() => this.endRound(gameId), 2000);
    } else {
      // Start new trick with winner leading
      setTimeout(() => {
        game.currentPlayerIndex = winnerIndex;
        game.currentTrick = { cards: [], leadSuit: null, leadPlayerIndex: winnerIndex };
        game.phase = 'playing';
        this.emitGameState(gameId);
        this.scheduleAutoPlay(gameId);
      }, 1500);
    }
  }

  /**
   * End a round: award 5 pts to last trick winner, resolve Chicago, check win condition.
   * Poker scoring already happened after discard_1.
   * Only the LAST trick awards 5 points (not every trick).
   */
  endRound(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    game.phase = 'round_scoring';

    // Award 5 pts to the winner of the last (5th) trick
    const lastTrick = game.trickResults[game.trickResults.length - 1];
    let lastTrickWinnerId = null;
    let lastTrickBonus2 = false;
    if (lastTrick) {
      lastTrickWinnerId = lastTrick.winnerId;
      const lastTrickWinner = game.players.find(p => p.id === lastTrick.winnerId);
      if (lastTrickWinner) {
        // Chicago players get their Chicago resolution instead — skip +5 for them
        if (!lastTrickWinner.chicagoDeclared) {
          lastTrickWinner.score += 5;
          console.log(`[Game ${gameId}] Last trick won by ${lastTrickWinner.username} (+5 pts)`);

          // Bonus +5 if winning card was a "2"
          const winnerCard = lastTrick.cards && lastTrick.cards.find(tc => tc.playerId === lastTrick.winnerId);
          if (winnerCard && winnerCard.card && winnerCard.card.rank === '2') {
            lastTrickWinner.score += 5;
            lastTrickBonus2 = true;
            console.log(`[Game ${gameId}] ${lastTrickWinner.username} won last trick with a 2! Bonus +5 pts`);
          }
        }
      }
    }

    const roundResults = [];
    for (const player of game.players) {
      const trickCount = game.trickResults.filter(t => t.winnerId === player.id).length;
      const result = {
        playerId: player.id,
        username: player.username,
        trickCount,
        chicagoDeclared: player.chicagoDeclared,
        chicagoSuccess: false,
        lastTrickWon: player.id === lastTrickWinnerId,
        points: player.id === lastTrickWinnerId && !player.chicagoDeclared ? 5 : 0,
        totalScore: player.score
      };

      if (player.chicagoDeclared) {
        const wonAllTricks = trickCount === game.totalTricks;
        result.chicagoSuccess = wonAllTricks;
        if (wonAllTricks) {
          result.points = 15;
          player.score += 15;
          console.log(`[Game ${gameId}] ${player.username} Chicago SUCCESS! +15 points`);
        } else {
          result.points = -15;
          player.score -= 15;
          if (player.score < 0) player.score = 0;
          console.log(`[Game ${gameId}] ${player.username} Chicago FAILED! -15 points`);
        }
        result.totalScore = player.score;
      }

      roundResults.push(result);
    }

    console.log(`[Game ${gameId}] Round ${game.round} scores: ${game.players.map(p => `${p.username}=${p.score}`).join(', ')}`);

    this.io.to(gameId).emit('game:round_end', {
      round: game.round,
      results: roundResults,
      lastTrickBonus2,
      scores: game.players.map(p => ({
        playerId: p.id,
        username: p.username,
        score: p.score
      }))
    });

    // Win condition: player who won the LAST trick AND has >= 52 points wins the game
    const WIN_THRESHOLD = 52;
    if (lastTrickWinnerId) {
      const lastTrickWinner = game.players.find(p => p.id === lastTrickWinnerId);
      if (lastTrickWinner && lastTrickWinner.score >= WIN_THRESHOLD) {
        console.log(`[Game ${gameId}] ${lastTrickWinner.username} wins the game with ${lastTrickWinner.score} points!`);
        setTimeout(() => this.endGame(gameId, lastTrickWinner.id, `Won last trick with ${lastTrickWinner.score} points`), 2000);
        return;
      }
    }

    // Start next round after 5 seconds
    setTimeout(() => {
      if (this.games.has(gameId) && game.phase !== 'finished') {
        this.startRound(gameId);
      }
    }, 5000);
  }

  /**
   * Handle the four of a kind player's choice.
   */
  handleFourOfAKindChoice(gameId, playerId, choice) {
    const game = this.games.get(gameId);
    if (!game || game.phase !== 'four_of_a_kind_choice') return;
    if (!game.fourOfAKindPending || game.fourOfAKindPending.playerId !== playerId) return;

    const player = game.players.find(p => p.id === playerId);

    if (choice === 'remove') {
      for (const p of game.players) {
        if (p.id !== playerId) {
          console.log(`[Game ${gameId}] ${p.username}'s score reset from ${p.score} to 0 (Four of a Kind remove)`);
          p.score = 0;
        }
      }
      this.io.to(gameId).emit('game:four_of_a_kind_result', {
        playerId,
        username: player.username,
        choice: 'remove',
        message: `${player.username} removed all opponents' points!`
      });
    } else {
      player.score += 8;
      this.io.to(gameId).emit('game:four_of_a_kind_result', {
        playerId,
        username: player.username,
        choice: 'points',
        message: `${player.username} took 8 points!`
      });
    }

    game.fourOfAKindPending = null;
    setTimeout(() => this.startDiscard2(gameId), 2000);
  }

  /**
   * Apply round scoring after all special cases are resolved.
   * @param {string} gameId
   * @param {Array} roundResults
   * @param {number|null} fourOfAKindRemovePlayerId - If set, this player used "remove"
   */
  applyRoundScoring(gameId, roundResults, fourOfAKindRemovePlayerId = null) {
    const game = this.games.get(gameId);
    if (!game) return;

    for (const result of roundResults) {
      const player = game.players.find(p => p.id === result.playerId);
      if (!player) continue;

      // Chicago scoring
      if (player.chicagoDeclared) {
        const wonAllTricks = result.trickCount === game.totalTricks;
        result.chicagoSuccess = wonAllTricks;
        if (wonAllTricks) {
          result.points = 15;
          player.score += 15;
          console.log(`[Game ${gameId}] ${player.username} Chicago SUCCESS! +15 points`);
        } else {
          result.points = -15;
          player.score -= 15;
          console.log(`[Game ${gameId}] ${player.username} Chicago FAILED! -15 points`);
        }
      } else {
        // Normal scoring based on poker hand
        const handRank = result.pokerHand.rank;
        // If the four-of-a-kind player chose "remove", others get 0 from four-of-a-kind
        // but they still get points from their own hand (the remove only zeroes score)
        if (fourOfAKindRemovePlayerId && result.playerId === fourOfAKindRemovePlayerId) {
          // The four-of-a-kind player who chose remove gets 0 points for this hand
          result.points = 0;
        } else {
          const points = gameLogic.getHandPoints(handRank);
          result.points = points;
          player.score += points;
        }
      }

      result.totalScore = player.score;
    }

    // Emit round end
    this.io.to(gameId).emit('game:round_end', {
      round: game.round,
      results: roundResults,
      lastTrickBonus2: false,
      scores: game.players.map(p => ({
        playerId: p.id,
        username: p.username,
        score: p.score
      }))
    });

    console.log(`[Game ${gameId}] Round ${game.round} scores: ${game.players.map(p => `${p.username}=${p.score}`).join(', ')}`);

    // Check for game-ending condition: no automatic point threshold win —
    // game continues until instant win or players decide. For now, let's end after 52 points
    // or use a round limit. Standard Chicago: play continues indefinitely.
    // We'll use 52 points as the win threshold.
    const WIN_THRESHOLD = 52;
    const potentialWinner = game.players.find(p => p.score >= WIN_THRESHOLD);

    if (potentialWinner) {
      this.endGame(gameId, potentialWinner.id, `Reached ${WIN_THRESHOLD} points`);
      return;
    }

    // Continue to next round after a delay
    setTimeout(() => {
      if (game.phase !== 'finished') {
        this.startRound(gameId);
      }
    }, 3000);
  }

  /**
   * End the game: determine final standings, update DB.
   */
  async endGame(gameId, winnerId, condition) {
    const game = this.games.get(gameId);
    if (!game || game.phase === 'finished') return;

    game.phase = 'finished';
    const winner = game.players.find(p => p.id === winnerId);
    game.winner = {
      id: winnerId,
      username: winner ? winner.username : 'Unknown',
      condition
    };

    console.log(`[Game ${gameId}] Game over! Winner: ${game.winner.username} (${condition})`);

    // Evaluate final poker hands — best hand at game end also scores
    // Use savedHand (snapshot before tricks) because p.hand is empty after all cards are played
    const finalEvals = game.players.map(p => ({
      player: p,
      result: gameLogic.evaluatePokerHand(p.savedHand && p.savedHand.length > 0 ? p.savedHand : p.hand)
    }));
    const validFinal = finalEvals.filter(e => e.result && e.result.rank >= 1);
    let finalPokerResults = null;
    if (validFinal.length > 0) {
      validFinal.sort((a, b) => gameLogic.compareHands(b.result, a.result));
      const best = validFinal[0];
      const second = validFinal[1];
      const isTie = second && gameLogic.compareHands(best.result, second.result) === 0;
      if (!isTie) {
        best.player.score += best.result.rank;
        console.log(`[Game ${gameId}] Final poker: ${best.player.username} scores ${best.result.rank} pts for ${best.result.name}`);
      }
      finalPokerResults = game.players.map(p => {
        const ev = finalEvals.find(e => e.player.id === p.id);
        const isBestHand = !isTie && ev && best.player.id === p.id;
        return {
          playerId: p.id,
          username: p.username,
          handName: ev && ev.result && ev.result.rank >= 1 ? ev.result.name : 'High Card',
          points: isBestHand ? best.result.rank : 0
        };
      });
    }

    // Re-read winner score after poker bonus
    if (winner) game.winner.finalScore = winner.score;

    // Calculate ELO changes
    // Sort players by score descending to assign positions
    const sortedPlayers = [...game.players].sort((a, b) => b.score - a.score);
    // Winner always gets position 1
    const eloInput = sortedPlayers.map((p, idx) => ({
      id: p.id,
      elo: 1200, // Will be fetched
      gamesPlayed: 0,
      position: p.id === winnerId ? 1 : idx + (sortedPlayers[0].id === winnerId ? 1 : 2)
    }));

    // Fetch current ELO and games_played from DB
    try {
      for (const ep of eloInput) {
        const result = await query('SELECT elo, games_played FROM users WHERE id = $1', [ep.id]);
        if (result.rows.length > 0) {
          ep.elo = result.rows[0].elo;
          ep.gamesPlayed = result.rows[0].games_played;
        }
      }

      // Ensure winner is position 1 and others are ordered
      let pos = 2;
      for (const ep of eloInput) {
        if (ep.id === winnerId) {
          ep.position = 1;
        } else {
          ep.position = pos++;
        }
      }

      const eloChanges = elo.updateMultiplayerElo(eloInput);

      // Insert game record
      const gameRecord = await query(
        `INSERT INTO games (status, winner_id, win_condition, rounds_played, created_at, finished_at)
         VALUES ('finished', $1, $2, $3, $4, NOW()) RETURNING id`,
        [winnerId, condition, game.round, game.createdAt]
      );
      const dbGameId = gameRecord.rows[0].id;

      // Insert game_players and update user stats
      for (const player of game.players) {
        const eloData = eloChanges.find(e => e.id === player.id);
        const eloPlayerInput = eloInput.find(e => e.id === player.id);
        const eloBefore = eloPlayerInput ? eloPlayerInput.elo : 1200;
        const eloAfter = eloData ? eloData.newElo : eloBefore;
        const eloChange = eloData ? eloData.eloChange : 0;

        await query(
          `INSERT INTO game_players (game_id, user_id, final_score, elo_before, elo_after, elo_change)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [dbGameId, player.id, player.score, eloBefore, eloAfter, eloChange]
        );

        const isWinner = player.id === winnerId;
        await query(
          `UPDATE users SET
            elo = $1,
            games_played = games_played + 1,
            wins = wins + $2,
            losses = losses + $3
           WHERE id = $4`,
          [eloAfter, isWinner ? 1 : 0, isWinner ? 0 : 1, player.id]
        );
      }

      // Emit game finished with ELO changes + final poker results
      this.io.to(gameId).emit('game:finished', {
        winner: game.winner,
        finalScores: game.players.map(p => ({
          playerId: p.id,
          username: p.username,
          score: p.score
        })),
        finalPokerResults,
        eloChanges: eloChanges.map(e => {
          const player = game.players.find(p => p.id === e.id);
          return {
            playerId: e.id,
            username: player ? player.username : 'Unknown',
            eloChange: e.eloChange,
            newElo: e.newElo
          };
        })
      });

    } catch (err) {
      console.error(`[Game ${gameId}] Error saving game results:`, err.message);
      // Still emit finish event even if DB fails
      this.io.to(gameId).emit('game:finished', {
        winner: game.winner,
        finalScores: game.players.map(p => ({
          playerId: p.id,
          username: p.username,
          score: p.score
        })),
        finalPokerResults,
        eloChanges: []
      });
    }

    // Clean up after delay
    setTimeout(() => {
      this.cleanupGame(gameId);
    }, 30000);
  }

  /**
   * Get game state from a player's perspective (hide other players' cards).
   */
  getPlayerView(gameId, playerId) {
    const game = this.games.get(gameId);
    if (!game) return null;

    const playerIndex = game.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) return null;

    return {
      id: game.id,
      phase: game.phase,
      round: game.round,
      dealerIndex: game.dealerIndex,
      discardPhase: game.discardPhase,
      players: game.players.map((p, idx) => ({
        id: p.id,
        username: p.username,
        score: p.score,
        cardCount: p.hand.length,
        collectedCount: p.collectedCards ? p.collectedCards.length : 0,
        chicagoDeclared: p.chicagoDeclared,
        connected: p.connected,
        // Only show the requesting player's hand
        hand: idx === playerIndex ? p.hand : undefined,
        isCurrentPlayer: idx === game.currentPlayerIndex
      })),
      currentPlayerIndex: game.currentPlayerIndex,
      currentPlayerId: game.players[game.currentPlayerIndex] ? game.players[game.currentPlayerIndex].id : null,
      currentTrick: {
        cards: game.currentTrick.cards,
        leadSuit: game.currentTrick.leadSuit
      },
      tricksPlayed: game.tricksPlayed,
      totalTricks: game.totalTricks,
      winner: game.winner,
      myIndex: playerIndex,
      // Top-level hand so frontend can always find it regardless of myIndex extraction order
      hand: game.players[playerIndex].hand
    };
  }

  /**
   * Handle player disconnect.
   */
  handleDisconnect(socketId) {
    const mapping = this.socketToGame.get(socketId);
    if (!mapping) return;

    const { gameId, playerId } = mapping;
    const game = this.games.get(gameId);
    if (!game) {
      this.socketToGame.delete(socketId);
      return;
    }

    const player = game.players.find(p => p.id === playerId);
    if (player) {
      player.connected = false;
      console.log(`[Game ${gameId}] ${player.username} disconnected`);

      this.io.to(gameId).emit('game:player_disconnected', {
        playerId: player.id,
        username: player.username
      });
    }

    // Check if all players disconnected
    const allDisconnected = game.players.every(p => !p.connected);
    if (allDisconnected && game.phase !== 'finished') {
      console.log(`[Game ${gameId}] All players disconnected. Cleaning up.`);
      this.cleanupGame(gameId);
      return;
    }

    // If it's the disconnected player's turn, schedule auto-play
    if (game.phase === 'playing' && player &&
        game.players[game.currentPlayerIndex] &&
        game.players[game.currentPlayerIndex].id === playerId) {
      this.scheduleAutoPlay(gameId);
    }

    this.socketToGame.delete(socketId);
  }

  /**
   * Schedule auto-play for disconnected player (30 second timeout).
   */
  scheduleAutoPlay(gameId) {
    const game = this.games.get(gameId);
    if (!game || game.phase !== 'playing') return;

    const currentPlayer = game.players[game.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.connected) return;

    const timerKey = `${gameId}_${currentPlayer.id}`;

    // Clear existing timer
    if (this.autoPlayTimers.has(timerKey)) {
      clearTimeout(this.autoPlayTimers.get(timerKey));
    }

    const timer = setTimeout(() => {
      this.autoPlayTimers.delete(timerKey);
      const g = this.games.get(gameId);
      if (!g || g.phase !== 'playing') return;

      const cp = g.players[g.currentPlayerIndex];
      if (!cp || cp.connected || cp.hand.length === 0) return;

      // Play the lowest valid card
      let cardIndex = 0;
      if (g.currentTrick.leadSuit) {
        const leadSuitCards = cp.hand
          .map((c, i) => ({ card: c, index: i }))
          .filter(ci => ci.card.suit === g.currentTrick.leadSuit);
        if (leadSuitCards.length > 0) {
          leadSuitCards.sort((a, b) => a.card.value - b.card.value);
          cardIndex = leadSuitCards[0].index;
        } else {
          // No lead suit, play lowest card
          const sorted = cp.hand.map((c, i) => ({ card: c, index: i }))
            .sort((a, b) => a.card.value - b.card.value);
          cardIndex = sorted[0].index;
        }
      }

      console.log(`[Game ${gameId}] Auto-playing for disconnected ${cp.username}`);
      this.playCard(gameId, cp.id, cardIndex);
    }, 30000);

    this.autoPlayTimers.set(timerKey, timer);
  }

  /**
   * Reconnect a player to their active game.
   */
  reconnectPlayer(gameId, playerId, newSocketId) {
    const game = this.games.get(gameId);
    if (!game) return null;

    const player = game.players.find(p => p.id === playerId);
    if (!player) return null;

    // Remove old mapping
    for (const [sid, mapping] of this.socketToGame.entries()) {
      if (mapping.gameId === gameId && mapping.playerId === playerId) {
        this.socketToGame.delete(sid);
      }
    }

    // Update socket
    player.socketId = newSocketId;
    player.connected = true;
    this.socketToGame.set(newSocketId, { gameId, playerId });

    // Join room
    const socket = this.io.sockets.sockets.get(newSocketId);
    if (socket) {
      socket.join(gameId);
    }

    console.log(`[Game ${gameId}] ${player.username} reconnected`);

    this.io.to(gameId).emit('game:player_reconnected', {
      playerId: player.id,
      username: player.username
    });

    // Clear any auto-play timer
    const timerKey = `${gameId}_${playerId}`;
    if (this.autoPlayTimers.has(timerKey)) {
      clearTimeout(this.autoPlayTimers.get(timerKey));
      this.autoPlayTimers.delete(timerKey);
    }

    return this.getPlayerView(gameId, playerId);
  }

  /**
   * Emit game state to all players (each gets their own view + private hand event).
   */
  emitGameState(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    for (const player of game.players) {
      const socket = this.io.sockets.sockets.get(player.socketId);
      if (socket) {
        socket.emit('game:state', this.getPlayerView(gameId, player.id));
        // Also send hand privately so discard phase can access it
        socket.emit('game:your_hand', { hand: player.hand });
      }
    }
  }

  /**
   * Clean up a game from memory.
   */
  cleanupGame(gameId) {
    const game = this.games.get(gameId);
    if (!game) return;

    // Remove socket mappings
    for (const player of game.players) {
      for (const [sid, mapping] of this.socketToGame.entries()) {
        if (mapping.gameId === gameId) {
          this.socketToGame.delete(sid);
        }
      }
    }

    // Clear auto-play timers
    for (const [key, timer] of this.autoPlayTimers.entries()) {
      if (key.startsWith(gameId)) {
        clearTimeout(timer);
        this.autoPlayTimers.delete(key);
      }
    }

    this.games.delete(gameId);
    console.log(`[Game ${gameId}] Cleaned up`);
  }

  /**
   * Find active game for a player.
   */
  findGameByPlayerId(playerId) {
    for (const [gameId, game] of this.games.entries()) {
      if (game.phase !== 'finished' && game.players.some(p => p.id === playerId)) {
        return gameId;
      }
    }
    return null;
  }

  /**
   * Get game by ID.
   */
  getGame(gameId) {
    return this.games.get(gameId);
  }
}

module.exports = GameManager;
