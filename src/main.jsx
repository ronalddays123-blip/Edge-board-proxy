// src/main.jsx
import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';

function AppDataEngine() {
  const [sportsbookData, setSportsbookData] = useState([]);
  const [prizepicksData, setPrizepicksData] = useState({});
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeSport, setActiveSport] = useState('NFL');

  useEffect(() => {
    let isAlive = true;
    
    async function syncData() {
      setLoading(true);
      try {
        const oddsSportParam = activeSport === 'NFL' ? 'americanfootball_nfl' : 'americanfootball_ncaaf';

        // Fetch both unblocked sportsbook lines and PrizePicks in parallel
        const [oddsRes, ppRes] = await Promise.all([
          fetch(`/api/odds?sport=${oddsSportParam}`),
          fetch(`/api/prizepicks?sport=${activeSport}`)
        ]);
        
        const oddsJson = await oddsRes.json();
        const ppJson = await ppRes.json();

        if (!isAlive) return;

        // Group live PrizePicks lines by player name + stat type for near-instant lookup speeds
        const ppLookup = {};
        if (ppJson?.success && Array.isArray(ppJson.projections)) {
          ppJson.projections.forEach(item => {
            if (item?.playerName && item?.statType) {
              const key = `${item.playerName.toLowerCase().trim()}_${item.statType.toLowerCase().trim()}`;
              ppLookup[key] = item.line;
            }
          });
        }

        setSportsbookData(oddsJson?.odds || []);
        setPrizepicksData(ppLookup);
      } catch (err) {
        console.error("Data matrix sync failure:", err.message);
      } finally {
        if (isAlive) setLoading(false);
      }
    }

    syncData();
    const timer = setInterval(syncData, 50000); // 50-second auto-refresh
    return () => { isAlive = false; clearInterval(timer); };
  }, [activeSport]);

  // useMemo optimizes search filtering so your screen layout never flags or freezes
  const filteredData = useMemo(() => {
    if (!Array.isArray(sportsbookData)) return [];
    
    // Group individual outcomes from the odds feed by unique player + market
    const uniqueMap = {};
    sportsbookData.forEach(item => {
      if (!item?.playerName) return;
      const key = `${item.playerName}_${item.marketType}`;
      if (!uniqueMap[key]) {
        uniqueMap[key] = item;
      }
    });

    const uniqueList = Object.values(uniqueMap);
    return uniqueList.filter(item => 
      item.playerName.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [sportsbookData, searchTerm]);

  return (
    <div style={{ backgroundColor: '#0d0e12', minHeight: '100vh', padding: '30px', color: '#f1f3f9', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        
        {/* Title Banner */}
        <h1 style={{ color: '#fff', margin: '0 0 5px 0', fontSize: '26px', fontWeight: '800' }}>EDGEBOARD PRO</h1>
        <p style={{ color: '#94a3b8', margin: '0 0 20px 0', fontSize: '14px' }}>Active Market Items Mapped: {filteredData.length}</p>
        
        {/* Navigation Filters */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
          <button onClick={() => setActiveSport('NFL')} style={{ backgroundColor: activeSport === 'NFL' ? '#00b37e' : '#1e293b', color: '#fff', border: 'none', padding: '12px 24px', borderRadius: '8px', fontWeight: '700', cursor: 'pointer', transition: '0.2s' }}>🏈 NFL</button>
          <button onClick={() => setActiveSport('CFB')} style={{ backgroundColor: activeSport === 'CFB' ? '#1e293b' : '#1e293b', color: '#fff', border: 'none', padding: '12px 24px', borderRadius: '8px', fontWeight: '700', cursor: 'pointer', transition: '0.2s' }}>🎓 CFB</button>
        </div>

        {/* Dynamic Search Input */}
        <input 
          type="text" 
          placeholder="🔍 Type a player profile name to filter lines..." 
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: '100%', padding: '14px 20px', fontSize: '15px', backgroundColor: '#141722', border: '1px solid #1e293b', borderRadius: '10px', color: '#ffffff', marginBottom: '20px', boxSizing: 'border-box', outline: 'none' }}
        />

        {/* Main Display Grid Frame */}
        <div style={{ backgroundColor: '#141722', borderRadius: '12px', padding: '20px', border: '1px solid #1e293b', boxShadow: '0 10px 25px rgba(0,0,0,0.3)' }}>
          {loading && filteredData.length === 0 ? (
            <div style={{ color: '#64748b', textAlign: 'center', padding: '20px', fontWeight: '600' }}>⚡ Streaming Live Sportsbook Market Matrix...</div>
          ) : filteredData.length > 0 ? (
            filteredData.map((item, idx) => {
              const name = item.playerName;
              
              // Simplify API market types into readable text labels
              let statLabel = item.marketType.replace(/_/g, ' ').toUpperCase();
              if (statLabel.includes('PASSING YARDS')) statLabel = 'PASSING YARDS';
              else if (statLabel.includes('RUSHING YARDS')) statLabel = 'RUSHING YARDS';
              else if (statLabel.includes('RECEIVING YARDS')) statLabel = 'RECEIVING YARDS';

              const bookLine = item.line || 0;
              const bookName = item.sportsbook || "Book";

              // Cross-reference lookup key into our mapped PrizePicks object parameters
              const mappingKey = `${name.toLowerCase().trim()}_${item.marketType.toLowerCase().trim()}`;
              const ppLine = prizepicksData[mappingKey];

              let ppLineDisplay = "Loading...";
              let calculatedEdgeText = "Market Stable";
              let edgeColor = "#64748b";

              if (ppLine !== undefined) {
                ppLineDisplay = ppLine;
                const diff = bookLine - ppLine;
                if (diff > 0) {
                  calculatedEdgeText = `🔥 OVER EDGE (+${diff.toFixed(1)})`;
                  edgeColor = '#00b37e'; 
                } else if (diff < 0) {
                  calculatedEdgeText = `🧊 UNDER EDGE (${Math.abs(diff).toFixed(1)})`;
                  edgeColor = '#ef4444'; 
                }
              } else {
                ppLineDisplay = "—";
                calculatedEdgeText = "No PP Line Found";
              }

              return (
                <div key={item.id || idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: '1px solid #1e293b' }}>
                  <div>
                    <div style={{ fontWeight: '700', color: '#fff', fontSize: '15px' }}>{name}</div>
                    <div style={{ color: '#64748b', fontSize: '11px', marginTop: '3px', fontWeight: '600', letterSpacing: '0.5px' }}>{statLabel}</div>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '20px', fontWeight: '700' }}>
                    <span style={{ color: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.08)', padding: '6px 12px', borderRadius: '6px', fontSize: '13px' }}>{bookName}: {bookLine}</span>
                    <span style={{ color: '#00b37e', fontSize: '14px', minWidth: '90px', textAlign: 'center' }}>PP: {ppLineDisplay}</span>
                    <span style={{ color: edgeColor, minWidth: '140px', textAlign: 'right', fontSize: '13px' }}>{calculatedEdgeText}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div style={{ color: '#64748b', textAlign: 'center', padding: '30px', fontWeight: '500' }}>No active betting markets currently found for this sport selection.</div>
          )}
        </div>

      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppDataEngine />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Minimalist error catcher to prevent compilation layout breakage alerts
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? <div style={{ color: '#fff', padding: '20px' }}>Dashboard Reloading...</div> : this.props.children; }

}
