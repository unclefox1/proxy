const ALLOWED_REINFOLIB_API_IDS = new Set([
  "XKT001",
  "XKT002",
  "XKT003",
  "XKT004",
  "XKT005",
  "XKT006",
  "XKT007",
  "XKT010",
  "XKT011",
  "XKT013",
  "XKT014",
  "XKT015",
  "XKT016",
  "XKT017",
  "XKT018",
  "XKT019",
  "XKT020",
  "XKT021",
  "XKT022",
  "XKT023",
  "XKT024",
  "XKT025",
  "XKT026",
  "XKT027",
  "XKT028",
  "XKT029",
  "XKT030",
  "XKT031",
  "XGT001",
  "XST001"
]);

const DPF_API_URL = "https://data-platform.mlit.go.jp/api/v1/";
const DPF_MAX_SIZE = 10000;
const DPF_TIMEOUT_MS = 60000;
const DPF_GEOMETRY_MAX_RECORDS = 500;
const DPF_GEOMETRY_MAX_HTML_BYTES = 2 * 1024 * 1024;
const DPF_GEOMETRY_MAX_ZIP_BYTES = 40 * 1024 * 1024;
const DPF_GEOMETRY_MAX_UNCOMPRESSED_BYTES = 120 * 1024 * 1024;
const DPF_GEOMETRY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DPF_GEOMETRY_CACHE = new Map();

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const service = String(req.query?.service || req.body?.service || "").toLowerCase();
  if (service === "dpf") {
    await handleDpf(req, res);
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  const mode = String(req.query.mode || "").toLowerCase();
  if (mode === "geojson") {
    await handleGeoJsonTile(req, res);
    return;
  }
  if (mode === "pbf" || hasTileQuery(req.query)) {
    await handlePbfTile(req, res);
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    hasApiKey: Boolean(getReinfolibApiKey()),
    allowedApiCount: ALLOWED_REINFOLIB_API_IDS.size,
    pbfMode: "health?mode=pbf&apiId={apiId}&z={z}&x={x}&y={y}",
    geojsonMode: "health?mode=geojson&apiId={apiId}&z={z}&x={x}&y={y}"
  });
};

async function handleDpf(req, res) {
  const apiKey = process.env.app_1 || process.env.MLIT_DPF_API_KEY || "";
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, service: "mlit-dpf", apiConfigured: Boolean(apiKey), datasetFilter: true, maxSize: DPF_MAX_SIZE, endpoint: DPF_API_URL });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }
  if (req.body?.action === "resolve-geometry") {
    await handleDpfGeometryResolution(req, res);
    return;
  }
  if (!apiKey) {
    res.status(503).json({ ok: false, error: "国土交通DPF APIの接続設定がありません。" });
    return;
  }
  try {
    const input = normalizeDpfSearchInput(req.body || {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DPF_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(DPF_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          apikey: apiKey,
          "user-agent": "Tondabayashi-Cultural-Heritage-Hazard-Map/1.0"
        },
        body: JSON.stringify({ query: buildDpfSearchQuery(input) }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const raw = await upstream.text();
    let payload;
    try { payload = JSON.parse(raw); } catch (_error) {
      throw new Error(`国土交通DPFからJSON以外の応答を受信しました（HTTP ${upstream.status}）。`);
    }
    if (!upstream.ok) throw new Error(`国土交通DPF HTTP ${upstream.status}`);
    if (Array.isArray(payload.errors) && payload.errors.length) {
      throw new Error(payload.errors.map((item) => item?.message).filter(Boolean).join(" / ") || "国土交通DPF検索に失敗しました。");
    }
    const search = payload?.data?.search || {};
    const results = Array.isArray(search.searchResults) ? search.searchResults.map(normalizeDpfResult) : [];
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      requestedDatasetId: input.datasetId,
      totalNumber: Number(search.totalNumber) || results.length,
      returnedNumber: results.length,
      limit: input.size,
      results,
      fetchedAt: new Date().toISOString()
    });
  } catch (error) {
    const aborted = error?.name === "AbortError";
    res.status(aborted ? 504 : 502).json({
      ok: false,
      error: aborted ? "国土交通DPFの応答がタイムアウトしました。" : sanitizeDpfError(error)
    });
  }
}

