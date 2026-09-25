// src/EdgeBoard.jsx
import React, { useState, useEffect } from 'react';

export default function EdgeBoard() {
  const [prizepicksData, setPrizepicksData] = useState([]);
  const [sportsbookData, setSportsbookData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    async function syncDataEngine() {
      try {
        // Fetch live lines from your PrizePicks proxy and the sportsbook API in parallel
        const [ppRes, oddsRes] = await Promise.all([
          fetch('/api/prizepicks'),
          fetch('/api/odds')
        ]);

        if (!ppRes.ok) throw new Error(`PrizePicks pipeline failure: Status ${ppRes.status}`);
        if (!oddsRes.ok) throw new Error(`Sportsbook odds pipeline failure: Status ${oddsRes.status}`);

        const ppJson = await ppRes.json();
        const oddsJson = await oddsRes.json();

        // Map and structure sportsbook lines by player name for instant dictionary lookup speeds
        const oddsLookup = {};
        if (oddsJson.success && Array.isArray(oddsJson.odds)) {
          oddsJson.odds.forEach(item => {
            const key = item.playerName.toLowerCase().trim();
            if (!oddsLookup[key]) {
              oddsLookup[key] = [];
            }
            oddsLookup[key].push(item);
          });
        }

        if (ppJson.success && Array.isArray(ppJson.projections)) {
          setPrizepicksData(ppJson.projections);
        } else if (Array.isArray(ppJson.data)) {
          setPrizepicksData(ppJson.data);
        }

        setSportsbookData(oddsLookup);
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    syncDataEngine();
    const interval = setInterval(syncDataEngine, 45000); // 45-second auto-refresh
    return () => clearInterval(interval);
  }, []);

  const filteredData = prizepicksData.filter(item => {
    const name = item.playerName || item.attributes?.display_name || "Unknown Player";
    return name.toLowerCase().includes(searchTerm.toLowerCase());
  });

  if (loading) return <div style={{ padding: '40px', color: '#fff', textAlign: 'center', fontFamily: 'sans-serif' }}>⚡ Synchronizing Multi-Book Market Feeds...</div>;
  if (error) return <div style={{ padding: '40px', color: '#ff6b6b', textAlign: 'center', fontFamily: 'sans-serif' }}>❌ Engine Error: {error}</div>;

  return (
    <div style={{ backgroundColor: '#121214', minHeight: '100vh', padding: '30px', color: '#e1e1e6', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Header Section */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <div>
            <h1 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '26px' }}>+EV Market Discrepancy Matrix</h1>
            <p style={{ margin: '0', color: '#7c7c8a', fontSize: '14px' }}>Comparing Live PrizePicks Boards Against Sharp Sportsbooks</p>
          </div>
          <span style={{ backgroundColor: '#29292e', padding: '8px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', border: '1px solid #323238' }}>
            📊 Tracked Props: {filteredData.length}
          </span>
        </div>

        {/* Real-time Filter */}
        <input 
          type="text" 
          placeholder="🔍 Type a player's name to check market lines..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: '100%', padding: '14px 20px', fontSize: '16px', backgroundColor: '#202024', border: '1px solid #323238', borderRadius: '8px', color: '#fff', marginBottom: '20px', boxSizing: 'border-box', outline: 'none' }}
        />

        {/* Multi-Book Comparison Table */}
        <div style={{ overflowX: 'auto', backgroundColor: '#202024', borderRadius: '8px', border: '1px solid #323238' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #323238', color: '#7c7c8a', fontSize: '13px', textTransform: 'uppercase' }}>
                <th style={{ padding: '16px' }}>Player Information</th>
                <th style={{ padding: '16px' }}>Stat Type</th>
                <th style={{ padding: '16px', textAlign: 'center' }}>PrizePicks</th>
                <th style={{ padding: '16px' }}>Sportsbook Markets</th>
                <th style={{ padding: '16px', textAlign: 'right' }}>Detected Edge</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.length > 0 ? (
                filteredData.map((player, idx) => {
                  const name = player.playerName || player.attributes?.display_name || "Unknown Player";
                  const stat = player.statType || player.attributes?.stat_type || "";
                  const ppLine = player.line !== undefined ? player.line : player.attributes?.line_score || 0;
                  
                  // Look up all lines matching this player from other books
                  const marketBooks = sportsbookData[name.toLowerCase().trim()] || [];

                  // Look for explicit value variations or heavy juice favorites
                  let lineDiffText = "Scanning Markets...";
                  let badgeColor = "#29292e";
                  let textColor = "#7c7c8a";

                  if (marketBooks.length > 0) {
                    // Quick check if any sportsbook has a line discrepancy from PrizePicks
                    const uniqueLines = [...new Set(marketBooks.map(b => b.line))].filter(l => l !== undefined);
                    const bookLine = uniqueLines[0] || ppLine;
                    const diff = bookLine - ppLine;

                    if (diff > 0) {
                      lineDiffText = `🔥 OVER (+${diff.toFixed(1)} Point Gap)`;
                      badgeColor = 'rgba(0, 179, 126, 0.15)';
                      textColor = '#00b37e';
                    } else if (diff < 0) {
                      lineDiffText = `🧊 UNDER (${diff.toFixed(1)} Point Gap)`;
                      badgeColor = 'rgba(247, 90, 104, 0.15)';
                      textColor = '#f75a68';
                    } else {
                      lineDiffText = "Market Aligned";
                      badgeColor = '#29292e';
                      textColor = '#e1e1e6';
                    }
                  } else {
                    lineDiffText = "No Book Matches";
                  }

                  return (
                    <tr key={player.id || idx} style={{ borderBottom: '1px solid #29292e' }}>
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ fontWeight: 'bold', color: '#fff' }}>{name}</div>
                        <div style={{ fontSize: '12px', color: '#7c7c8a' }}>{player.team || "PROP"}</div>
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        <span style={{ backgroundColor: '#29292e', padding: '4px 10px', borderRadius: '4px', fontSize: '13px', border: '1px solid #323238' }}>
                          {stat.replace('_', ' ')}
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 'bold', fontSize: '16px', color: '#fff' }}>
                        {ppLine}
                      </td>
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '240px' }}>
                          {marketBooks.length > 0 ? (
                            marketBooks.slice(0, 2).map((book, bIdx) => (
                              <div key={bIdx} style={{ fontSize: '12px', color: '#a9a9b2', display: 'flex', justifyContent: 'space-between', backgroundColor: '#16161a', padding: '4px 8px', borderRadius: '4px' }}>
                                <span>{book.sportsbook}</span>
                                <span style={{ color: '#fff', fontWeight: 'bold' }}>{book.line} ({book.price > 0 ? `+${book.price}` : book.price})</span>
                              </div>
                            ))
                          ) : (
                            <span style={{ fontSize: '12px', color: '#4e4e5a', fontStyle: 'italic' }}>Waiting for sportsbook line generation...</span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                        <span style={{ backgroundColor: badgeColor, color: textColor, padding: '6px 12px', borderRadius: '6px', fontSize: '13px', fontWeight: 'bold', border: `1px solid ${textColor}33`, display: 'inline-block' }}>
                          {lineDiffText}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="5" style={{ padding: '30px', textAlign: 'center', color: '#7c7c8a' }}>No player lines mapped.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}
