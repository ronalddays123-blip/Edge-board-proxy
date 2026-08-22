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

  // Explicit timeout: without this, if PrizePicks' server just never
  // responds (rather than erroring), this function — and your browser's
  // spinner — could hang far longer than is useful. This turns a silent
  // hang into a fast, clear "timed out" error instead.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const url = "https://partner-api.prizepicks.com/projections?per_page=300&include=new_player";
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        // some unofficial endpoints reject requests with no browser-like UA
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    clearTimeout(timeout);
    const data = await r.json();

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json(data);
  } catch (e) {
    clearTimeout(timeout);
    const message = e.name === "AbortError"
      ? "PrizePicks didn't respond within 8 seconds — likely down or blocking requests right now, not a code issue. Try again shortly."
      : e.message;
    res.status(500).json({ error: message });
  }
}
