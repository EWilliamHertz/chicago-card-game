/**
 * Core game logic for Chicago card game.
 * Handles deck creation, dealing, trick evaluation, and poker hand ranking.
 */

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_SYMBOLS = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠'
};

/**
 * Get numeric value for a card rank.
 * @param {string} rank
 * @returns {number} 2-14
 */
function getCardValue(rank) {
  const values = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
  };
  return values[rank] || 0;
}

/**
 * Create a shuffled 52-card deck.
 * @returns {Array<{suit: string, rank: string, value: number}>}
 */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        suit,
        rank,
        value: getCardValue(rank)
      });
    }
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Deal exactly 5 cards to each player from the deck (deck is mutated).
 * @param {Array} deck - Shuffled deck (will be modified)
 * @param {number} numPlayers - 2-4
 * @returns {Array<Array>} Array of hands (5 cards each)
 */
function dealCards(deck, numPlayers) {
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < numPlayers; j++) {
      hands[j].push(deck.pop());
    }
  }
  return hands;
}

/**
 * Deal replacement cards from the deck.
 * @param {Array} deck - Remaining deck (will be modified)
 * @param {number} count - Number of cards to deal
 * @returns {Array} Replacement cards
 */
function dealReplacementCards(deck, count) {
  const cards = [];
  for (let i = 0; i < count && deck.length > 0; i++) {
    cards.push(deck.pop());
  }
  return cards;
}

/**
 * Compare two cards in a trick context.
 * Cards matching leadSuit beat cards that don't.
 * Among same suit, higher value wins.
 * @param {object} a - First card
 * @param {object} b - Second card
 * @param {string} leadSuit - The suit that was led
 * @returns {number} Positive if a wins, negative if b wins
 */
function compareCards(a, b, leadSuit) {
  const aIsLead = a.suit === leadSuit;
  const bIsLead = b.suit === leadSuit;

  if (aIsLead && !bIsLead) return 1;
  if (!aIsLead && bIsLead) return -1;
  if (aIsLead && bIsLead) return a.value - b.value;
  // Neither is lead suit — doesn't matter, but compare by value
  return a.value - b.value;
}

/**
 * Determine the winner of a trick.
 * Only cards of the lead suit can win. Highest value of lead suit wins.
 * @param {Array<{playerId: number, card: object}>} trickCards
 * @param {string} leadSuit
 * @returns {number} Winner's playerId
 */
function determineTrickWinner(trickCards, leadSuit) {
  let winner = null;
  let highestValue = -1;

  for (const entry of trickCards) {
    if (entry.card.suit === leadSuit && entry.card.value > highestValue) {
      highestValue = entry.card.value;
      winner = entry.playerId;
    }
  }

  return winner;
}

// ==================== POKER HAND EVALUATION ====================

/**
 * Check if five cards form a flush (all same suit).
 * @param {Array} five - Exactly 5 cards
 * @returns {boolean}
 */
function isFlush(five) {
  return five.every(c => c.suit === five[0].suit);
}

/**
 * Check if five cards form a straight (consecutive values).
 * Ace can be high (10-J-Q-K-A) or low (A-2-3-4-5).
 * @param {Array} five - Exactly 5 cards sorted by value ascending
 * @returns {boolean}
 */
function isStraight(five) {
  const sorted = [...five].sort((a, b) => a.value - b.value);
  const values = sorted.map(c => c.value);

  // Normal straight check
  let isNormal = true;
  for (let i = 1; i < 5; i++) {
    if (values[i] !== values[i - 1] + 1) {
      isNormal = false;
      break;
    }
  }
  if (isNormal) return true;

  // Ace-low straight: A-2-3-4-5 (values: 2,3,4,5,14)
  if (values[0] === 2 && values[1] === 3 && values[2] === 4 && values[3] === 5 && values[4] === 14) {
    return true;
  }

  return false;
}

/**
 * Get the high card value of a straight (handling ace-low).
 * @param {Array} five - 5 cards
 * @returns {number}
 */
function getStraightHighCard(five) {
  const sorted = [...five].sort((a, b) => a.value - b.value);
  const values = sorted.map(c => c.value);

  // Ace-low straight
  if (values[0] === 2 && values[1] === 3 && values[2] === 4 && values[3] === 5 && values[4] === 14) {
    return 5; // 5-high straight
  }
  return values[4]; // Normal: highest card
}

/**
 * Generate all k-element combinations from an array.
 * @param {Array} arr
 * @param {number} k
 * @returns {Array<Array>}
 */
