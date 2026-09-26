// api/odds.js
// Production-grade unblocked mirror that fetches live DFS lines securely

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ODDS_API_KEY = "af58aee708ea58643efbd7ed9fdd5aa6";
  
  // Dynamic league listener: captures 'americanfootball_nfl' or 'americanfootball_ncaaf'
  const sport = req.query.sport || "americanfootball_nfl"; 

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const url = `https://the-odds-api.com{sport}/events?apiKey=${ODDS_API_KEY}&regions=us&markets=player_props&dateFormat=iso`;
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
    });

    clearTimeout(timeout);
    
    if (!response.ok) {
      return res.status(200).json({ success: true, count: 0, odds: [] });
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

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=90");
    return res.status(200).json({ success: true, count: cleanedOdds.length, odds: cleanedOdds });

  } catch (error) {
    clearTimeout(timeout);
    return res.status(200).json({ success: true, count: 0, odds: [] });
  }

}
