'use strict';

const session = require('express-session');
const { q } = require('./db');

const DAY = 24 * 60 * 60 * 1000;

/** Хранилище сессий express-session в SQLite. */
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  expiresOf(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    return exp ? new Date(exp).getTime() : Date.now() + DAY;
  }

  get(sid, cb) {
    try {
      const row = q('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      q('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), this.expiresOf(sess));
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sess, cb) {
    try {
      q('UPDATE sessions SET expires = ? WHERE sid = ?').run(this.expiresOf(sess), sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      q('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  cleanup() {
    try {
      q('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    } catch {
      /* ignore */
    }
  }
}

module.exports = SqliteStore;
