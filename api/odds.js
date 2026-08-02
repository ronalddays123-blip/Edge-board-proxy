// api/odds.js
// Vercel serverless function — this is the piece that keeps your API key
// hidden from anyone viewing the page. Deploy this file at api/odds.js
// in a Vercel project and it becomes a live endpoint at /api/odds

export default async function handler(req, res) {
  const {
    sport = "basketball_wnba",
    markets = "h2h,spreads,totals",
    regions = "us",
  } = req.query;

  const apiKey = process.env.PARLAY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Missing PARLAY_API_KEY environment variable. Set it in Vercel > Project > Settings > Environment Variables.",
    });
  }

  try {
    const url =
      `https://parlay-api.com/v1/sports/${sport}/odds` +
      `?apiKey=${apiKey}&regions=${regions}&markets=${markets}&oddsFormat=american`;

    const r = await fetch(url);
    const data = await r.json();

    // cache for 30s so you don't burn credits on every page refresh
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
