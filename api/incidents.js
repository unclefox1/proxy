const INCIDENT_URL = "https://www.om119.jp/section/saigaiPc.html";
const COUNT_URL = "https://www.om119.jp/section/saigaiCnt.html";
const SOURCE_PAGE_URL = "https://www.om119.jp/saigai_toukei/saigaijyoho/47.html";

const ACTIVE_WORDS = ["出動中", "活動中", "対応中", "出場中", "災害対応中"];
const PAST_WORDS = ["終了", "活動終了", "処理終了", "鎮火", "救出完了", "対応終了", "出動を終了"];
const MUNICIPALITIES = ["柏原市", "羽曳野市", "藤井寺市", "富田林市", "河内長野市", "太子町", "河南町", "千早赤阪村"];

let cache = null;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=300");
}

function sendJson(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function fetchShiftJisText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 hazard-map OM119 reference fetch",
      accept: "text/html,*/*"
    }
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  return new TextDecoder("shift_jis").decode(buffer);
}

function stripTags(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:li|p|div|tr|table|ul)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDigits(text) {
  return String(text || "").replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function classifyStatus(text, sectionStatus) {
  if (sectionStatus === "active") return "active";
  if (PAST_WORDS.some((word) => text.includes(word))) return "past";
  if (ACTIVE_WORDS.some((word) => text.includes(word))) return sectionStatus === "past" ? "past" : "active";
  return sectionStatus || "unknown";
}

function statusLabel(status) {
  return { active: "出動中", past: "過去情報", unknown: "状態不明" }[status] || "状態不明";
}

function inferYear(month, day) {
  const now = new Date();
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  const diffDays = (candidate.getTime() - now.getTime()) / 86400000;
  if (diffDays > 60) year -= 1;
  return year;
}

function toJstIso(year, month, day, hour, minute) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+09:00`;
}

function extractIncidentFields(text) {
  const normalized = normalizeDigits(text);
  const match = normalized.match(/(\d{1,2})月(\d{1,2})日(\d{1,2})時(\d{1,2})分ごろ、(.+?)(?:付近)?において、(.+?)の通報により(.+?)です。?$/);
  const fallback = normalized.match(/(\d{1,2})月(\d{1,2})日(\d{1,2})時(\d{1,2})分ごろ、(.+?)(?:付近|周辺|地内)?(?:において|で)、?(.+?)(?:です。?)?$/);
  const parsed = match || fallback;
  if (!parsed) {
    const municipality = MUNICIPALITIES.find((name) => normalized.includes(name)) || "";
    return {
      datetimeText: "",
      datetime: null,
      inferredYear: false,
      municipality,
      placeText: "",
      incidentType: "",
      actionText: "",
      geocodeQuery: municipality ? `大阪府${municipality}` : "",
      precision: municipality ? "市町村付近" : "不明"
    };
  }
  const [, monthText, dayText, hourText, minuteText, placeRaw, typeRaw = "", actionRaw = ""] = parsed;
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const year = inferYear(month, day);
  const placeText = `${placeRaw.trim()}付近`;
  const municipality = MUNICIPALITIES.find((name) => placeRaw.includes(name)) || "";
  const geocodeQuery = buildGeocodeQuery(placeRaw, municipality);
  return {
    datetimeText: `${month}月${day}日${hour}時${minute}分ごろ`,
    datetime: toJstIso(year, month, day, hour, minute),
    inferredYear: true,
    municipality,
    placeText,
    incidentType: typeRaw.trim(),
    actionText: actionRaw.trim(),
    geocodeQuery,
    precision: getLocationPrecision(placeRaw)
  };
}

function buildGeocodeQuery(placeRaw, municipality) {
  const cleaned = String(placeRaw || "")
    .replace(/付近|周辺|地内/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!cleaned) return municipality ? `大阪府${municipality}` : "";
  if (cleaned.startsWith("大阪府")) return cleaned;
  return `大阪府${cleaned}`;
}

function getLocationPrecision(placeRaw) {
  const value = String(placeRaw || "");
  if (/丁目/.test(value)) return "町丁目付近";
  if (MUNICIPALITIES.some((name) => value === name)) return "市町村付近";
  return value ? "大字・町名付近" : "不明";
}

function buildIncidentId(item, index) {
  const base = [item.datetime || item.datetimeText, item.municipality, item.placeText, item.incidentType, index]
    .filter(Boolean)
    .join("-");
  return `om119-${base}`.replace(/[^\w\u3040-\u30ff\u3400-\u9fff-]+/g, "-").slice(0, 120);
}

function parseIncidentSection(html, startLabel, endLabel, status) {
  const start = html.indexOf(startLabel);
  if (start < 0) return [];
  const end = endLabel ? html.indexOf(endLabel, start + startLabel.length) : -1;
  const section = html.slice(start, end > start ? end : undefined);
  return Array.from(section.matchAll(/<li\b[\s\S]*?<\/li>/gi), (match) => stripTags(match[0]))
    .filter(Boolean)
    .map((text, index) => {
      const fields = extractIncidentFields(text);
      const itemStatus = classifyStatus(text, status);
      const item = {
        status: itemStatus,
        statusLabel: statusLabel(itemStatus),
        ...fields,
        description: text,
        sourceText: text,
        source: "大阪南消防組合 災害発生情報・災害受信件数",
        sourceUrl: SOURCE_PAGE_URL
      };
      item.id = buildIncidentId(item, index);
      return item;
    });
}

function parseIncidents(html) {
  const active = parseIncidentSection(html, "現在発生している災害", "過去の災害経過情報", "active");
  const past = parseIncidentSection(html, "過去の災害経過情報", "</body>", "past");
  return { active, past, unknown: [] };
}

function parseCounts(html) {
  const text = stripTags(html);
  const updateText = text.match(/～(.+?現在)～/)?.[1] || "";
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const cells = [];
    const cellPattern = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)\s*>/gi;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }
    if (cells.length >= 5 && cells[0]) {
      rows.push({
        label: cells[0],
        fire: cells[1],
        rescue: cells[2],
        emergency: cells[3],
        other: cells[4]
      });
    }
  }
  return { updateText, rows };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  const refresh = req.query?.refresh === "1";
  const now = Date.now();
  if (!refresh && cache && now - cache.time < 2 * 60 * 1000) {
    sendJson(res, 200, cache.body);
    return;
  }

  try {
    const [incidentHtml, countHtml] = await Promise.all([
      fetchShiftJisText(INCIDENT_URL),
      fetchShiftJisText(COUNT_URL).catch(() => "")
    ]);
    const incidents = parseIncidents(incidentHtml);
    const counts = countHtml ? parseCounts(countHtml) : { updateText: "", rows: [] };
    const body = {
      ok: true,
      source: "大阪南消防組合 災害発生情報・災害受信件数",
      sourceUrl: SOURCE_PAGE_URL,
      incidentUrl: INCIDENT_URL,
      countUrl: COUNT_URL,
      fetchedAt: new Date().toISOString(),
      counts,
      incidents,
      ...incidents
    };
    cache = { time: now, body };
    sendJson(res, 200, body);
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error.message || String(error),
      source: "大阪南消防組合 災害発生情報・災害受信件数",
      sourceUrl: SOURCE_PAGE_URL,
      active: [],
      past: [],
      unknown: [],
      counts: { updateText: "", rows: [] }
    });
  }
};
