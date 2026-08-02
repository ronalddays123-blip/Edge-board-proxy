// api/odds.js
// Vercel serverless function — hides your API key from the page and can now
// pull multiple sports in a single request.
//
// Single sport:    /api/odds?sport=basketball_wnba&markets=h2h
// Multiple sports: /api/odds?sport=basketball_wnba,basketball_nba,baseball_mlb&markets=h2h

export default async function handler(req, res) {
  // allow this endpoint to be called from any of your deployment URLs
  // (production, preview, etc.) without the browser blocking it
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

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

  const sportsList = sport.split(",").map((s) => s.trim()).filter(Boolean);

  try {
    const results = await Promise.all(
      sportsList.map(async (sportKey) => {
        const url =
          `https://parlay-api.com/v1/sports/${sportKey}/odds` +
          `?apiKey=${apiKey}&regions=${regions}&markets=${markets}&oddsFormat=american`;
        const r = await fetch(url);
        const data = await r.json();
        return { sport: sportKey, ok: r.ok, data };
      })
    );

    // single sport requested -> return the array of games directly, same shape as before
    // multiple sports requested -> return an object keyed by sport so nothing downstream breaks
    const payload =
      sportsList.length === 1
        ? results[0].data
        : Object.fromEntries(results.map((r) => [r.sport, r.data]));

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

