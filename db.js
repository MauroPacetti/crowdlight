const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'crowdlight.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    num_groups INTEGER DEFAULT 10,
    max_audience INTEGER DEFAULT 500,
    is_active INTEGER DEFAULT 1,
    controller_token TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);
  CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
  CREATE INDEX IF NOT EXISTS idx_events_controller_token ON events(controller_token);
`);

// Prepared statements
const stmts = {
  createUser: db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById: db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?'),

  createEvent: db.prepare('INSERT INTO events (slug, user_id, name, num_groups, max_audience, controller_token) VALUES (?, ?, ?, ?, ?, ?)'),
  getEventBySlug: db.prepare('SELECT * FROM events WHERE slug = ?'),
  getEventByToken: db.prepare('SELECT * FROM events WHERE controller_token = ?'),
  getEventsByUser: db.prepare('SELECT id, slug, name, num_groups, max_audience, is_active, controller_token, created_at FROM events WHERE user_id = ? ORDER BY created_at DESC'),
  updateEvent: db.prepare('UPDATE events SET name = ?, num_groups = ?, max_audience = ?, is_active = ? WHERE slug = ? AND user_id = ?'),
  deleteEvent: db.prepare('DELETE FROM events WHERE slug = ? AND user_id = ?'),
};

module.exports = { db, stmts };
