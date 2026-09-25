// src/Dashboard.jsx
import React, { useState, useEffect } from 'react';

export default function Dashboard() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    async function fetchLines() {
      try {
        // Points directly to your deployed Vercel serverless proxy endpoint
        const response = await fetch('/api/prizepicks');
        if (!response.ok) throw new Error('Failed to capture active player lines');
        
        const json = await response.json();
        if (json.success) {
          setData(json.projections);
        } else {
          throw new Error(json.error || 'Unknown server error');
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchLines();
    // Auto-refresh lines every 60 seconds to lock in fresh data without hitting rate limits
    const interval = setInterval(fetchLines, 60000);
    return () => clearInterval(interval);
  }, []);

  // Filter rows based on search input (Player Name or Team)
  const filteredData = data.filter(item => 
    item.playerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.team.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) return <div style={{ padding: '40px', color: '#fff', textAlign: 'center', fontFamily: 'sans-serif' }}>⚡ Synchronizing with PrizePicks Engine...</div>;
  if (error) return <div style={{ padding: '40px', color: '#ff6b6b', textAlign: 'center', fontFamily: 'sans-serif' }}>❌ Error: {error}</div>;

  return (
    <div style={{ backgroundColor: '#121214', minHeight: '100vh', padding: '30px', color: '#e1e1e6', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Header Block */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <div>
            <h1 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '28px' }}>PrizePicks Board Real-Time Sync</h1>
            <p style={{ margin: '0', color: '#7c7c8a', fontSize: '14px' }}>Active Lines Tracker • Auto-refreshing every 60s</p>
          </div>
          <span style={{ backgroundColor: '#29292e', padding: '8px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', border: '1px solid #323238' }}>
            🟢 Live Props Connected: {data.length}
          </span>
        </div>

        {/* Live Filter Bar */}
        <input 
          type="text" 
          placeholder="🔍 Filter by player name or team..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: '100%', padding: '14px 20px', fontSize: '16px', backgroundColor: '#202024', border: '1px solid #323238', borderRadius: '8px', color: '#fff', marginBottom: '20px', boxSizing: 'border-box', outline: 'none' }}
        />

        {/* Dynamic Data Grid */}
        <div style={{ overflowX: 'auto', backgroundColor: '#202024', borderRadius: '8px', border: '1px solid #323238' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #323238', color: '#7c7c8a', fontSize: '13px', textTransform: 'uppercase' }}>
                <th style={{ padding: '16px' }}>Player Info</th>
                <th style={{ padding: '16px' }}>Team</th>
                <th style={{ padding: '16px' }}>Stat Category</th>
                <th style={{ padding: '16px', textAlign: 'right' }}>PrizePicks Line</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.length > 0 ? (
                filteredData.map((player) => (
                  <tr key={player.id} style={{ borderBottom: '1px solid #29292e', transition: 'background-color 0.2s' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#29292e'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                    <td style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                      {player.playerImage && (
                        <img src={player.playerImage} alt={player.playerName} style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: '#121214' }} />
                      )}
                      <div>
                        <div style={{ fontWeight: 'bold', color: '#fff' }}>{player.playerName}</div>
                        <div style={{ fontSize: '12px', color: '#7c7c8a' }}>{player.position} - {player.description}</div>
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px', fontWeight: '500' }}>{player.team}</td>
                    <td style={{ padding: '14px 16px' }}>
                      <span style={{ backgroundColor: '#29292e', padding: '4px 10px', borderRadius: '4px', fontSize: '13px', border: '1px solid #323238' }}>
                        {player.statType.replace('_', ' ')}
                      </span>
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right', fontWeight: 'bold', fontSize: '18px', color: '#00b37e' }}>
                      {player.line}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="4" style={{ padding: '30px', textAlign: 'center', color: '#7c7c8a' }}>No matching active player lines found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  );
}
