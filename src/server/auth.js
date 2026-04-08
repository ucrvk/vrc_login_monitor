const crypto = require("crypto");
const { SESSION_TTL_MS, nowMs } = require("./config");

const ADMIN_SESSION_COOKIE_NAME = "lm_admin_sid";
const USER_SESSION_COOKIE_NAME = "lm_user_sid";
const AUTH_DEBUG_ENABLED = process.env.AUTH_DEBUG !== "0";

function shortValue(value, visible = 10) {
  if (typeof value !== "string" || !value) {
    return "";
  }
  if (value.length <= visible) {
    return value;
  }
  return `${value.slice(0, visible)}...(${value.length})`;
}

function authDebug(message, payload) {
  if (!AUTH_DEBUG_ENABLED) {
    return;
  }
  const extra = payload ? ` ${JSON.stringify(payload)}` : "";
  console.log(`[AUTH DEBUG] ${message}${extra}`);
}

function parseCookies(headerValue) {
  if (!headerValue || typeof headerValue !== "string") {
    return {};
  }
  const out = {};
  for (const part of headerValue.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) {
      continue;
    }
    out[key] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function createSessionStore() {
  const sessions = new Map();

  function cleanup() {
    const cutoff = nowMs() - SESSION_TTL_MS;
    for (const [sid, record] of sessions.entries()) {
      if (record.updatedAt < cutoff) {
        sessions.delete(sid);
      }
    }
  }

  return {
    create(payload = {}) {
      cleanup();
      const sid = crypto.randomBytes(24).toString("hex");
      sessions.set(sid, { updatedAt: nowMs(), payload });
      return sid;
    },
    get(sid) {
      cleanup();
      const record = sessions.get(sid);
      if (!record) {
        return null;
      }
      record.updatedAt = nowMs();
      sessions.set(sid, record);
      return record.payload || {};
    },
    remove(sid) {
      sessions.delete(sid);
    }
  };
}

function createAuthService(adminPassword) {
  const adminSessions = createSessionStore();
  const userSessions = createSessionStore();

  // 检测是否为 HTTPS 环境（生产环境）
  function isSecureContext() {
    return process.env.NODE_ENV === "production";
  }

  function getSameSiteValue() {
    return isSecureContext() ? "None" : "Lax";
  }

  function cookieValue(name, value) {
    const secure = isSecureContext();
    return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=${getSameSiteValue()}${secure ? "; Secure" : ""}; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}`;
  }

  function clearCookie(name) {
    const secure = isSecureContext();
    return `${name}=; HttpOnly; Path=/; SameSite=${getSameSiteValue()}${secure ? "; Secure" : ""}; Max-Age=0`;
  }

  function setCookies(res, values) {
    res.setHeader("Set-Cookie", values);
    authDebug("set-cookie", {
      count: Array.isArray(values) ? values.length : 1,
      cookies: (Array.isArray(values) ? values : [values]).map((v) => String(v).split(";")[0])
    });
  }

  function getAuthState(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    const adminSid = cookies[ADMIN_SESSION_COOKIE_NAME] || "";
    const userSid = cookies[USER_SESSION_COOKIE_NAME] || "";

    const adminPayload = adminSid ? adminSessions.get(adminSid) : null;
    const userPayload = userSid ? userSessions.get(userSid) : null;

    const state = {
      authenticated: !!adminPayload || !!userPayload,
      role: adminPayload ? "admin" : userPayload ? "user" : "",
      admin: {
        sid: adminSid,
        authenticated: !!adminPayload
      },
      user: {
        sid: userSid,
        authenticated: !!userPayload,
        loginUserId: userPayload?.loginUserId || null,
        usrid: userPayload?.usrid || "",
        displayName: userPayload?.displayName || ""
      }
    };
    authDebug("get-auth-state", {
      method: req.method || "GET",
      url: req.url || "",
      hasCookieHeader: !!req.headers.cookie,
      rawCookie: req.headers.cookie || "",
      parsedAdminSid: shortValue(adminSid),
      parsedUserSid: shortValue(userSid),
      adminSessionHit: !!adminPayload,
      userSessionHit: !!userPayload,
      role: state.role
    });
    return state;
  }

  function login(res, password) {
    if (password !== adminPassword) {
      authDebug("admin-login-failed", { reason: "invalid-password" });
      return false;
    }
    const sid = adminSessions.create();
    setCookies(res, [cookieValue(ADMIN_SESSION_COOKIE_NAME, sid)]);
    authDebug("admin-login-success", { sid: shortValue(sid) });
    return true;
  }

  function loginUser(res, input = {}) {
    const resolvedLoginUserId = Number(input.loginUserId || input.id || 0);
    const usrid = input.usrid || "";
    const displayName = input.displayName || "";
    if (!resolvedLoginUserId) {
      authDebug("user-login-failed", { reason: "missing-login-user-id" });
      return false;
    }
    const sid = userSessions.create({ loginUserId: resolvedLoginUserId, usrid, displayName });
    setCookies(res, [cookieValue(USER_SESSION_COOKIE_NAME, sid)]);
    authDebug("user-login-success", {
      sid: shortValue(sid),
      loginUserId: resolvedLoginUserId,
      usrid
    });
    return true;
  }

  function logoutAdmin(res, sid) {
    if (sid) {
      adminSessions.remove(sid);
    }
    setCookies(res, [clearCookie(ADMIN_SESSION_COOKIE_NAME)]);
    authDebug("admin-logout", { sid: shortValue(sid || "") });
  }

  function logoutUser(res, sid) {
    if (sid) {
      userSessions.remove(sid);
    }
    setCookies(res, [clearCookie(USER_SESSION_COOKIE_NAME)]);
    authDebug("user-logout", { sid: shortValue(sid || "") });
  }

  function logoutAll(res, authState) {
    if (authState?.admin?.sid) {
      adminSessions.remove(authState.admin.sid);
    }
    if (authState?.user?.sid) {
      userSessions.remove(authState.user.sid);
    }
    setCookies(res, [clearCookie(ADMIN_SESSION_COOKIE_NAME), clearCookie(USER_SESSION_COOKIE_NAME)]);
    authDebug("logout-all", {
      adminSid: shortValue(authState?.admin?.sid || ""),
      userSid: shortValue(authState?.user?.sid || "")
    });
  }

  return {
    getAuthState,
    login,
    loginUser,
    logoutAdmin,
    logoutUser,
    logoutAll
  };
}

module.exports = {
  createAuthService
};
