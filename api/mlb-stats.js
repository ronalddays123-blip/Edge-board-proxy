// api/mlb-stats.js
// MLB's free, public, documented Stats API — no key, no auth, unlike the
// PrizePicks situation. Confirmed structure via public docs/examples:
// https://statsapi.mlb.com/api/v1/people/search?names=<name>
// https://statsapi.mlb.com/api/v1/people/{id}/stats?stats=gameLog&group=hitting&season=YYYY

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { player, group = "hitting", season } = req.query;
  if (!player) {
    return res.status(400).json({ error: "Missing player query param" });
  }

  const seasonYear = season || new Date().getFullYear();

  try {
    const searchRes = await fetch(
      `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(player)}`
    );
    const searchJson = await searchRes.json();
    const person = searchJson.people?.[0];
    if (!person) {
      return res.status(404).json({ error: `No MLB player found matching "${player}"` });
    }

    const statsRes = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${person.id}/stats?stats=gameLog&group=${group}&season=${seasonYear}`
    );
    const statsJson = await statsRes.json();
    const games = statsJson.stats?.[0]?.splits || [];

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ player: person.fullName, playerId: person.id, games });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
