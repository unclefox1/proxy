const zlib = require("zlib");

const JTWC_PAGE_URLS = [
  "https://www.metoc.navy.mil/jtwc/jtwc.html",
  "https://www.cnmoc.usff.navy.mil/Our-Commands/Fleet-Weather-Center-San-Diego/Joint-Typhoon-Warning-Center/"
];
const PRODUCT_BASE = "https://www.metoc.navy.mil/jtwc/products/";
const STORM_ID_RE = /^[a-z]{2}\d{4}$/i;
const TYPE_EXT = {
  kmz: ".kmz",
  kml: ".kml",
  tcw: ".tcw",
  webText: "web.txt",
  gif: ".gif"
};
const NOAA_RAW_BASE = "https://tgftp.nws.noaa.gov/data/raw/wt/";
const NOAA_JTWC_BULLETIN_CODES = [
  ...rangeCodes("wtpn", 31, 35),
  ...rangeCodes("wtio", 31, 35),
  ...rangeCodes("wtxs", 31, 35),
  ...rangeCodes("wtps", 31, 35)
];

const memoryCache = new Map();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=1800");
}

function sendJson(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function badRequest(res, message) {
  sendJson(res, 400, { ok: false, error: message });
}

async function cached(key, ttlMs, loader, refresh = false) {
  const now = Date.now();
  const hit = memoryCache.get(key);
  if (!refresh && hit && now - hit.time < ttlMs) return hit.value;
  const value = await loader();
  memoryCache.set(key, { time: now, value });
  return value;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 hazard-map JTWC reference fetch",
      accept: "text/html,application/xml,text/plain,*/*"
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 hazard-map JTWC reference fetch",
      accept: "application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,application/xml,text/xml,*/*"
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

async function fetchOfficialPage() {
  const errors = [];
  for (const url of JTWC_PAGE_URLS) {
    try {
      const html = await fetchText(url);
      return { html, sourceUrl: url };
    } catch (error) {
      errors.push(`${url}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join(" / "));
}

async function getStormList(refresh = false) {
  return cached("jtwc:list", 30 * 60 * 1000, async () => {
    const bulletinStorms = await getJtwcBulletinStorms(true).catch(() => []);
    if (bulletinStorms.length) {
      return {
        ok: true,
        fetchedAt: new Date().toISOString(),
        sourceUrl: NOAA_RAW_BASE,
        storms: bulletinStorms.map(({ warningText, points, ...storm }) => storm)
      };
    }
    const { html, sourceUrl } = await fetchOfficialPage();
    const storms = parseJtwcProductLinks(html);
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      sourceUrl,
      storms
    };
  }, refresh);
}

function parseJtwcProductLinks(html) {
  const productsByStorm = new Map();
  const hrefs = Array.from(String(html || "").matchAll(/href=["']([^"']+)["']/gi), (match) => decodeHtml(match[1]));
  hrefs.forEach((href) => {
    const absolute = new URL(href, PRODUCT_BASE).href;
    if (!isAllowedJtwcProductUrl(absolute)) return;
    const stormId = extractStormIdFromProductUrl(absolute);
    if (!stormId) return;
    if (!productsByStorm.has(stormId)) {
      productsByStorm.set(stormId, {
        stormId,
        basin: stormId.slice(0, 2).toUpperCase(),
        number: stormId.slice(2, 4),
        year: stormId.slice(4, 6),
        name: null,
        products: {}
      });
    }
    const storm = productsByStorm.get(stormId);
    const type = getProductTypeFromUrl(absolute);
    if (type) storm.products[type] = absolute;
  });
  return Array.from(productsByStorm.values()).sort((a, b) => a.stormId.localeCompare(b.stormId));
}

function getProductTypeFromUrl(url) {
  const lower = String(url || "").toLowerCase();
  if (lower.endsWith(".kmz")) return "kmz";
  if (lower.endsWith(".kml")) return "kml";
  if (lower.endsWith(".tcw")) return "tcw";
  if (lower.endsWith("web.txt")) return "webText";
  if (lower.endsWith(".gif")) return "gif";
  return "";
}

function extractStormIdFromProductUrl(url) {
  const lower = String(url || "").toLowerCase();
  const file = lower.split("/").pop() || "";
  const match = file.match(/^([a-z]{2}\d{4})(?:web)?\.(?:kmz|kml|tcw|txt|gif)$/i)
    || file.match(/^([a-z]{2}\d{4})web\.txt$/i);
  return match?.[1] || "";
}

function assertStormId(value) {
  const stormId = String(value || "").toLowerCase();
  if (!STORM_ID_RE.test(stormId)) throw new Error("invalid stormId");
  return stormId;
}

function assertProductType(value) {
  const type = String(value || "");
  if (!Object.prototype.hasOwnProperty.call(TYPE_EXT, type)) throw new Error("invalid product type");
  return type;
}

function buildProductUrl(stormId, type) {
  const id = assertStormId(stormId);
  const productType = assertProductType(type);
  return `${PRODUCT_BASE}${id}${TYPE_EXT[productType]}`;
}

function isAllowedJtwcProductUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.metoc.navy.mil" && parsed.pathname.startsWith("/jtwc/products/");
  } catch {
    return false;
  }
}

async function getProduct(stormId, type, refresh = false) {
  const url = buildProductUrl(stormId, type);
  return cached(`jtwc:product:${stormId}:${type}`, 30 * 60 * 1000, async () => {
    if (type === "gif" || type === "kmz") {
      return { url, buffer: await fetchArrayBuffer(url) };
    }
    return { url, text: await fetchText(url) };
  }, refresh);
}

async function getGeoJson(stormId, refresh = false) {
  const id = assertStormId(stormId);
  const bulletinStorms = await getJtwcBulletinStorms(refresh).catch(() => []);
  const bulletinStorm = bulletinStorms.find((storm) => storm.stormId === id);
  if (bulletinStorm) {
    return {
      ok: true,
      stormId: id,
      source: "JTWC / NOAA raw warning",
      fetchedAt: new Date().toISOString(),
      geojson: jtwcBulletinToGeoJson(bulletinStorm),
      warningText: bulletinStorm.warningText,
      rawProducts: {
        noaaRaw: bulletinStorm.products?.tcw || bulletinStorm.sourceUrl || "",
        gif: buildProductUrl(id, "gif")
      }
    };
  }
  const rawProducts = {};
  let kmlText = "";
  let productUrl = "";
  try {
    const kmz = await getProduct(id, "kmz", refresh);
    productUrl = kmz.url;
    kmlText = extractKmlFromKmz(Buffer.from(kmz.buffer));
    rawProducts.kmz = kmz.url;
  } catch (kmzError) {
    rawProducts.kmzError = kmzError.message || String(kmzError);
    try {
      const kml = await getProduct(id, "kml", refresh);
      productUrl = kml.url;
      kmlText = kml.text;
      rawProducts.kml = kml.url;
    } catch (kmlError) {
      rawProducts.kmlError = kmlError.message || String(kmlError);
    }
  }
  let warningText = "";
  try {
    const tcw = await getProduct(id, "tcw", refresh);
    warningText = tcw.text;
    rawProducts.tcw = tcw.url;
  } catch (error) {
    rawProducts.tcwError = error.message || String(error);
  }
  try {
    rawProducts.gif = buildProductUrl(id, "gif");
  } catch {}
  const geojson = kmlText ? kmlToGeoJson(kmlText, { stormId: id, productUrl }) : { type: "FeatureCollection", features: [] };
  return {
    ok: true,
    stormId: id,
    source: "JTWC",
    fetchedAt: new Date().toISOString(),
    geojson,
    warningText,
    rawProducts
  };
}

function rangeCodes(prefix, start, end) {
  const codes = [];
  for (let value = start; value <= end; value += 1) codes.push(`${prefix}${value}`);
  return codes;
}

async function getJtwcBulletinStorms(refresh = false) {
  return cached("jtwc:noaa-bulletins", 10 * 60 * 1000, async () => {
    const now = new Date();
    const results = await Promise.allSettled(NOAA_JTWC_BULLETIN_CODES.map(async (code) => {
      const url = `${NOAA_RAW_BASE}${code}.pgtw..txt`;
      const text = await fetchText(url);
      return parseJtwcWarningBulletin(text, url, now);
    }));
    return results
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value)
      .filter((storm, index, storms) => storms.findIndex((item) => item.stormId === storm.stormId) === index)
      .sort((a, b) => String(a.issueTime || "").localeCompare(String(b.issueTime || "")) * -1);
  }, refresh);
}

function parseJtwcWarningBulletin(text, sourceUrl, now = new Date()) {
  const body = String(text || "");
  if (!/JOINT TYPHOON WRNCEN|JOINT TYPHOON WARNING CENTER/i.test(body)) return null;
  const header = body.match(/^(WT[A-Z]{2}\d{2})\s+PGTW\s+(\d{6})/m);
  const issueDate = parseJtwcRemarkDate(body, header?.[2]) || inferWmoIssueDate(header?.[2], now);
  if (!issueDate || now.getTime() - issueDate.getTime() > 10 * 24 * 60 * 60 * 1000) return null;
  if (/THIS IS THE FINAL WARNING/i.test(body) && now.getTime() - issueDate.getTime() > 12 * 60 * 60 * 1000) return null;

  const subject = body.match(/SUBJ\/([^\r\n]+?WARNING NR\s+\d+)/i)?.[1] || "";
  const title = body.match(/\b((?:SUPER\s+)?(?:TYPHOON|TROPICAL STORM|TROPICAL DEPRESSION|TROPICAL CYCLONE|CYCLONE)\s+\d{2}[A-Z]\s+\([^)]+\))/i)?.[1] || subject;
  const storm = title.match(/(\d{2})([A-Z])\s+\(([^)]+)\)/i);
  if (!storm) return null;
  const basin = jtwcBasinFromSuffix(storm[2]);
  const year = String(issueDate.getUTCFullYear()).slice(2);
  const stormId = `${basin}${storm[1]}${year}`.toLowerCase();
  const warningNumber = Number(body.match(/WARNING NR\s+(\d+)/i)?.[1] || NaN);
  const points = parseJtwcWarningPoints(body, issueDate);
  if (!points.length) return null;

  return {
    stormId,
    basin: basin.toUpperCase(),
    number: storm[1],
    year,
    name: storm[3],
    title: title.trim(),
    warningNumber: Number.isFinite(warningNumber) ? warningNumber : null,
    issueTime: issueDate.toISOString(),
    sourceUrl,
    products: { tcw: sourceUrl },
    points,
    warningText: body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, "").trim()
  };
}

function inferWmoIssueDate(ddhhmm, now = new Date()) {
  const match = String(ddhhmm || "").match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!day || hour > 23 || minute > 59) return null;
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, minute));
  if (candidate.getTime() - now.getTime() > 6 * 60 * 60 * 1000) candidate.setUTCMonth(candidate.getUTCMonth() - 1);
  return candidate;
}

function parseJtwcRemarkDate(text, ddhhmm) {
  const dateMatch = String(text || "").match(/\b(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})\b/i);
  const timeMatch = String(ddhhmm || "").match(/^\d{2}(\d{2})(\d{2})$/);
  if (!dateMatch) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const day = Number(dateMatch[1]);
  const month = months[dateMatch[2].toUpperCase()];
  const year = 2000 + Number(dateMatch[3]);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  if (!day || month === undefined || !Number.isFinite(year) || hour > 23 || minute > 59) return null;
  return new Date(Date.UTC(year, month, day, hour, minute));
}

function jtwcBasinFromSuffix(suffix) {
  const key = String(suffix || "").toUpperCase();
  if (key === "W") return "wp";
  if (key === "C") return "cp";
  if (key === "E") return "ep";
  if (key === "A" || key === "B") return "io";
  if (key === "S" || key === "P") return "sh";
  return "wp";
}

function parseJtwcWarningPoints(text) {
  const body = String(text || "");
  const points = [];
  const currentBlock = body.match(/WARNING POSITION:[\s\S]{0,900}?PRESENT WIND DISTRIBUTION:/i)?.[0] || body;
  const currentTime = currentBlock.match(/(\d{6}Z)\s+---\s+NEAR\s+([0-9.]+)([NS])\s+([0-9.]+)([EW])/i);
  if (currentTime) {
    const currentWind = body.match(/PRESENT WIND DISTRIBUTION:[\s\S]{0,200}?MAX SUSTAINED WINDS\s*-\s*(\d{1,3})\s*KT/i);
    points.push({
      forecast_hour: 0,
      label: "実況",
      valid_time: currentTime[1],
      lat: signedCoord(currentTime[2], currentTime[3]),
      lon: signedCoord(currentTime[4], currentTime[5]),
      max_wind_kt: currentWind ? Number(currentWind[1]) : null
    });
  }
  const forecastRe = /(\d{1,3})\s+HRS,\s+VALID AT:\s*[\r\n]+\s*(\d{6}Z)\s+---\s+([0-9.]+)([NS])\s+([0-9.]+)([EW])[\s\S]{0,260}?MAX SUSTAINED WINDS\s*-\s*(\d{1,3})\s*KT/gi;
  let match;
  while ((match = forecastRe.exec(body))) {
    points.push({
      forecast_hour: Number(match[1]),
      label: `${Number(match[1])}時間後`,
      valid_time: match[2],
      lat: signedCoord(match[3], match[4]),
      lon: signedCoord(match[5], match[6]),
      max_wind_kt: Number(match[7])
    });
  }
  return points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
}

function signedCoord(value, hemisphere) {
  const number = Number(value);
  if (!Number.isFinite(number)) return NaN;
  return /S|W/i.test(hemisphere) ? -number : number;
}

function jtwcBulletinToGeoJson(storm) {
  const features = [];
  const coords = (storm.points || []).map((point) => [point.lon, point.lat]).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (coords.length >= 2) {
    features.push({
      type: "Feature",
      properties: {
        stormId: storm.stormId,
        name: `${storm.title || storm.name} 予報経路`,
        description: `JTWC ${storm.warningNumber ? `Warning NR ${storm.warningNumber}` : "Warning"}`,
        product: "JTWC NOAA raw warning",
        feature_type: "track",
        max_wind_kt: Math.max(...(storm.points || []).map((point) => point.max_wind_kt || 0)),
        valid_time: storm.points?.[0]?.valid_time || "",
        color: "#be185d"
      },
      geometry: { type: "LineString", coordinates: coords }
    });
  }
  (storm.points || []).forEach((point, index) => {
    const radiusPolygon = createJtwcWindRadiusPolygon(point, "34");
    if (radiusPolygon) {
      features.push({
        type: "Feature",
        properties: {
          stormId: storm.stormId,
          name: `${storm.title || storm.name} ${point.label || ""} 34kt wind radius`.trim(),
          description: `34 kt wind radius / ${point.target_time_jst || point.valid_time || ""}`,
          product: "JTWC NOAA raw warning",
          feature_type: "wind-radius",
          wind_threshold_kt: 34,
          forecast_hour: point.forecast_hour,
          valid_time: point.target_time_jst || point.valid_time || "",
          valid_time_raw: point.valid_time_raw || "",
          target_time_iso: point.target_time_iso || "",
          target_time_jst: point.target_time_jst || "",
          time_label: point.time_label || point.label || "",
          color: "#f9a8d4"
        },
        geometry: radiusPolygon
      });
    }
    features.push({
      type: "Feature",
      properties: {
        stormId: storm.stormId,
        name: `${storm.title || storm.name} ${point.label || ""}`.trim(),
        description: `最大風速 ${point.max_wind_kt ?? "-"} kt / ${point.valid_time || ""}`,
        product: "JTWC NOAA raw warning",
        feature_type: index === 0 ? "current" : "forecast",
        forecast_hour: point.forecast_hour,
        max_wind_kt: point.max_wind_kt,
        valid_time: point.valid_time,
        color: "#db2777"
      },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] }
    });
  });
  return { type: "FeatureCollection", features };
}

function createJtwcWindRadiusPolygon(point, threshold = "34") {
  const radii = point?.wind_radii?.[threshold];
  if (!radii) return null;
  const maxRadius = Math.max(radii.ne || 0, radii.se || 0, radii.sw || 0, radii.nw || 0);
  if (!Number.isFinite(maxRadius) || maxRadius <= 0) return null;
  const coordinates = [];
  for (let bearing = 0; bearing <= 360; bearing += 8) {
    const radiusNm = getJtwcRadiusForBearing(radii, bearing);
    if (!Number.isFinite(radiusNm) || radiusNm <= 0) continue;
    coordinates.push(destinationPoint(point.lon, point.lat, bearing, radiusNm * 1.852));
  }
  if (coordinates.length < 4) return null;
  coordinates.push(coordinates[0]);
  return { type: "Polygon", coordinates: [coordinates] };
}

function getJtwcRadiusForBearing(radii, bearing) {
  const normalized = ((bearing % 360) + 360) % 360;
  if (normalized >= 0 && normalized < 90) return radii.ne;
  if (normalized >= 90 && normalized < 180) return radii.se;
  if (normalized >= 180 && normalized < 270) return radii.sw;
  return radii.nw;
}

function destinationPoint(lon, lat, bearingDeg, distanceKm) {
  const radiusKm = 6371.0088;
  const bearing = bearingDeg * Math.PI / 180;
  const angularDistance = distanceKm / radiusKm;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [normalizeLongitude(lon2 * 180 / Math.PI), lat2 * 180 / Math.PI];
}

function normalizeLongitude(lon) {
  return ((lon + 540) % 360) - 180;
}

function extractKmlFromKmz(buffer) {
  let offset = 0;
  while (offset < buffer.length - 30) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString("utf8");
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (/\.kml$/i.test(name)) {
      const compressed = buffer.slice(dataStart, dataEnd);
      if (method === 0) return compressed.toString("utf8");
      if (method === 8) return zlib.inflateRawSync(compressed).toString("utf8");
      throw new Error(`unsupported zip compression method ${method}`);
    }
    offset = dataEnd;
  }
  throw new Error("KML not found in KMZ");
}

function kmlToGeoJson(kmlText, meta = {}) {
  const placemarks = Array.from(String(kmlText || "").matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/gi), (match) => match[0]);
  const features = [];
  placemarks.forEach((placemark, index) => {
    const baseProps = {
      stormId: meta.stormId,
      productUrl: meta.productUrl,
      name: textFromTag(placemark, "name"),
      description: stripTags(textFromTag(placemark, "description")),
      product: "JTWC KML",
      feature_index: index
    };
    const point = textFromTag(placemark, "Point");
    const line = textFromTag(placemark, "LineString");
    const polygon = textFromTag(placemark, "Polygon");
    if (point) {
      const coords = parseKmlCoords(textFromTag(point, "coordinates"));
      if (coords[0]) features.push({ type: "Feature", properties: enrichJtwcProps(baseProps), geometry: { type: "Point", coordinates: coords[0] } });
    }
    if (line) {
      const coords = parseKmlCoords(textFromTag(line, "coordinates"));
      if (coords.length >= 2) features.push({ type: "Feature", properties: enrichJtwcProps(baseProps), geometry: { type: "LineString", coordinates: coords } });
    }
    if (polygon) {
      const coords = parseKmlCoords(textFromTag(polygon, "coordinates"));
      if (coords.length >= 4) features.push({ type: "Feature", properties: enrichJtwcProps(baseProps), geometry: { type: "Polygon", coordinates: [coords] } });
    }
  });
  return { type: "FeatureCollection", features };
}

function enrichJtwcProps(props) {
  const haystack = `${props.name || ""} ${props.description || ""}`;
  const wind = haystack.match(/(?:wind|intensity|max(?:imum)?(?:\s+wind)?)\D{0,20}(\d{2,3})\s*(?:kt|kts|knots)?/i);
  const dtg = haystack.match(/\b(\d{6,10}Z?)\b/);
  return {
    ...props,
    max_wind_kt: wind ? Number(wind[1]) : null,
    valid_time: dtg?.[1] || "",
    color: "#db2777"
  };
}

function parseKmlCoords(text) {
  return String(text || "").trim().split(/\s+/).map((part) => {
    const [lon, lat] = part.split(",").map(Number);
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
  }).filter(Boolean);
}

function textFromTag(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, "i"));
  return decodeHtml(match?.[1] || "").trim();
}

function stripTags(text) {
  return decodeHtml(String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function parseJtwcWarningPoints(text, issueDate) {
  const body = String(text || "");
  const points = [];
  const currentBlock = body.match(/WARNING POSITION:[\s\S]*?(?=\n\s*---\s*\r?\n\s*FORECASTS:|\n\s*FORECASTS:)/i)?.[0] || body;
  const currentTime = currentBlock.match(/(\d{6}Z)\s+---\s+NEAR\s+([0-9.]+)([NS])\s+([0-9.]+)([EW])/i);
  if (currentTime) {
    const currentWind = currentBlock.match(/MAX SUSTAINED WINDS\s*-\s*(\d{1,3})\s*KT/i);
    points.push(buildJtwcPoint({
      forecastHour: 0,
      rawTime: currentTime[1],
      lat: signedCoord(currentTime[2], currentTime[3]),
      lon: signedCoord(currentTime[4], currentTime[5]),
      windKt: currentWind ? Number(currentWind[1]) : null,
      windRadii: parseJtwcWindRadii(currentBlock),
      issueDate
    }));
  }
  const forecastRe = /(\d{1,3})\s+HRS,\s+VALID AT:\s*[\r\n]+\s*(\d{6}Z)\s+---\s+([0-9.]+)([NS])\s+([0-9.]+)([EW])[\s\S]{0,260}?MAX SUSTAINED WINDS\s*-\s*(\d{1,3})\s*KT/gi;
  const matches = Array.from(body.matchAll(forecastRe));
  matches.forEach((match, index) => {
    const nextIndex = matches[index + 1]?.index ?? body.search(/\nREMARKS:/i);
    const blockEnd = nextIndex > match.index ? nextIndex : Math.min(body.length, match.index + 1600);
    const block = body.slice(match.index, blockEnd);
    points.push(buildJtwcPoint({
      forecastHour: Number(match[1]),
      rawTime: match[2],
      lat: signedCoord(match[3], match[4]),
      lon: signedCoord(match[5], match[6]),
      windKt: Number(match[7]),
      windRadii: parseJtwcWindRadii(block),
      issueDate
    }));
  });
  return points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
}

function buildJtwcPoint({ forecastHour, rawTime, lat, lon, windKt, windRadii, issueDate }) {
  const targetDate = resolveJtwcDdtg(rawTime, issueDate);
  const label = `${forecastHour}h`;
  const targetJst = formatJtwcJst(targetDate);
  const shortTargetJst = formatJtwcJstShort(targetDate);
  return {
    forecast_hour: forecastHour,
    label,
    valid_time: targetJst || rawTime,
    valid_time_raw: rawTime,
    target_time_iso: targetDate ? targetDate.toISOString() : "",
    target_time_jst: targetJst,
    time_label: shortTargetJst ? `${label} ${shortTargetJst}` : label,
    lat,
    lon,
    max_wind_kt: windKt,
    wind_radii: windRadii || {}
  };
}

function resolveJtwcDdtg(ddhhmmZ, issueDate) {
  const match = String(ddhhmmZ || "").match(/^(\d{2})(\d{2})(\d{2})Z$/i);
  if (!match || !(issueDate instanceof Date) || Number.isNaN(issueDate.getTime())) return null;
  const day = Number(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const candidate = new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), day, hour, minute));
  const fifteenDays = 15 * 24 * 60 * 60 * 1000;
  if (candidate.getTime() - issueDate.getTime() > fifteenDays) candidate.setUTCMonth(candidate.getUTCMonth() - 1);
  if (issueDate.getTime() - candidate.getTime() > fifteenDays) candidate.setUTCMonth(candidate.getUTCMonth() + 1);
  return candidate;
}

function formatJtwcJst(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())} JST`;
}

function formatJtwcJstShort(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(jst.getUTCMonth() + 1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

function parseJtwcWindRadii(block) {
  const radii = {};
  [34, 50, 64].forEach((threshold) => {
    const pattern = new RegExp(String.raw`RADIUS OF\s+0?${threshold}\s+KT WINDS\s*-\s*(\d{1,3})\s+NM NORTHEAST QUADRANT[\s\S]{0,120}?(\d{1,3})\s+NM SOUTHEAST QUADRANT[\s\S]{0,120}?(\d{1,3})\s+NM SOUTHWEST QUADRANT[\s\S]{0,120}?(\d{1,3})\s+NM NORTHWEST QUADRANT`, "i");
    const match = String(block || "").match(pattern);
    if (match) {
      radii[String(threshold)] = {
        ne: Number(match[1]),
        se: Number(match[2]),
        sw: Number(match[3]),
        nw: Number(match[4])
      };
    }
  });
  return radii;
}

function jtwcBulletinToGeoJson(storm) {
  const features = [];
  const coords = (storm.points || []).map((point) => [point.lon, point.lat]).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (coords.length >= 2) {
    const firstPoint = storm.points[0] || {};
    const lastPoint = storm.points[storm.points.length - 1] || {};
    features.push({
      type: "Feature",
      properties: {
        stormId: storm.stormId,
        name: `${storm.title || storm.name} forecast track`,
        description: `JTWC ${storm.warningNumber ? `Warning NR ${storm.warningNumber}` : "Warning"}`,
        product: "JTWC NOAA raw warning",
        feature_type: "track",
        max_wind_kt: Math.max(...(storm.points || []).map((point) => point.max_wind_kt || 0)),
        valid_time: firstPoint.target_time_jst || firstPoint.valid_time || "",
        valid_time_raw: firstPoint.valid_time_raw || "",
        target_time_iso: firstPoint.target_time_iso || "",
        target_time_jst: firstPoint.target_time_jst && lastPoint.target_time_jst ? `${firstPoint.target_time_jst} - ${lastPoint.target_time_jst}` : "",
        time_label: firstPoint.label && lastPoint.label ? `${firstPoint.label}-${lastPoint.label}` : "",
        color: "#be185d"
      },
      geometry: { type: "LineString", coordinates: coords }
    });
  }
  (storm.points || []).forEach((point, index) => {
    const radiusPolygon = createJtwcWindRadiusPolygon(point, "34");
    if (radiusPolygon) {
      features.push({
        type: "Feature",
        properties: {
          stormId: storm.stormId,
          name: `${storm.title || storm.name} ${point.label || ""} 34kt wind radius`.trim(),
          description: `34 kt wind radius / ${point.target_time_jst || point.valid_time || ""}`,
          product: "JTWC NOAA raw warning",
          feature_type: "wind-radius",
          wind_threshold_kt: 34,
          forecast_hour: point.forecast_hour,
          valid_time: point.target_time_jst || point.valid_time || "",
          valid_time_raw: point.valid_time_raw || "",
          target_time_iso: point.target_time_iso || "",
          target_time_jst: point.target_time_jst || "",
          time_label: point.time_label || point.label || "",
          color: "#f9a8d4"
        },
        geometry: radiusPolygon
      });
    }
    features.push({
      type: "Feature",
      properties: {
        stormId: storm.stormId,
        name: `${storm.title || storm.name} ${point.label || ""}`.trim(),
        description: `Max wind ${point.max_wind_kt ?? "-"} kt / ${point.target_time_jst || point.valid_time || ""}`,
        product: "JTWC NOAA raw warning",
        feature_type: index === 0 ? "current" : "forecast",
        forecast_hour: point.forecast_hour,
        max_wind_kt: point.max_wind_kt,
        valid_time: point.target_time_jst || point.valid_time || "",
        valid_time_raw: point.valid_time_raw || "",
        target_time_iso: point.target_time_iso || "",
        target_time_jst: point.target_time_jst || "",
        time_label: point.time_label || point.label || "",
        color: "#db2777"
      },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] }
    });
  });
  return { type: "FeatureCollection", features };
}

module.exports = {
  setCors,
  sendJson,
  badRequest,
  getStormList,
  getProduct,
  getGeoJson,
  assertStormId,
  assertProductType
};
