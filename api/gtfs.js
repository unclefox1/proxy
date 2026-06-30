const MAX_BODY_BYTES = 8 * 1024;
const MAX_UPSTREAM_BYTES = 20 * 1024 * 1024;

const ALLOWED_URLS = [
  /^https:\/\/loc\.bus-vision\.jp\/(?:realtime|gtfs|gtfs_v2)\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/api\.gtfs-data\.jp\/v2\/organizations\/[A-Za-z0-9_.-]+\/feeds\/[A-Za-z0-9_.-]+\/files\/feed\.zip$/,
  /^https:\/\/bus-vision\.jp\/realtime\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/bus-vision\.jp\/gtfs_v2\/[A-Za-z0-9_./-]+\/gtfsFeed$/,
  /^https:\/\/km\.bus-vision\.jp\/realtime\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/realtime\.gtfs\.info\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/nagai\.nolbe\.net\/buslocation\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/(?:gunbus|kanetsu|ncb)\.nolbe\.net\/buslocation\/[A-Za-z0-9_./-]+$/,
  /^https?:\/\/(?:akaiwa|takubus)\.bustei\.net\/[A-Za-z0-9_./-]+\.pb$/,
  /^https:\/\/akita\.bustei\.net\/[A-Za-z0-9_./-]+\.pb$/,
  /^http:\/\/kumagaya\.bus-go\.com\/GTFS-RT\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/ajt-mobusta-gtfs\.mcapps\.jp\/(?:realtime|static)\/[0-9]+\/[A-Za-z0-9_./-]+(?:\.zip|\.bin)$/,
  /^https:\/\/s3-ajt-mobusta-gtfs\.s3\.ap-northeast-1\.amazonaws\.com\/realtime\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/gtfs-rt-files\.buscatch\.jp\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/gtfs\.yanbaru-bus-navi\.com\/gtfs-rt\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/[a-z0-9-]+\.kochi-mobility\.net\/gtfs-rt\/[A-Za-z0-9_./-]+\.pb$/,
  /^https:\/\/(?:www\.)?gunbus\.co\.jp\/GTFS\/[A-Za-z0-9_./()-]+\.zip$/,
  /^https:\/\/kan-etsu\.net\/relays\/download\/[A-Za-z0-9_./?&=%()-]+$/,
  /^https:\/\/ncb\.jp\/route\/GTFS\/[A-Za-z0-9_./()-]+(?:\.zip|\.PB)$/,
  /^https:\/\/www\.city\.akaiwa\.lg\.jp\/material\/files\/group\/[0-9]+\/[A-Za-z0-9_./-]+\.zip$/,
  /^https:\/\/www\.akita-bus\.or\.jp\/~akita-gtfs\/[A-Za-z0-9_./-]+\.zip$/,
  /^https:\/\/www\.takubus\.com\/app\/download\/[0-9]+\/[A-Za-z0-9_./-]+\.zip(?:\?[A-Za-z0-9_./%&=:-]+)?$/,
  /^https:\/\/api-public\.odpt\.org\/api\/v4\/files\/[A-Za-z0-9_./-]+\.zip(?:\?[A-Za-z0-9_./%&=:-]+)?$/,
  /^https:\/\/api-public\.odpt\.org\/api\/v4\/gtfs\/realtime\/[A-Za-z0-9_./-]+$/
];

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
  if (!isAllowedGtfsUrl(url)) {
    sendJson(res, 400, { error: "Invalid or unsupported GTFS URL" });
    return;
  }

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/octet-stream,*/*"
      }
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.byteLength > MAX_UPSTREAM_BYTES) {
      sendJson(res, 502, { error: "Upstream response too large" });
      return;
    }
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
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

function isAllowedGtfsUrl(value) {
  if (typeof value !== "string") return false;
  if (value.length > 1000) return false;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return false;
    if (url.username || url.password || url.hash) return false;
    return ALLOWED_URLS.some((pattern) => pattern.test(url.toString()));
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
