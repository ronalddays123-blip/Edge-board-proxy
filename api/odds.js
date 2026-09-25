// src/EdgeBoard.jsx
import React, { useState, useEffect } from 'react';

export default function EdgeBoard() {
  const [prizepicksData, setPrizepicksData] = useState([]);
  const [statsData, setStatsData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    async function syncDataEngine() {
      try {
        // Fetch live lines from your PrizePicks proxy and custom MLB math in parallel
        const [ppRes, statsRes] = await Promise.all([
          fetch('/api/prizepicks'),
          fetch('/api/mlb-stats')
        ]);

        if (!ppRes.ok) throw new Error(`PrizePicks pipeline failure: Status ${ppRes.status}`);
        if (!statsRes.ok) throw new Error(`MLB Stats pipeline failure: Status ${statsRes.status}`);

        const ppJson = await ppRes.json();
        const statsJson = await statsRes.json();

        // Map your MLB stats by player name for instant dictionary lookup speeds
        const statsLookup = {};
        if (statsJson.success && Array.isArray(statsJson.stats)) {
          statsJson.stats.forEach(item => {
            statsLookup[item.playerName.toLowerCase().trim()] = item;
          });
        } else if (Array.isArray(statsJson)) {
          // Fallback array parsing
          statsJson.forEach(item => {
            if (item.playerName) statsLookup[item.playerName.toLowerCase().trim()] = item;
          });
        }

        if (ppJson.success && Array.isArray(ppJson.projections)) {
          setPrizepicksData(ppJson.projections);
        } else if (Array.isArray(ppJson.data)) {
          setPrizepicksData(ppJson.data);
        }

        setStatsData(statsLookup);
        setError(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    syncDataEngine();
    const interval = setInterval(syncDataEngine, 45000);
    return () => clearInterval(interval);
  }, []);

  const filteredData = prizepicksData.filter(item => {
    const name = item.playerName || item.attributes?.display_name || "Unknown Player";
    return name.toLowerCase().includes(searchTerm.toLowerCase());
  });

  if (loading) return <div style={{ padding: '40px', color: '#fff', textAlign: 'center', fontFamily: 'sans-serif' }}>⚡ Merging PrizePicks Lines with Custom Model Metrics...</div>;
  if (error) return <div style={{ padding: '40px', color: '#ff6b6b', textAlign: 'center', fontFamily: 'sans-serif' }}>❌ Engine Error: {error}</div>;

  return (
    <div style={{ backgroundColor: '#121214', minHeight: '100vh', padding: '30px', color: '#e1e1e6', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Header Block */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <div>
            <h1 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '26px' }}>Custom Edge Discrepancy Matrix</h1>
            <p style={{ margin: '0', color: '#7c7c8a', fontSize: '14px' }}>Comparing Board Projections Against Your Personal Math Engine</p>
          </div>
          <span style={{ backgroundColor: '#29292e', padding: '8px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', border: '1px solid #323238' }}>
            📊 Tracked Props: {filteredData.length}
          </span>
        </div>

        <input 
          type="text" 
          placeholder="🔍 Search active discrepancy lines..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: '100%', padding: '14px 20px', fontSize: '16px', backgroundColor: '#202024', border: '1px solid #323238', borderRadius: '8px', color: '#fff', marginBottom: '20px', boxSizing: 'border-box', outline: 'none' }}
        />

        {/* Unified Edge Layout Grid */}
        <div style={{ overflowX: 'auto', backgroundColor: '#202024', borderRadius: '8px', border: '1px solid #323238' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #323238', color: '#7c7c8a', fontSize: '13px', textTransform: 'uppercase' }}>
                <th style={{ padding: '16px' }}>Player Information</th>
                <th style={{ padding: '16px' }}>Stat Variant</th>
                <th style={{ padding: '16px', textAlign: 'center' }}>PrizePicks</th>
                <th style={{ padding: '16px', textAlign: 'center' }}>Your Projection</th>
                <th style={{ padding: '16px', textAlign: 'right' }}>Calculated Edge</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.length > 0 ? (
                filteredData.map((player, idx) => {
                  const name = player.playerName || player.attributes?.display_name || "Unknown Player";
                  const stat = player.statType || player.attributes?.stat_type || "";
                  const ppLine = player.line !== undefined ? player.line : player.attributes?.line_score || 0;
                  
                  // Look up match in your custom mlb-stats dataset
                  const userMatch = statsData[name.toLowerCase().trim()];
                  const customLine = userMatch ? userMatch.projectedLine : null;

                  // Evaluate the mathematical delta discrepancy
                  let edgeDisplay = "No Match";
                  let edgeColor = "#7c7c8a";
                  
                  if (customLine !== null) {
                    const diff = customLine - ppLine;
                    if (diff > 0) {
                      edgeDisplay = `🔥 OVER (+${diff.toFixed(1)})`;
                      edgeColor = '#00b37e'; // Green highlight for Over value
                    } else if (diff < 0) {
                      edgeDisplay = `🧊 UNDER (${diff.toFixed(1)})`;
                      edgeColor = '#f75a68'; // Red highlight for Under value
                    } else {
                      edgeDisplay = "0.0 (Perfect Match)";
                      edgeColor = "#e1e1e6";
                    }
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
                      <td style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 'bold' }}>{ppLine}</td>
                      <td style={{ padding: '14px 16px', textAlign: 'center', color: '#a9a9b2' }}>{customLine !== null ? customLine : '—'}</td>
                      <td style={{ padding: '14px 16px', textAlign: 'right', fontWeight: 'bold', color: edgeColor }}>
                        {edgeDisplay}
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
