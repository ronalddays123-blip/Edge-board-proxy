// src/main.jsx
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';

function AppDataEngine() {
  const [prizepicksData, setPrizepicksData] = useState([]);
  const [sportsbookData, setSportsbookData] = useState({});
  const [activeSport, setActiveSport] = useState('americanfootball_nfl');

  useEffect(() => {
    let isAlive = true;
    async function syncData() {
      try {
        // Map the website button variables over to the exact league names PrizePicks requires
        let ppSportParam = 'NFL';
        if (activeSport.includes('ncaaf')) ppSportParam = 'CFB';
        else if (activeSport.includes('basketball_nba')) ppSportParam = 'NBA';
        else if (activeSport.includes('ncaab')) ppSportParam = 'CBB';
        else if (activeSport.includes('mlb')) ppSportParam = 'MLB';

        const [ppRes, oddsRes] = await Promise.all([
          fetch(`/api/prizepicks?sport=${ppSportParam}`),
          fetch(`/api/odds?sport=${activeSport}`)
        ]);
        const ppJson = await ppRes.json();
        const oddsJson = await oddsRes.json();

        if (!isAlive) return;

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

        setPrizepicksData(ppJson?.projections || ppJson?.data || []);
        setSportsbookData(oddsLookup);
      } catch (err) {
        console.error("Data fetch error:", err.message);
      }
    }
    syncData();
    const timer = setInterval(syncData, 45000);
    return () => { isAlive = false; clearInterval(timer); };
  }, [activeSport]);

  return (
    <div style={{ backgroundColor: '#0d0e12', minHeight: '100vh', padding: '30px', color: '#f1f3f9', fontFamily: 'sans-serif' }}>
      <h1 style={{ color: '#fff', margin: '0 0 5px 0' }}>EDGEBOARD PRO</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 20px 0', fontSize: '14px' }}>Active Boards Mapped: {prizepicksData.length}</p>
      
      {/* Expanded Multi-Sport Panel */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '25px', flexWrap: 'wrap' }}>
        <button onClick={() => setActiveSport('americanfootball_nfl')} style={{ backgroundColor: activeSport === 'americanfootball_nfl' ? '#00b37e' : '#202024', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>🏈 NFL</button>
        <button onClick={() => setActiveSport('americanfootball_ncaaf')} style={{ backgroundColor: activeSport === 'americanfootball_ncaaf' ? '#00b37e' : '#202024', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>🎓 CFB</button>
        <button onClick={() => setActiveSport('basketball_nba')} style={{ backgroundColor: activeSport === 'basketball_nba' ? '#00b37e' : '#202024', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>🏀 NBA</button>
        <button onClick={() => setActiveSport('basketball_ncaab')} style={{ backgroundColor: activeSport === 'basketball_ncaab' ? '#00b37e' : '#202024', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>🎓 CBB</button>
        <button onClick={() => setActiveSport('baseball_mlb')} style={{ backgroundColor: activeSport === 'baseball_mlb' ? '#00b37e' : '#202024', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' }}>⚾ MLB</button>
      </div>

      <div style={{ backgroundColor: '#141722', borderRadius: '12px', padding: '20px', border: '1px solid #1e293b' }}>
        {prizepicksData.length > 0 ? (
          prizepicksData.slice(0, 75).map((player, idx) => {
            const name = player.playerName || "Unknown Player";
            const stat = player.statType || "Prop";
            const ppLine = player.line || 0;
            
            const matches = sportsbookData[name.toLowerCase().trim()] || [];
            const bookLine = matches.length > 0 ? matches[0].line : "No Match";

            return (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid #1e293b' }}>
                <div>
                  <div style={{ fontWeight: 'bold', color: '#fff' }}>{name}</div>
                  <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>{stat.replace(/_/g, ' ').toUpperCase()}</div>
                </div>
                <div style={{ fontWeight: 'bold', display: 'flex', alignItems: 'center' }}>
                  <span style={{ color: '#00b37e' }}>PP: {ppLine}</span>
                  <span style={{ marginLeft: '15px', color: '#3b82f6' }}>Books: {bookLine}</span>
                </div>
              </div>
            );
          })
        ) : (
          <div style={{ color: '#64748b', textAlign: 'center' }}>Connecting to data streams... Please wait.</div>
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
