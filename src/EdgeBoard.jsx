// src/EdgeBoard.jsx
import React, { useState, useEffect } from 'react';

export default function EdgeBoard() {
  const [prizepicksData, setPrizepicksData] = useState([]);
  const [sportsbookData, setSportsbookData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  
  // ⚡ THIS IS THE HOOK: Tracks which sport market is currently selected
  const [activeSport, setActiveSport] = useState('americanfootball_nfl');

  useEffect(() => {
    async function syncDataEngine() {
      setLoading(true); // Trigger brief loading state when switching sports
      try {
        // Appends the activeSport state string dynamically into your backend query router
        const [ppRes, oddsRes] = await Promise.all([
          fetch('/api/prizepicks'),
          fetch(`/api/odds?sport=${activeSport}`)
        ]);

        if (!ppRes.ok) throw new Error(`PrizePicks pipeline failure: Status ${ppRes.status}`);
        if (!oddsRes.ok) throw new Error(`Sportsbook odds pipeline failure: Status ${oddsRes.status}`);

        const ppJson = await ppRes.json();
        const oddsJson = await oddsRes.json();

        // Structure sportsbook lines by player name for instant dictionary lookup speeds
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
  }, [activeSport]); // ⚡ Re-runs the entire sync block automatically whenever a sport button is pushed!

  const filteredData = prizepicksData.filter(item => {
    const name = item.playerName || item.attributes?.display_name || "Unknown Player";
    return name.toLowerCase().includes(searchTerm.toLowerCase());
  });

  if (error) return <div style={{ padding: '40px', color: '#ff6b6b', textAlign: 'center', fontFamily: 'sans-serif' }}>❌ Engine Error: {error}</div>;

  return (
    <div style={{ backgroundColor: '#121214', minHeight: '100vh', padding: '30px', color: '#e1e1e6', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Header Section */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h1 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '26px' }}>+EV Market Discrepancy Matrix</h1>
            <p style={{ margin: '0', color: '#7c7c8a', fontSize: '14px' }}>Comparing Live PrizePicks Boards Against Sharp Sportsbooks</p>
          </div>
          <span style={{ backgroundColor: '#29292e', padding: '8px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', border: '1px solid #323238' }}>
            📊 Tracked Props: {filteredData.length}
          </span>
        </div>

        {/* ⚡ THE INTERACTIVE BUTTONS: Updates the hook state when clicked */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', flexWrap: 'wrap' }}>
          <button onClick={() => setActiveSport('americanfootball_nfl')} style={{ backgroundColor: activeSport === 'americanfootball_nfl' ? '#00b37e' : '#202024', color: '#fff', border: '1px solid #323238', padding: '10px 18px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>🏈 NFL</button>
          <button onClick={() => setActiveSport('americanfootball_ncaaf')} style={{ backgroundColor: activeSport === 'americanfootball_ncaaf' ? '#00b37e' : '#202024', color: '#fff', border: '1px solid #323238', padding: '10px 18px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>🎓 College Football</button>
          <button onClick={() => setActiveSport('basketball_nba')} style={{ backgroundColor: activeSport === 'basketball_nba' ? '#00b37e' : '#202024', color: '#fff', border: '1px solid #323238', padding: '10px 18px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>🏀 NBA</button>
          <button onClick={() => setActiveSport('basketball_ncaab')} style={{ backgroundColor: activeSport === 'basketball_ncaab' ? '#00b37e' : '#202024', color: '#fff', border: '1px solid #323238', padding: '10px 18px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>🎓 College Basketball</button>
        </div>

        {/* Real-time Search Filter */}
        <input 
          type="text" 
          placeholder="🔍 Type a player's name to filter lines..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: '100%', padding: '14px 20px', fontSize: '16px', backgroundColor: '#202024', border: '1px solid #323238', borderRadius: '8px', color: '#fff', marginBottom: '20px', boxSizing: 'border-box', outline: 'none' }}
        />

        {/* Multi-Book Comparison Table */}
        <div style={{ overflowX: 'auto', backgroundColor: '#202024', borderRadius: '8px', border: '1px solid #323238' }}>
          {loading ? (
            <div style={{ padding: '60px', color: '#fff', textAlign: 'center' }}>⚡ Synchronizing Fresh Market Feeds...</div>
          ) : (
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
                    
                    const marketBooks = sportsbookData[name.toLowerCase().trim()] || [];

                    let lineDiffText = "Market Aligned";
                    let badgeColor = "#29292e";
                    let textColor = "#e1e1e6";

                    if (marketBooks.length > 0) {
                      const bookLine = marketBooks[0].line;
                      const diff = bookLine - ppLine;

                      if (diff > 0) {
                        lineDiffText = `🔥 OVER (+${diff.toFixed(1)} Gap)`;
                        badgeColor = 'rgba(0, 179, 126, 0.15)';
                        textColor = '#00b37e';
                      } else if (diff < 0) {
                        lineDiffText = `🧊 UNDER (${diff.toFixed(1)} Gap)`;
                        badgeColor = 'rgba(247, 90, 104, 0.15)';
                        textColor = '#f75a68';
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
                              <span style={{ fontSize: '12px', color: '#4e4e5a', fontStyle: 'italic' }}>Lines generating...</span>
                            )}
