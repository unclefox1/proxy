const { setCors, sendJson, getStormList } = require("./_shared");

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
    const refresh = req.query?.refresh === "1";
    sendJson(res, 200, await getStormList(refresh));
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error.message || String(error), storms: [] });
  }
};
