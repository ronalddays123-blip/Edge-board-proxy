// api/prizepicks.js
// Production League Isolation Engine matching PrizePicks Internal Numerical Keys

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Captures requested league from your dashboard buttons (Defaults to NFL)
  const targetLeague = req.query.sport || "NFL";

  // Maps your website's sport text letters directly to PrizePicks internal numerical database IDs
  const leagueIdMap = {
    "NFL": "9",
    "CFB": "11",
    "NBA": "7",
    "CBB": "19",
    "MLB": "2"
  };

  const targetId = leagueIdMap[targetLeague.toUpperCase()] || "9";

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
    if (!r.ok) throw new Error(`PrizePicks network response failed: Status ${r.status}`);

    const rawData = await r.json();
    const playerMap = {};

    // Build the mapping dictionary matching players to their respective numerical league indices
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "new_player" || item.type === "player") {
          const leagueRelationId = item.relationships?.league?.data?.id;
          playerMap[item.id] = {
            name: item.attributes.display_name || item.attributes.name,
            team: item.attributes.team,
            leagueId: leagueRelationId ? String(leagueRelationId) : "Unknown"
          };
        }
      });
    }

    // Flatten data matrix and strictly isolate matching league items
    const cleanedProjections = (rawData.data || [])
      .map(proj => {
        const playerId = proj.relationships?.new_player?.data?.id || proj.relationships?.player?.data?.id;
        const playerInfo = playerMap[playerId] || { name: "Unknown Player", team: "N/A", leagueId: "Unknown" };
        
        return {
          id: proj.id,
          playerName: playerInfo.name,
          team: playerInfo.team || "N/A",
          leagueId: playerInfo.leagueId, // Embedded internal ID
          statType: proj.attributes.stat_type,
          line: proj.attributes.line_score,
          position: proj.attributes.position || "PROP",
        };
      })
      // ⚡ STICKY FILTER RULE: Safely retains lines that match our active sport number key
      .filter(item => item.leagueId === targetId);

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=45");
    return res.status(200).json({ success: true, projections: cleanedProjections });

  } catch (e) {
    clearTimeout(timeout);
    return res.status(500).json({ success: false, error: e.message });
  }

}
