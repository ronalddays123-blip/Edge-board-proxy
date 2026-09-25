// api/odds.js
// Live Sportsbook Odds Aggregator Engine for +EV Comparison

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Your The Odds API key has been added directly here as requested
  const ODDS_API_KEY = "af58aee708ea58643efbd7ed9fdd5aa6";
  
  // Defaulting to MLB player props since it's active in your repository
  const sport = req.query.sport || "baseball_mlb"; 
  const region = "us"; // Targets US sportsbooks like DraftKings, FanDuel, etc.
  const markets = "player_props"; // Instructs the API to fetch player over/under lines

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

    // Parse and transform the multi-bookmaker layout down to a flattened structure
    if (Array.isArray(rawOddsData)) {
      rawOddsData.forEach(event => {
        if (event.bookmakers) {
          event.bookmakers.forEach(book => {
            if (book.markets) {
              book.markets.forEach(market => {
                if (market.outcomes) {
                  market.outcomes.forEach(outcome => {
                    cleanedOdds.push({
                      id: `${event.id}_${book.key}_${market.key}`,
                      playerName: outcome.description, // The player's identity
                      sportsbook: book.title,          // e.g., DraftKings, FanDuel, Pinnacle
                      marketType: market.key,          // e.g., player_home_runs, player_strikeouts
                      selection: outcome.name,         // "Over" or "Under"
                      price: outcome.price,            // American betting odds integer
                      line: outcome.point              // The target line threshold (e.g. 1.5)
                    });
                  });
                }
              });
            }
          });
        }
      });
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ success: true, count: cleanedOdds.length, odds: cleanedOdds });

  } catch (error) {
    clearTimeout(timeout);
    return res.status(500).json({ success: false, error: error.message });
  }
}
