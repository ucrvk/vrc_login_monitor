const fs = require("fs");
const path = require("path");
const { JWT } = require("google-auth-library");

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseServiceAccountKey(input) {
  if (input && typeof input === "object") {
    return input;
  }

  if (!isNonEmptyString(input)) {
    throw new Error("fcm: options.serviceAccountKey is required");
  }

  const maybePath = path.resolve(process.cwd(), input);
  if (fs.existsSync(maybePath)) {
    const raw = fs.readFileSync(maybePath, "utf8");
    return JSON.parse(raw);
  }

  try {
    return JSON.parse(input);
  } catch (_error) {
    throw new Error("fcm: options.serviceAccountKey must be a JSON object, JSON string, or file path");
  }
}

function getTargetToken(options) {
  const token = options.targetToken || options.token;
  if (!isNonEmptyString(token)) {
    throw new Error("fcm: options.targetToken is required");
  }
  return token;
}

async function getAccessToken(serviceAccount) {
  const clientEmail = serviceAccount.client_email;
  const privateKey = serviceAccount.private_key;
  if (!isNonEmptyString(clientEmail) || !isNonEmptyString(privateKey)) {
    throw new Error("fcm: service account key must include client_email and private_key");
  }

  const jwt = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [FCM_SCOPE]
  });

  const result = await jwt.authorize();
  if (!isNonEmptyString(result.access_token)) {
    throw new Error("fcm: failed to get access token");
  }

  return result.access_token;
}

async function sendFcm(payload, options = {}) {
  const targetToken = getTargetToken(options);
  const serviceAccount = parseServiceAccountKey(options.serviceAccountKey);
  const projectId = options.projectId || serviceAccount.project_id;
  if (!isNonEmptyString(projectId)) {
    throw new Error("fcm: projectId is required (options.projectId or serviceAccount.project_id)");
  }

  const accessToken = await getAccessToken(serviceAccount);
  const title = options.title || `VRChat ${payload.type}`;
  const body = options.body || payload.message || payload.type;

  const endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const requestBody = {
    message: {
      token: targetToken,
      notification: {
        title,
        body
      },
      data: {
        eventType: String(payload.type || ""),
        timestamp: String(payload.timestamp || Date.now()),
        payload: JSON.stringify(payload.content || {})
      }
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(requestBody)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`fcm: HTTP ${response.status} ${text}`);
  }
}

module.exports = {
  send: sendFcm
};
