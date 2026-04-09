const http = require("http");
const { createAuthService } = require("./src/server/auth");
const { createApiHandler, sendJson } = require("./src/server/api");
const { createDb } = require("./src/server/db");
const {
  getAdminPasswordFromConfigFile,
  getLoginPortFromConfigFile,
  DB_PATH,
  isNonEmptyString
} = require("./src/server/config");
const { createRepositories } = require("./src/server/repositories");
const { serveStatic } = require("./src/server/static");
const { createVrchatService } = require("./src/server/vrchat");

async function main() {
  const loginPort = getLoginPortFromConfigFile();
  const adminPassword = getAdminPasswordFromConfigFile();
  if (!isNonEmptyString(adminPassword)) {
    throw new Error("缺少管理员密码：请在 /data/config.tmol 或 /data/config.toml 中配置 ADMIN_PASSWORD");
  }

  const db = createDb(DB_PATH);
  const repositories = createRepositories(db);
  const authService = createAuthService(adminPassword);
  const vrchatService = createVrchatService(repositories);
  const handleApi = createApiHandler({ authService, repositories, vrchatService });

  const startupResult = await vrchatService.startMonitoringIfPossible();
  if (startupResult.started) {
    console.log("WS 已连接，开始监听事件...");
  } else {
    console.warn(`监控尚未启动: ${startupResult.reason}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${loginPort}`}`);
    
    // CORS 配置：允许携带 cookie
    const origin = req.headers.origin || `http://127.0.0.1:${loginPort}`;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    // 处理 OPTIONS 预检请求
    if ((req.method || "GET").toUpperCase() === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    
    try {
      const handled = await handleApi(req, res, url);
      if (handled) {
        return;
      }
      if ((req.method || "GET").toUpperCase() === "GET") {
        serveStatic(url.pathname, res);
        return;
      }
      sendJson(res, 404, { error: `Not Found: ${url.pathname}` });
    } catch (error) {
      const message = error?.message || String(error);
      if (message === "invalid json") {
        sendJson(res, 400, { error: message });
        return;
      }
      console.error("请求处理失败:", message);
      sendJson(res, 500, { error: message });
    }
  });

  server.on("error", (error) => {
    console.error("HTTP 服务启动失败:", error?.message || error);
  });

  server.listen(loginPort, "0.0.0.0", () => {
    console.log(`Dashboard 已启动: http://127.0.0.1:${loginPort}`);
    console.log(`SQLite: ${DB_PATH}`);
  });
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