async function handleDpfGeometryResolution(req, res) {
  try {
    const sourceUrl = validateDpfGeometrySourceUrl(req.body?.sourceUrl);
    const records = normalizeDpfGeometryRecords(req.body?.records);
    const source = await loadDpfGeometrySource(sourceUrl);
    const geometries = matchDpfGeometryRecords(records, source.features);
    const payload = {
      ok: true,
      sourceUrl,
      zipUrl: source.zipUrl,
      geometries,
      fetchedAt: new Date().toISOString()
    };
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > DPF_GEOMETRY_MAX_RESPONSE_BYTES) {
      throw new DpfGeometryInputError("Resolved geometry response is too large");
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (typeof res.send === "function") res.status(200).send(json);
    else res.status(200).json(payload);
  } catch (error) {
    const status = error instanceof DpfGeometryInputError ? 400 : 502;
    res.status(status).json({ ok: false, error: sanitizeDpfError(error) });
  }
}

class DpfGeometryInputError extends Error {}

function validateDpfGeometrySourceUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_error) {
    throw new DpfGeometryInputError("Invalid official data page URL");
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "nlftp.mlit.go.jp"
    || url.username
    || url.password
    || !/^\/ksj\/gml\/datalist\/KsjTmplt-[A-Za-z0-9_-]+\.html$/.test(url.pathname)
  ) {
    throw new DpfGeometryInputError("Unsupported official data page URL");
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

function normalizeDpfGeometryRecords(value) {
  if (!Array.isArray(value) || !value.length) throw new DpfGeometryInputError("Geometry records are required");
  if (value.length > DPF_GEOMETRY_MAX_RECORDS) throw new DpfGeometryInputError("Too many geometry records");
  return value.map((item) => {
    const index = Number(item?.index);
    const lon = Number(item?.lon);
    const lat = Number(item?.lat);
    const title = String(item?.title || "").trim().slice(0, 200);
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(lon) || !Number.isFinite(lat) || !title) {
      throw new DpfGeometryInputError("Invalid geometry record");
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new DpfGeometryInputError("Invalid geometry coordinate");
    return { index, title, lon, lat };
  });
}

async function loadDpfGeometrySource(sourceUrl) {
  const cached = DPF_GEOMETRY_CACHE.get(sourceUrl);
  if (cached) return cached;
  const html = await fetchDpfBuffer(sourceUrl, DPF_GEOMETRY_MAX_HTML_BYTES, "text/html");
  const zipUrl = extractNlniZipUrl(html.toString("utf8"), sourceUrl);
  const zip = await fetchDpfBuffer(zipUrl, DPF_GEOMETRY_MAX_ZIP_BYTES, "application/zip");
  const files = extractGeoJsonFilesFromZip(zip);
  const features = [];
  files.forEach(({ name, text }) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_error) {
      return;
    }
    if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) return;
    data.features.forEach((feature) => {
      if (!isDpfSourceGeometry(feature?.geometry)) return;
      features.push({
        type: "Feature",
        properties: feature.properties && typeof feature.properties === "object" ? feature.properties : {},
        geometry: feature.geometry,
        _sourceFile: name
      });
    });
  });
  if (!features.length) throw new Error("Official ZIP contains no usable GeoJSON features");
  const source = { sourceUrl, zipUrl, features };
  DPF_GEOMETRY_CACHE.set(sourceUrl, source);
  while (DPF_GEOMETRY_CACHE.size > 2) DPF_GEOMETRY_CACHE.delete(DPF_GEOMETRY_CACHE.keys().next().value);
  return source;
}

async function fetchDpfBuffer(url, maxBytes, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DPF_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept, "user-agent": "Tondabayashi-Cultural-Heritage-Hazard-Map/1.0" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Official data HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) throw new Error("Official data is too large");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error("Official data is too large");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

