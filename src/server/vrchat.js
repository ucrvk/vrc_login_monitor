const path = require("path");
const fs = require("fs");
const { VRChat } = require("vrchat");
const {
  APP_INFO,
  SUPPORTED_EVENT_TYPES,
  isNonEmptyString
} = require("./config");

function readEventUser(content) {
  const user = content && typeof content === "object" ? content.user : null;
  const userId = isNonEmptyString(content?.userId) ? content.userId.trim() : "";
  return {
    id: isNonEmptyString(user?.id) ? user.id.trim() : userId,
    username: isNonEmptyString(user?.username) ? user.username.trim() : "",
    displayName: isNonEmptyString(user?.displayName) ? user.displayName.trim() : ""
  };
}

function getUserLabel(content) {
  const eventUser = readEventUser(content);
  return eventUser.displayName || eventUser.username || "好友";
}

async function buildEventMessage(eventType, content) {
  const userLabel = getUserLabel(content);
  if (eventType === "friend-online") {
    return `${userLabel}上线了`;
  }
  if (eventType === "friend-offline") {
    return `${userLabel}下线了`;
  }
  if (eventType === "friend-location") {
    const location = isNonEmptyString(content?.location) ? content.location.trim() : "";
    const travelingToLocation = isNonEmptyString(content?.travelingToLocation)
      ? content.travelingToLocation.trim()
      : "";
    if (location === "traveling") {
      return "";
    }
    const target = travelingToLocation || location;
    if (target === "private" || content?.worldId === "private") {
      return "";
    }
    const worldName = isNonEmptyString(content?.world?.name) ? content.world.name.trim() : target;
    return `${userLabel}更换房间到了${worldName || "未知房间"}`;
  }
  if (eventType === "friend-add") {
    return `${userLabel}添加你为好友`;
  }
  if (eventType === "friend-delete") {
    return `${userLabel}删除了你的好友`;
  }
  return eventType;
}

function createEventPayload(eventType, content) {
  return buildEventMessage(eventType, content).then((message) => {
    if (!isNonEmptyString(message)) {
      return null;
    }
    return {
      type: eventType,
      message,
      content,
      timestamp: Date.now()
    };
  });
}

const notifySenderCache = new Map();

function getNotifySender(method) {
  if (notifySenderCache.has(method)) {
    return notifySenderCache.get(method);
  }
  const filePath = path.resolve(process.cwd(), "notify", `${method}.js`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`通知器不存在: ${method}`);
  }
  const mod = require(filePath);
  const send = typeof mod === "function" ? mod : mod && mod.send;
  if (typeof send !== "function") {
    throw new Error(`通知器缺少 send: ${method}`);
  }
  notifySenderCache.set(method, send);
  return send;
}

function createVrchatClient() {
  return new VRChat({
    application: APP_INFO,
    authentication: {
      optimistic: false
    }
  });
}

function normalizeFactorName(name) {
  if (name === "emailotp" || name === "emailOtp") {
    return "emailOtp";
  }
  if (name === "totp") {
    return "totp";
  }
  if (name === "otp") {
    return "otp";
  }
  return "";
}

function readUserIdentity(userData) {
  const usrid = isNonEmptyString(userData?.id) ? userData.id.trim() : "";
  const displayName = isNonEmptyString(userData?.displayName) ? userData.displayName.trim() : "";
  return { usrid, displayName };
}

function authHeadersByToken(token) {
  return {
    cookie: `auth=${token}`
  };
}

function resolveTargetUserIdFromEvent(content) {
  const eventUser = readEventUser(content);
  return eventUser.id || "";
}

function getWebSocketFromClient(client) {
  const pipeline = client?.pipeline;
  return (
    pipeline?.socket ||
    pipeline?.ws ||
    pipeline?.websocket ||
    pipeline?.connection?.socket ||
    null
  );
}

function closeClientSocket(client) {
  try {
    const ws = getWebSocketFromClient(client);
    if (ws && typeof ws.close === "function") {
      ws.close();
    }
  } catch (_error) {
    // ignore
  }
}

