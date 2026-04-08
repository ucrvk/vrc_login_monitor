function getBaseUrl() {
  const base = import.meta.env.VITE_API_BASE;
  if (typeof base === "string" && base.trim()) {
    return base.trim().replace(/\/+$/, "");
  }
  return "";
}

export async function apiFetch(path, options = {}) {
  const base = getBaseUrl();
  const url = `${base}${path}`;

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || "GET",
    credentials: "include",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}
