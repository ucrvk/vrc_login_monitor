const fs = require("fs");
const http = require("http");
const path = require("path");

if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const { VRChat } = require("vrchat");

const CONFIG_PATH = path.resolve(__dirname, "config.json");
const LOGIN_PORT = 3688;
const APP_INFO = {
  name: "login-monitor",
  version: "1.0.0",
  contact: "https://vrchat.community/javascript"
};

function isPlainEmptyObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseConfigFromEnv() {
  const encoded = process.env.CONFIG;
  if (!isNonEmptyString(encoded)) {
    throw new Error("config.json 不可用，且环境变量 CONFIG 不存在");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!isNonEmptyString(decoded)) {
    throw new Error("环境变量 CONFIG 解码后为空");
  }

  try {
    return JSON.parse(decoded);
  } catch (_error) {
    throw new Error("环境变量 CONFIG 解码后不是有效 JSON");
  }
}

function loadConfig() {
  let config = null;

  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    if (isNonEmptyString(raw)) {
      config = JSON.parse(raw);
    }
  }

  if (!config || isPlainEmptyObject(config)) {
    config = parseConfigFromEnv();
  }

  if (!Array.isArray(config.subscriptions)) {
    throw new Error("config.json 中 subscriptions 必须是数组");
  }
  if (config.notify && !Array.isArray(config.notify)) {
    throw new Error("config.json 中 notify 必须是数组");
  }
  return config;
}

function getTokenFromEnv() {
  const candidates = [
    process.env.VRC_TOKEN,
    process.env.VRCHAT_TOKEN,
    process.env.TOKEN
  ];

  for (const token of candidates) {
    if (isNonEmptyString(token)) {
      return token.trim();
    }
  }

  return "";
}

function containsValueDeep(target, expected) {
  if (target === expected) {
    return true;
  }

  if (Array.isArray(target)) {
    return target.some((item) => containsValueDeep(item, expected));
  }

  if (target && typeof target === "object") {
    return Object.values(target).some((item) => containsValueDeep(item, expected));
  }

  return false;
}

function matchesSubscription(content, subscription) {
  if (!isNonEmptyString(subscription.dest)) {
    return true;
  }

  return containsValueDeep(content, subscription.dest);
}

function createEventPayload(eventType, content) {
  const message = buildEventMessage(eventType, content);
  if (!isNonEmptyString(message)) {
    return null;
  }

  return {
    type: eventType,
    message,
    content,
    timestamp: Date.now()
  };
}

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

  if (isNonEmptyString(eventUser.username)) {
    return eventUser.username;
  }

  if (isNonEmptyString(eventUser.displayName)) {
    return eventUser.displayName;
  }

  return "好友";
}

function normalizeLocationTarget(content) {
  const location = isNonEmptyString(content?.location) ? content.location.trim() : "";
  const travelingToLocation = isNonEmptyString(content?.travelingToLocation)
    ? content.travelingToLocation.trim()
    : "";

  if (location === "traveling" && travelingToLocation) {
    return travelingToLocation;
  }

  return location;
}

function buildEventMessage(eventType, content) {
  const userLabel = getUserLabel(content);

  if (eventType === "friend-online") {
    return `${userLabel}上线了`;
  }

  if (eventType === "friend-offline") {
    return `${userLabel}下线了`;
  }

  if (eventType === "friend-location") {
    const target = normalizeLocationTarget(content);
    const isPrivate =
      (isNonEmptyString(content?.worldId) && content.worldId.trim() === "private") ||
      target === "private";

    if (isPrivate) {
      return "";
    }

    const destination = target || "未知房间";
    return `${userLabel}更换房间到了${destination}`;
  }

  return `${eventType}`;
}

function loadNotifyHandlers(notifyConfig = []) {
  const handlers = [];

  for (const item of notifyConfig) {
    if (!item || !isNonEmptyString(item.method)) {
      continue;
    }

    const modulePath = path.resolve(__dirname, "notify", `${item.method}.js`);
    if (!fs.existsSync(modulePath)) {
      console.error(`通知器不存在: ${modulePath}`);
      continue;
    }

    const mod = require(modulePath);
    const send = typeof mod === "function" ? mod : mod && mod.send;
    if (typeof send !== "function") {
      console.error(`通知器未导出 send 方法: ${modulePath}`);
      continue;
    }

    handlers.push({
      method: item.method,
      options: item.options || {},
      send
    });
  }

  if (handlers.length === 0) {
    handlers.push({
      method: "consoleLog",
      options: {},
      send: async (payload) => {
        console.log(`[${payload.type}]`, payload.message || payload.type);
      }
    });
  }

  return handlers;
}

