const MAX_BODY_BYTES = 256 * 1024;
const MAX_UPSTREAM_BYTES = 20 * 1024 * 1024;
const KUNISHITEI_BASE_URL = "https://kunishitei.bunka.go.jp";
const KUNISHITEI_SEARCH_PATH = "/bsys/searchlist";
const KUNISHITEI_CSV_PATH = "/utile/csv-list";
const KUNISHITEI_MAX_RESULTS = 2000;
const KUNISHITEI_MAX_SEGMENTS = 120;
const KUNISHITEI_FETCH_TIMEOUT_MS = 15000;

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
  /^https:\/\/api-public\.odpt\.org\/api\/v4\/gtfs\/realtime\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/api\.odpt\.org\/api\/v4\/gtfs\/realtime\/[A-Za-z0-9_./-]+$/,
  /^https:\/\/api\.odpt\.org\/api\/v4\/files\/[A-Za-z0-9_./-]+\.zip(?:\?[A-Za-z0-9_./%&=:-]+)?$/
];

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: "gtfs-proxy",
      odptConsumerKeyConfigured: Boolean(process.env.ODPT_CONSUMER_KEY)
    });
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

  if (body.service === "kunishitei") {
    await handleKunishiteiRequest(body, res);
    return;
  }

  const url = body.url;
  if (!isAllowedGtfsUrl(url)) {
    sendJson(res, 400, { error: "Invalid or unsupported GTFS URL" });
    return;
  }

  try {
    const upstreamUrl = buildUpstreamUrl(url);
    const upstream = await fetch(upstreamUrl, {
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
    sendJson(res, error.status || 502, { error: "Upstream request failed", detail: error.message });
  }
};

function buildUpstreamUrl(value) {
  const upstream = new URL(value);
  if (upstream.hostname !== "api.odpt.org") return upstream.toString();

  const consumerKey = process.env.ODPT_CONSUMER_KEY || "";
  if (!consumerKey) {
    const error = new Error("ODPT_CONSUMER_KEY is not configured");
    error.status = 500;
    throw error;
  }
  if (!upstream.searchParams.has("acl:consumerKey")) {
    upstream.searchParams.set("acl:consumerKey", consumerKey);
  }
  return upstream.toString();
}

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

async function handleKunishiteiRequest(body, res) {
  try {
    if (body.mode === "count") {
      const result = await countKunishiteiSegment(body.segment || {});
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (body.mode === "csv") {
      const result = await fetchKunishiteiSegmentsCsv(Array.isArray(body.segments) ? body.segments : []);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    sendJson(res, 400, { ok: false, error: "Unsupported kunishitei mode" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      error: error?.message || "Kunishitei request failed"
    });
  }
}

async function countKunishiteiSegment(segment) {
  const query = normalizeKunishiteiSegment(segment);
  const session = await createKunishiteiSession();
  const html = await postKunishiteiForm(session, KUNISHITEI_SEARCH_PATH, buildKunishiteiSearchParams(query));
  return { count: parseKunishiteiSearchCount(html), atomicCount: 1 };
}

async function fetchKunishiteiSegmentsCsv(segments) {
  if (!segments.length) throw new Error("取得条件がありません。");
  if (segments.length > KUNISHITEI_MAX_SEGMENTS) {
    throw new Error(`CSV取得条件が多すぎます（${segments.length}件）。条件を絞ってください。`);
  }
  const session = await createKunishiteiSession();
  const csvParts = [];
  let totalCount = 0;
  for (const segment of segments) {
    const query = normalizeKunishiteiSegment(segment);
    const html = await postKunishiteiForm(session, KUNISHITEI_SEARCH_PATH, buildKunishiteiSearchParams(query));
    const count = parseKunishiteiSearchCount(html);
    if (count > KUNISHITEI_MAX_RESULTS) {
      throw new Error(`${query.categoryLabel || query.categoryId} の一部条件が${KUNISHITEI_MAX_RESULTS}件を超えています。`);
    }
    if (count <= 0) continue;
    totalCount += count;
    csvParts.push(await postKunishiteiCsv(session));
  }
  const merged = mergeKunishiteiCsvTexts(csvParts);
  if (!hasKunishiteiUsableCoordinateColumns(merged)) {
    await enrichKunishiteiRowsWithCoordinates(merged);
  }
  return {
    csv: stringifyKunishiteiCsv(merged.headers, merged.rows),
    count: totalCount,
    csvPartCount: csvParts.length,
    atomicCount: segments.length
  };
}

function normalizeKunishiteiSegment(segment) {
  const categoryId = String(segment.categoryId || "").trim();
  if (!/^\d{3}$/.test(categoryId)) throw new Error("文化財分類IDが不正です。");
  return {
    categoryId,
    categoryLabel: String(segment.categoryLabel || categoryId),
    eraProfile: String(segment.eraProfile || ""),
    regionValues: normalizeKunishiteiValues(segment.regionValues),
    eraValues: normalizeKunishiteiValues(segment.eraValues)
  };
}

function normalizeKunishiteiValues(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

function buildKunishiteiSearchParams(query) {
  const params = new URLSearchParams();
  params.set("_method", "POST");
  params.set("kind_page_check", "");
  params.set("sortTarget", "area");
  params.set("sortType", "asc");
  params.set("screen_id", "index");
  params.set("page_no", "1");
  params.set("large_kind", "");
  params.set("manage_id", "");
  params.set("register_id", "");
  params.set("register_sub_id", query.categoryId);
  (query.regionValues || []).forEach((regionValue) => {
    if (regionValue) params.append("seat_pref", regionValue);
  });
  (query.eraValues || []).forEach((eraValue) => {
    if (eraValue) params.append(`era_${query.categoryId}`, eraValue);
  });
  return params;
}

async function createKunishiteiSession() {
  const response = await fetchKunishiteiOfficial(`${KUNISHITEI_BASE_URL}${KUNISHITEI_SEARCH_PATH}`, {
    headers: kunishiteiOfficialHeaders()
  }, "公式検索ページ");
  if (!response.ok) throw new Error(`公式検索ページ HTTP ${response.status}`);
  const html = await response.text();
  const cookie = extractKunishiteiCookieHeader(response.headers);
  const csrfToken = extractKunishiteiCsrfToken(html);
  if (!csrfToken) {
    const title = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    throw new Error(`公式検索ページからCSRFトークンを取得できませんでした${title ? `（${title}）` : ""}。`);
  }
  return { cookie, csrfToken };
}

async function postKunishiteiForm(session, path, params) {
  params.set("_csrfToken", session.csrfToken);
  const response = await fetchKunishiteiOfficial(`${KUNISHITEI_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...kunishiteiOfficialHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Cookie": session.cookie,
      "Origin": KUNISHITEI_BASE_URL,
      "Referer": `${KUNISHITEI_BASE_URL}${KUNISHITEI_SEARCH_PATH}`
    },
    body: params.toString()
  }, "公式検索処理");
  session.cookie = mergeKunishiteiCookieHeader(session.cookie, response.headers);
  if (!response.ok) throw new Error(`公式検索 HTTP ${response.status}`);
  const html = await response.text();
  const nextToken = extractKunishiteiCsrfToken(html);
  if (nextToken) session.csrfToken = nextToken;
  return html;
}

async function postKunishiteiCsv(session) {
  const params = new URLSearchParams();
  params.set("_method", "POST");
  params.set("_csrfToken", session.csrfToken);
  const response = await fetchKunishiteiOfficial(`${KUNISHITEI_BASE_URL}${KUNISHITEI_CSV_PATH}`, {
    method: "POST",
    headers: {
      ...kunishiteiOfficialHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Cookie": session.cookie,
      "Origin": KUNISHITEI_BASE_URL,
      "Referer": `${KUNISHITEI_BASE_URL}${KUNISHITEI_SEARCH_PATH}`,
      "Accept": "text/csv,application/octet-stream,*/*;q=0.8"
    },
    body: params.toString()
  }, "公式CSV出力");
  session.cookie = mergeKunishiteiCookieHeader(session.cookie, response.headers);
  if (!response.ok) throw new Error(`公式CSV HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "";
  const encoding = /shift[_-]?jis|cp932|sjis/i.test(contentType) ? "shift_jis" : "utf-8";
  const text = new TextDecoder(encoding).decode(buffer);
  if (/^\s*<!DOCTYPE html|<html[\s>]/i.test(text)) {
    throw new Error("公式CSV出力がHTMLを返しました。検索条件またはセッションが無効です。");
  }
  return text;
}

function kunishiteiOfficialHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 tondabayashi-hazard-map gtfs-kunishitei/1.0",
    "Accept": "text/html,application/xhtml+xml,application/xml,text/csv,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.8,en;q=0.6"
  };
}

function extractKunishiteiCsrfToken(html) {
  const source = String(html || "");
  return source.match(/name=["']_csrfToken["'][^>]*value=["']([^"']+)["']/i)?.[1]
    || source.match(/value=["']([^"']+)["'][^>]*name=["']_csrfToken["']/i)?.[1]
    || source.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1]
    || "";
}

function parseKunishiteiSearchCount(html) {
  const text = String(html || "").replace(/,/g, "");
  const match = text.match(/([0-9]+)\s*件中/);
  if (!match) {
    if (/2,?000件を超える|エラー|条件を絞/i.test(text)) return KUNISHITEI_MAX_RESULTS + 1;
    throw new Error("検索件数を公式ページから読み取れませんでした。");
  }
  return Number(match[1]) || 0;
}

function extractKunishiteiCookieHeader(headers) {
  return getKunishiteiSetCookieValues(headers)
    .map((value) => String(value).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function mergeKunishiteiCookieHeader(current, headers) {
  const map = new Map();
  String(current || "").split(/;\s*/).filter(Boolean).forEach((pair) => {
    const index = pair.indexOf("=");
    if (index > 0) map.set(pair.slice(0, index), pair.slice(index + 1));
  });
  getKunishiteiSetCookieValues(headers).forEach((value) => {
    const pair = String(value).split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) map.set(pair.slice(0, index), pair.slice(index + 1));
  });
  return Array.from(map.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
}

function getKunishiteiSetCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((item) => item.trim()).filter(Boolean);
}

function mergeKunishiteiCsvTexts(texts) {
  const headerSet = new Set();
  const rows = [];
  const seen = new Set();
  texts.forEach((text) => {
    const parsed = parseKunishiteiCsvRows(text);
    if (parsed.length < 2) return;
    const headers = parsed[0].map((value) => String(value || "").trim());
    headers.forEach((header) => headerSet.add(header));
    parsed.slice(1).forEach((row) => {
      if (!row.some((cell) => String(cell || "").trim())) return;
      const object = {};
      headers.forEach((header, index) => {
        object[header || `field_${index + 1}`] = row[index] ?? "";
      });
      const key = JSON.stringify(object);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(object);
    });
  });
  const headers = Array.from(headerSet).filter(Boolean);
  if (!headers.length) throw new Error("CSVに有効なヘッダーがありません。");
  return { headers, rows };
}

function hasKunishiteiUsableCoordinateColumns(merged) {
  const lonKey = findKunishiteiCoordinateHeader(merged.headers, ["経度", "lng", "lon", "longitude", "x", "long"]);
  const latKey = findKunishiteiCoordinateHeader(merged.headers, ["緯度", "lat", "latitude", "y"]);
  if (!lonKey || !latKey) return false;
  return merged.rows.some((row) => Number.isFinite(Number(row[lonKey])) && Number.isFinite(Number(row[latKey])));
}

function findKunishiteiCoordinateHeader(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeKunishiteiHeader);
  return headers.find((header) => {
    const normalized = normalizeKunishiteiHeader(header);
    return normalizedCandidates.some((candidate) => normalized === candidate || normalized.includes(candidate));
  }) || "";
}

function normalizeKunishiteiHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[ _\-（）()]/g, "");
}

async function enrichKunishiteiRowsWithCoordinates(merged) {
  const headers = merged.headers;
  const rows = merged.rows;
  if (!headers.includes("緯度")) headers.push("緯度");
  if (!headers.includes("経度")) headers.push("経度");
  const groups = new Map();
  rows.forEach((row) => {
    const registerId = firstKunishiteiValue(row, ["台帳ID", "register_sub_id", "register_id", "subtype"]);
    const itemId = firstKunishiteiValue(row, ["管理対象ID", "manage_id", "code", "item_id"]);
    if (!/^\d{3}$/.test(registerId) || !itemId) return;
    if (!groups.has(registerId)) groups.set(registerId, new Set());
    groups.get(registerId).add(itemId);
  });
  const coordinateMap = new Map();
  for (const [registerId, itemSet] of groups) {
    const items = Array.from(itemSet);
    for (let i = 0; i < items.length; i += 120) {
      const chunk = items.slice(i, i + 120);
      const markers = await fetchKunishiteiMapChangeGroup(registerId, chunk).catch(() => []);
      markers.forEach((marker) => {
        const code = String(marker.code || marker.item_id || marker.manage_id || "").trim();
        const lat = Number(marker.latitude);
        const lon = Number(marker.longitude);
        if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        coordinateMap.set(`${String(marker.subtype || registerId)}:${code}`, { latitude: lat, longitude: lon, marker });
      });
    }
  }
  rows.forEach((row) => {
    const registerId = firstKunishiteiValue(row, ["台帳ID", "register_sub_id", "register_id", "subtype"]);
    const itemId = firstKunishiteiValue(row, ["管理対象ID", "manage_id", "code", "item_id"]);
    const hit = coordinateMap.get(`${registerId}:${itemId}`);
    if (!hit) return;
    row["緯度"] = String(hit.latitude);
    row["経度"] = String(hit.longitude);
    if (!row["所在地"] && hit.marker.address) row["所在地"] = hit.marker.address;
    if (!row["URL"]) row["URL"] = `${KUNISHITEI_BASE_URL}/heritage/detail/${registerId}/${itemId}`;
  });
}

async function fetchKunishiteiMapChangeGroup(registerId, items) {
  const url = new URL("/search/map-change-group", KUNISHITEI_BASE_URL);
  url.searchParams.set("register_sub_id", registerId);
  items.forEach((item, index) => {
    url.searchParams.append(`items[${index}]`, item);
  });
  const response = await fetchKunishiteiOfficial(url, { headers: kunishiteiOfficialHeaders() }, "公式地図座標取得");
  if (!response.ok) throw new Error(`公式地図座標 HTTP ${response.status}`);
  const data = await response.json();
  const marker = data?.marker;
  if (Array.isArray(marker)) return marker;
  if (marker && typeof marker === "object") return [marker];
  return [];
}

async function fetchKunishiteiOfficial(url, options = {}, label = "公式サイト") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KUNISHITEI_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutSeconds = Math.round(KUNISHITEI_FETCH_TIMEOUT_MS / 1000);
      throw new Error(`${label}への接続が${timeoutSeconds}秒でタイムアウトしました。しばらく後に再試行してください。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function firstKunishiteiValue(row, keys) {
  for (const key of keys) {
    const value = String(row[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function stringifyKunishiteiCsv(headers, rows) {
  return [
    headers.map(csvEscapeKunishitei).join(","),
    ...rows.map((row) => headers.map((header) => csvEscapeKunishitei(row[header] ?? "")).join(","))
  ].join("\n");
}

function parseKunishiteiCsvRows(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cell) => String(cell || "").trim())) rows.push(row);
  return rows;
}

function csvEscapeKunishitei(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
