const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
const { VRChat } = require("vrchat");

const CONFIG_PATH = path.resolve(__dirname, "config.json");
const APP_INFO = {
  name: "login-monitor",
  version: "1.0.0",
  contact: "https://vrchat.community/javascript"
};

function isPlainEmptyObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function parseConfigFromEnv() {
  const encoded = process.env.CONFIG;
  if (!isNonEmptyString(encoded)) {
    throw new Error("config.json 不可用，且环境变量 CONFIG 不存在");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch (_error) {
    throw new Error("环境变量 CONFIG 不是有效的 base64");
  }

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

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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
  return {
    type: eventType,
    content,
    timestamp: Date.now()
  };
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
        console.log(`[${payload.type}]`, JSON.stringify(payload.content));
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

async function promptLoginAndGetToken(vrchat) {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const username = (await rl.question("VRChat 用户名/邮箱: ")).trim();
    const password = (await rl.question("VRChat 密码: ")).trim();

    let cachedOtp = "";
    const twoFactorCode = async () => {
      if (!cachedOtp) {
        cachedOtp = (await rl.question("OTP (如需 2FA): ")).trim();
      }
      return cachedOtp;
    };

    await vrchat.login({
      username,
      password,
      twoFactorCode,
      throwOnError: true
    });

    const verified = await vrchat.verifyAuthToken({ throwOnError: true });
    const token = verified?.data?.token;

    if (!isNonEmptyString(token)) {
      throw new Error("登录成功，但未拿到可用 token");
    }

    return token;
  } finally {
    rl.close();
  }
}

async function ensureToken(vrchat, config) {
  const fromConfig = await verifyTokenWithSdk(vrchat, config.token);
  if (fromConfig) {
    if (fromConfig !== config.token) {
      config.token = fromConfig;
      saveConfig(config);
    }
    return fromConfig;
  }

  console.log("token 为空或失效，请在控制台登录...");
  const freshToken = await promptLoginAndGetToken(vrchat);
  config.token = freshToken;
  saveConfig(config);
  console.log("token 已写入 config.json");
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