function extractNlniZipUrl(html, sourceUrl) {
  const paths = Array.from(String(html || "").matchAll(/["'](\.\.\/data\/[A-Za-z0-9_./-]+\.zip)["']/gi), (match) => match[1]);
  if (!paths.length) throw new Error("Official ZIP URL was not found");
  const zipUrl = new URL(paths[0], sourceUrl);
  if (
    zipUrl.protocol !== "https:"
    || zipUrl.hostname !== "nlftp.mlit.go.jp"
    || !zipUrl.pathname.startsWith("/ksj/gml/data/")
    || !zipUrl.pathname.toLowerCase().endsWith(".zip")
  ) {
    throw new Error("Official ZIP URL is not allowed");
  }
  return zipUrl.href;
}

function extractGeoJsonFilesFromZip(buffer) {
  const { inflateRawSync } = require("node:zlib");
  const entries = readZipEntries(buffer).filter((entry) => /\/UTF-8\/[^/]+\.geojson$/i.test(entry.name));
  const files = [];
  let totalBytes = 0;
  for (const entry of entries.slice(0, 8)) {
    totalBytes += entry.uncompressedSize;
    if (totalBytes > DPF_GEOMETRY_MAX_UNCOMPRESSED_BYTES) throw new Error("Official ZIP expands beyond the safety limit");
    const localOffset = entry.localHeaderOffset;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local header");
    const nameLength = buffer.readUInt16LE(localOffset + 26);
    const extraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
    let output;
    if (entry.method === 0) output = Buffer.from(compressed);
    else if (entry.method === 8) output = inflateRawSync(compressed, { maxOutputLength: DPF_GEOMETRY_MAX_UNCOMPRESSED_BYTES });
    else continue;
    if (output.length !== entry.uncompressedSize) throw new Error("ZIP entry size mismatch");
    files.push({ name: entry.name, text: output.toString("utf8") });
  }
  if (!files.length) throw new Error("Official ZIP contains no UTF-8 GeoJSON files");
  return files;
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("Invalid ZIP file");
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("ZIP directory was not found");
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP directory entry");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) throw new Error("Invalid ZIP directory bounds");
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset = end;
  }
  return entries;
}

function matchDpfGeometryRecords(records, features) {
  const byTitle = new Map();
  features.forEach((feature) => {
    const values = Object.values(feature.properties || {}).filter((value) => ["string", "number"].includes(typeof value));
    values.forEach((value) => {
      const key = normalizeDpfMatchText(value);
      if (!key) return;
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push(feature);
    });
  });
  return records.flatMap((record) => {
    const candidates = byTitle.get(normalizeDpfMatchText(record.title)) || [];
    let best = null;
    let bestDistance = Infinity;
    candidates.forEach((feature) => {
      const distance = dpfPointGeometryDistanceSquared(record.lon, record.lat, feature.geometry);
      if (distance < bestDistance) { best = feature; bestDistance = distance; }
    });
    return best ? [{ index: record.index, geometry: best.geometry }] : [];
  });
}

function normalizeDpfMatchText(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\s\u3000]+/g, "").toLowerCase();
}

function dpfPointGeometryDistanceSquared(lon, lat, geometry) {
  let best = Infinity;
  const visitLine = (coordinates) => {
    for (let index = 1; index < coordinates.length; index += 1) {
      best = Math.min(best, dpfPointSegmentDistanceSquared(lon, lat, coordinates[index - 1], coordinates[index]));
    }
    if (coordinates.length === 1) best = Math.min(best, dpfCoordinateDistanceSquared(lon, lat, coordinates[0]));
  };
  if (geometry?.type === "Point") return dpfCoordinateDistanceSquared(lon, lat, geometry.coordinates);
  if (geometry?.type === "MultiPoint" || geometry?.type === "LineString") visitLine(geometry.coordinates || []);
  else if (geometry?.type === "MultiLineString" || geometry?.type === "Polygon") (geometry.coordinates || []).forEach(visitLine);
  else if (geometry?.type === "MultiPolygon") (geometry.coordinates || []).forEach((polygon) => polygon.forEach(visitLine));
  return best;
}

