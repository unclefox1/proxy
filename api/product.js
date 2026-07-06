const { setCors, sendJson, badRequest, getProduct, assertStormId, assertProductType } = require("./_shared");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  try {
    const stormId = assertStormId(req.query?.stormId);
    const type = assertProductType(req.query?.type);
    const product = await getProduct(stormId, type, req.query?.refresh === "1");
    if (type === "gif" || type === "kmz") {
      const buffer = Buffer.from(product.buffer);
      res.statusCode = 200;
      res.setHeader("Content-Type", type === "gif" ? "image/gif" : "application/vnd.google-earth.kmz");
      res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=1800");
      res.end(buffer);
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", type === "tcw" || type === "webText" ? "text/plain; charset=utf-8" : "application/vnd.google-earth.kml+xml; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=1800");
    res.end(product.text || "");
  } catch (error) {
    if (/invalid/.test(error.message || "")) badRequest(res, error.message);
    else sendJson(res, 502, { ok: false, error: error.message || String(error) });
  }
};
