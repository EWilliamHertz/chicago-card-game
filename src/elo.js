/**
 * ELO rating calculation for Chicago card game.
 */

/**
 * Calculate expected score using standard ELO formula.
 * @param {number} playerElo
 * @param {number} opponentElo
 * @returns {number} Expected score between 0 and 1
 */
function expectedScore(playerElo, opponentElo) {
  return 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
}

/**
 * Calculate ELO change for a single matchup.
 * @param {number} playerElo - Player's current ELO
 * @param {number} opponentElo - Opponent's current ELO
 * @param {number} actualScore - 1 for win, 0.5 for draw, 0 for loss
 * @param {number} kFactor - K-factor (32 for new players, 16 for experienced)
 * @returns {number} ELO change (can be negative)
 */
function calculateEloChange(playerElo, opponentElo, actualScore, kFactor = 32) {
  const expected = expectedScore(playerElo, opponentElo);
  return Math.round(kFactor * (actualScore - expected));
}

/**
 * Calculate ELO changes for a multiplayer game.
 * Each player is compared against every other player.
 * Position 1 = winner (beat everyone), higher positions = worse finish.
 *
 * @param {Array<{id: number, elo: number, gamesPlayed: number, position: number}>} players
 * @returns {Array<{id: number, eloChange: number, newElo: number}>}
 */
function updateMultiplayerElo(players) {
  const results = players.map(player => ({
    id: player.id,
    eloChange: 0,
    newElo: player.elo
  }));

  // Compare each pair of players
  for (let i = 0; i < players.length; i++) {
    const playerA = players[i];
    const kA = playerA.gamesPlayed < 30 ? 32 : 16;

    for (let j = i + 1; j < players.length; j++) {
      const playerB = players[j];
      const kB = playerB.gamesPlayed < 30 ? 32 : 16;

      // Determine outcome based on positions (lower position = better)
      let scoreA, scoreB;
      if (playerA.position < playerB.position) {
        scoreA = 1;   // A won against B
        scoreB = 0;   // B lost against A
      } else if (playerA.position > playerB.position) {
        scoreA = 0;
        scoreB = 1;
      } else {
        scoreA = 0.5; // Draw (same position — shouldn't happen normally)
        scoreB = 0.5;
      }

      const changeA = calculateEloChange(playerA.elo, playerB.elo, scoreA, kA);
      const changeB = calculateEloChange(playerB.elo, playerA.elo, scoreB, kB);

      results[i].eloChange += changeA;
      results[j].eloChange += changeB;
    }
  }

  // Apply cumulative changes
  for (let i = 0; i < results.length; i++) {
    results[i].newElo = Math.max(100, players[i].elo + results[i].eloChange);
  }

  return results;
}

module.exports = { calculateEloChange, updateMultiplayerElo, expectedScore };
