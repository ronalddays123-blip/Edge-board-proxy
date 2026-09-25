// src/EdgeBoard.jsx
import React, { useState, useEffect } from 'react';

export default function EdgeBoard() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    async function fetchLines() {
      try {
        const response = await fetch('/api/prizepicks');
        if (!response.ok) throw new Error(`Server connection issue: Status ${response.status}`);
        
        const json = await response.json();
        
        // Match the exact success criteria returned by your working Vercel logs
        if (json.success && Array.isArray(json.projections)) {
          setData(json.projections);
          setError(null);
        } else if (Array.isArray(json.data)) {
          // Fallback just in case your old raw payload structure cached
          setData(json.data);
          setError(null);
        } else {
          throw new Error('Received unexpected data formatting from server.');
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchLines();
    const interval = setInterval(fetchLines, 45000); // Smart fetch refresh cycle
    return () => clearInterval(interval);
  }, []);

  const filteredData = data.filter(item => {
    // Dynamic checker to handle both the old uncleaned schema and the clean upgraded version securely
    const name = item.playerName || item.attributes?.display_name || "Unknown Player";
    return name.toLowerCase().includes(searchTerm.toLowerCase());
  });

  if (loading) return <div style={{ padding: '40px', color: '#fff', textAlign: 'center', fontFamily: 'sans-serif' }}>⚡ Synchronizing with PrizePicks Engine...</div>;
  if (error) return <div style={{ padding: '40px', color: '#ff6b6b', textAlign: 'center', fontFamily: 'sans-serif' }}>❌ Connection Error: {error}</div>;

  return (
    <div style={{ backgroundColor: '#121214', minHeight: '100vh', padding: '30px', color: '#e1e1e6', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Top Header Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <div>
            <h1 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '26px' }}>PrizePicks Board Board Engine</h1>
            <p style={{ margin: '0', color: '#7c7c8a', fontSize: '14px' }}>Active System Tracking Matrix</p>
          </div>
          <span style={{ backgroundColor: '#29292e', padding: '8px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', border: '1px solid #323238' }}>
            🟢 Props Live: {filteredData.length}
          </span>
        </div>

        {/* Live Filter Input */}
        <input 
          type="text" 
          placeholder="🔍 Type a player's name to instantly search lines..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: '100%', padding: '14px 20px', fontSize: '16px', backgroundColor: '#202024', border: '1px solid #323238', borderRadius: '8px', color: '#fff', marginBottom: '20px', boxSizing: 'border-box', outline: 'none' }}
        />

        {/* Dynamic Prop Table Layout */}
        <div style={{ overflowX: 'auto', backgroundColor: '#202024', borderRadius: '8px', border: '1px solid #323238' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #323238', color: '#7c7c8a', fontSize: '13px', textTransform: 'uppercase' }}>
                <th style={{ padding: '16px' }}>Player Identity</th>
                <th style={{ padding: '16px' }}>Team</th>
                <th style={{ padding: '16px' }}>Stat Variant</th>
                <th style={{ padding: '16px', textAlign: 'right' }}>Current Prop Line</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.length > 0 ? (
                filteredData.map((player, idx) => {
                  // Direct safety extractors to avoid rendering errors
                  const name = player.playerName || player.attributes?.display_name || "Unknown Player";
                  const team = player.team || player.attributes?.team || "N/A";
                  const stat = player.statType || player.attributes?.stat_type || "Unknown Stat";
                  const score = player.line !== undefined ? player.line : player.attributes?.line_score || "0";
                  const subtext = player.position || player.attributes?.position || "";

                  return (
                    <tr key={player.id || idx} style={{ borderBottom: '1px solid #29292e' }}>
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ fontWeight: 'bold', color: '#fff' }}>{name}</div>
                        <div style={{ fontSize: '12px', color: '#7c7c8a' }}>{subtext}</div>
                      </td>
                      <td style={{ padding: '14px 16px', fontWeight: '500' }}>{team}</td>
                      <td style={{ padding: '14px 16px' }}>
                        <span style={{ backgroundColor: '#29292e', padding: '4px 10px', borderRadius: '4px', fontSize: '13px', border: '1px solid #323238' }}>
                          {stat.replace('_', ' ')}
                        </span>
                      </td>
                      <td style={{ padding: '14px 16px', textAlign: 'right', fontWeight: 'bold', fontSize: '18px', color: '#00b37e' }}>
                        {score}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="4" style={{ padding: '30px', textAlign: 'center', color: '#7c7c8a' }}>No matching properties running on board.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}