function getCombinations(arr, k) {
  const results = [];
  if (k === 0) return [[]];
  if (arr.length < k) return [];

  function combine(start, current) {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    const remaining = k - current.length;
    for (let i = start; i <= arr.length - remaining; i++) {
      current.push(arr[i]);
      combine(i + 1, current);
      current.pop();
    }
  }

  combine(0, []);
  return results;
}

/**
 * Classify exactly 5 cards into a poker hand.
 * @param {Array} five - Exactly 5 cards
 * @returns {{rank: number, name: string, tiebreaker: Array<number>, cards: Array}}
 */
function classifyFiveCardHand(five) {
  const sorted = [...five].sort((a, b) => b.value - a.value); // descending
  const flush = isFlush(sorted);
  const straight = isStraight(sorted);
  const straightHigh = straight ? getStraightHighCard(sorted) : 0;

  // Count rank occurrences
  const rankCounts = {};
  for (const card of sorted) {
    rankCounts[card.value] = (rankCounts[card.value] || 0) + 1;
  }

  const counts = Object.entries(rankCounts)
    .map(([value, count]) => ({ value: parseInt(value), count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.value - a.value;
    });

  const countPattern = counts.map(c => c.count).join(',');

  // Royal Flush: 10-J-Q-K-A of same suit
  if (flush && straight && straightHigh === 14) {
    // Verify it's actually 10-J-Q-K-A
    const values = sorted.map(c => c.value).sort((a, b) => a - b);
    if (values[0] === 10 && values[4] === 14) {
      return { rank: 9, name: 'Royal Flush', tiebreaker: [14], cards: sorted };
    }
  }

  // Straight Flush
  if (flush && straight) {
    return { rank: 8, name: 'Straight Flush', tiebreaker: [straightHigh], cards: sorted };
  }

  // Four of a Kind
  if (countPattern === '4,1') {
    return {
      rank: 7, name: 'Four of a Kind',
      tiebreaker: [counts[0].value, counts[1].value],
      cards: sorted
    };
  }

  // Full House
  if (countPattern === '3,2') {
    return {
      rank: 6, name: 'Full House',
      tiebreaker: [counts[0].value, counts[1].value],
      cards: sorted
    };
  }

  // Flush
  if (flush) {
    return {
      rank: 5, name: 'Flush',
      tiebreaker: sorted.map(c => c.value),
      cards: sorted
    };
  }

  // Straight
  if (straight) {
    return {
      rank: 4, name: 'Straight',
      tiebreaker: [straightHigh],
      cards: sorted
    };
  }

  // Three of a Kind
  if (countPattern === '3,1,1') {
    return {
      rank: 3, name: 'Three of a Kind',
      tiebreaker: [counts[0].value, counts[1].value, counts[2].value],
      cards: sorted
    };
  }

  // Two Pair
  if (countPattern === '2,2,1') {
    return {
      rank: 2, name: 'Two Pair',
      tiebreaker: [counts[0].value, counts[1].value, counts[2].value],
      cards: sorted
    };
  }

  // One Pair
  if (countPattern === '2,1,1,1') {
    return {
      rank: 1, name: 'One Pair',
      tiebreaker: [counts[0].value, counts[1].value, counts[2].value, counts[3].value],
      cards: sorted
    };
  }

  // High Card
  return {
    rank: 0, name: 'High Card',
    tiebreaker: sorted.map(c => c.value),
    cards: sorted
  };
}

/**
 * Compare two classified hands. Returns positive if a is better.
 * @param {object} a - Classified hand
 * @param {object} b - Classified hand
 * @returns {number}
 */
function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  // Compare tiebreakers
  const len = Math.min(a.tiebreaker.length, b.tiebreaker.length);
  for (let i = 0; i < len; i++) {
    if (a.tiebreaker[i] !== b.tiebreaker[i]) {
      return a.tiebreaker[i] - b.tiebreaker[i];
    }
  }
  return 0;
}

/**
 * Evaluate the best 5-card poker hand from a collection of cards.
 * Uses brute-force combinations for small sets, optimized approach for larger sets.
 *
 * @param {Array} cards - Array of cards (0 to 26+)
 * @returns {{rank: number, name: string, cards: Array}|null}
 */
function evaluatePokerHand(cards) {
  if (!cards || cards.length < 5) {
    // Not enough cards for a poker hand
    return { rank: 0, name: 'High Card', cards: cards || [] };
  }

  // For manageable sizes, brute-force all 5-card combinations
  if (cards.length <= 20) {
    return evaluateBruteForce(cards);
  }

  // For larger sets (>20 cards), use optimized approach
  return evaluateOptimized(cards);
}

/**
 * Brute-force evaluation: check all C(n,5) combinations.
 */
