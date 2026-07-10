const BASE_URL = "https://kunishitei.bunka.go.jp";
const SEARCH_PATH = "/bsys/searchlist";
const CSV_PATH = "/utile/csv-list";
const MAX_RESULTS = 2000;
const MAX_ATOMIC_REQUESTS = 180;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (body.mode === "count") {
      const result = await countSegment(body.segment || {});
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (body.mode === "csv") {
      const result = await fetchSegmentsCsv(Array.isArray(body.segments) ? body.segments : []);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    sendJson(res, 400, { ok: false, error: "Unsupported mode" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error?.message || "Kunishitei proxy failed"
    });
  }
};

async function countSegment(segment) {
  const atomics = expandSegment(segment);
  if (atomics.length > MAX_ATOMIC_REQUESTS) {
    throw new Error(`検索条件が多すぎます（${atomics.length}件）。地域・時代を絞ってください。`);
  }
  const session = await createOfficialSession();
  let count = 0;
  for (const atomic of atomics) {
    const html = await postOfficialForm(session, SEARCH_PATH, buildSearchParams(atomic));
    count += parseSearchCount(html);
  }
  return { count, atomicCount: atomics.length };
}

async function fetchSegmentsCsv(segments) {
  if (!segments.length) throw new Error("取得条件がありません。");
  const atomics = segments.flatMap(expandSegment);
  if (atomics.length > MAX_ATOMIC_REQUESTS) {
    throw new Error(`CSV取得条件が多すぎます（${atomics.length}件）。条件を絞ってください。`);
  }
  const session = await createOfficialSession();
  const csvParts = [];
  let totalCount = 0;
  for (const atomic of atomics) {
    const html = await postOfficialForm(session, SEARCH_PATH, buildSearchParams(atomic));
    const count = parseSearchCount(html);
    if (count > MAX_RESULTS) {
      throw new Error(`${atomic.categoryLabel || atomic.categoryId} の一部条件が${MAX_RESULTS}件を超えています。`);
    }
    if (count <= 0) continue;
    totalCount += count;
    const csv = await postOfficialCsv(session);
    csvParts.push(csv);
  }
  const merged = mergeCsvTexts(csvParts);
  if (!hasUsableCoordinateColumns(merged)) {
    await enrichRowsWithCoordinates(merged);
  }
  const csv = stringifyCsv(merged.headers, merged.rows);
  return { csv, count: totalCount, csvPartCount: csvParts.length, atomicCount: atomics.length };
}

function expandSegment(segment) {
  const categoryId = String(segment.categoryId || "").trim();
  if (!/^\d{3}$/.test(categoryId)) throw new Error("文化財分類IDが不正です。");
  const regionValues = normalizeValues(segment.regionValues);
  const eraValues = normalizeValues(segment.eraValues);
  const regions = regionValues.length ? regionValues : [""];
  const eras = segment.eraProfile ? (eraValues.length ? eraValues : [""]) : [""];
  const atomics = [];
  regions.forEach((regionValue) => {
    eras.forEach((eraValue) => {
      atomics.push({
        categoryId,
        categoryLabel: String(segment.categoryLabel || categoryId),
        eraProfile: String(segment.eraProfile || ""),
        regionValue,
        eraValue
      });
    });
  });
  return atomics;
}

function normalizeValues(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

function buildSearchParams(atomic) {
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
  params.set("register_sub_id", atomic.categoryId);
  if (atomic.regionValue) params.set("seat_pref", atomic.regionValue);
  if (atomic.eraValue) params.set(`era_${atomic.categoryId}`, atomic.eraValue);
  return params;
}

async function createOfficialSession() {
  const response = await fetch(`${BASE_URL}${SEARCH_PATH}`, {
    headers: officialHeaders()
  });
  if (!response.ok) throw new Error(`公式検索ページ HTTP ${response.status}`);
  const html = await response.text();
  const cookie = extractCookieHeader(response.headers);
  const csrfToken = extractCsrfToken(html);
  if (!csrfToken) {
    const title = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    throw new Error(`公式検索ページからCSRFトークンを取得できませんでした${title ? `（${title}）` : ""}。`);
  }
  return { cookie, csrfToken };
}

async function postOfficialForm(session, path, params) {
  params.set("_csrfToken", session.csrfToken);
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      ...officialHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Cookie": session.cookie,
      "Origin": BASE_URL,
      "Referer": `${BASE_URL}${SEARCH_PATH}`
    },
    body: params.toString()
  });
  session.cookie = mergeCookieHeader(session.cookie, response.headers);
  if (!response.ok) throw new Error(`公式検索 HTTP ${response.status}`);
  const html = await response.text();
  const nextToken = extractCsrfToken(html);
  if (nextToken) session.csrfToken = nextToken;
  return html;
}

async function postOfficialCsv(session) {
  const params = new URLSearchParams();
  params.set("_method", "POST");
  params.set("_csrfToken", session.csrfToken);
  const response = await fetch(`${BASE_URL}${CSV_PATH}`, {
    method: "POST",
    headers: {
      ...officialHeaders(),
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Cookie": session.cookie,
      "Origin": BASE_URL,
      "Referer": `${BASE_URL}${SEARCH_PATH}`,
      "Accept": "text/csv,application/octet-stream,*/*;q=0.8"
    },
    body: params.toString()
  });
  session.cookie = mergeCookieHeader(session.cookie, response.headers);
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

function officialHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 tondabayashi-hazard-map kunishitei-csv/1.0",
    "Accept": "text/html,application/xhtml+xml,application/xml,text/csv,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.8,en;q=0.6"
  };
}

