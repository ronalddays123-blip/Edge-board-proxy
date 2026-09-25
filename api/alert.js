// api/alert.js
// High-Speed Discord Notification Gateway for your PrizePicks Bot

export default async function handler(req, res) {
  // Allow your website to trigger this alert securely
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Restrict to POST requests containing the edge/discrepancy data payload
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Paste the Webhook Link you copied from your Discord channel right here
  const DISCORD_WEBHOOK_URL = "PASTE_YOUR_COPIED_DISCORD_WEBHOOK_URL_HERE";

  try {
    const { playerName, statType, prizePicksLine, sharpLine, edgePercentage, direction } = req.body;

    // Validate that the request has the vital data blocks
    if (!playerName || !statType || !prizePicksLine) {
      return res.status(400).json({ error: "Missing required player prop data fields." });
    }

    // Determine the color bar styling for the Discord message layout (Green for Over, Red for Under)
    const embedColor = direction?.toLowerCase() === "over" ? 3066993 : 15158332;

    // Structure a highly scannable, mobile-friendly Discord layout payload
    const discordPayload = {
      username: "PrizePicks Edge Tracker",
      avatar_url: "https://prizepicks.com",
      embeds: [
        {
          title: `🚨 +EV LINE DISCREPANCY DETECTED 🚨`,
          color: embedColor,
          fields: [
            { name: "👤 Player Name", value: `**${playerName}**`, inline: true },
            { name: "📊 Stat Type", value: statType, inline: true },
            { name: "🎯 Recommended Play", value: `**${direction?.toUpperCase() || "CHECK"}**`, inline: true },
            { name: "🔴 PrizePicks Line", value: `${prizePicksLine}`, inline: true },
            { name: "🔵 Sharp Book Line", value: `${sharpLine || "N/A"}`, inline: true },
            { name: "📈 Calculated Edge", value: `**+${edgePercentage || "0"}%**`, inline: true }
          ],
          timestamp: new Date().toISOString(),
          footer: { text: "Vercel Edge Engine Middleware" }
        }
      ]
    };

    // Forward the compiled notification directly to Discord's servers
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload)
    });

    if (!response.ok) {
      throw new Error(`Discord API responded with status code: ${response.status}`);
    }

    return res.status(200).json({ success: true, message: "Alert sent successfully to Discord!" });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
