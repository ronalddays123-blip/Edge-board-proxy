// api/prizepicks.js
// Optimized PrizePicks proxy with built-in data formatting for your website dashboard.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const url = "https://partner-api.prizepicks.com/projections?per_page=300&include=new_player";
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    });
    
    clearTimeout(timeout);
    
    if (!r.ok) {
      throw new Error(`PrizePicks returned status code: ${r.status}`);
    }

    const rawData = await r.json();

    // 1. Build a fast lookup dictionary matching player IDs to their actual names and teams
    const playerMap = {};
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "new_player") {
          playerMap[item.id] = {
            name: item.attributes.display_name,
            team: item.attributes.team,
            image: item.attributes.image_url
          };
        }
      });
    }

    // 2. Map and flatten the messy projection rows into a clean, scannable format
    const cleanedProjections = rawData.data.map(proj => {
      const playerId = proj.relationships?.new_player?.data?.id;
      const playerInfo = playerMap[playerId] || { name: "Unknown Player", team: "N/A", image: "" };

      return {
        id: proj.id,
        playerName: playerInfo.name,
        team: playerInfo.team,
        playerImage: playerInfo.image,
        statType: proj.attributes.stat_type,
        line: proj.attributes.line_score,
        position: proj.attributes.position,
        description: proj.attributes.description || ""
      };
    });

    // 3. Return the clean array to your frontend with edge caching rules
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json({ 
      success: true,
      count: cleanedProjections.length,
      projections: cleanedProjections 
    });

  } catch (e) {
    clearTimeout(timeout);
    const message = e.name === "AbortError"
      ? "PrizePicks didn't respond within 8 seconds — likely down or blocking requests right now. Try again shortly."
      : e.message;
    res.status(500).json({ success: false, error: message });
  }
}