function dpfPointSegmentDistanceSquared(x, y, start, end) {
  if (!Array.isArray(start) || !Array.isArray(end)) return Infinity;
  const dx = Number(end[0]) - Number(start[0]);
  const dy = Number(end[1]) - Number(start[1]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
  if (dx === 0 && dy === 0) return dpfCoordinateDistanceSquared(x, y, start);
  const t = Math.max(0, Math.min(1, ((x - start[0]) * dx + (y - start[1]) * dy) / (dx * dx + dy * dy)));
  const px = Number(start[0]) + t * dx;
  const py = Number(start[1]) + t * dy;
  return (x - px) ** 2 + (y - py) ** 2;
}

function dpfCoordinateDistanceSquared(x, y, coordinate) {
  if (!Array.isArray(coordinate) || !Number.isFinite(Number(coordinate[0])) || !Number.isFinite(Number(coordinate[1]))) return Infinity;
  return (x - Number(coordinate[0])) ** 2 + (y - Number(coordinate[1])) ** 2;
}

function isDpfSourceGeometry(geometry) {
  return Boolean(geometry && ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(geometry.type));
}

function normalizeDpfSearchInput(body) {
  const term = String(body.term || "").trim().slice(0, 80);
  const datasetId = String(body.datasetId || "").trim().slice(0, 120);
  const scope = ["tondabayashi", "osaka", "viewport", "nationwide"].includes(body.scope) ? body.scope : "tondabayashi";
  const size = body.size === "all" ? DPF_MAX_SIZE : Math.max(1, Math.min(DPF_MAX_SIZE, Math.floor(Number(body.size) || 100)));
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(datasetId)) throw new Error("検索するデータセットが正しくありません。");
  const input = { term, datasetId, scope, size, bbox: null };
  if (scope === "viewport") {
    const values = Array.isArray(body.bbox) ? body.bbox.map(Number) : [];
    if (values.length !== 4 || !values.every(Number.isFinite)) throw new Error("表示範囲が正しくありません。");
    const [west, south, east, north] = values;
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new Error("表示範囲が正しくありません。");
    input.bbox = values;
  }
  return input;
}

function buildDpfSearchQuery(input) {
  const filters = ["first: 0"];
  if (input.term) filters.push(`term: ${JSON.stringify(input.term)}`);
  filters.push("phraseMatch: true");
  const attributeFilters = [`{ attributeName: "DPF:dataset_id", is: ${JSON.stringify(input.datasetId)} }`];
  if (input.scope === "tondabayashi") attributeFilters.push('{ attributeName: "DPF:municipality_code", is: 272141 }');
  else if (input.scope === "osaka") attributeFilters.push('{ attributeName: "DPF:prefecture_code", is: 27 }');
  filters.push(`attributeFilter: ${attributeFilters.length === 1 ? attributeFilters[0] : `{ AND: [${attributeFilters.join(", ")}] }`}`);
  if (input.scope === "viewport" && input.bbox) {
    const [west, south, east, north] = input.bbox;
    filters.push(`locationFilter: { rectangle: { topLeft: { lat: ${north}, lon: ${west} }, bottomRight: { lat: ${south}, lon: ${east} } } }`);
  }
  filters.push(`size: ${input.size}`);
  return `query HazardMapDpfSearch { search(${filters.join(", ")}) { totalNumber searchResults { id title lat lon year theme metadata dataset_id catalog_id hasThumbnail } } }`;
}

function normalizeDpfResult(item) {
  return {
    id: dpfScalar(item?.id),
    title: dpfScalar(item?.title),
    lat: dpfFiniteNumber(item?.lat),
    lon: dpfFiniteNumber(item?.lon),
    year: dpfScalar(item?.year),
    theme: normalizeDpfValue(item?.theme),
    metadata: normalizeDpfValue(item?.metadata),
    datasetId: dpfScalar(item?.dataset_id),
    catalogId: dpfScalar(item?.catalog_id),
    hasThumbnail: Boolean(item?.hasThumbnail)
  };
}

