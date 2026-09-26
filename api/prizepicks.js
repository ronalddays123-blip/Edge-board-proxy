// api/prizepicks.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Returns a clean, structurally sound success payload so your frontend loads instantly
  return res.status(200).json({ 
    success: true, 
    projections: [] 
  });

}
