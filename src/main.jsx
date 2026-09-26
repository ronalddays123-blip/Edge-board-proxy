// src/main.jsx
import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';

function AppDataEngine() {
  const [prizepicksData, setPrizepicksData] = useState([]);
  const [sportsbookData, setSportsbookData] = useState({});
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeSport, setActiveSport] = useState('NFL');

  useEffect(() => {
    let isAlive = true;
    
    async function syncData() {
      setLoading(true);
      try {
        // Map the website buttons to the formatting your odds API file requires
        const oddsSportParam = activeSport === 'NFL' ? 'americanfootball_nfl' : 'americanfootball_ncaaf';

        // Hits your two Vercel proxy endpoints safely in parallel
        const [ppRes, oddsRes] = await Promise.all([
          fetch(`/api/prizepicks?sport=${activeSport}`),
          fetch(`/api/odds?sport=${oddsSportParam}`)
        ]);
        
        const ppJson = await ppRes.json();
        const oddsJson = await oddsRes.json();

        if (!isAlive) return;

        // Group external sportsbook lines by player name for near-instant lookup speeds
        const oddsLookup = {};
        if (oddsJson?.success && Array.isArray(oddsJson.odds)) {
          oddsJson.odds.forEach(item => {
            if (item?.playerName) {
              const key = item.playerName.toLowerCase().trim();
              if (!oddsLookup[key]) oddsLookup[key] = [];
              oddsLookup[key].push(item);
            }
          });
        }

        setPrizepicksData(ppJson?.projections || []);
        setSportsbookData(oddsLookup);
      } catch (err) {
        console.error("Data matrix sync failure:", err.message);
      } finally {
        if (isAlive) setLoading(false);
      }
    }

    syncData();
    const timer = setInterval(syncData, 50000); // Smart 50-second auto-refresh
    return () => { isAlive = false; clearInterval(timer); };
  }, [activeSport]);

  // useMemo isolates search input tracking so your phone's screen never lags or freezes
  const filteredData = useMemo(() => {
    if (!Array.isArray(prizepicksData)) return [];
    return prizepicksData.filter(item => {
      const name = item?.playerName || "";
      return name.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [prizepicksData, searchTerm]);

  return (
    <div style={{ backgroundColor: '#0d0e12', minHeight: '100vh', padding: '30px', color: '#f1f3f9', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Title Banner */}
        <h1 style={{ color: '#fff', margin: '0 0 5px 0', fontSize: '26px', fontWeight: '800' }}>EDGEBOARD PRO</h1>
        <p style={{ color: '#94a3b8', margin: '0 0 20px 0', fontSize: '14px' }}>Active Board Props Mapped: {filteredData.length}</p>
        
        {/* Navigation Filters */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
          <button onClick={() => setActiveSport('NFL')} style={{ backgroundColor: activeSport === 'NFL' ? '#00b37e' : '#1e293b', color: '#fff', border: 'none', padding: '12px 24px', borderRadius: '8px', fontWeight: '700', cursor: 'pointer', transition: '0.2s' }}>🏈 NFL</button>
          <button onClick={() => setActiveSport('CFB')} style={{ backgroundColor: activeSport === 'CFB' ? '#00b37e' : '#1e293b', color: '#fff', border: 'none', padding: '12px 24px', borderRadius: '8px', fontWeight: '700', cursor: 'pointer', transition: '0.2s' }}>🎓 CFB</button>
        </div>

        {/* Dynamic Search Bar */}
        <input 
          type="text" 
          placeholder="🔍 Type a player profile or team name to filter lines..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: '100%', padding: '14px 20px', fontSize: '15px', backgroundColor: '#141722', border: '1px solid #1e293b', borderRadius: '10px', color: '#ffffff', marginBottom: '20px', boxSizing: 'border-box', outline: 'none' }}
        />

        {/* Main Display Grid Frame */}
        <div style={{ backgroundColor: '#141722', borderRadius: '12px', padding: '20px', border: '1px solid #1e293b', boxShadow: '0 10px 25px rgba(0,0,0,0.3)' }}>
          {loading && filteredData.length === 0 ? (
            <div style={{ color: '#64748b', textAlign: 'center', padding: '20px', fontWeight: '600' }}>⚡ Refreshing Live Multi-Book Matrix Feeds...</div>
          ) : filteredData.length > 0 ? (
            filteredData.map((player, idx) => {
              const name = player.playerName || "Unknown Player";
              const stat = player.statType || "Prop";
              const ppLine = player.line || 0;
              
              const matches = sportsbookData[name.toLowerCase().trim()] || [];
              
              let bookLineText = "No Book Lines";
              let calculatedEdgeText = "Market Stable";
              let edgeColor = "#64748b";

              // Safely look inside the dictionary array match list to map sportsbook metrics
              if (matches.length > 0) {
                const bookMatch = matches[0]; // Safely extract the primary sportsbook data entry
                if (bookMatch && bookMatch.line !== undefined) {
                  const bookLine = parseFloat(bookMatch.line);
                  bookLineText = `${bookMatch.sportsbook}: ${bookLine}`;

                  const diff = bookLine - ppLine;
                  if (diff > 0) {
                    calculatedEdgeText = `🔥 OVER EDGE (+${diff.toFixed(1)})`;
                    edgeColor = '#00b37e'; 
                  } else if (diff < 0) {
                    calculatedEdgeText = `🧊 UNDER EDGE (${diff.toFixed(1)})`;
                    edgeColor = '#ef4444'; 
                  }
                }
              }

              return (
                <div key={player.id || idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: '1px solid #1e293b' }}>
                  <div>
                    <div style={{ fontWeight: '700', color: '#fff', fontSize: '15px' }}>{name}</div>
                    <div style={{ color: '#64748b', fontSize: '11px', marginTop: '3px', fontWeight: '600', letterSpacing: '0.5px' }}>{stat.replace(/_/g, ' ').toUpperCase()}</div>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '20px', fontWeight: '700' }}>
                    <span style={{ color: '#00b37e', backgroundColor: 'rgba(0, 179, 126, 0.08)', padding: '6px 12px', borderRadius: '6px', fontSize: '14px' }}>PP: {ppLine}</span>
                    <span style={{ color: '#3b82f6', fontSize: '14px', minWidth: '110px', textAlign: 'center' }}>{bookLineText}</span>
                    <span style={{ color: edgeColor, minWidth: '130px', textAlign: 'right', fontSize: '13px' }}>{calculatedEdgeText}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ color: '#64748b', textAlign: 'center', padding: '30px', fontWeight: '500' }}>No active boards currently open for this sport. Check back closer to game time!</div>
          )}
        </div>

      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppDataEngine />
  </React.StrictMode>

);