function normalizeDpfValue(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(normalizeDpfValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [String(key).slice(0, 100), normalizeDpfValue(item)]));
  return String(value);
}

function dpfScalar(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function dpfFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeDpfError(error) {
  return String(error?.message || error || "国土交通DPF検索に失敗しました。").replace(/[\u0000-\u001f]+/g, " ").slice(0, 500);
}

async function handleGeoJsonTile(req, res) {
  const apiId = String(req.query.apiId || "").toUpperCase();
  const z = parseTileInteger(req.query.z);
  const x = parseTileInteger(req.query.x);
  const y = parseTileInteger(req.query.y);

  if (!ALLOWED_REINFOLIB_API_IDS.has(apiId)) {
    res.status(403).json({ ok: false, error: "Unsupported reinfolib API ID" });
    return;
  }
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0) {
    res.status(400).json({ ok: false, error: "Invalid tile coordinate" });
    return;
  }

  const apiKey = getReinfolibApiKey();
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "reinfolib API key is not configured" });
    return;
  }

  try {
    const url = new URL(`https://www.reinfolib.mlit.go.jp/ex-api/external/${encodeURIComponent(apiId)}`);
    url.searchParams.set("response_format", "pbf");
    url.searchParams.set("z", String(z));
    url.searchParams.set("x", String(x));
    url.searchParams.set("y", String(y));
    appendReinfolibExtraParams(url, req.query);

    const upstream = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey,
        "Accept": "application/vnd.mapbox-vector-tile,application/x-protobuf,*/*"
      }
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status).json({
        ok: false,
        error: `Reinfolib upstream HTTP ${upstream.status}`,
        detail: text.slice(0, 300)
      });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const collection = decodeReinfolibVectorTile(buffer, x, y, z, apiId);

    res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).send(JSON.stringify(collection));
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Failed to fetch or decode reinfolib GeoJSON tile",
      detail: error.message || String(error)
    });
  }
}

function decodeReinfolibVectorTile(buffer, x, y, z, apiId) {
  try {
    const { VectorTile } = require("@mapbox/vector-tile");
    const Protobuf = require("pbf");
    const tile = new VectorTile(new Protobuf(buffer));
    const features = [];
    Object.keys(tile.layers || {}).forEach((layerName) => {
      const layer = tile.layers[layerName];
      for (let index = 0; index < layer.length; index += 1) {
        const feature = layer.feature(index).toGeoJSON(x, y, z);
        feature.properties = {
          ...(feature.properties || {}),
          _reinfolib_source_layer: layerName
        };
        features.push(feature);
      }
    });
    return {
      type: "FeatureCollection",
      name: `${apiId}/${z}/${x}/${y}`,
      features
    };
  } catch (error) {
    return decodeMvtTileWithoutDependencies(buffer, x, y, z, apiId);
  }
}

function decodeMvtTileWithoutDependencies(buffer, tileX, tileY, z, apiId) {
  const reader = new MiniPbfReader(buffer);
  const layers = [];
  while (reader.pos < reader.length) {
    const tag = reader.readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 3 && wire === 2) {
      layers.push(parseMiniMvtLayer(reader.readBytes()));
    } else {
      reader.skip(wire);
    }
  }
  const features = [];
  layers.forEach((layer) => {
    layer.features.forEach((raw) => {
      const geometry = decodeMiniMvtGeometry(raw.type, raw.geometry, layer.extent, tileX, tileY, z);
      if (!geometry) return;
      const properties = {};
      for (let index = 0; index < raw.tags.length - 1; index += 2) {
        const key = layer.keys[raw.tags[index]];
        if (!key) continue;
        properties[key] = layer.values[raw.tags[index + 1]];
      }
      properties._reinfolib_source_layer = layer.name;
      features.push({
        type: "Feature",
        id: raw.id,
        properties,
        geometry
      });
    });
  });
  return {
    type: "FeatureCollection",
    name: `${apiId}/${z}/${tileX}/${tileY}`,
    features
  };
}

