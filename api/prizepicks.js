// api/prizepicks.js
// Unofficial, undocumented PrizePicks endpoint — no key, no login. This is
// the same endpoint their own app calls. It could change or stop working
// without notice since PrizePicks doesn't publish or support it.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const url = "https://partner-api.prizepicks.com/projections?per_page=1000";
    const r = await fetch(url, {
      headers: {
        // some unofficial endpoints reject requests with no browser-like UA
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    const data = await r.json();

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
