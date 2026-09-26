// src/main.jsx
import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';

// ⚙️ ERROR BOUNDARY SYSTEM TO PREVENT WHITE SCREENS
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', backgroundColor: '#0d0e12', minHeight: '100vh', color: '#f87171', fontFamily: 'sans-serif', textAlign: 'center' }}>
          <h2>❌ Application Runtime Exception</h2>
          <p style={{ color: '#94a3b8' }}>{this.state.error?.toString()}</p>
          <button onClick={() => window.location.reload()} style={{ backgroundColor: '#3b82f6', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', marginTop: '10px' }}>Reload Dashboard</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// 📊 THE PLATFORM CORE ENGINE
function EdgeBoard() {
  const [prizepicksData, setPrizepicksData] = useState([]);
  const [sportsbookData, setSportsbookData] = useState({});
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeSport, setActiveSport] = useState('americanfootball_nfl');

  useEffect(() => {
    async function syncDataEngine() {
      setIsRefreshing(true);
      try {
        const [ppRes, oddsRes] = await Promise.all([
          fetch('/api/prizepicks'),
          fetch(`/api/odds?sport=${activeSport}`)
        ]);

        if (!ppRes.ok) throw new Error(`PrizePicks sync issue (${ppRes.status})`);
        if (!oddsRes.ok) throw new Error(`Sportsbook sync issue (${oddsRes.status})`);

        const ppJson = await ppRes.json();
        const oddsJson = await oddsRes.json();

        const oddsLookup = {};
        if (oddsJson && oddsJson.success && Array.isArray(oddsJson.odds)) {
          oddsJson.odds.forEach(item => {
            if (item && item.playerName) {
              const key = item.playerName.toLowerCase().trim();
              if (!oddsLookup[key]) oddsLookup[key] = [];
              oddsLookup[key].push(item);
            }
          });
        }

        const rawRows = ppJson?.projections || ppJson?.data || [];
        setPrizepicksData(Array.isArray(rawRows) ? rawRows : []);
        setSportsbookData(oddsLookup);
        setError(null);
      } catch (err) {
        console.error("Pipeline Sync Error:", err.message);
        setError(err.message);
      } finally {
        setIsRefreshing(false);
      }
    }

    syncDataEngine();
    const interval = setInterval(syncDataEngine, 45000);
    return () => clearInterval(interval);
  }, [activeSport]);

  const filteredData = useMemo(() => {
    if (!Array.isArray(prizepicksData)) return [];
    return prizepicksData.filter(item => {
      const name = item?.playerName || item?.attributes?.display_name || "";
      return name.toLowerCase().includes(searchTerm.toLowerCase());
    });
  }, [prizepicksData, searchTerm]);

  return (
    <div style={{ backgroundColor: '#0d0e12', minHeight: '100vh', padding: '40px 20px', color: '#f1f3f9', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        
        {/* Header Block Layout */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px', flexWrap: 'wrap', gap: '20px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
              <h1 style={{ margin: 0, color: '#ffffff', fontSize: '28px', fontWeight: '800', letterSpacing: '-0.5px' }}>EDGEBOARD PRO</h1>
              <span style={{ backgroundColor: '#1b2d24', color: '#34d399', fontSize: '11px', fontWeight: '700', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(52, 211, 153, 0.2)' }}>QUANT ENGINE ACTIVE</span>
            </div>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '14px' }}>Real-time positive expected value (+EV) market intelligence platform.</p>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {isRefreshing && <span style={{ color: '#fbbf24', fontSize: '13px' }}>🔄 Revalidating Feeds...</span>}
            <div style={{ backgroundColor: '#1e293b', padding: '10px 20px', borderRadius: '12px', fontSize: '13px', fontWeight: '700', border: '1px solid #334155', color: '#f8fafc' }}>
              🎯 Live Assets Mapped: {filteredData.length}
            </div>
          </div>
        </div>

        {/* Multi-Sport League Selection Panel */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', backgroundColor: '#141722', padding: '6px', borderRadius: '12px', border: '1px solid #1e293b', maxWidth: 'fit-content' }}>
          {[
            { id: 'americanfootball_nfl', label: '🏈 NFL' },
            { id: 'americanfootball_ncaaf', label: '🎓 CFB' },
            { id: 'basketball_nba', label: '🏀 NBA' },
            { id: 'basketball_ncaab', label: '🎓 CBB' }
          ].map(sport => (
            <button 
              key={sport.id}
              onClick={() => setActiveSport(sport.id)} 
              style={{ 
                backgroundColor: activeSport === sport.id ? '#3b82f6' : 'transparent', 
                color: activeSport === sport.id ? '#ffffff' : '#94a3b8', 
                border: 'none', 
                padding: '10px 20px', 
                borderRadius: '8px', 
                fontSize: '14px', 
                fontWeight: '700', 
                cursor: 'pointer', 
                transition: 'all 0.2s ease'
              }}
            >
              {sport.label}
            </button>
          ))}
        </div>

        {error && (
          <div style={{ padding: '16px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '12px', color: '#f87171', marginBottom: '24px', fontSize: '14px', fontWeight: '500' }}>
            ⚠️ Network Pipeline Exception: {error}
          </div>
        )}

        {/* Search Input Container */}
        <div style={{ position: 'relative', marginBottom: '24px' }}>
          <input 
            type="text" 
            placeholder="🔍 Search specific player profiles or teams..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '16px 20px', fontSize: '15px', backgroundColor: '#141722', border: '1px solid #1e293b', borderRadius: '12px', color: '#ffffff', boxSizing: 'border-box', outline: 'none', fontFamily: 'inherit' }}
          />
        </div>

        {/* Premium Data View Frame */}
        <div style={{ overflowX: 'auto', backgroundColor: '#141722', borderRadius: '16px', border: '1px solid #1e293b', boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '800px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1e293b', color: '#64748b', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                <th style={{ padding: '18px 24px' }}>Player Asset</th>
                <th style={{ padding: '18px 24px' }}>Market Variant</th>
                <th style={{ padding: '18px 24px', textAlign: 'center' }}>PrizePicks Projection</th>
                <th style={{ padding: '18px 24px' }}>Sharp Bookmaker Index</th>
                <th style={{ padding: '18px 24px', textAlign: 'right' }}>Calculated Edge</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.length > 0 ? (
                filteredData.map((player, idx) => {
                  if (!player) return null;
                  const name = player.playerName || player.attributes?.display_name || "Unknown Profile";
                  const stat = player.statType || player.attributes?.stat_type || "N/A";
                  const ppLine = player.line !== undefined ? player.line : player.attributes?.line_score || 0;
                  const team = player.team || player.attributes?.team || "PROP";
                  
                  const marketBooks = sportsbookData[name.toLowerCase().trim()] || [];

                  let lineDiffText = "Market Stable";
                  let badgeBg = '#1e293b';
                  let textColor = '#94a3b8';

                  if (marketBooks.length > 0) {
                    const firstMatch = marketBooks[0];
                    if (firstMatch && firstMatch.line !== undefined) {
                      const bookLine = firstMatch.line;
                      const diff = bookLine - ppLine;

                      if (diff > 0) {
                        lineDiffText = `🔥 OVER (+${diff.toFixed(1)})`;
                        badgeBg = 'rgba(16, 185, 129, 0.12)';
                        textColor = '#10b981';
                      } else if (diff < 0) {
                        lineDiffText = `🧊 UNDER (${diff.toFixed(1)})`;
                        badgeBg = 'rgba(239, 68, 68, 0.12)';
                        textColor = '#ef4444';
                      }
                    }
                  } else {
                    lineDiffText = "No Book Variants";
                  }

                  return (
                    <tr 
                      key={player.id || idx} 
                      style={{ borderBottom: '1px solid #11141d' }}
                    >
                      <td style={{ padding: '16px 24px' }}>
