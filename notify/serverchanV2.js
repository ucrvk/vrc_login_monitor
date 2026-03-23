function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

async function sendServerChan(payload, options = {}) {
    const sckey = options.sckey;
    if (!isNonEmptyString(sckey)) {
        throw new Error("serverchanV2: options.sckey is required");
    }

    const endpoint = `https://sctapi.ftqq.com/${sckey}.send`;
    const title = options.title || `VRChat ${payload.type}`;
    const desp = [
        `event: ${payload.type}`,
        `time: ${new Date(payload.timestamp).toISOString()}`,
        "",
        "```json",
        JSON.stringify(payload.content, null, 2),
        "```"
    ].join("\n");

    const body = new URLSearchParams({
        title,
        desp
    });

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`serverchanV2: HTTP ${response.status} ${text}`);
    }

    const result = await response.json().catch(() => null);
    if (result && result.code !== 0) {
        throw new Error(`serverchanV2: API error code=${result.code} message=${result.message || ""}`);
    }
}

module.exports = {
    send: sendServerChan
};
