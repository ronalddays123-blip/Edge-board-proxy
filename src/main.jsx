// src/main.jsx
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';

function AppDataEngine() {
  const [prizepicksData, setPrizepicksData] = useState([]);
  const [sportsbookData, setSportsbookData] = useState({});
  const [activeSport, setActiveSport] = useState('NFL');

  useEffect(() => {
    let isAlive = true;
    async function syncData() {
      try {
        const oddsSportParam = activeSport === 'NFL' ? 'americanfootball_nfl' : 'americanfootball_ncaaf';

        // Hits both the live PrizePicks scanner and the live sportsbook odds tracker simultaneously
        const [ppRes, oddsRes] = await Promise.all([
          fetch(`/api/prizepicks?sport=${activeSport}`),
          fetch(`/api/odds?sport=${oddsSportParam}`)
        ]);
        
        const ppJson = await ppRes.json();
        const oddsJson = await oddsRes.json();

        if (!isAlive) return;

        // Group external sportsbook line records into a fast dictionary index array
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
      }
    }
    syncData();
    const timer = setInterval(syncData, 45000);
    return () => { isAlive = false; clearInterval(timer); };
  }, [activeSport]);

  return (
    <div style={{ backgroundColor: '#0d0e12', minHeight: '100vh', padding: '30px', color: '#f1f3f9', fontFamily: 'sans-serif' }}>
      <h1 style={{ color: '#fff', margin: '0 0 5px 0', fontSize: '24px', fontWeight: 'bold' }}>EDGEBOARD PRO</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 20px 0', fontSize: '14px' }}>Active Lines Tracked: {prizepicksData.length}</p>
      
      <div style={{ display: 'flex', gap: '8px', marginBottom: '25px' }}>
        <button onClick={() => setActiveSport('NFL')} style={{ backgroundColor: activeSport === 'NFL' ? '#00b37e' : '#202024', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>🏈 NFL</button>
        <button onClick={() => setActiveSport('CFB')} style={{ backgroundColor: activeSport === 'CFB' ? '#00b37e' : '#202024', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>🎓 CFB</button>
      </div>

      <div style={{ backgroundColor: '#141722', borderRadius: '12px', padding: '20px', border: '1px solid #1e293b' }}>
        {prizepicksData.length > 0 ? (
          prizepicksData.map((player, idx) => {
            const name = player.playerName || "Unknown Player";
            const stat = player.statType || "Prop";
            const ppLine = player.line || 0;
            
            // Look up matching player lines from external bookmakers inside our state map
            const matches = sportsbookData[name.toLowerCase().trim()] || [];
            
            // Search the match array to pull a real sportsbook line benchmark (e.g. from DraftKings or Pinnacle)
            let bookLineText = "Scanning Markets...";
            let calculatedEdgeText = "Market Stable";
            let edgeColor = "#64748b";

            if (matches.length > 0) {
              const bookMatch = matches[0]; // Extract first matching sportsbook profile
              const bookLine = bookMatch.line;
              bookLineText = `${bookMatch.sportsbook}: ${bookLine}`;

              // Math Engine: Check if a structural discrepancy variant exists
              const diff = bookLine - ppLine;
              if (diff > 0) {
                calculatedEdgeText = `🔥 OVER EDGE (+${diff.toFixed(1)})`;
                edgeColor = '#00b37e'; // Green indicator for over value
              } else if (diff < 0) {
                calculatedEdgeText = `🧊 UNDER EDGE (${diff.toFixed(1)})`;
                edgeColor = '#ef4444'; // Red indicator for under value
              }
            } else {
              bookLineText = "Market Stable";
            }

            return (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: '1px solid #1e293b' }}>
                <div>
                  <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{name}</div>
                  <div style={{ color: '#64748b', fontSize: '12px', marginTop: '3px' }}>{stat.replace(/_/g, ' ').toUpperCase()}</div>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '20px', fontWeight: 'bold' }}>
                  <span style={{ color: '#00b37e', backgroundColor: 'rgba(0, 179, 126, 0.08)', padding: '6px 12px', borderRadius: '6px' }}>PP: {ppLine}</span>
                  <span style={{ color: '#3b82f6', fontSize: '14px', minWidth: '110px', textAlign: 'center' }}>{bookLineText}</span>
                  <span style={{ color: edgeColor, minWidth: '130px', textAlign: 'right', fontSize: '13px' }}>{calculatedEdgeText}</span>
                </div>
              </div>
            );
          })
        ) : (
          <div style={{ color: '#64748b', textAlign: 'center', padding: '20px' }}>Connecting to data matrix pipelines... Please wait.</div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppDataEngine />
  </React.StrictMode>

);
