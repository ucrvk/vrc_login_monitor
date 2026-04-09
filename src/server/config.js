const fs = require("fs");
const path = require("path");

const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || "data/app.db");
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const WEB_DIST_DIR = path.resolve(process.cwd(), "web", "dist");
const SESSION_COOKIE_NAME = "lm_sid";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const APP_INFO = {
  name: "login-monitor",
  version: "2.0.0",
  contact: "wenwen12306@gmail.com"
};
const SUPPORTED_EVENT_TYPES = [
  "friend-online",
  "friend-offline",
  "friend-location",
  "friend-add",
  "friend-delete"
];
const ADMIN_CONFIG_CANDIDATES = [
  "/data/config.tmol",
  "/data/config.toml",
  path.resolve(process.cwd(), "data", "config.tmol"),
  path.resolve(process.cwd(), "data", "config.toml")
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowMs() {
  return Date.now();
}

function parseTomlLikeContent(raw) {
  const result = {};
  const lines = String(raw || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function getConfigValueFromConfigFile(candidates) {
  for (const filePath of ADMIN_CONFIG_CANDIDATES) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!isNonEmptyString(raw)) {
      continue;
    }
    const config = parseTomlLikeContent(raw);
    for (const key of candidates) {
      const value = config[key];
      if (isNonEmptyString(value)) {
        return value.trim();
      }
    }
  }
  return "";
}

function getAdminPasswordFromConfigFile() {
  return getConfigValueFromConfigFile(["ADMIN_PASSWORD", "admin_password", "adminPassword"]);
}

function getLoginPortFromConfigFile() {
  const raw = getConfigValueFromConfigFile(["PORT", "port", "LOGIN_PORT", "login_port"]);
  if (isNonEmptyString(raw)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 65535) {
      return n;
    }
  }
  return 3688;
}

function getEnvToken() {
  const candidates = [process.env.VRC_TOKEN, process.env.VRCHAT_TOKEN, process.env.TOKEN];
  for (const token of candidates) {
    if (isNonEmptyString(token)) {
      return token.trim();
    }
  }
  return "";
}

module.exports = {
  APP_INFO,
  CONFIG_PATH,
  DB_PATH,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  SUPPORTED_EVENT_TYPES,
  WEB_DIST_DIR,
  ensureDirForFile,
  getAdminPasswordFromConfigFile,
  getLoginPortFromConfigFile,
  getEnvToken,
  isNonEmptyString,
  nowMs
};
