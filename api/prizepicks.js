// api/prizepicks.js
// Broad-Spectrum PrizePicks Data Scraper (Bypasses category blocks)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    // ⚡ Targets their main web-app board directly to bypass partner limitations
    const url = "https://prizepicks.com";
    
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://prizepicks.com"
      },
    });

    clearTimeout(timeout);
    if (!r.ok) throw new Error(`PrizePicks gateway refused connection: Status ${r.status}`);

    const rawData = await r.json();
    const playerMap = {};

    // Map out player names
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "new_player" || item.type === "player") {
          playerMap[item.id] = {
            name: item.attributes.display_name || item.attributes.name,
            team: item.attributes.team || "N/A"
          };
        }
      });
    }

    // Flatten everything into an open data stream
    const cleanedProjections = (rawData.data || []).map(proj => {
      const playerId = proj.relationships?.new_player?.data?.id || proj.relationships?.player?.data?.id;
      const playerInfo = playerMap[playerId] || { name: "Unknown Player", team: "N/A" };
      
      return {
        id: proj.id,
        playerName: playerInfo.name,
        team: playerInfo.team,
        statType: proj.attributes.stat_type,
        line: proj.attributes.line_score,
        position: proj.attributes.position || "PROP",
      };
    });

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=15, stale-while-revalidate=45");
    return res.status(200).json({ success: true, projections: cleanedProjections });

  } catch (e) {
    clearTimeout(timeout);
    return res.status(500).json({ success: false, error: e.message });
  }

}
