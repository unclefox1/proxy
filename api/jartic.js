const JARTIC_ENDPOINT = "https://api.jartic-open-traffic.org/geoserver";
const MAX_BODY_BYTES = 16 * 1024;

const ALLOWED_TYPE_NAMES = new Set([
  "t_travospublic_measure_5m",
  "t_travospublic_measure_1h",
  "t_travospublic_measure_5m_img",
  "t_travospublic_measure_1h_img"
]);

const STATIC_PARAMS = {
  service: "WFS",
  version: "2.0.0",
  request: "GetFeature",
  outputFormat: "application/json",
  srsName: "EPSG:4326",
  exceptions: "application/json"
};

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

  const endpoint = body.endpoint || JARTIC_ENDPOINT;
  if (endpoint !== JARTIC_ENDPOINT) {
    sendJson(res, 400, { error: "Invalid endpoint" });
    return;
  }

  const typeName = body.typeNames || "";
  if (!ALLOWED_TYPE_NAMES.has(typeName)) {
    sendJson(res, 400, { error: "Invalid typeNames" });
    return;
  }

  for (const [key, expected] of Object.entries(STATIC_PARAMS)) {
    if (body[key] !== expected) {
      sendJson(res, 400, { error: `Invalid ${key}` });
      return;
    }
  }

  const cql = body.cql_filter || "";
  if (!isValidCqlFilter(cql)) {
    sendJson(res, 400, { error: "Invalid cql_filter" });
    return;
  }

  try {
    const upstreamUrl = new URL(JARTIC_ENDPOINT);
    Object.entries(STATIC_PARAMS).forEach(([key, value]) => upstreamUrl.searchParams.set(key, value));
    upstreamUrl.searchParams.set("typeNames", typeName);
    const url = `${upstreamUrl.toString()}&cql_filter=${encodeURIComponent(cql)}`;
    const upstream = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    res.send(text);
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

function isValidCqlFilter(cql) {
  if (typeof cql !== "string") return false;
  const number = "(-?\\d+(?:\\.\\d+)?)";
  const roadTypes = "(?:1|3)";
  const timeCode = "\\d{12}";
  const fieldRoad = "(?:道路種別|\\\\u9053\\\\u8def\\\\u7a2e\\\\u5225)";
  const fieldTime = "(?:時間コード|\\\\u6642\\\\u9593\\\\u30b3\\\\u30fc\\\\u30c9)";
  const fieldGeom = "(?:ジオメトリ|\\\\u30b8\\\\u30aa\\\\u30e1\\\\u30c8\\\\u30ea)";
  const pattern = new RegExp(`^${fieldRoad}=${roadTypes} AND ${fieldTime}=${timeCode} AND BBOX\\(${fieldGeom},${number},${number},${number},${number},'EPSG:4326'\\)$`, "u");
  const match = cql.match(pattern);
  if (!match) return false;
  const west = Number(match[1]);
  const south = Number(match[2]);
  const east = Number(match[3]);
  const north = Number(match[4]);
  if (![west, south, east, north].every(Number.isFinite)) return false;
  if (west < 122 || east > 154 || south < 20 || north > 46) return false;
  if (east <= west || north <= south) return false;
  return (east - west) * (north - south) <= 4.0;
}
