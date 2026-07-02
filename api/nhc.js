const MAX_BODY_BYTES = 8 * 1024;
const MAX_UPSTREAM_BYTES = 32 * 1024 * 1024;

const ALLOWED_NHC_KMZ = /^https:\/\/www\.nhc\.noaa\.gov\/gis\/best_track\/(?:al|ep|cp)\d{6}_(?:best_track|windswath)\.kmz$/i;

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return;
  }

  let body;
  try {
    body = await getJsonBody(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message || "Invalid JSON body" });
    return;
  }

  const url = body.url;
  if (!isAllowedNhcUrl(url)) {
    sendJson(res, 400, { error: "Invalid or unsupported NHC URL" });
    return;
  }

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.google-earth.kmz,application/octet-stream,*/*"
      }
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.byteLength > MAX_UPSTREAM_BYTES) {
      sendJson(res, 502, { error: "Upstream response too large" });
      return;
    }
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/vnd.google-earth.kmz");
    res.setHeader("cache-control", "public, max-age=86400");
    res.send(buffer);
  } catch (error) {
    sendJson(res, 502, { error: "Upstream request failed", detail: error.message });
  }
};

async function getJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    const size = Buffer.byteLength(JSON.stringify(req.body), "utf8");
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    return req.body;
  }

  const text = typeof req.body === "string" ? req.body : await readRawBody(req);
  if (Buffer.byteLength(text || "", "utf8") > MAX_BODY_BYTES) {
    const error = new Error("Request body too large");
    error.status = 413;
    throw error;
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data, "utf8") > MAX_BODY_BYTES) {
        const error = new Error("Request body too large");
        error.status = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isAllowedNhcUrl(value) {
  if (typeof value !== "string") return false;
  if (value.length > 500) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    return ALLOWED_NHC_KMZ.test(url.toString());
  } catch {
    return false;
  }
}

function setCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data));
}
