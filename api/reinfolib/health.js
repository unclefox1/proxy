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
  if (mode === "pbf" || hasTileQuery(req.query)) {
    await handlePbfTile(req, res);
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    hasApiKey: Boolean(getReinfolibApiKey()),
    allowedApiCount: ALLOWED_REINFOLIB_API_IDS.size,
    pbfMode: "health?mode=pbf&apiId={apiId}&z={z}&x={x}&y={y}"
  });
};

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
