const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { CONFIG_PATH, ensureDirForFile, isNonEmptyString, nowMs } = require("./config");

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName);
  return !!row;
}

function tableHasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function tableSql(db, tableName) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName);
  return row && typeof row.sql === "string" ? row.sql : "";
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!isNonEmptyString(raw)) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function parseConfigFromEnv() {
  const encoded = process.env.CONFIG;
  if (!isNonEmptyString(encoded)) {
    return null;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (!isNonEmptyString(decoded)) {
      return null;
    }
    return JSON.parse(decoded);
  } catch (_error) {
    return null;
  }
}

function createDb(dbPath) {
  ensureDirForFile(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  normalizeLegacyTableNames(db);
  initSchema(db);
  migrateFromLegacyTables(db);
  ensureUserChannelsAllowMultipleRows(db);
  seedFromLegacyConfigIfNeeded(db);
  ensureDestUserVisibilityMappings(db);
  return db;
}

function normalizeLegacyTableNames(db) {
  if (tableExists(db, "user_channels") && !tableHasColumn(db, "user_channels", "login_user_id")) {
    if (!tableExists(db, "user_channels_legacy")) {
      db.exec("ALTER TABLE user_channels RENAME TO user_channels_legacy");
    } else {
      db.exec("DROP TABLE user_channels");
    }
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usrid TEXT UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dest_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usrid TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login_user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      dest_user_id INTEGER,
      dest_usrid TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (login_user_id) REFERENCES login_users(id) ON DELETE CASCADE,
      FOREIGN KEY (dest_user_id) REFERENCES dest_users(id) ON DELETE SET NULL,
      UNIQUE(login_user_id, event_type, dest_user_id)
    );

    CREATE TABLE IF NOT EXISTS user_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login_user_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      options_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (login_user_id) REFERENCES login_users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS login_user_dest_users (
      login_user_id INTEGER NOT NULL,
      dest_user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (login_user_id, dest_user_id),
      FOREIGN KEY (login_user_id) REFERENCES login_users(id) ON DELETE CASCADE,
      FOREIGN KEY (dest_user_id) REFERENCES dest_users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subscriptions_event_enabled
      ON subscriptions(event_type, enabled);

    CREATE INDEX IF NOT EXISTS idx_channels_login_user_enabled
      ON user_channels(login_user_id, enabled);

    CREATE INDEX IF NOT EXISTS idx_login_user_dest_users_lookup
      ON login_user_dest_users(login_user_id, dest_user_id);
  `);

  if (!tableHasColumn(db, "login_users", "display_name")) {
    db.exec("ALTER TABLE login_users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  if (!tableHasColumn(db, "subscriptions", "dest_usrid")) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN dest_usrid TEXT");
  }
  if (tableExists(db, "dest_users") && tableHasColumn(db, "subscriptions", "dest_user_id")) {
    db.exec(`
      UPDATE subscriptions
      SET dest_usrid = (
        SELECT usrid FROM dest_users d WHERE d.id = subscriptions.dest_user_id
      )
      WHERE (dest_usrid IS NULL OR dest_usrid = '')
        AND dest_user_id IS NOT NULL
    `);
  }
}

function ensureUserChannelsAllowMultipleRows(db) {
  if (!tableExists(db, "user_channels")) {
    return;
  }
  const sql = tableSql(db, "user_channels");
  const hasLegacyUnique = /UNIQUE\s*\(\s*login_user_id\s*,\s*method\s*\)/i.test(sql);
  if (!hasLegacyUnique) {
    return;
  }

  if (tableExists(db, "__user_channels_old_multi__")) {
    db.exec("DROP TABLE __user_channels_old_multi__");
  }

  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE user_channels RENAME TO __user_channels_old_multi__");
    db.exec(`
      CREATE TABLE user_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login_user_id INTEGER NOT NULL,
        method TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        options_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (login_user_id) REFERENCES login_users(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT INTO user_channels (id, login_user_id, method, enabled, options_json, created_at, updated_at)
      SELECT id, login_user_id, method, enabled, options_json, created_at, updated_at
      FROM __user_channels_old_multi__
      ORDER BY id ASC
    `);
    db.exec("DROP TABLE __user_channels_old_multi__");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_channels_login_user_enabled
      ON user_channels(login_user_id, enabled)
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureDestUserVisibilityMappings(db) {
  const now = nowMs();
  db.prepare(
    `INSERT OR IGNORE INTO login_user_dest_users (login_user_id, dest_user_id, created_at)
     SELECT DISTINCT login_user_id, dest_user_id, ?
     FROM subscriptions
     WHERE dest_user_id IS NOT NULL`
  ).run(now);
}

function migrateFromLegacyTables(db) {
  const hasOldUsers = tableExists(db, "users");
  const hasOldSubs = tableExists(db, "user_subscriptions");
  const hasOldChannels = tableExists(db, "user_channels_legacy") || tableExists(db, "user_channels");
  const hasOldLoginState = tableExists(db, "user_login_state");
  if (!hasOldUsers || !hasOldSubs || !hasOldLoginState) {
    return;
  }

  const newCount = Number(db.prepare("SELECT COUNT(*) AS c FROM login_users").get().c || 0);
  if (newCount > 0) {
    return;
  }

  db.exec("BEGIN");
  try {
    const now = nowMs();
    const oldUsers = db
      .prepare(
        `SELECT id, vrchat_user_id, username, display_name
         FROM users
         ORDER BY id ASC`
      )
      .all();

    const oldToNewMap = new Map();
    const insertLoginUser = db.prepare(
      `INSERT INTO login_users (usrid, display_name, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    );

    for (const old of oldUsers) {
      const usrid =
        (isNonEmptyString(old.vrchat_user_id) && old.vrchat_user_id.trim()) ||
        (isNonEmptyString(old.username) && old.username.trim()) ||
        `legacy-user-${old.id}`;

      const tokenRow = db
        .prepare("SELECT token FROM user_login_state WHERE user_id = ?")
        .get(old.id);
      const token =
        (tokenRow && isNonEmptyString(tokenRow.token) && tokenRow.token.trim()) || "";

      const displayName =
        (isNonEmptyString(old.display_name) && old.display_name.trim()) ||
        (isNonEmptyString(old.username) && old.username.trim()) ||
        usrid;

      const result = insertLoginUser.run(usrid, displayName, token, now, now);
      oldToNewMap.set(old.id, Number(result.lastInsertRowid));

      if (isNonEmptyString(old.vrchat_user_id)) {
        db.prepare(
          `INSERT OR IGNORE INTO dest_users (usrid, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        ).run(
          old.vrchat_user_id.trim(),
          isNonEmptyString(old.display_name) ? old.display_name.trim() : old.vrchat_user_id.trim(),
          now,
          now
        );
      }
    }

    const oldSubs = db
      .prepare(
        `SELECT user_id, event_type, dest, enabled, created_at, updated_at
         FROM user_subscriptions`
      )
      .all();

    const insertSub = db.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (login_user_id, event_type, dest_user_id, dest_usrid, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const row of oldSubs) {
      const loginUserId = oldToNewMap.get(row.user_id);
      if (!loginUserId) {
        continue;
      }
      let destUserId = null;
      if (isNonEmptyString(row.dest)) {
        db.prepare(
          `INSERT OR IGNORE INTO dest_users (usrid, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        ).run(row.dest.trim(), row.dest.trim(), now, now);
        const destRow = db.prepare("SELECT id FROM dest_users WHERE usrid = ?").get(row.dest.trim());
        destUserId = destRow ? destRow.id : null;
      }
      insertSub.run(
        loginUserId,
        row.event_type,
        destUserId,
        isNonEmptyString(row.dest) ? row.dest.trim() : null,
        Number(row.enabled) === 0 ? 0 : 1,
        row.created_at || now,
        row.updated_at || now
      );
    }

    if (hasOldChannels) {
      const oldChannelTable = tableExists(db, "user_channels_legacy") ? "user_channels_legacy" : "user_channels";
      const oldChannels = db
        .prepare(
          `SELECT user_id, method, enabled, options_json, created_at, updated_at
           FROM ${oldChannelTable}`
        )
        .all();
      const insertChannel = db.prepare(
        `INSERT OR REPLACE INTO user_channels
         (login_user_id, method, enabled, options_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const row of oldChannels) {
        const loginUserId = oldToNewMap.get(row.user_id);
        if (!loginUserId) {
          continue;
        }
        insertChannel.run(
          loginUserId,
          row.method,
          Number(row.enabled) === 0 ? 0 : 1,
          isNonEmptyString(row.options_json) ? row.options_json : "{}",
          row.created_at || now,
          row.updated_at || now
        );
      }
    }

    db.exec("COMMIT");
    console.log("已完成旧表迁移到新模型");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function seedFromLegacyConfigIfNeeded(db) {
  const count = Number(db.prepare("SELECT COUNT(*) AS c FROM login_users").get().c || 0);
  if (count > 0) {
    return;
  }

  const legacy = readJsonSafe(CONFIG_PATH) || parseConfigFromEnv();
  if (!legacy) {
    return;
  }

  const now = nowMs();
  const seedUsrid = "default-login-user";
  const seedToken = isNonEmptyString(legacy.token) ? legacy.token.trim() : "";

  db.prepare(
    `INSERT INTO login_users (usrid, display_name, token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(seedUsrid, "Pending User", seedToken, now, now);

  const loginUserId = db.prepare("SELECT id FROM login_users WHERE usrid = ?").get(seedUsrid).id;

  if (Array.isArray(legacy.notify)) {
    for (const item of legacy.notify) {
      if (!item || !isNonEmptyString(item.method)) {
        continue;
      }
      db.prepare(
        `INSERT OR REPLACE INTO user_channels
         (login_user_id, method, enabled, options_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(loginUserId, item.method.trim(), 1, JSON.stringify(item.options || {}), now, now);
    }
  }

  if (Array.isArray(legacy.subscriptions)) {
    for (const item of legacy.subscriptions) {
      if (!item || !isNonEmptyString(item.type)) {
        continue;
      }

      let destUserId = null;
      if (isNonEmptyString(item.dest)) {
        const usrid = item.dest.trim();
        db.prepare(
          `INSERT OR IGNORE INTO dest_users (usrid, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        ).run(usrid, usrid, now, now);
        const destRow = db.prepare("SELECT id FROM dest_users WHERE usrid = ?").get(usrid);
        destUserId = destRow ? destRow.id : null;
      }

      db.prepare(
        `INSERT OR IGNORE INTO subscriptions
         (login_user_id, event_type, dest_user_id, dest_usrid, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(loginUserId, item.type.trim(), destUserId, isNonEmptyString(item.dest) ? item.dest.trim() : null, 1, now, now);
    }
  }
}

module.exports = {
  createDb
};
