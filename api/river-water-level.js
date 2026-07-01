const RIVER_BASE = "https://www.river.go.jp/kawabou";
const ALLOWED_PREF_CODES = new Set([
  "101", "102", "103", "104", "105",
  "201", "301", "401", "501", "601", "701",
  "801", "901", "1001", "1101", "1201", "1301", "1401",
  "1501", "1601", "1701", "1801", "1901", "2001",
  "2101", "2201", "2301", "2401",
  "2501", "2601", "2701", "2801", "2901", "3001",
  "3101", "3201", "3301", "3401", "3501",
  "3601", "3701", "3801", "3901",
  "4001", "4101", "4201", "4301", "4401", "4501", "4601",
  "4701"
]);

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res, "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "GET only" });
    return;
  }

  const prefCode = String(req.query?.prefCode || "").trim();
  const obsFcd = String(req.query?.obsFcd || "").trim();
  if (!ALLOWED_PREF_CODES.has(prefCode)) {
    sendJson(res, 400, { ok: false, error: "Invalid prefCode" });
    return;
  }
  if (!/^\d{10,16}$/.test(obsFcd)) {
    sendJson(res, 400, { ok: false, error: "Invalid obsFcd" });
    return;
  }

  try {
    const [levelData, stationData] = await Promise.all([
      fetchJson(`${RIVER_BASE}/file/files/obslist/twninfo/tm/stg/${prefCode}.json`),
      fetchLatestStationCollection(prefCode)
    ]);
    const observation = findObservation(levelData, obsFcd);
    if (!observation) {
      sendJson(res, 404, { ok: false, error: "Observation not found" });
      return;
    }

    const stationFeature = findStationFeature(stationData, obsFcd);
    const station = normalizeStation(stationFeature?.properties || {}, prefCode, obsFcd);
    const thresholds = normalizeThresholds(stationFeature?.properties || {});
    const latest = normalizeObservation(observation, thresholds);

    sendJson(res, 200, {
      ok: true,
      source: "国土交通省「川の防災情報」",
      sourceUrl: "https://www.river.go.jp/",
      fetchedAt: new Date().toISOString(),
      station,
      thresholds,
      latest
    }, {
      "cache-control": "public, s-maxage=300, stale-while-revalidate=600"
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: "River water level request failed",
      detail: error.message
    });
  }
};

async function fetchLatestStationCollection(prefCode) {
  const current = await fetchJson(`${RIVER_BASE}/file/system/tmCrntTime.json`);
  const match = String(current.crntObsTime || "").match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Invalid current time response");
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let lastError;
  for (const offset of [0, 5, 10, 15]) {
    const date = new Date(base - offset * 60 * 1000);
    const path = `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}/${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}`;
    try {
      return await fetchJson(`${RIVER_BASE}/file/gjson/obs/${path}/stg/${prefCode}.json`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`No station metadata for ${prefCode}`);
}

function findObservation(data, obsFcd) {
  const towns = Array.isArray(data?.prefTwn) ? data.prefTwn : [];
  for (const town of towns) {
    const observations = Array.isArray(town?.stg) ? town.stg : [];
    const found = observations.find((item) => String(item.obsFcd || "") === obsFcd);
    if (found) return found;
  }
  return null;
}

function findStationFeature(collection, obsFcd) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  return features.find((feature) => String(feature?.properties?.obs_fcd || "") === obsFcd) || null;
}

function normalizeStation(properties, prefCode, obsFcd) {
  return {
    stationId: obsFcd,
    obsFcd,
    ofcCd: properties.ofc_cd ?? "",
    itemKindCode: properties.itmknd_cd ?? "",
    obsCd: properties.obs_cd ?? "",
    name: properties.obs_nm || properties.obs_nm_s || "水位観測所",
    shortName: properties.obs_nm_s || properties.obs_nm || "水位観測所",
    prefCode,
    townCode: properties.twn_cd ?? "",
    riverCode: properties.rvr_cd ?? "",
    latitude: toNumber(properties.lat),
    longitude: toNumber(properties.lon)
  };
}

function normalizeThresholds(properties) {
  return {
    standby: toNumber(properties.rsrv_stg),
    floodWatch: toNumber(properties.warn_stg),
    evacuation: toNumber(properties.spcl_warn_stg),
    danger: toNumber(properties.dng_stg),
    flood: toNumber(properties.fld_stg)
  };
}

function normalizeObservation(item, thresholds) {
  const waterLevel = toNumber(item.stg);
  const statusCode = toNumber(item.stgCcd);
  const overLevel = toNumber(item.stgOvlvl) ?? 0;
  const status = classifyStatus({ waterLevel, statusCode, overLevel, thresholds });
  return {
    observedAtJst: item.obsTime || "",
    waterLevel,
    waterLevelHeight: toNumber(item.stgHght),
    tenMinuteChange: toNumber(item.stg10mChg),
    qualityFlag: item.stgQmflg ?? null,
    statusCode,
    overLevel,
    status,
    statusLabel: statusLabels[status] || "不明",
    unit: "m"
  };
}

function classifyStatus({ waterLevel, statusCode, overLevel, thresholds }) {
  if (statusCode === null || statusCode >= 130 || waterLevel === null) return "missing";
  if ((overLevel >= 70 && (validThreshold(thresholds.danger) || validThreshold(thresholds.flood))) || reached(waterLevel, thresholds.danger) || reached(waterLevel, thresholds.flood)) return "danger";
  if ((overLevel >= 50 && validThreshold(thresholds.evacuation)) || reached(waterLevel, thresholds.evacuation)) return "evacuation";
  if ((overLevel >= 20 && validThreshold(thresholds.floodWatch)) || reached(waterLevel, thresholds.floodWatch)) return "floodWatch";
  if (reached(waterLevel, thresholds.standby)) return "standby";
  return "normal";
}

const statusLabels = {
  normal: "通常",
  standby: "水防団待機水位以上",
  floodWatch: "氾濫注意水位以上",
  evacuation: "避難判断水位以上",
  danger: "氾濫危険水位以上",
  missing: "欠測・閉局等"
};

function reached(value, threshold) {
  return Number.isFinite(value) && validThreshold(threshold) && value >= threshold;
}

function validThreshold(threshold) {
  return Number.isFinite(threshold) && threshold > 0;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "referer": `${RIVER_BASE}/pc/tmlist`,
      "user-agent": "Mozilla/5.0 (compatible; TondabayashiHazardMap/1.0)"
    }
  });
  if (!response.ok) throw new Error(`Upstream ${response.status}: ${url}`);
  const text = await response.text();
  return JSON.parse(text);
}

function setCorsHeaders(req, res, methods) {
  const origin = req.headers.origin || "";
  if (origin === "https://adeac.jp" || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
  res.setHeader("access-control-allow-methods", methods);
  res.setHeader("access-control-allow-headers", "content-type");
}

function sendJson(res, status, data, headers = {}) {
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.status(status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(JSON.stringify(data));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
