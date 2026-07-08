const list = require("../lib/api-handlers/list");
const product = require("../lib/api-handlers/product");
const geojson = require("../lib/api-handlers/geojson");

module.exports = async function handler(req, res) {
  const mode = String(req.query?.mode || "").toLowerCase();
  if (mode === "list") return list(req, res);
  if (mode === "product") return product(req, res);
  if (mode === "geojson") return geojson(req, res);

  setCors(res);
  res.status(400).json({
    ok: false,
    error: "Invalid JTWC mode",
    allowedModes: ["list", "product", "geojson"]
  });
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