async function dispatchNotify(handlers, payload) {
  for (const handler of handlers) {
    try {
      await handler.send(payload, handler.options);
    } catch (error) {
      console.error(`通知失败(${handler.method}):`, error?.message || error);
    }
  }
}

async function verifyTokenWithSdk(vrchat, token) {
  if (!isNonEmptyString(token)) {
    return null;
  }

  const response = await vrchat.verifyAuthToken({
    credentials: "omit",
    headers: {
      cookie: `auth=${token}`
    }
  });

  if (response?.data?.ok && isNonEmptyString(response.data.token)) {
    return response.data.token;
  }

  return null;
}

function renderLoginPage(message = "", token = "", error = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VRChat 登录</title>
  <style>
    body { font-family: sans-serif; margin: 24px; max-width: 560px; }
    input, button { width: 100%; padding: 8px; margin: 6px 0; box-sizing: border-box; }
    .msg { color: #0a7a2f; margin: 8px 0; }
    .err { color: #b00020; margin: 8px 0; }
    .token { word-break: break-all; background: #f4f4f4; padding: 8px; }
  </style>
</head>
<body>
  <h2>VRChat 登录</h2>
  ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ""}
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
  ${token ? `<div>token:</div><div class="token">${escapeHtml(token)}</div>` : ""}
  <form method="post" action="/login">
    <label>用户名/邮箱</label>
    <input name="username" required />
    <label>密码</label>
    <input name="password" type="password" required />
    <label>OTP (可选)</label>
    <input name="otp" />
    <button type="submit">登录</button>
  </form>
</body>
</html>`;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function startWebLoginAndGetToken(vrchat, port = LOGIN_PORT) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const complete = (fn) => {
      if (finished) {
        return;
      }
      finished = true;
      fn();
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginPage("请登录 VRChat 账号"));
        return;
      }

      if (req.method === "POST" && url.pathname === "/login") {
        try {
          const rawBody = await readRequestBody(req);
          const form = new URLSearchParams(rawBody);

          const username = (form.get("username") || "").trim();
          const password = (form.get("password") || "").trim();
          const otp = (form.get("otp") || "").trim();

          if (!username || !password) {
            throw new Error("用户名和密码不能为空");
          }

          await vrchat.login({
            username,
            password,
            twoFactorCode: async () => otp,
            throwOnError: true
          });

          const verified = await vrchat.verifyAuthToken({ throwOnError: true });
          const token = verified?.data?.token;
          if (!isNonEmptyString(token)) {
            throw new Error("登录成功，但未拿到可用 token");
          }

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLoginPage("登录成功，服务即将关闭", token));

          res.on("finish", () => {
            server.close(() => {
              complete(() => resolve(token));
            });
          });
          return;
        } catch (error) {
          res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLoginPage("", "", error?.message || String(error)));
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    });

    server.on("error", (error) => {
      complete(() => reject(error));
    });

    server.listen(port, "0.0.0.0", () => {
      console.log(`token 为空或失效，请访问 http://127.0.0.1:${port} 登录`);
    });
  });
}

async function ensureToken(vrchat, config) {
  const envToken = getTokenFromEnv();
  const fromEnv = await verifyTokenWithSdk(vrchat, envToken);
  if (fromEnv) {
    return fromEnv;
  }

  const fromConfig = await verifyTokenWithSdk(vrchat, config.token);
  if (fromConfig) {
    return fromConfig;
  }

  const freshToken = await startWebLoginAndGetToken(vrchat, LOGIN_PORT);
  return freshToken;
}

function attachSubscriptions(vrchat, subscriptions, notifyHandlers) {
  const grouped = new Map();

  for (const item of subscriptions) {
    if (!item || !isNonEmptyString(item.type)) {
      continue;
    }

    if (!grouped.has(item.type)) {
      grouped.set(item.type, []);
    }

    grouped.get(item.type).push(item);
  }

  for (const [eventType, rules] of grouped) {
    vrchat.on(eventType, async (content) => {
      const matched = rules.some((rule) => matchesSubscription(content, rule));
      if (!matched) {
        return;
      }

      const payload = createEventPayload(eventType, content);
      if (!payload) {
        return;
      }

      await dispatchNotify(notifyHandlers, payload);
    });
  }
}

async function main() {
  const config = loadConfig();

  const vrchat = new VRChat({
    application: APP_INFO,
    authentication: {
      optimistic: false
    }
  });

  const notifyHandlers = loadNotifyHandlers(config.notify || []);
  const token = await ensureToken(vrchat, config);
  attachSubscriptions(vrchat, config.subscriptions, notifyHandlers);

  await vrchat.pipeline.authenticate(token);
  console.log("WS 已连接，开始监听事件...");
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
