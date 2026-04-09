const { SUPPORTED_EVENT_TYPES, isNonEmptyString, nowMs } = require("./config");

function deserializeOptions(json) {
  if (!isNonEmptyString(json)) {
    return {};
  }
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function serializeOptions(options) {
  try {
    return JSON.stringify(options || {});
  } catch (_error) {
    return "{}";
  }
}

function createRepositories(db) {
  function extractNotifyTokenFromOptions(options) {
    if (!options || typeof options !== "object") {
      return "";
    }
    const candidates = [options.token, options.sendkey, options.sckey];
    for (const item of candidates) {
      if (isNonEmptyString(item)) {
        return item.trim();
      }
    }
    return "";
  }
  function listLoginUsers() {
    return db
      .prepare(
        `SELECT id, usrid, display_name, token, created_at, updated_at
         FROM login_users
         ORDER BY id ASC`
      )
      .all();
  }

  function getLoginUserById(id) {
    return (
      db
        .prepare(
          `SELECT id, usrid, display_name, token, created_at, updated_at
           FROM login_users
           WHERE id = ?`
        )
        .get(id) || null
    );
  }

  function getLoginUserByUsrid(usrid) {
    return (
      db
        .prepare(
          `SELECT id, usrid, display_name, token, created_at, updated_at
           FROM login_users
           WHERE usrid = ?`
        )
        .get(usrid) || null
    );
  }

  function upsertLoginUser(input) {
    const now = nowMs();
    const id = Number(input.id || 0);
    if (id > 0) {
      const existing = getLoginUserById(id);
      if (!existing) {
        throw new Error("loginUser not found");
      }
      return id;
    }

    const placeholderUsrid = `pending-${now}-${Math.floor(Math.random() * 1000)}`;
    const result = db
      .prepare(
        "INSERT INTO login_users (usrid, display_name, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(placeholderUsrid, "Pending User", "", now, now);
    return Number(result.lastInsertRowid);
  }

  function upsertLoginUserByIdentityAndToken({ usrid, displayName, token }) {
    const normalizedUsrid = isNonEmptyString(usrid) ? usrid.trim() : "";
    const normalizedDisplayName = isNonEmptyString(displayName) ? displayName.trim() : "";
    const normalizedToken = isNonEmptyString(token) ? token.trim() : "";
    if (!normalizedUsrid || !normalizedDisplayName || !normalizedToken) {
      throw new Error("usrid, displayName and token are required");
    }

    const now = nowMs();
    const existing = getLoginUserByUsrid(normalizedUsrid);
    if (existing) {
      db.prepare(
        "UPDATE login_users SET display_name = ?, token = ?, updated_at = ? WHERE id = ?"
      ).run(normalizedDisplayName, normalizedToken, now, existing.id);
      return existing.id;
    }

    const result = db
      .prepare(
        "INSERT INTO login_users (usrid, display_name, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(normalizedUsrid, normalizedDisplayName, normalizedToken, now, now);
    return Number(result.lastInsertRowid);
  }

  function updateLoginUserIdentityAndToken(loginUserId, { usrid, displayName, token }) {
    const now = nowMs();
    db.prepare(
      "UPDATE login_users SET usrid = ?, display_name = ?, token = ?, updated_at = ? WHERE id = ?"
    ).run(usrid, displayName, token, now, loginUserId);
  }

  function listDestUsers() {
    return db
      .prepare(
        `SELECT id, usrid, display_name, created_at, updated_at
         FROM dest_users
         ORDER BY id ASC`
      )
      .all();
  }

  function listDestUsersByLoginUserId(loginUserId) {
    return db
      .prepare(
        `SELECT d.id, d.usrid, d.display_name, d.created_at, d.updated_at
         FROM login_user_dest_users m
         INNER JOIN dest_users d ON d.id = m.dest_user_id
         WHERE m.login_user_id = ?
         ORDER BY d.id ASC`
      )
      .all(loginUserId);
  }

  function getDestUserById(id) {
    return (
      db
        .prepare(
          `SELECT id, usrid, display_name, created_at, updated_at
           FROM dest_users
           WHERE id = ?`
        )
        .get(id) || null
    );
  }

  function upsertDestUser(input) {
    const now = nowMs();
    const id = Number(input.id || 0);
    const usrid = isNonEmptyString(input.usrid) ? input.usrid.trim() : "";
    const displayName = isNonEmptyString(input.displayName) ? input.displayName.trim() : "";
    if (!usrid || !displayName) {
      throw new Error("destUser usrid and displayName are required");
    }

    if (id > 0) {
      const existing = getDestUserById(id);
      if (!existing) {
        throw new Error("destUser not found");
      }
      db.prepare("UPDATE dest_users SET usrid = ?, display_name = ?, updated_at = ? WHERE id = ?").run(
        usrid,
        displayName,
        now,
        id
      );
      return id;
    }

    const existingByUsrid = db
      .prepare(
        `SELECT id FROM dest_users
         WHERE usrid = ?`
      )
      .get(usrid);
    if (existingByUsrid && existingByUsrid.id) {
      db.prepare("UPDATE dest_users SET display_name = ?, updated_at = ? WHERE id = ?").run(
        displayName,
        now,
        existingByUsrid.id
      );
      return Number(existingByUsrid.id);
    }

    const result = db
      .prepare("INSERT INTO dest_users (usrid, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(usrid, displayName, now, now);
    return Number(result.lastInsertRowid);
  }

  function attachDestUserToLoginUser(loginUserId, destUserId) {
    const now = nowMs();
    db.prepare(
      `INSERT OR IGNORE INTO login_user_dest_users (login_user_id, dest_user_id, created_at)
       VALUES (?, ?, ?)`
    ).run(loginUserId, destUserId, now);
  }

  function removeDestUserFromLoginUser(loginUserId, destUserId) {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM login_user_dest_users WHERE login_user_id = ? AND dest_user_id = ?").run(
        loginUserId,
        destUserId
      );
      db.prepare("DELETE FROM subscriptions WHERE login_user_id = ? AND dest_user_id = ?").run(loginUserId, destUserId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function isDestUserVisibleToLoginUser(loginUserId, destUserId) {
    const row = db
      .prepare(
        `SELECT 1 AS ok
         FROM login_user_dest_users
         WHERE login_user_id = ? AND dest_user_id = ?`
      )
      .get(loginUserId, destUserId);
    return !!row;
  }

  function getSubscriptionsByLoginUserId(loginUserId) {
    return db
      .prepare(
        `SELECT s.id, s.event_type, s.dest_usrid, s.enabled, s.created_at, s.updated_at
         FROM subscriptions s
         WHERE s.login_user_id = ?
         ORDER BY s.id ASC`
      )
      .all(loginUserId);
  }

  function replaceSubscriptions(loginUserId, subscriptions) {
    const now = nowMs();
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM subscriptions WHERE login_user_id = ?").run(loginUserId);

      if (Array.isArray(subscriptions)) {
        const insert = db.prepare(
          `INSERT INTO subscriptions
           (login_user_id, event_type, dest_usrid, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        );

        for (const row of subscriptions) {
          if (!row || !isNonEmptyString(row.eventType)) {
            continue;
          }
          const eventType = row.eventType.trim();
          if (!SUPPORTED_EVENT_TYPES.includes(eventType)) {
            continue;
          }

          // friend-add / friend-delete 仅支持 any（destUsrid = NULL）
          const onlyAny = eventType === "friend-add" || eventType === "friend-delete";
          const destUsrid = onlyAny
            ? null
            : row.destUsrid === null || row.destUsrid === undefined
              ? null
              : (isNonEmptyString(row.destUsrid) ? row.destUsrid.trim() : null);
          insert.run(loginUserId, eventType, destUsrid, row.enabled === false ? 0 : 1, now, now);
        }
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getChannelsByLoginUserId(loginUserId) {
    const rows = db
      .prepare(
        `SELECT id, method, enabled, options_json, created_at, updated_at
         FROM user_channels
         WHERE login_user_id = ?
         ORDER BY id ASC`
      )
      .all(loginUserId)
      .map((row) => ({
        ...row,
        options: deserializeOptions(row.options_json)
      }));

    const firstEnabled = rows.find((r) => !!r.enabled);
    const token = firstEnabled ? extractNotifyTokenFromOptions(firstEnabled.options) : "";

    if (!token) {
      return [];
    }

    return [
      {
        id: firstEnabled.id,
        method: "serverchanV3",
        enabled: true,
        options: {
          sendkey: token
        },
        token,
        created_at: firstEnabled.created_at,
        updated_at: firstEnabled.updated_at
      }
    ];
  }

  function setNotifyToken(loginUserId, tokenInput) {
    const now = nowMs();
    const token = isNonEmptyString(tokenInput) ? tokenInput.trim() : "";
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM user_channels WHERE login_user_id = ?").run(loginUserId);

      if (token) {
        db.prepare(
          `INSERT INTO user_channels
           (login_user_id, method, enabled, options_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(loginUserId, "serverchanV3", 1, serializeOptions({ sendkey: token }), now, now);
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function listUsersWithDetails() {
    const users = listLoginUsers();
    return users.map((u) => ({
      id: u.id,
      usrid: u.usrid,
      displayName: u.display_name || "",
      token: u.token || "",
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      subscriptions: getSubscriptionsByLoginUserId(u.id).map((s) => ({
        id: s.id,
        eventType: s.event_type,
        destUsrid: isNonEmptyString(s.dest_usrid) ? s.dest_usrid : null,
        enabled: !!s.enabled,
        createdAt: s.created_at,
        updatedAt: s.updated_at
      })),
      channels: getChannelsByLoginUserId(u.id).map((c) => ({
        id: c.id,
        token: c.token || "",
        createdAt: c.created_at,
        updatedAt: c.updated_at
      })),
      loginState: {
        token: u.token || "",
        isTokenValid: isNonEmptyString(u.token),
        lastVerifiedAt: null,
        lastError: "",
        updatedAt: u.updated_at
      }
    }));
  }

  function listSubscriptionsByEventType(eventType) {
    return db
      .prepare(
        `SELECT s.login_user_id, s.dest_usrid
         FROM subscriptions s
         WHERE s.event_type = ? AND s.enabled = 1`
      )
      .all(eventType);
  }

  function listEnabledSubscriptionsByLoginUserAndEventType(loginUserId, eventType) {
    return db
      .prepare(
        `SELECT s.dest_usrid
         FROM subscriptions s
         WHERE s.login_user_id = ? AND s.event_type = ? AND s.enabled = 1`
      )
      .all(loginUserId, eventType);
  }

  function listLoginUsersWithEnabledSubscriptions() {
    return db
      .prepare(
        `SELECT DISTINCT u.id, u.usrid, u.display_name, u.token, u.updated_at
         FROM login_users u
         INNER JOIN subscriptions s ON s.login_user_id = u.id
         WHERE s.enabled = 1`
      )
      .all();
  }

  function listChannelsByLoginUserIds(loginUserIds) {
    if (!Array.isArray(loginUserIds) || loginUserIds.length === 0) {
      return [];
    }
    const placeholders = loginUserIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT login_user_id, method, options_json
         FROM user_channels
         WHERE enabled = 1 AND login_user_id IN (${placeholders})`
      )
      .all(...loginUserIds)
      .map((row) => {
        const options = deserializeOptions(row.options_json);
        return {
          loginUserId: row.login_user_id,
          token: extractNotifyTokenFromOptions(options)
        };
      })
      .filter((row) => !!row.token)
      .map((row) => ({
        loginUserId: row.loginUserId,
        method: "serverchanV3",
        options: {
          sendkey: row.token
        }
      }));
  }

  function listLoginUsersWithToken() {
    return db
      .prepare(
        `SELECT id, usrid, display_name, token
         FROM login_users
         WHERE token IS NOT NULL AND token != ''
         ORDER BY updated_at DESC`
      )
      .all();
  }

  return {
    getLoginUserById,
    getLoginUserByUsrid,
    getDestUserById,
    getSubscriptionsByLoginUserId,
    upsertLoginUser,
    upsertLoginUserByIdentityAndToken,
    updateLoginUserIdentityAndToken,
    upsertDestUser,
    attachDestUserToLoginUser,
    removeDestUserFromLoginUser,
    isDestUserVisibleToLoginUser,
    replaceSubscriptions,
    setNotifyToken,
    getChannelsByLoginUserId,
    listUsersWithDetails,
    listDestUsers,
    listDestUsersByLoginUserId,
    listSubscriptionsByEventType,
    listEnabledSubscriptionsByLoginUserAndEventType,
    listChannelsByLoginUserIds,
    listLoginUsersWithToken,
    listLoginUsersWithEnabledSubscriptions
  };
}

module.exports = {
  createRepositories
};
