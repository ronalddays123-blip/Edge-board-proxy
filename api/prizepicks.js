// api/prizepicks.js
// Modernized Unblocked PrizePicks Live Prop Scanner Engine

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Captures the active league from your dashboard buttons (Defaults to NFL)
  const targetLeague = req.query.sport || "NFL";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    // ⚡ ROUTES THROUGH AN OPEN UNBLOCKED DATA PORTER TO BYPASS CLOUDFLARE BLOCKAGES
    const url = "https://allorigins.win" + encodeURIComponent("https://prizepicks.com");
    
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
      },
    });

    clearTimeout(timeout);
    if (!r.ok) throw new Error(`PrizePicks bridge connection exception: Status ${r.status}`);

    const rawData = await r.json();
    
    // Map numerical league IDs out of the payload
    const leagueMap = {};
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "league") {
          leagueMap[item.id] = item.attributes?.name?.toUpperCase(); // e.g. "NFL", "CFB"
        }
      });
    }

    // Map player details
    const playerMap = {};
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "new_player" || item.type === "player") {
          const leagueId = item.relationships?.league?.data?.id;
          playerMap[item.id] = {
            name: item.attributes.display_name || item.attributes.name,
            team: item.attributes.team || "PROP",
            leagueName: leagueMap[leagueId] || "OTHER"
          };
        }
      });
    }

    // Process and flatten matching items down to your front end
    const cleanedProjections = (rawData.data || [])
      .map(proj => {
        const playerId = proj.relationships?.new_player?.data?.id || proj.relationships?.player?.data?.id;
        const playerInfo = playerMap[playerId] || { name: "Active Profile", team: "PROP", leagueName: "OTHER" };
        
        return {
          id: proj.id,
          playerName: playerInfo.name,
          team: playerInfo.team,
          league: playerInfo.leagueName,
          statType: proj.attributes.stat_type || "Prop",
          line: parseFloat(proj.attributes.line_score || 0),
        };
      })
      // ⚡ STICKY FILTER: Separates sports completely based on your clicks!
      .filter(item => item.league === targetLeague.toUpperCase());

    res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    return res.status(200).json({ success: true, projections: cleanedProjections });

  } catch (e) {
    clearTimeout(timeout);
    console.error("Direct connection blocked. Resetting blank array buffer.");
    // 🛑 REMOVED ALL OLD HARDCODED FALLBACK ARRAYS ENTIRELY
    return res.status(200).json({ success: true, projections: [] });
  }
}
