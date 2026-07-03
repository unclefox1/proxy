const ALLOWED_URL_PATTERN = /^https:\/\/www\.wbgt\.env\.go\.jp\/alert\/dl\/(\d{4})\/alert_(\d{8})_(05|14|17)\.csv$/;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, s-maxage=300, max-age=60");
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!ALLOWED_URL_PATTERN.test(url)) {
    res.status(400).json({ error: "Unsupported WBGT alert CSV URL" });
    return;
  }

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "text/csv,*/*;q=0.8",
        "User-Agent": "tondabayashi-hazard-map-wbgt-proxy/1.0"
      }
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `WBGT upstream HTTP ${upstream.status}` });
      return;
    }

    const text = await upstream.text();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(text);
  } catch (error) {
    res.status(502).json({ error: error?.message || "WBGT upstream fetch failed" });
  }
};