function evaluateBruteForce(cards) {
  const combos = getCombinations(cards, 5);
  let bestHand = null;

  for (const combo of combos) {
    const hand = classifyFiveCardHand(combo);
    if (!bestHand || compareHands(hand, bestHand) > 0) {
      bestHand = hand;
    }
  }

  return bestHand;
}

/**
 * Optimized evaluation for large card sets (>20).
 * Checks for best hands from top down:
 * 1. Group by suit for flush-based hands
 * 2. Group by rank for pair/set-based hands
 * 3. Check for straights by sorting
 */
function evaluateOptimized(cards) {
  let bestHand = null;

  // Group by suit
  const bySuit = {};
  for (const card of cards) {
    if (!bySuit[card.suit]) bySuit[card.suit] = [];
    bySuit[card.suit].push(card);
  }

  // Check flush-based hands (Royal Flush, Straight Flush, Flush)
  for (const suit of SUITS) {
    const suitCards = bySuit[suit];
    if (!suitCards || suitCards.length < 5) continue;

    // Sort by value descending
    suitCards.sort((a, b) => b.value - a.value);

    // Check for straight flushes within this suit
    const uniqueValues = [...new Set(suitCards.map(c => c.value))].sort((a, b) => b - a);

    // Check consecutive sequences
    for (let i = 0; i <= uniqueValues.length - 5; i++) {
      if (uniqueValues[i] - uniqueValues[i + 4] === 4) {
        // Found a straight flush
        const targetValues = new Set();
        for (let v = uniqueValues[i + 4]; v <= uniqueValues[i]; v++) {
          targetValues.add(v);
        }
        const hand = suitCards.filter(c => targetValues.has(c.value)).slice(0, 5);
        const classified = classifyFiveCardHand(hand);
        if (!bestHand || compareHands(classified, bestHand) > 0) {
          bestHand = classified;
        }
      }
    }

    // Check ace-low straight flush (A-2-3-4-5)
    if (uniqueValues.includes(14) && uniqueValues.includes(2) &&
        uniqueValues.includes(3) && uniqueValues.includes(4) && uniqueValues.includes(5)) {
      const targetValues = new Set([14, 2, 3, 4, 5]);
      const hand = suitCards.filter(c => targetValues.has(c.value)).slice(0, 5);
      const classified = classifyFiveCardHand(hand);
      if (!bestHand || compareHands(classified, bestHand) > 0) {
        bestHand = classified;
      }
    }

    // Best flush from this suit (top 5 cards)
    if (suitCards.length >= 5) {
      const flushHand = suitCards.slice(0, 5);
      const classified = classifyFiveCardHand(flushHand);
      if (!bestHand || compareHands(classified, bestHand) > 0) {
        bestHand = classified;
      }
    }
  }

  // Group by rank value
  const byRank = {};
  for (const card of cards) {
    if (!byRank[card.value]) byRank[card.value] = [];
    byRank[card.value].push(card);
  }

  const rankGroups = Object.entries(byRank)
    .map(([value, cards]) => ({ value: parseInt(value), cards, count: cards.length }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  // Check four of a kind
  for (const group of rankGroups) {
    if (group.count >= 4) {
      const fourCards = group.cards.slice(0, 4);
      // Find best kicker
      const remaining = cards.filter(c => c.value !== group.value)
        .sort((a, b) => b.value - a.value);
      if (remaining.length > 0) {
        const hand = [...fourCards, remaining[0]];
        const classified = classifyFiveCardHand(hand);
        if (!bestHand || compareHands(classified, bestHand) > 0) {
          bestHand = classified;
        }
      }
    }
  }

  // Check full house
  const triples = rankGroups.filter(g => g.count >= 3).sort((a, b) => b.value - a.value);
  const pairs = rankGroups.filter(g => g.count >= 2).sort((a, b) => b.value - a.value);

  if (triples.length > 0) {
    for (const triple of triples) {
      for (const pair of pairs) {
        if (pair.value !== triple.value && pair.count >= 2) {
          const hand = [...triple.cards.slice(0, 3), ...pair.cards.slice(0, 2)];
          const classified = classifyFiveCardHand(hand);
          if (!bestHand || compareHands(classified, bestHand) > 0) {
            bestHand = classified;
          }
          break; // Best pair for this triple found
        }
      }
    }
    // Also check if another triple can serve as the pair
    if (triples.length > 1) {
      const hand = [...triples[0].cards.slice(0, 3), ...triples[1].cards.slice(0, 2)];
      const classified = classifyFiveCardHand(hand);
      if (!bestHand || compareHands(classified, bestHand) > 0) {
        bestHand = classified;
      }
    }
  }

  // If we already found at least a flush, skip lower hands (already checked above)
  if (bestHand && bestHand.rank >= 5) {
    return bestHand;
  }

  // Check straight (not flush)
  const uniqueVals = [...new Set(cards.map(c => c.value))].sort((a, b) => b - a);
  for (let i = 0; i <= uniqueVals.length - 5; i++) {
    if (uniqueVals[i] - uniqueVals[i + 4] === 4) {
      const targetValues = [];
      for (let v = uniqueVals[i + 4]; v <= uniqueVals[i]; v++) {
        targetValues.push(v);
      }
      const hand = targetValues.map(v => cards.find(c => c.value === v));
      const classified = classifyFiveCardHand(hand);
      if (!bestHand || compareHands(classified, bestHand) > 0) {
        bestHand = classified;
      }
      break; // Highest straight found
    }
  }

  // Check ace-low straight
  if (uniqueVals.includes(14) && uniqueVals.includes(2) &&
      uniqueVals.includes(3) && uniqueVals.includes(4) && uniqueVals.includes(5)) {
    const hand = [14, 5, 4, 3, 2].map(v => cards.find(c => c.value === v));
    const classified = classifyFiveCardHand(hand);
    if (!bestHand || compareHands(classified, bestHand) > 0) {
      bestHand = classified;
    }
  }

  // If we already have a straight or better, return
  if (bestHand && bestHand.rank >= 4) {
    return bestHand;
  }

  // Three of a kind
  if (triples.length > 0) {
    const triple = triples[0];
    const kickers = cards.filter(c => c.value !== triple.value)
      .sort((a, b) => b.value - a.value)
      .slice(0, 2);
    const hand = [...triple.cards.slice(0, 3), ...kickers];
    const classified = classifyFiveCardHand(hand);
    if (!bestHand || compareHands(classified, bestHand) > 0) {
      bestHand = classified;
    }
  }

  // Two pair
  const pairsOnly = rankGroups.filter(g => g.count >= 2).sort((a, b) => b.value - a.value);
  if (pairsOnly.length >= 2) {
    const p1 = pairsOnly[0];
    const p2 = pairsOnly[1];
    const kicker = cards.filter(c => c.value !== p1.value && c.value !== p2.value)
      .sort((a, b) => b.value - a.value);
    if (kicker.length > 0) {
      const hand = [...p1.cards.slice(0, 2), ...p2.cards.slice(0, 2), kicker[0]];
      const classified = classifyFiveCardHand(hand);
      if (!bestHand || compareHands(classified, bestHand) > 0) {
        bestHand = classified;
      }
    }
  }

  // One pair
  if (pairsOnly.length >= 1) {
    const p = pairsOnly[0];
    const kickers = cards.filter(c => c.value !== p.value)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    const hand = [...p.cards.slice(0, 2), ...kickers];
    if (hand.length === 5) {
      const classified = classifyFiveCardHand(hand);
      if (!bestHand || compareHands(classified, bestHand) > 0) {
        bestHand = classified;
      }
    }
  }

  // High card
  const highCards = [...cards].sort((a, b) => b.value - a.value).slice(0, 5);
  if (highCards.length === 5) {
    const classified = classifyFiveCardHand(highCards);
    if (!bestHand || compareHands(classified, bestHand) > 0) {
      bestHand = classified;
    }
  }

  return bestHand;
}

/**
 * Get points awarded for a poker hand rank.
 * @param {number} handRank
 * @returns {number}
 */
function getHandPoints(handRank) {
  const pointMap = {
    0: 0, // High Card
    1: 1, // One Pair
    2: 2, // Two Pair
    3: 3, // Three of a Kind
    4: 4, // Straight
    5: 5, // Flush
    6: 6, // Full House
    7: 8, // Four of a Kind
    8: 0, // Straight Flush (instant win)
    9: 0  // Royal Flush (instant win)
  };
  return pointMap[handRank] !== undefined ? pointMap[handRank] : 0;
}

/**
 * Check if a hand rank is an instant win condition.
 * @param {number} handRank
 * @returns {boolean}
 */
function isInstantWin(handRank) {
  return handRank === 8 || handRank === 9;
}

/**
 * Check if a hand rank is four of a kind.
 * @param {number} handRank
 * @returns {boolean}
 */
function isFourOfAKind(handRank) {
  return handRank === 7;
}

module.exports = {
  createDeck,
  dealCards,
  dealReplacementCards,
  getCardValue,
  compareCards,
  compareHands,
  determineTrickWinner,
  evaluatePokerHand,
  getHandPoints,
  isInstantWin,
  isFourOfAKind,
  isFlush,
  isStraight,
  getCombinations,
  classifyFiveCardHand,
  SUITS,
  RANKS,
  SUIT_SYMBOLS
};
