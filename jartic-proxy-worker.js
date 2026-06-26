const JARTIC_ENDPOINT = "https://api.jartic-open-traffic.org/geoserver";
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

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    const bodyText = await request.text();
    if (bodyText.length > 16384) {
      return json({ error: "Request body too large" }, 413);
    }

    let body;
    try {
      body = JSON.parse(bodyText || "{}");
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const endpoint = body.endpoint || JARTIC_ENDPOINT;
    if (endpoint !== JARTIC_ENDPOINT) {
      return json({ error: "Invalid endpoint" }, 400);
    }

    const typeName = body.typeNames || "";
    if (!ALLOWED_TYPE_NAMES.has(typeName)) {
      return json({ error: "Invalid typeNames" }, 400);
    }

    for (const [key, expected] of Object.entries(STATIC_PARAMS)) {
      if (body[key] !== expected) {
        return json({ error: `Invalid ${key}` }, 400);
      }
    }

    const cql = body.cql_filter || "";
    if (!isValidCqlFilter(cql)) {
      return json({ error: "Invalid cql_filter" }, 400);
    }

    const upstreamUrl = new URL(JARTIC_ENDPOINT);
    Object.entries(STATIC_PARAMS).forEach(([key, value]) => upstreamUrl.searchParams.set(key, value));
    upstreamUrl.searchParams.set("typeNames", typeName);
    const upstream = await fetch(`${upstreamUrl.toString()}&cql_filter=${encodeURIComponent(cql)}`, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...corsHeaders(),
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8"
      }
    });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8" }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
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
