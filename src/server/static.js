const fs = require("fs");
const path = require("path");
const { WEB_DIST_DIR } = require("./config");

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function contentTypeByExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon"
  };
  return map[ext] || "application/octet-stream";
}

function renderNoDistPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard Not Built</title>
</head>
<body style="font-family:sans-serif;margin:24px;max-width:760px;">
  <h2>Dashboard 前端尚未构建</h2>
  <p>请在项目根目录执行 <code>npm run web:build</code>。</p>
</body>
</html>`;
}

function serveStatic(reqPath, res) {
  if (!fs.existsSync(WEB_DIST_DIR)) {
    sendText(res, 200, renderNoDistPage(), "text/html; charset=utf-8");
    return true;
  }

  const requestPath = decodeURIComponent(reqPath || "/");
  const clean = requestPath.replace(/^\/+/, "");
  const candidate = path.resolve(WEB_DIST_DIR, clean);

  if (candidate.startsWith(WEB_DIST_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    const content = fs.readFileSync(candidate);
    res.writeHead(200, { "Content-Type": contentTypeByExt(candidate) });
    res.end(content);
    return true;
  }

  const indexPath = path.resolve(WEB_DIST_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf8");
    sendText(res, 200, html, "text/html; charset=utf-8");
    return true;
  }

  sendText(res, 200, renderNoDistPage(), "text/html; charset=utf-8");
  return true;
}

module.exports = {
  serveStatic,
  sendText
};
