// api/prizepicks.js
// Production Sport-League Isolation Filter Middleware

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ⚡ CAPTURES THE SPORT SELECTION FROM YOUR WEBSITE BUTTONS (Defaults to NFL)
  const targetLeague = req.query.sport || "NFL";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const url = "https://prizepicks.com";
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://prizepicks.com",
      },
    });

    clearTimeout(timeout);
    if (!r.ok) throw new Error(`PrizePicks server returned status ${r.status}`);

    const rawData = await r.json();

    // 1. Build a lookup index for leagues, matching player tracking rows to sports leagues
    const leagueMap = {};
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "league") {
          leagueMap[item.id] = item.attributes?.name; // e.g., "NFL", "CFB", "NBA", "CBB", "MLB"
        }
      });
    }

    // 2. Build a player identifier map to grab names, teams, and track their league IDs
    const playerMap = {};
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "new_player" || item.type === "player") {
          const leagueId = item.relationships?.league?.data?.id;
          playerMap[item.id] = {
            name: item.attributes.display_name || item.attributes.name,
            team: item.attributes.team,
            leagueName: leagueMap[leagueId] || "Unknown"
          };
        }
      });
    }

    // 3. Flatten and apply strict isolation filters
    const cleanedProjections = (rawData.data || [])
      .map(proj => {
        const playerId = proj.relationships?.new_player?.data?.id || proj.relationships?.player?.data?.id;
        const playerInfo = playerMap[playerId] || { name: "Unknown Player", team: "N/A", leagueName: "Unknown" };
        
        return {
          id: proj.id,
          playerName: playerInfo.name,
          team: playerInfo.team || "N/A",
          league: playerInfo.leagueName, // Mapped league string
          statType: proj.attributes.stat_type,
          line: proj.attributes.line_score,
          position: proj.attributes.position || "PROP",
        };
      })
      // ⚡ CRITICAL FILTER: Throws away anything that does not match the exact button selection!
      .filter(item => item.league.toUpperCase() === targetLeague.toUpperCase());

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=45");
    return res.status(200).json({ success: true, projections: cleanedProjections });

  } catch (e) {
    clearTimeout(timeout);
    return res.status(500).json({ success: false, error: e.message });
  }

}
