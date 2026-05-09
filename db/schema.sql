-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(30) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  elo INTEGER DEFAULT 1200,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Game history
CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  status VARCHAR(20) DEFAULT 'finished',
  winner_id INTEGER REFERENCES users(id),
  win_condition VARCHAR(50),
  rounds_played INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP DEFAULT NOW()
);

-- Game participants
CREATE TABLE IF NOT EXISTS game_players (
  id SERIAL PRIMARY KEY,
  game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  final_score INTEGER DEFAULT 0,
  elo_before INTEGER,
  elo_after INTEGER,
  elo_change INTEGER
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_users_elo ON users(elo DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_games_winner ON games(winner_id);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);