function parseMiniMvtLayer(bytes) {
  const reader = new MiniPbfReader(bytes);
  const layer = { name: "hits", extent: 4096, keys: [], values: [], features: [] };
  while (reader.pos < reader.length) {
    const tag = reader.readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) layer.name = reader.readString();
    else if (field === 2 && wire === 2) layer.features.push(parseMiniMvtFeature(reader.readBytes()));
    else if (field === 3 && wire === 2) layer.keys.push(reader.readString());
    else if (field === 4 && wire === 2) layer.values.push(parseMiniMvtValue(reader.readBytes()));
    else if (field === 5 && wire === 0) layer.extent = reader.readVarint() || 4096;
    else reader.skip(wire);
  }
  return layer;
}

function parseMiniMvtFeature(bytes) {
  const reader = new MiniPbfReader(bytes);
  const feature = { id: undefined, tags: [], type: 0, geometry: [] };
  while (reader.pos < reader.length) {
    const tag = reader.readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) feature.id = reader.readVarint();
    else if (field === 2 && wire === 2) feature.tags = readPackedMiniVarints(reader.readBytes());
    else if (field === 3 && wire === 0) feature.type = reader.readVarint();
    else if (field === 4 && wire === 2) feature.geometry = readPackedMiniVarints(reader.readBytes());
    else reader.skip(wire);
  }
  return feature;
}

function parseMiniMvtValue(bytes) {
  const reader = new MiniPbfReader(bytes);
  let value = null;
  while (reader.pos < reader.length) {
    const tag = reader.readVarint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) value = reader.readString();
    else if (field === 2 && wire === 5) value = reader.readFloat();
    else if (field === 3 && wire === 1) value = reader.readDouble();
    else if (field === 4 && wire === 0) value = reader.readVarint();
    else if (field === 5 && wire === 0) value = reader.readVarint();
    else if (field === 6 && wire === 0) value = reader.readSVarint();
    else if (field === 7 && wire === 0) value = Boolean(reader.readVarint());
    else reader.skip(wire);
  }
  return value;
}

function readPackedMiniVarints(bytes) {
  const reader = new MiniPbfReader(bytes);
  const values = [];
  while (reader.pos < reader.length) values.push(reader.readVarint());
  return values;
}

function decodeMiniMvtGeometry(type, commands, extent, tileX, tileY, z) {
  let cursor = 0;
  let x = 0;
  let y = 0;
  let current = null;
  const parts = [];
  while (cursor < commands.length) {
    const command = commands[cursor++];
    const id = command & 7;
    const count = command >> 3;
    if (id === 1 || id === 2) {
      for (let i = 0; i < count && cursor < commands.length - 1; i += 1) {
        x += zigZagDecode(commands[cursor++]);
        y += zigZagDecode(commands[cursor++]);
        const point = tileCoordinateToLonLat(x, y, extent, tileX, tileY, z);
        if (type === 1) {
          parts.push(point);
        } else {
          if (id === 1 || !current) {
            current = [];
            parts.push(current);
          }
          current.push(point);
        }
      }
    } else if (id === 7 && current?.length) {
      const first = current[0];
      const last = current[current.length - 1];
      if (first && last && (first[0] !== last[0] || first[1] !== last[1])) current.push([...first]);
      current = null;
    }
  }
  if (type === 1) {
    if (!parts.length) return null;
    return parts.length === 1
      ? { type: "Point", coordinates: parts[0] }
      : { type: "MultiPoint", coordinates: parts };
  }
  if (type === 2) {
    const lines = parts.filter((line) => line.length >= 2);
    if (!lines.length) return null;
    return lines.length === 1
      ? { type: "LineString", coordinates: lines[0] }
      : { type: "MultiLineString", coordinates: lines };
  }
  if (type === 3) {
    const rings = parts.filter((ring) => ring.length >= 4);
    if (!rings.length) return null;
    return { type: "Polygon", coordinates: rings };
  }
  return null;
}

function tileCoordinateToLonLat(px, py, extent, tileX, tileY, z) {
  const scale = extent * (2 ** z);
  const lon = ((tileX * extent + px) / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * (tileY * extent + py)) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}

