const RIVER_BASE = "https://www.river.go.jp/kawabou";
const DEFAULT_PREF_CODES = ["2501", "2601", "2701", "2801", "2901", "3001"];
const ALLOWED_PREF_CODES = new Set([
  "2401", "2501", "2601", "2701", "2801", "2901", "3001", "3101"
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
    const collections = await Promise.all(prefCodes.map((prefCode) => fetchStationCollection(prefCode, time)));
    const features = collections.flatMap((collection) => normalizeStationFeatures(collection));
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
      "cache-control": "public, s-maxage=86400, stale-while-revalidate=604800"
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

function normalizeStationFeatures(collection) {
  const features = Array.isArray(collection?.features) ? collection.features : [];
  return features
    .filter((feature) => feature?.geometry?.type === "Point")
    .map((feature) => {
      const p = feature.properties || {};
      return {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          stationId: String(p.obs_fcd || ""),
          obsFcd: String(p.obs_fcd || ""),
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
          displayStatus: "unknown",
          source: "国土交通省 川の防災情報"
        }
      };
    });
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
