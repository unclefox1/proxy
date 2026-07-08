const ALLOWED_REINFOLIB_API_IDS = [
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
];

module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  res.status(200).json({
    ok: true,
    hasApiKey: Boolean(process.env.REINFOLIB_API_KEY),
    allowedApiCount: ALLOWED_REINFOLIB_API_IDS.length
  });
};
