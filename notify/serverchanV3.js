function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseUidFromSendKey(sendkey) {
  const match = /^sctp(\d{5})/i.exec(sendkey);
  if (!match) {
    throw new Error("serverchanV3: sendkey format is invalid");
  }

  return match[1];
}

async function sendServerChanV3(payload, options = {}) {
  const sendkey = options.sendkey;
  if (!isNonEmptyString(sendkey)) {
    throw new Error("serverchanV3: options.sendkey is required");
  }

  const uid = parseUidFromSendKey(sendkey);
  const title = options.title || `VRChat ${payload.type}`;
  const desp = [
    `event: ${payload.type}`,
    `time: ${new Date(payload.timestamp).toISOString()}`,
    "",
    payload.message || payload.type
  ].join("\n");

  const params = new URLSearchParams({ title, desp });
  const endpoint = `https://${uid}.push.ft07.com/send/${sendkey}.send?${params.toString()}`;

  const response = await fetch(endpoint, { method: "GET" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`serverchanV3: HTTP ${response.status} ${text}`);
  }

  const result = await response.json().catch(() => null);
  if (result && result.code !== 0) {
    throw new Error(`serverchanV3: API error code=${result.code} message=${result.message || ""}`);
  }
}

module.exports = {
  send: sendServerChanV3
};
