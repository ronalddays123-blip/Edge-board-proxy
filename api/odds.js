// api/odds.js
// Multi-Sport Live Sportsbook Odds Aggregator Engine

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ODDS_API_KEY = "af58aee708ea58643efbd7ed9fdd5aa6";
  
  // Dynamically reads the sport query parameter from your frontend request.
  // Defaults to NFL if no sport parameter is explicitly declared.
  const sport = req.query.sport || "americanfootball_nfl"; 
  const region = "us"; 
  const markets = "player_props"; 

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8500);

  try {
    const url = `https://the-odds-api.com{sport}/events?apiKey=${ODDS_API_KEY}&regions=${region}&markets=${markets}&dateFormat=iso`;

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`The Odds API responded with status: ${response.status}. Returning empty slate.`);
      return res.status(200).json({ success: true, count: 0, odds: [], note: "Market currently inactive." });
    }

    const rawOddsData = await response.json();
    const cleanedOdds = [];

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
                      playerName: outcome.description, 
                      sportsbook: book.title,          
                      marketType: market.key,          
                      selection: outcome.name,         
                      price: outcome.price,            
                      line: outcome.point              
                    });
                  });
                }
              });
            }
          });
        }
      });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=90");
    return res.status(200).json({ success: true, count: cleanedOdds.length, odds: cleanedOdds });

  } catch (error) {
    clearTimeout(timeout);
    console.error("Odds pipeline caught error:", error.message);
    return res.status(200).json({ success: true, count: 0, odds: [], error: error.message });
  }
}