function extractCsrfToken(html) {
  const source = String(html || "");
  return source.match(/name=["']_csrfToken["'][^>]*value=["']([^"']+)["']/i)?.[1]
    || source.match(/value=["']([^"']+)["'][^>]*name=["']_csrfToken["']/i)?.[1]
    || source.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i)?.[1]
    || "";
}

function parseSearchCount(html) {
  const text = String(html || "").replace(/,/g, "");
  const match = text.match(/([0-9]+)\s*件中/);
  if (!match) {
    if (/2,?000件を超える|エラー|条件を絞/i.test(text)) return MAX_RESULTS + 1;
    throw new Error("検索件数を公式ページから読み取れませんでした。");
  }
  return Number(match[1]) || 0;
}

function extractCookieHeader(headers) {
  return getSetCookieValues(headers)
    .map((value) => String(value).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

function mergeCookieHeader(current, headers) {
  const map = new Map();
  String(current || "").split(/;\s*/).filter(Boolean).forEach((pair) => {
    const index = pair.indexOf("=");
    if (index > 0) map.set(pair.slice(0, index), pair.slice(index + 1));
  });
  getSetCookieValues(headers).forEach((value) => {
    const pair = String(value).split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) map.set(pair.slice(0, index), pair.slice(index + 1));
  });
  return Array.from(map.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((item) => item.trim()).filter(Boolean);
}

function mergeCsvTexts(texts) {
  const headerSet = new Set();
  const rows = [];
  const seen = new Set();
  texts.forEach((text) => {
    const parsed = parseCsvRows(text);
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

function hasUsableCoordinateColumns(merged) {
  const lonKey = findCoordinateHeader(merged.headers, ["経度", "lng", "lon", "longitude", "x", "long"]);
  const latKey = findCoordinateHeader(merged.headers, ["緯度", "lat", "latitude", "y"]);
  if (!lonKey || !latKey) return false;
  return merged.rows.some((row) => Number.isFinite(Number(row[lonKey])) && Number.isFinite(Number(row[latKey])));
}

function findCoordinateHeader(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  return headers.find((header) => {
    const normalized = normalizeHeader(header);
    return normalizedCandidates.some((candidate) => normalized === candidate || normalized.includes(candidate));
  }) || "";
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[ _\-（）()]/g, "");
}

async function enrichRowsWithCoordinates(merged) {
  const headers = merged.headers;
  const rows = merged.rows;
  if (!headers.includes("緯度")) headers.push("緯度");
  if (!headers.includes("経度")) headers.push("経度");
  const groups = new Map();
  rows.forEach((row) => {
    const registerId = firstValue(row, ["台帳ID", "register_sub_id", "register_id", "subtype"]);
    const itemId = firstValue(row, ["管理対象ID", "manage_id", "code", "item_id"]);
    if (!/^\d{3}$/.test(registerId) || !itemId) return;
    if (!groups.has(registerId)) groups.set(registerId, new Set());
    groups.get(registerId).add(itemId);
  });
  const coordinateMap = new Map();
  for (const [registerId, itemSet] of groups) {
    const items = Array.from(itemSet);
    for (let i = 0; i < items.length; i += 120) {
      const chunk = items.slice(i, i + 120);
      const markers = await fetchMapChangeGroup(registerId, chunk).catch((error) => {
        console.warn(`Kunishitei coordinate fetch failed ${registerId}`, error);
        return [];
      });
      markers.forEach((marker) => {
        const code = String(marker.code || marker.item_id || marker.manage_id || "").trim();
        const lat = Number(marker.latitude);
        const lon = Number(marker.longitude);
        if (!code || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        coordinateMap.set(`${String(marker.subtype || registerId)}:${code}`, {
          latitude: lat,
          longitude: lon,
          marker
        });
      });
    }
  }
  rows.forEach((row) => {
    const registerId = firstValue(row, ["台帳ID", "register_sub_id", "register_id", "subtype"]);
    const itemId = firstValue(row, ["管理対象ID", "manage_id", "code", "item_id"]);
    const hit = coordinateMap.get(`${registerId}:${itemId}`);
    if (!hit) return;
    row["緯度"] = String(hit.latitude);
    row["経度"] = String(hit.longitude);
    if (!row["所在地"] && hit.marker.address) row["所在地"] = hit.marker.address;
    if (!row["URL"]) row["URL"] = `${BASE_URL}/heritage/detail/${registerId}/${itemId}`;
  });
}

async function fetchMapChangeGroup(registerId, items) {
  const url = new URL("/search/map-change-group", BASE_URL);
  url.searchParams.set("register_sub_id", registerId);
  items.forEach((item, index) => {
    url.searchParams.append(`items[${index}]`, item);
  });
  const response = await fetch(url, {
    headers: officialHeaders()
  });
  if (!response.ok) throw new Error(`公式地図座標 HTTP ${response.status}`);
  const data = await response.json();
  const marker = data?.marker;
  if (Array.isArray(marker)) return marker;
  if (marker && typeof marker === "object") return [marker];
  return [];
}

function firstValue(row, keys) {
  for (const key of keys) {
    const value = String(row[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function stringifyCsv(headers, rows) {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] ?? "")).join(","))
  ].join("\n");
}

function parseCsvRows(text) {
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

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
