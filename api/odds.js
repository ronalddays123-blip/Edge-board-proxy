// api/odds.js
// Live Sportsbook Odds Aggregator Engine for +EV Comparison

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 💡 GET YOUR FREE API KEY AT: https://the-odds-api.com
  // You can paste your key directly here or use a Vercel Environment Variable
  const ODDS_API_KEY = process.env.ODDS_API_KEY || "YOUR_THE_ODDS_API_KEY_HERE";
  
  // Defaulting to MLB player props since it's active in your repo
  const sport = req.query.sport || "baseball_mlb"; 
  const region = "us"; // Targets US sportsbooks
  const markets = "player_props"; // Tells the API we want player over/unders

  // If you haven't put your API key in yet, this sends test data so your website doesn't crash
  if (ODDS_API_KEY === "YOUR_THE_ODDS_API_KEY_HERE") {
    return res.status(200).json({
      success: true,
      message: "API Key placeholder detected. Returning test data.",
      odds: [
        { playerName: "Aaron Judge", sportsbook: "Pinnacle", marketType: "batter_home_runs", selection: "Over", price: -110, line: 0.5 },
        { playerName: "Shohei Ohtani", sportsbook: "DraftKings", marketType: "batter_total_bases", selection: "Under", price: +105, line: 1.5 }
      ]
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8500);

  try {
    const url = `https://the-odds-api.com{sport}/events?apiKey=${ODDS_API_KEY}&regions=${region}&markets=${markets}&dateFormat=iso`;

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`The Odds API returned status code: ${response.status}`);
    }

    const rawOddsData = await response.json();
    const cleanedOdds = [];

    rawOddsData.forEach(event => {
      if (event.bookmakers) {
        event.bookmakers.forEach(book => {
          if (book.markets) {
            book.markets.forEach(market => {
              if (market.outcomes) {
                market.outcomes.forEach(outcome => {
                  cleanedOdds.push({
                    id: `${event.id}_${book.key}`,
                    playerName: outcome.description, // The player's name
                    sportsbook: book.title,          // DraftKings, FanDuel, Pinnacle, etc.
                    marketType: market.key,          // stat type
                    selection: outcome.name,           // "Over" or "Under"
                    price: outcome.price,             // Betting odds (American odds)
                    line: outcome.point               // The sportsbook line (e.g. 1.5)
                  });
                });
              }
            });
          }
        });
      }
    });

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ success: true, count: cleanedOdds.length, odds: cleanedOdds });

  } catch (error) {
    clearTimeout(timeout);
    return res.status(500).json({ success: false, error: error.message });
  }
}
