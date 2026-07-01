const RIVER_BASE = "https://www.river.go.jp/kawabou";
const DEFAULT_PREF_CODES = ["2501", "2601", "2701", "2801", "2901", "3001"];
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

  const prefCodes = getPrefCodes(req.query?.prefCodes);
  try {
    const time = await getCurrentTime();
    const snapshots = await Promise.all(prefCodes.map(async (prefCode) => {
      const [stationCollection, levelCollection] = await Promise.all([
        fetchStationCollection(prefCode, time),
        fetchLevelCollection(prefCode)
      ]);
      return { stationCollection, levelCollection };
    }));
    const features = snapshots.flatMap(({ stationCollection, levelCollection }) => {
      const levelIndex = buildLevelIndex(levelCollection);
      return normalizeStationFeatures(stationCollection, levelIndex);
    });
    sendJson(res, 200, {
      ok: true,
      fetchedAt: new Date().toISOString(),
      source: "国土交通省「川の防災情報」",
      sourceUrl: "https://www.river.go.jp/",
      currentTime: time.label,
      prefCodes,
      featureCount: features.length,
      data: {
        type: "FeatureCollection",
        features
      }
    }, {
      "cache-control": "public, s-maxage=300, stale-while-revalidate=600"
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: "River station request failed",
      detail: error.message
    });
  }
};

function getPrefCodes(value) {
  const raw = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const requested = raw.length ? raw : DEFAULT_PREF_CODES;
  const filtered = requested.filter((code) => ALLOWED_PREF_CODES.has(code));
  return filtered.length ? Array.from(new Set(filtered)) : DEFAULT_PREF_CODES;
}

async function getCurrentTime() {
  const data = await fetchJson(`${RIVER_BASE}/file/system/tmCrntTime.json`);
  const label = String(data.crntObsTime || "");
  const match = label.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Invalid current time response");
  return {
    label,
    date: `${match[1]}${match[2]}${match[3]}`,
    hm: `${match[4]}${match[5]}`
  };
}

async function fetchStationCollection(prefCode, time) {
  const candidates = buildTimeCandidates(time);
  let lastError;
  for (const candidate of candidates) {
    try {
      return await fetchJson(`${RIVER_BASE}/file/gjson/obs/${candidate.date}/${candidate.hm}/stg/${prefCode}.json`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`No station data for ${prefCode}`);
}

async function fetchLevelCollection(prefCode) {
  return fetchJson(`${RIVER_BASE}/file/files/obslist/twninfo/tm/stg/${prefCode}.json`);
}

function buildLevelIndex(collection) {
  const index = new Map();
  const towns = Array.isArray(collection?.prefTwn) ? collection.prefTwn : [];
  towns.forEach((town) => {
    const levels = Array.isArray(town.stg) ? town.stg : [];
    levels.forEach((item) => {
      if (item?.obsFcd) index.set(String(item.obsFcd), item);
    });
  });
  return index;
}

function buildTimeCandidates(time) {
  const year = Number(time.date.slice(0, 4));
  const month = Number(time.date.slice(4, 6)) - 1;
  const day = Number(time.date.slice(6, 8));
  const hour = Number(time.hm.slice(0, 2));
  const minute = Number(time.hm.slice(2, 4));
  const base = Date.UTC(year, month, day, hour, minute);
  return [0, 5, 10, 15].map((offset) => {
    const date = new Date(base - offset * 60 * 1000);
    return {
      date: `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`,
      hm: `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}`
    };
  });
}

function normalizeStationFeatures(collection, levelIndex) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  return features
    .filter((feature) => feature?.geometry?.type === "Point")
    .map((feature) => {
      const p = feature.properties || {};
      const obsFcd = String(p.obs_fcd || "");
      const observation = levelIndex.get(obsFcd) || null;
      const thresholds = {
        standby: toNumber(p.rsrv_stg),
        floodWatch: toNumber(p.warn_stg),
        evacuation: toNumber(p.spcl_warn_stg),
        danger: toNumber(p.dng_stg),
        flood: toNumber(p.fld_stg)
      };
      const latest = normalizeObservation(observation, thresholds);
      return {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          stationId: obsFcd,
          obsFcd,
          ofcCd: numberOrString(p.ofc_cd),
          itemKindCode: numberOrString(p.itmknd_cd),
          obsCd: numberOrString(p.obs_cd),
          name: p.obs_nm || p.obs_nm_s || "水位観測所",
          shortName: p.obs_nm_s || p.obs_nm || "水位観測所",
          prefCode: String(p.pref_cd || ""),
          townCode: numberOrString(p.twn_cd),
          riverCode: numberOrString(p.rvr_cd),
          latitude: toNumber(p.lat),
          longitude: toNumber(p.lon),
          lastStationTime: p.obs_time || "",
          statusCode: numberOrString(p.stg_ccd),
          overLevel: numberOrString(p.stg_ovlvl),
          reservoirStage: toNumber(p.rsrv_stg),
          warningStage: toNumber(p.warn_stg),
          specialWarningStage: toNumber(p.spcl_warn_stg),
          dangerStage: toNumber(p.dng_stg),
          floodStage: toNumber(p.fld_stg),
          latestObservedAt: latest.observedAtJst,
          latestWaterLevel: latest.waterLevel,
          latestWaterLevelHeight: latest.waterLevelHeight,
          latestTenMinuteChange: latest.tenMinuteChange,
          latestQualityFlag: latest.qualityFlag,
          latestStatusCode: latest.statusCode,
          latestOverLevel: latest.overLevel,
          latestStatusLabel: latest.statusLabel,
          displayStatus: latest.status,
          source: "国土交通省 川の防災情報"
        }
      };
    });
}

function normalizeObservation(item, thresholds) {
  if (!item) {
    return {
      observedAtJst: "",
      waterLevel: null,
      waterLevelHeight: null,
      tenMinuteChange: null,
      qualityFlag: null,
      statusCode: null,
      overLevel: null,
      status: "missing",
      statusLabel: statusLabels.missing
    };
  }
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
    statusLabel: statusLabels[status] || "不明"
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

function numberOrString(value) {
  return value === null || value === undefined ? "" : value;
}
