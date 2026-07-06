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
