const { setCors, sendJson, badRequest, getGeoJson } = require("./_shared");

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
    sendJson(res, 200, await getGeoJson(req.query?.stormId, req.query?.refresh === "1"));
  } catch (error) {
    if (/invalid/.test(error.message || "")) badRequest(res, error.message);
    else sendJson(res, 502, { ok: false, error: error.message || String(error), geojson: { type: "FeatureCollection", features: [] } });
  }
};