function createVrchatService(repositories) {
  const sdk = createVrchatClient();
  const loginFlows = new Map();
  const LOGIN_FLOW_TTL_MS = 5 * 60 * 1000;

  const state = {
    started: false,
    reconciling: false,
    lastReconciledAt: null,
    connections: new Map()
  };

  function listNotifyMethods() {
    return ["serverchanV3"];
  }

  function cleanupLoginFlows() {
    const cutoff = Date.now() - LOGIN_FLOW_TTL_MS;
    for (const [flowId, flow] of loginFlows.entries()) {
      if (flow.createdAt < cutoff) {
        loginFlows.delete(flowId);
      }
    }
  }

  async function verifyTokenWithSdk(token) {
    if (!isNonEmptyString(token)) {
      return null;
    }
    try {
      const response = await sdk.verifyAuthToken({
        credentials: "omit",
        headers: {
          cookie: `auth=${token}`
        }
      });
      if (response?.data?.ok && isNonEmptyString(response.data.token)) {
        return response.data.token;
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  async function getCurrentUserWithToken(token) {
    try {
      const result = await sdk.getCurrentUser({
        credentials: "omit",
        headers: {
          cookie: `auth=${token}`
        },
        throwOnError: false
      });
      if (result?.data && !result?.error) {
        return result.data;
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  async function verifyAndPersistToken(tokenInput) {
    const normalized = isNonEmptyString(tokenInput) ? tokenInput.trim() : "";
    if (!normalized) {
      return { ok: false, error: "token 为空" };
    }

    const verified = await verifyTokenWithSdk(normalized);
    if (!verified) {
      return { ok: false, error: "token 校验失败" };
    }

    const user = await getCurrentUserWithToken(verified);
    const identity = readUserIdentity(user);
    if (!identity.usrid || !identity.displayName) {
      return { ok: false, error: "无法通过 token 获取 /auth/user 信息" };
    }

    const loginUserId = repositories.upsertLoginUserByIdentityAndToken({
      usrid: identity.usrid,
      displayName: identity.displayName,
      token: verified
    });

    await reconcileConnections();

    return {
      ok: true,
      token: verified,
      loginUser: {
        id: loginUserId,
        usrid: identity.usrid,
        displayName: identity.displayName
      }
    };
  }

  async function dispatchChannels(channels, payload) {
    for (const channel of channels) {
      try {
        const send = getNotifySender(channel.method);
        await send(payload, channel.options || {});
      } catch (error) {
        console.error(`通知失败(loginUser=${channel.loginUserId}, method=${channel.method}):`, error?.message || error);
      }
    }
  }

  async function handleEventForLoginUser(loginUserId, eventType, content) {
    const enrichedContent = await enrichEventContentForMessage(loginUserId, eventType, content);
    const payload = await createEventPayload(eventType, enrichedContent);
    if (!payload) {
      return;
    }

    const subscriptions = repositories.listEnabledSubscriptionsByLoginUserAndEventType(loginUserId, eventType);
    if (!subscriptions.length) {
      return;
    }

    if (eventType === "friend-add" || eventType === "friend-delete") {
      const channels = repositories.getChannelsByLoginUserId(loginUserId).map((row) => ({
        loginUserId,
        method: "serverchanV3",
        options: {
          sendkey: row.token
        }
      }));
      if (!channels.length) {
        return;
      }
      await dispatchChannels(channels, payload);
      return;
    }

    const eventTargetUsrid = resolveTargetUserIdFromEvent(enrichedContent);
    let matched = false;
    for (const sub of subscriptions) {
      if (!isNonEmptyString(sub.dest_usrid)) {
        matched = true;
        break;
      }
      if (isNonEmptyString(eventTargetUsrid) && sub.dest_usrid === eventTargetUsrid) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      return;
    }

    const channels = repositories.getChannelsByLoginUserId(loginUserId).map((row) => ({
      loginUserId,
      method: "serverchanV3",
      options: {
        sendkey: row.token
      }
    }));

    if (!channels.length) {
      return;
    }

    await dispatchChannels(channels, payload);
  }

  async function enrichEventContentForMessage(loginUserId, eventType, content) {
    if (eventType !== "friend-add" && eventType !== "friend-delete") {
      return content;
    }
    const userId = isNonEmptyString(content?.userId) ? content.userId.trim() : "";
    if (!userId) {
      return content;
    }
    const existedName =
      isNonEmptyString(content?.user?.displayName) ||
      isNonEmptyString(content?.user?.username);
    if (existedName) {
      return content;
    }
    const loginUser = repositories.getLoginUserById(loginUserId);
    if (!loginUser || !isNonEmptyString(loginUser.token)) {
      return content;
    }
    const user = await getUserByIdWithToken(userId, loginUser.token);
    if (!user) {
      return content;
    }
    return {
      ...(content && typeof content === "object" ? content : {}),
      userId,
      user
    };
  }

  async function listFriendsByLoginUserId(loginUserId) {
    const user = repositories.getLoginUserById(loginUserId);
    if (!user) {
      return { ok: false, error: "loginUser not found", friends: [] };
    }
    if (!isNonEmptyString(user.token)) {
      return { ok: false, error: "该用户未配置有效 token", friends: [] };
    }

    async function fetchFriendsByOfflineFlag(offline) {
      const result = await sdk.getFriends({
        throwOnError: false,
        credentials: "omit",
        headers: {
          cookie: `auth=${user.token}`
        },
        query: {
          offline
        }
      });
      if (result?.error || !Array.isArray(result?.data)) {
        return {
          ok: false,
          error: result?.error?.message || `List Friends 请求失败(offline=${offline})`,
          data: []
        };
      }
      return { ok: true, error: "", data: result.data };
    }

    const [onlinePart, offlinePart] = await Promise.all([
      fetchFriendsByOfflineFlag(false),
      fetchFriendsByOfflineFlag(true)
    ]);

    if (!onlinePart.ok || !offlinePart.ok) {
      const errors = [onlinePart.error, offlinePart.error].filter(Boolean).join("; ");
      return { ok: false, error: errors || "List Friends 请求失败", friends: [] };
    }

    const merged = [...onlinePart.data, ...offlinePart.data];
    const seen = new Set();
    const friends = [];
    for (const f of merged) {
      const usrid = isNonEmptyString(f?.id) ? f.id.trim() : "";
      const displayName = isNonEmptyString(f?.displayName) ? f.displayName.trim() : "";
      if (!usrid || !displayName || seen.has(usrid)) {
        continue;
      }
      seen.add(usrid);
      friends.push({ usrid, displayName });
    }

    return { ok: true, friends };
  }

  function scheduleReconnect(loginUserId, reason) {
    const record = state.connections.get(loginUserId);
    if (!record || record.stopped) {
      return;
    }

    if (record.reconnectTimer) {
      return;
    }

    record.status = "reconnecting";
    record.lastError = reason || record.lastError || "连接中断";
    record.reconnectAttempts += 1;

    const delay = Math.min(60000, Math.pow(2, Math.max(0, record.reconnectAttempts - 1)) * 1000);
    record.reconnectTimer = setTimeout(async () => {
      record.reconnectTimer = null;
      await connectForLoginUser(loginUserId, { forceRecreate: true });
    }, delay);
  }

  async function connectForLoginUser(loginUserId, options = {}) {
    const forceRecreate = !!options.forceRecreate;
    const user = repositories.getLoginUserById(loginUserId);
    if (!user || !isNonEmptyString(user.token)) {
      disconnectForLoginUser(loginUserId, "缺少可用 token");
      return;
    }

    const existing = state.connections.get(loginUserId);
    const sameToken = existing && existing.token === user.token;
    if (!forceRecreate && sameToken && (existing.status === "connected" || existing.status === "connecting")) {
      return;
    }

    if (existing) {
      disconnectForLoginUser(loginUserId, "重建连接", true);
    }

    console.log(
      `[WS] 创建连接 loginUserId=${loginUserId} usrid=${user.usrid || ""} displayName=${user.display_name || ""}`
    );

    const client = createVrchatClient();
    const record = {
      loginUserId,
      usrid: user.usrid,
      displayName: user.display_name,
      token: user.token,
      status: "connecting",
      reconnectAttempts: 0,
      reconnectTimer: null,
      lastError: "",
      connectedAt: null,
      stopped: false,
      client
    };
    state.connections.set(loginUserId, record);

    for (const eventType of SUPPORTED_EVENT_TYPES) {
      client.on(eventType, async (content) => {
        try {
          await handleEventForLoginUser(loginUserId, eventType, content);
        } catch (error) {
          console.error(`处理事件失败(loginUser=${loginUserId}, type=${eventType}):`, error?.message || error);
        }
      });
    }

    try {
      await client.pipeline.authenticate(user.token);
      record.status = "connected";
      record.reconnectAttempts = 0;
      record.lastError = "";
      record.connectedAt = Date.now();

      const ws = getWebSocketFromClient(client);
      if (ws && typeof ws.on === "function") {
        ws.on("close", () => {
          scheduleReconnect(loginUserId, "WS 已关闭");
        });
        ws.on("error", (err) => {
          scheduleReconnect(loginUserId, err?.message || "WS 错误");
        });
      }
    } catch (error) {
      record.status = "error";
      record.lastError = error?.message || "认证失败";
      scheduleReconnect(loginUserId, record.lastError);
    }
  }

  function disconnectForLoginUser(loginUserId, reason, keepEntry) {
    const record = state.connections.get(loginUserId);
    if (!record) {
      return;
    }

    console.log(
      `[WS] 主动断开连接 loginUserId=${loginUserId} usrid=${record.usrid || ""} reason=${reason || "unknown"}`
    );

    record.stopped = true;
    if (record.reconnectTimer) {
      clearTimeout(record.reconnectTimer);
      record.reconnectTimer = null;
    }

    record.status = "stopped";
    record.lastError = reason || "";
    closeClientSocket(record.client);

    if (!keepEntry) {
      state.connections.delete(loginUserId);
    }
  }

  async function reconcileConnections() {
    if (state.reconciling) {
      return;
    }

    state.reconciling = true;
    try {
      const desiredUsers = repositories
        .listLoginUsersWithEnabledSubscriptions()
        .filter((u) => isNonEmptyString(u.token));

      const desiredIds = new Set(desiredUsers.map((u) => Number(u.id)));
      for (const user of desiredUsers) {
        await connectForLoginUser(Number(user.id));
      }

      for (const loginUserId of Array.from(state.connections.keys())) {
        if (!desiredIds.has(Number(loginUserId))) {
          disconnectForLoginUser(Number(loginUserId), "无启用订阅或无 token", false);
        }
      }

      state.started = true;
      state.lastReconciledAt = Date.now();
    } finally {
      state.reconciling = false;
    }
  }

  async function startMonitoringIfPossible() {
    await reconcileConnections();
    return { started: true };
  }

  function getStatus() {
    const details = Array.from(state.connections.values()).map((record) => ({
      loginUserId: record.loginUserId,
      usrid: record.usrid || "",
      displayName: record.displayName || "",
      status: record.status,
      tokenTail: isNonEmptyString(record.token) ? record.token.slice(-6) : "",
      lastError: record.lastError || "",
      connectedAt: record.connectedAt || null
    }));

    const active = details.find((item) => item.status === "connected") || null;

    return {
      monitoringStarted: state.started,
      activeUserId: active ? active.loginUserId : null,
      activeTokenTail: active ? active.tokenTail : "",
      totalConnections: details.length,
      connectedCount: details.filter((d) => d.status === "connected").length,
      reconnectingCount: details.filter((d) => d.status === "reconnecting").length,
      errorCount: details.filter((d) => d.status === "error").length,
      reconciling: state.reconciling,
      lastReconciledAt: state.lastReconciledAt,
      connections: details
    };
  }

  async function startLoginWithPassword({ username, password }) {
    if (!isNonEmptyString(username) || !isNonEmptyString(password)) {
      throw new Error("username and password are required");
    }

    cleanupLoginFlows();
    const client = createVrchatClient();

    const initial = await client.getCurrentUser({
      credentials: "omit",
      responseTransformer: undefined,
      throwOnError: false,
      headers: {
        authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(username.trim())}:${encodeURIComponent(password.trim())}`,
          "utf8"
        ).toString("base64")}`
      }
    });

    if (!initial?.data) {
      return {
        ok: false,
        error: initial?.error?.message || "账号或密码错误"
      };
    }

    const methods = Array.isArray(initial.data.requiresTwoFactorAuth)
      ? initial.data.requiresTwoFactorAuth.map((m) => normalizeFactorName(String(m))).filter(Boolean)
      : [];

    if (!methods.length) {
      const verified = await client.verifyAuthToken({ throwOnError: false });
      const token = verified?.data?.token;
      if (!isNonEmptyString(token)) {
        return { ok: false, error: "登录成功但未获取到 token" };
      }
      return verifyAndPersistToken(token);
    }

    const flowId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    loginFlows.set(flowId, {
      createdAt: Date.now(),
      client,
      methods
    });

    return {
      ok: true,
      requiresTwoFactor: true,
      flowId,
      methods: methods.map((m) => (m === "emailOtp" ? "emailotp" : m))
    };
  }

  async function completeLoginWithFactor({ flowId, method, code }) {
    cleanupLoginFlows();
    const flow = loginFlows.get(flowId);
    if (!flow) {
      return { ok: false, error: "登录流程不存在或已过期" };
    }

    const normalizedMethod = normalizeFactorName(method);
    if (!normalizedMethod || !flow.methods.includes(normalizedMethod)) {
      return { ok: false, error: "当前登录流程不支持该验证方式" };
    }
    if (!isNonEmptyString(code)) {
      return { ok: false, error: "验证码不能为空" };
    }

    try {
      let result = null;
      if (normalizedMethod === "totp") {
        result = await flow.client.verify2Fa({
          throwOnError: false,
          body: { code: code.trim() }
        });
      } else if (normalizedMethod === "otp") {
        result = await flow.client.verifyRecoveryCode({
          throwOnError: false,
          body: { code: code.trim() }
        });
      } else {
        result = await flow.client.verify2FaEmailCode({
          throwOnError: false,
          body: { code: code.trim() }
        });
      }

      if (!result?.data?.verified) {
        return { ok: false, error: result?.error?.message || "验证码校验失败" };
      }

      const verified = await flow.client.verifyAuthToken({ throwOnError: false });
      const token = verified?.data?.token;
      if (!isNonEmptyString(token)) {
        return { ok: false, error: "验证成功但未获取 token" };
      }

      loginFlows.delete(flowId);
      return verifyAndPersistToken(token);
    } catch (error) {
      return { ok: false, error: error?.message || "二次验证失败" };
    }
  }

  async function sendNotifyTestByToken(tokenInput) {
    const token = isNonEmptyString(tokenInput) ? tokenInput.trim() : "";
    if (!token) {
      return { ok: false, error: "通知 token 为空" };
    }

    try {
      const send = getNotifySender("serverchanV3");
      await send(
        {
          type: "notify-test",
          message: "这是一条测试通知",
          content: {
            source: "dashboard",
            kind: "manual-test"
          },
          timestamp: Date.now()
        },
        {
          sendkey: token,
          title: "VRChat Monitor 测试通知"
        }
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "测试通知发送失败" };
    }
  }

  async function getUserByIdWithToken(userId, token) {
    const result = await sdk.getUser({
      throwOnError: false,
      credentials: "omit",
      headers: authHeadersByToken(token),
      path: { userId }
    });
    if (result?.error || !result?.data) {
      return null;
    }
    return result.data;
  }

  return {
    listFriendsByLoginUserId,
    completeLoginWithFactor,
    getStatus,
    listNotifyMethods,
    reconcileConnections,
    sendNotifyTestByToken,
    startLoginWithPassword,
    startMonitoringIfPossible
  };
}

module.exports = {
  createVrchatService
};
