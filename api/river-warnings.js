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
    const time = await getCurrentRwTime();
    const collections = await Promise.all(prefCodes.map((prefCode) => fetchWarningCollection(prefCode, time)));
    const stationCollections = await Promise.all(prefCodes.map((prefCode) => fetchStationCollection(prefCode, time)));
    const stationIndex = buildStationIndex(stationCollections);
    const features = collections.flatMap((collection, index) => {
      return normalizeWarningFeatures(collection, prefCodes[index], stationIndex);
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
      error: "River warning request failed",
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

async function getCurrentRwTime() {
  const data = await fetchJson(`${RIVER_BASE}/file/system/rwCrntTime.json`);
  const label = String(data.crntRwTime || "");
  const match = label.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Invalid river warning time response");
  return {
    label,
    date: `${match[1]}${match[2]}${match[3]}`,
    hm: `${match[4]}${match[5]}`
  };
}

async function fetchWarningCollection(prefCode, time) {
  return fetchJson(`${RIVER_BASE}/file/files/rw/list/pref/${time.date}/${time.hm}/${prefCode}.json`);
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

function buildStationIndex(collections) {
  const index = new Map();
  collections.forEach((collection) => {
    (collection?.features || []).forEach((feature) => {
      const p = feature.properties || {};
      if (p.obs_fcd && feature.geometry?.type === "Point") {
        index.set(String(p.obs_fcd), feature);
      }
    });
  });
  return index;
}

function normalizeWarningFeatures(collection, prefCode, stationIndex) {
  const features = [];
  const towns = Array.isArray(collection?.twn) ? collection.twn : [];
  towns.forEach((town) => {
    const warnings = Array.isArray(town.rw) ? town.rw : [];
    warnings.forEach((warning) => {
      if (!isDisplayableWarning(warning)) return;
      const stations = Array.isArray(warning.stgobs) ? warning.stgobs : [];
      stations.forEach((station) => {
        const stationFeature = stationIndex.get(String(station.obsFcd || ""));
        if (!stationFeature?.geometry) return;
        features.push({
          type: "Feature",
          geometry: stationFeature.geometry,
          properties: {
            id: `${warning.type || "rw"}:${warning.code || ""}:${station.obsFcd || ""}`,
            prefCode,
            townCode: town.twnCd ?? "",
            townName: town.twnNm || "",
            type: warning.type || "rw",
            typeLabel: getWarningTypeLabel(warning.type),
            riverSystemCode: warning.rsysCd ?? "",
            riverSystemName: warning.rsysNm || "",
            code: warning.code ?? "",
            name: warning.name || "",
            warningId: warning.id ?? "",
            annTime: warning.annTime || "",
            level: toNumber(warning.lvl),
            kind: warning.knd ?? "",
            kindName: warning.kndNmM || warning.kndNm || warning.kndNmS || "",
            stageTrend: warning.stgUpdwnFlg ?? "",
            obsFcd: String(station.obsFcd || ""),
            obsName: station.obsNm || station.obsNmS || "",
            stationOverLevel: toNumber(station.stgOvlvl),
            source: "国土交通省 川の防災情報"
          }
        });
      });
    });
  });
  return dedupeFeatures(features);
}

function isDisplayableWarning(warning) {
  if (!warning || !warning.type) return false;
  if (warning.annTime) return true;
  const level = toNumber(warning.lvl);
  return Number.isFinite(level) && level > 0;
}

function dedupeFeatures(features) {
  const seen = new Set();
  return features.filter((feature) => {
    const key = feature.properties.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getWarningTypeLabel(type) {
  return {
    fldfr: "洪水予報",
    evstg: "水位到達情報",
    fldctl: "洪水調節",
    damdsch: "ダム放流通知"
  }[type] || "河川情報";
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json,text/plain,*/*",
      referer: `${RIVER_BASE}/pc/rwlist`,
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
