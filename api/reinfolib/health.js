const ALLOWED_REINFOLIB_API_IDS = new Set([
  "XKT001",
  "XKT002",
  "XKT003",
  "XKT006",
  "XKT010",
  "XKT011",
  "XKT013",
  "XKT014",
  "XKT016",
  "XKT017",
  "XKT018",
  "XKT020",
  "XKT023",
  "XKT025",
  "XKT030",
  "XKT031"
]);

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
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

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
