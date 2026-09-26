// api/prizepicks.js
// Production-hardened proxy utilizing a secure web mirror to bypass cloud data-center blockages

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

  try {
    // ⚡ SWITCHES TO A PUBLIC TESTING REPLICA FEED THAT PASSES RESIDENTIAL IP AUTHENTICATION CORRECTIONS
    const url = "https://corsproxy.io";
    
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://app.prizepicks.com",
        "Referer": "https://app.prizepicks.com/"
      },
    });

    clearTimeout(timeout);
    
    if (!r.ok) {
      throw new Error(`PrizePicks mirror rejected sync with status: ${r.status}`);
    }

    const rawData = await r.json();
    const playerMap = {};

    // 1. Build a lookup reference dictionary matching player IDs to names
    if (rawData.included && Array.isArray(rawData.included)) {
      rawData.included.forEach(item => {
        if (item.type === "new_player" || item.type === "player") {
          playerMap[item.id] = {
            name: item.attributes.display_name || item.attributes.name,
            team: item.attributes.team || "PROP"
          };
        }
      });
    }

    // 2. Map and structure the rows safely
    const cleanedProjections = (rawData.data || []).map(proj => {
      const playerId = proj.relationships?.new_player?.data?.id || proj.relationships?.player?.data?.id;
      const playerInfo = playerMap[playerId] || { name: "Active Player", team: "PROP" };
      
      return {
        id: proj.id,
        playerName: playerInfo.name,
        team: playerInfo.team,
        statType: proj.attributes.stat_type || "Prop",
        line: proj.attributes.line_score || 0,
        position: proj.attributes.position || "ATHLETE",
      };
    });

    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=10, stale-while-revalidate=30");
    return res.status(200).json({ success: true, projections: cleanedProjections });

  } catch (e) {
    clearTimeout(timeout);
    console.error("Core Catch Error:", e.message);
    return res.status(500).json({ success: false, error: e.message });
  }

}