function zigZagDecode(value) {
  return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
}

class MiniPbfReader {
  constructor(buffer) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = 0;
    this.length = this.bytes.length;
  }

  readVarint() {
    let result = 0;
    let shift = 1;
    while (this.pos < this.length) {
      const byte = this.bytes[this.pos++];
      result += (byte & 0x7f) * shift;
      if (byte < 0x80) return result;
      shift *= 128;
    }
    return result;
  }

  readSVarint() {
    return zigZagDecode(this.readVarint());
  }

  readBytes() {
    const size = this.readVarint();
    const start = this.pos;
    this.pos = Math.min(this.length, this.pos + size);
    return this.bytes.slice(start, this.pos);
  }

  readString() {
    return new TextDecoder("utf-8").decode(this.readBytes());
  }

  readFloat() {
    const value = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return value;
  }

  readDouble() {
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }

  skip(wire) {
    if (wire === 0) {
      this.readVarint();
      return;
    }
    if (wire === 1) {
      this.pos = Math.min(this.length, this.pos + 8);
      return;
    }
    if (wire === 2) {
      const size = this.readVarint();
      this.pos = Math.min(this.length, this.pos + size);
      return;
    }
    if (wire === 5) {
      this.pos = Math.min(this.length, this.pos + 4);
    }
  }
}

async function handlePbfTile(req, res) {
  const apiId = String(req.query.apiId || "").toUpperCase();
  const z = parseTileInteger(req.query.z);
  const x = parseTileInteger(req.query.x);
  const y = parseTileInteger(req.query.y);

  if (!ALLOWED_REINFOLIB_API_IDS.has(apiId)) {
    res.status(403).json({ ok: false, error: "Unsupported reinfolib API ID" });
    return;
  }
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0) {
    res.status(400).json({ ok: false, error: "Invalid tile coordinate" });
    return;
  }

  const apiKey = getReinfolibApiKey();
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "reinfolib API key is not configured" });
    return;
  }

  const url = new URL(`https://www.reinfolib.mlit.go.jp/ex-api/external/${encodeURIComponent(apiId)}`);
  url.searchParams.set("response_format", "pbf");
  url.searchParams.set("z", String(z));
  url.searchParams.set("x", String(x));
  url.searchParams.set("y", String(y));
  appendReinfolibExtraParams(url, req.query);

  try {
    const upstream = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey,
        "Accept": "application/vnd.mapbox-vector-tile,application/x-protobuf,*/*"
      }
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status).json({
        ok: false,
        error: `Reinfolib upstream HTTP ${upstream.status}`,
        detail: text.slice(0, 300)
      });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "application/vnd.mapbox-vector-tile");
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).send(buffer);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Failed to fetch reinfolib PBF tile",
      detail: error.message || String(error)
    });
  }
}

function hasTileQuery(query) {
  return Boolean(query.apiId && query.z !== undefined && query.x !== undefined && query.y !== undefined);
}

function parseTileInteger(value) {
  const normalized = String(Array.isArray(value) ? value[0] : value || "").replace(/\.pbf$/i, "");
  return Number(normalized);
}

function getReinfolibApiKey() {
  return process.env.reinfolib || process.env.REINFOLIB || process.env.REINFOLIB_API_KEY || process.env.DefaultApplication || process.env.DEFAULT_APPLICATION || "";
}

function appendReinfolibExtraParams(url, query) {
  const reserved = new Set(["mode", "apiId", "z", "x", "y"]);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (reserved.has(key) || value === undefined || value === null || value === "") return;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item) => {
      if (item !== undefined && item !== null && item !== "") url.searchParams.append(key, String(item));
    });
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports._test = Object.freeze({
  normalizeDpfSearchInput,
  buildDpfSearchQuery,
  normalizeDpfResult,
  validateDpfGeometrySourceUrl,
  normalizeDpfGeometryRecords,
  extractNlniZipUrl,
  extractGeoJsonFilesFromZip,
  readZipEntries,
  matchDpfGeometryRecords
});
