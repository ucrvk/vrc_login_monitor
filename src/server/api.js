const { SUPPORTED_EVENT_TYPES, isNonEmptyString } = require("./config");
const AUTH_DEBUG_ENABLED = process.env.AUTH_DEBUG !== "0";

function apiAuthDebug(message, payload) {
  if (!AUTH_DEBUG_ENABLED) {
    return;
  }
  const extra = payload ? ` ${JSON.stringify(payload)}` : "";
  console.log(`[API AUTH DEBUG] ${message}${extra}`);
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  
  // 保留之前已设置的头（如 Set-Cookie）
  const existingHeaders = res.getHeaders ? res.getHeaders() : {};
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...existingHeaders
  });
  res.end(body);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!isNonEmptyString(raw)) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function createApiHandler({ authService, repositories, vrchatService }) {
  return async function handleApi(req, res, url) {
    const method = (req.method || "GET").toUpperCase();
    const pathname = url.pathname;
    const authState = authService.getAuthState(req);
    const matchesAnyPath = (...candidates) => candidates.includes(pathname);

    const requireAnyAuth = () => {
      if (authState.authenticated) {
        apiAuthDebug("authorized", {
          method,
          pathname,
          role: authState.role,
          loginUserId: authState.user.loginUserId || null
        });
        return true;
      }
      apiAuthDebug("unauthorized", {
        method,
        pathname,
        role: authState.role || "",
        hasCookieHeader: !!req.headers.cookie,
        cookie: req.headers.cookie || "",
        adminAuthenticated: !!authState.admin.authenticated,
        userAuthenticated: !!authState.user.authenticated
      });
      sendJson(res, 401, { error: "unauthorized" });
      return false;
    };

    const canAccessLoginUser = (loginUserId) => {
      if (authState.admin.authenticated) {
        return true;
      }
      return authState.user.authenticated && Number(authState.user.loginUserId) === Number(loginUserId);
    };

    if (method === "POST" && matchesAnyPath("/api/admin/login", "/admin/login")) {
      const body = await parseJsonBody(req);
      if (!isNonEmptyString(body.password)) {
        sendJson(res, 400, { error: "password is required" });
        return true;
      }
      const ok = authService.login(res, body.password);
      if (!ok) {
        sendJson(res, 401, { error: "invalid password" });
        return true;
      }
      apiAuthDebug("admin-login-ok", { method, pathname });
      sendJson(res, 200, { ok: true, role: "admin" });
      return true;
    }

    if (method === "POST" && matchesAnyPath("/api/admin/logout", "/admin/logout")) {
      authService.logoutAdmin(res, authState.admin.sid);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (method === "GET" && matchesAnyPath("/api/admin/me", "/admin/me")) {
      sendJson(res, 200, {
        authenticated: !!authState.admin.authenticated,
        role: authState.admin.authenticated ? "admin" : ""
      });
      return true;
    }

    if (method === "POST" && matchesAnyPath("/api/auth/vrc/login/start", "/auth/vrc/login/start")) {
      const body = await parseJsonBody(req);
      const result = await vrchatService.startLoginWithPassword({
        username: body.username,
        password: body.password
      });
      if (result.ok && !result.requiresTwoFactor && result.loginUser) {
        const sessionOk = authService.loginUser(res, result.loginUser);
        if (sessionOk) {
          apiAuthDebug("vrc-login-start-established-session", {
            loginUserId: result.loginUser.id || result.loginUser.loginUserId || null,
            usrid: result.loginUser.usrid
          });
        } else {
          apiAuthDebug("vrc-login-start-session-failed", {
            loginUser: result.loginUser
          });
        }
      } else {
        apiAuthDebug("vrc-login-start-result", {
          ok: !!result.ok,
          requiresTwoFactor: !!result.requiresTwoFactor
        });
      }
      sendJson(res, 200, result);
      return true;
    }

    if (method === "POST" && matchesAnyPath("/api/auth/vrc/login/verify", "/auth/vrc/login/verify")) {
      const body = await parseJsonBody(req);
      const result = await vrchatService.completeLoginWithFactor({
        flowId: body.flowId,
        method: body.method,
        code: body.code
      });
      if (result.ok && result.loginUser) {
        const sessionOk = authService.loginUser(res, result.loginUser);
        if (sessionOk) {
          apiAuthDebug("vrc-login-verify-established-session", {
            loginUserId: result.loginUser.id || result.loginUser.loginUserId || null,
            usrid: result.loginUser.usrid
          });
        } else {
          apiAuthDebug("vrc-login-verify-session-failed", {
            loginUser: result.loginUser
          });
        }
      } else {
        apiAuthDebug("vrc-login-verify-result", {
          ok: !!result.ok,
          error: result.error || ""
        });
      }
      sendJson(res, 200, result);
      return true;
    }

    if (method === "POST" && matchesAnyPath("/api/auth/vrc/logout", "/auth/vrc/logout")) {
      authService.logoutUser(res, authState.user.sid);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (method === "GET" && matchesAnyPath("/api/auth/vrc/me", "/auth/vrc/me")) {
      sendJson(res, 200, {
        authenticated: !!authState.user.authenticated,
        role: authState.user.authenticated ? "user" : "",
        loginUserId: authState.user.loginUserId || null,
        usrid: authState.user.usrid || "",
        displayName: authState.user.displayName || ""
      });
      return true;
    }

    if (method === "GET" && pathname === "/api/meta") {
      if (!requireAnyAuth()) {
        return true;
      }
      sendJson(res, 200, {
        eventTypes: SUPPORTED_EVENT_TYPES,
        notifyMethods: ["serverchanV3"]
      });
      return true;
    }

    if (method === "GET" && pathname === "/api/system/status") {
      if (!requireAnyAuth()) {
        return true;
      }
      sendJson(res, 200, vrchatService.getStatus());
      return true;
    }

    if (method === "POST" && pathname === "/api/system/start-monitoring") {
      if (!requireAnyAuth()) {
        return true;
      }
      sendJson(res, 403, { ok: false, error: "总监听开关已改为系统自动管理，不可手动修改" });
      return true;
    }

    const friendsMatch = pathname.match(/^\/api\/users\/(\d+)\/friends$/);
    if (method === "GET" && friendsMatch) {
      if (!requireAnyAuth()) {
        return true;
      }
      const loginUserId = Number(friendsMatch[1]);
      if (!repositories.getLoginUserById(loginUserId)) {
        sendJson(res, 404, { error: "loginUser not found" });
        return true;
      }
      if (!canAccessLoginUser(loginUserId)) {
        sendJson(res, 403, { error: "forbidden" });
        return true;
      }
      const result = await vrchatService.listFriendsByLoginUserId(loginUserId);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error || "获取好友列表失败", destUsers: [] });
        return true;
      }
      sendJson(res, 200, { destUsers: result.friends });
      return true;
    }

    if (method === "GET" && pathname === "/api/users") {
      if (!requireAnyAuth()) {
        return true;
      }
      let users = repositories.listUsersWithDetails();
      if (!authState.admin.authenticated) {
        users = users.filter((u) => Number(u.id) === Number(authState.user.loginUserId));
      }
      sendJson(res, 200, { users });
      return true;
    }

    if (method === "POST" && pathname === "/api/users") {
      if (!requireAnyAuth()) {
        return true;
      }
      sendJson(res, 403, { error: "loginUser 仅允许通过 VRC 登录自动创建" });
      return true;
    }

    const subMatch = pathname.match(/^\/api\/users\/(\d+)\/subscriptions$/);
    if (method === "POST" && subMatch) {
      if (!requireAnyAuth()) {
        return true;
      }
      const loginUserId = Number(subMatch[1]);
      if (!repositories.getLoginUserById(loginUserId)) {
        sendJson(res, 404, { error: "loginUser not found" });
        return true;
      }
      if (!canAccessLoginUser(loginUserId)) {
        sendJson(res, 403, { error: "forbidden" });
        return true;
      }
      const body = await parseJsonBody(req);
      repositories.replaceSubscriptions(loginUserId, body.subscriptions || []);
      await vrchatService.reconcileConnections();
      const subscriptions = repositories.getSubscriptionsByLoginUserId(loginUserId).map((row) => ({
        id: row.id,
        eventType: row.event_type,
        destUsrid: row.dest_usrid || null,
        enabled: !!row.enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
      sendJson(res, 200, { subscriptions });
      return true;
    }

    const channelMatch = pathname.match(/^\/api\/users\/(\d+)\/channels$/);
    if (method === "POST" && channelMatch) {
      if (!requireAnyAuth()) {
        return true;
      }
      const loginUserId = Number(channelMatch[1]);
      if (!repositories.getLoginUserById(loginUserId)) {
        sendJson(res, 404, { error: "loginUser not found" });
        return true;
      }
      if (!canAccessLoginUser(loginUserId)) {
        sendJson(res, 403, { error: "forbidden" });
        return true;
      }
      const body = await parseJsonBody(req);
      repositories.setNotifyToken(loginUserId, body.token || "");
      const channels = repositories.getChannelsByLoginUserId(loginUserId).map((row) => ({
        id: row.id,
        token: row.token || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
      sendJson(res, 200, { channels });
      return true;
    }

    const channelTestMatch = pathname.match(/^\/api\/users\/(\d+)\/channels\/test$/);
    if (method === "POST" && channelTestMatch) {
      if (!requireAnyAuth()) {
        return true;
      }
      const loginUserId = Number(channelTestMatch[1]);
      if (!repositories.getLoginUserById(loginUserId)) {
        sendJson(res, 404, { error: "loginUser not found" });
        return true;
      }
      if (!canAccessLoginUser(loginUserId)) {
        sendJson(res, 403, { error: "forbidden" });
        return true;
      }
      const body = await parseJsonBody(req);
      const stored = repositories.getChannelsByLoginUserId(loginUserId);
      const token = isNonEmptyString(body.token)
        ? body.token.trim()
        : (stored[0] && stored[0].token) || "";
      const result = await vrchatService.sendNotifyTestByToken(token);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    const tokenMatch = pathname.match(/^\/api\/users\/(\d+)\/token$/);
    if (method === "POST" && tokenMatch) {
      if (!requireAnyAuth()) {
        return true;
      }
      sendJson(res, 403, { error: "token 仅允许通过 VRC 登录流程自动写入" });
      return true;
    }

    const legacyLoginStartMatch = pathname.match(/^\/api\/users\/(\d+)\/login\/start$/);
    if (method === "POST" && legacyLoginStartMatch) {
      sendJson(res, 410, { error: "请改用 /auth/vrc/login/start" });
      return true;
    }

    const legacyLoginVerifyMatch = pathname.match(/^\/api\/users\/(\d+)\/login\/verify$/);
    if (method === "POST" && legacyLoginVerifyMatch) {
      sendJson(res, 410, { error: "请改用 /auth/vrc/login/verify" });
      return true;
    }

    return false;
  };
}

module.exports = {
  createApiHandler,
  sendJson
};
