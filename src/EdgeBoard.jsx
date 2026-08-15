import React, { useState, useMemo, useEffect, useCallback, memo } from "react";
import { TrendingUp, TrendingDown, Plus, Activity, Trash2, History, AlertCircle, Radio, RefreshCw } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

// Real, working persistence for the deployed site — localStorage, not
// window.storage (that API only exists inside Claude.ai's artifact preview
// and was silently doing nothing on the actual deployed domain). Mirrors the
// same get/set contract so the try/catch logic throughout this file needs no
// other changes: get() throws on a missing key, same as before.
const storage = {
  get: async (key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error("not found: " + key);
    return { key, value: raw };
  },
  set: async (key, value) => {
    localStorage.setItem(key, value);
    return { key, value };
  },
};


// NOTE ON LIVE FETCHING: this only works when Edge Board itself is deployed
// as a real site (e.g. alongside your proxy on Vercel). Inside the Claude.ai
// artifact preview, network calls are sandboxed to Anthropic's own API, so
// the fetch below will fail silently in-preview — that's expected, not a bug.
// Deploy this file for the live panel to actually pull odds.

const BOOKMAKER_KEY_MAP = {
  fanduel: "FanDuel",
  draftkings: "DraftKings",
  underdog: "Underdog Fantasy",
  prizepicks: "PrizePicks",
};

function extractSide(outcomeName) {
  if (!outcomeName) return null;
  const lower = outcomeName.toLowerCase();
  if (lower === "over" || lower.startsWith("over ")) return "Over";
  if (lower === "under" || lower.startsWith("under ")) return "Under";
  if (lower === "yes") return "Over";
  if (lower === "no") return "Under";
  return null;
}

function parseLiveOdds(json) {
  const events = Array.isArray(json) ? json : Object.values(json || {}).flat();
  const rows = {};
  (events || []).forEach((ev) => {
    const matchup = `${ev.away_team} @ ${ev.home_team}`;
    (ev.bookmakers || []).forEach((bm) => {
      const bookKey = BOOKMAKER_KEY_MAP[bm.key];
      if (!bookKey) return;
      (bm.markets || []).forEach((mkt) => {
        const stat = mkt.key.replace(/^player_/, "").replace(/_/g, " ");
        (mkt.outcomes || []).forEach((oc) => {
          const side = extractSide(oc.name);
          if (!side) return;
          const player = oc.description || "Unknown player";
          const line = oc.point;
          const id = `${player}|${stat}|${line}|${matchup}`;
          if (!rows[id]) rows[id] = { player, stat, line, matchup, books: emptyBooks() };
          rows[id].books[bookKey][side.toLowerCase()] = oc.price;
        });
      });
    });
  });
  return Object.values(rows);
}

// ---------- odds math ----------
const impliedProb = (odds) => {
  const o = Number(odds);
  if (!o) return null;
  return o > 0 ? 100 / (o + 100) : -o / (-o + 100);
};

// Power-method vig removal: finds exponent e such that pi1^e + pi2^e = 1,
// then fair_i = pi_i^e. This compresses extreme probabilities more than
// simple proportional scaling and is the better-regarded correction for
// favorite/longshot bias in the de-vig literature. Falls back to
// proportional scaling if there's no vig to remove (shouldn't normally happen).
const powerDevig = (overOdds, underOdds) => {
  const pi1 = impliedProb(overOdds);
  const pi2 = impliedProb(underOdds);
  if (pi1 == null || pi2 == null) return null;
  const B = pi1 + pi2;
  if (B <= 1) return { overFair: pi1 / B, underFair: pi2 / B, hold: B - 1 };

  const f = (e) => Math.pow(pi1, e) + Math.pow(pi2, e);
  let lo = 1, hi = 50;
  while (f(hi) > 1 && hi < 5000) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 1) lo = mid; else hi = mid;
  }
  const e = (lo + hi) / 2;
  return { overFair: Math.pow(pi1, e), underFair: Math.pow(pi2, e), hold: B - 1 };
};

const probToAmerican = (p) => {
  if (!p || p <= 0 || p >= 1) return null;
  return p > 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
};

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const oddsFmt = (o) => (o == null || o === "" ? null : Number(o) > 0 ? `+${o}` : `${o}`);
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "leg";

// ---------- stats helpers for correlation ----------
function invNormCDF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        let val = A[i][i] - sum;
        if (val < 1e-8) val = 1e-8;
        L[i][j] = Math.sqrt(val);
      } else {
        L[i][j] = (A[i][j] - sum) / (L[j][j] || 1e-8);
      }
    }
  }
  return L;
}

function randNormal() {
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function slipEVExact(legs, payoutTable) {
  const n = legs.length;
  if (n === 0) return { ev: 0, winProb: 0 };
  let ev = 0, winProb = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let prob = 1, correct = 0;
    for (let i = 0; i < n; i++) {
      const p = legs[i].fairProb;
      if (mask & (1 << i)) { prob *= p; correct++; } else { prob *= 1 - p; }
    }
    const mult = payoutTable[correct] || 0;
    ev += prob * mult;
    if (correct === n) winProb = prob;
  }
  return { ev, winProb };
}

function slipEVCorrelated(legs, payoutTable, groupCorr, trials = 4000) {
  const n = legs.length;
  if (n === 0) return { ev: 0, winProb: 0 };
  const rho = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (legs[i].group && legs[i].group === legs[j].group) {
        const r = groupCorr[legs[i].group] ?? 0.3;
        rho[i][j] = r; rho[j][i] = r;
      }
    }
  }
  const L = cholesky(rho);
  const thresholds = legs.map((l) => invNormCDF(1 - l.fairProb));
  let evSum = 0, wins = 0;
  for (let t = 0; t < trials; t++) {
    const z = Array.from({ length: n }, randNormal);
    let correct = 0;
    for (let i = 0; i < n; i++) {
      let xi = 0;
      for (let k = 0; k <= i; k++) xi += L[i][k] * z[k];
      if (xi > thresholds[i]) correct++;
    }
    evSum += payoutTable[correct] || 0;
    if (correct === n) wins++;
  }
  return { ev: evSum / trials, winProb: wins / trials };
}

const DEFAULT_POWER = { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 };
const DEFAULT_FLEX = {
  3: { 3: 2.25, 2: 1.25 },
  4: { 4: 5, 3: 1.5 },
  5: { 5: 10, 4: 2, 3: 0.4 },
  6: { 6: 25, 5: 2, 4: 0.4 },
};

const BOOKS = [
  { key: "PrizePicks", short: "PP", color: "#B084F5" },
  { key: "Underdog Fantasy", short: "UD", color: "#3FCF7F" },
  { key: "DraftKings", short: "DK", color: "#D9B94A" },
  { key: "FanDuel", short: "FD", color: "#3E9CFF" },
];
const SHORT_TO_KEY = Object.fromEntries(BOOKS.map((b) => [b.short, b.key]));
const emptyBooks = () => Object.fromEntries(BOOKS.map((b) => [b.key, { over: "", under: "" }]));
const STAT_PRESETS = ["Points", "Rebounds", "Assists", "PRA", "3PT Made", "Steals", "Blocks"];

// Combines fair probabilities across books, weighting lower-hold (tighter) lines
// more heavily since a tighter two-sided price is generally a more trustworthy
// signal than a book quoting a wide, loose market on the same prop.
function computeFairFromBooks(books, side) {
  const rows = [];
  BOOKS.forEach(({ key }) => {
    const b = books[key];
    if (b && b.over && b.under) {
      const nv = powerDevig(b.over, b.under);
      if (nv) rows.push({ fair: side === "Over" ? nv.overFair : nv.underFair, hold: Math.max(nv.hold, 0.001) });
    }
  });
  if (rows.length === 0) return null;
  const weights = rows.map((r) => 1 / r.hold);
  const totalW = weights.reduce((a, c) => a + c, 0);
  const fairProb = rows.reduce((sum, r, i) => sum + r.fair * weights[i], 0) / totalW;
  const spread = rows.length > 1 ? Math.max(...rows.map((r) => r.fair)) - Math.min(...rows.map((r) => r.fair)) : 0;
  return { fairProb, n: rows.length, spread };
}

function parseQuickPaste(text) {
  const updates = {};
  const chunks = text.split(/[,;\n]+/);
  chunks.forEach((chunk) => {
    const m = chunk.trim().match(/^([A-Za-z]{2,3})\D*(-?\+?\d+)\s*\/\s*(-?\+?\d+)/);
    if (m) {
      const key = SHORT_TO_KEY[m[1].toUpperCase()];
      if (key) updates[key] = { over: m[2], under: m[3] };
    }
  });
  return updates;
}

const COLORS = {
  bg: "#0A0D10", panel: "#12171C", line: "#232B32", text: "#E7ECEF",
  muted: "#7C8894", faint: "#4B555F", green: "#35C48C", red: "#FF5C5C", amber: "#E8A33D",
};
const mono = "'IBM Plex Mono','SF Mono',ui-monospace,Menlo,monospace";
const sans = "'Inter',system-ui,-apple-system,sans-serif";

function Field({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: sans, fontSize: 11, letterSpacing: "0.06em", color: COLORS.muted, textTransform: "uppercase" }}>{label}</span>
      {children}
    </div>
  );
}

const inputStyle = {
  background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 4, color: COLORS.text,
  fontFamily: mono, fontSize: 13, padding: "7px 9px", outline: "none", width: "100%",
};

const chipStyle = (active) => ({
  fontFamily: sans, fontSize: 12, padding: "6px 12px", borderRadius: 16, cursor: "pointer",
  border: `1px solid ${active ? COLORS.green : COLORS.line}`,
  background: active ? "rgba(53,196,140,0.15)" : "transparent",
  color: active ? COLORS.green : COLORS.muted, fontWeight: 600,
});

const cellColor = (bookKey, leg) => {
  const b = leg.books?.[bookKey];
  const oddsSide = leg.side === "Over" ? b?.over : b?.under;
  if (!b || !oddsSide) return null;
  const imp = impliedProb(oddsSide);
  if (leg.fairProb == null || imp == null) return "neutral";
  if (imp < leg.fairProb - 0.005) return "green";
  if (imp > leg.fairProb + 0.005) return "red";
  return "neutral";
};

const SPORT_MARKETS = {
  basketball_wnba: "player_points,player_rebounds,player_assists",
  basketball_nba: "player_points,player_rebounds,player_assists",
  baseball_mlb: "player_hits,player_home_runs,player_strikeouts",
  americanfootball_nfl: "player_pass_yds,player_rush_yds,player_receptions",
  icehockey_nhl: "player_points,player_shots_on_goal,player_goals",
  soccer_epl: "player_shots_on_target,player_goals,player_assists",
  soccer_uefa_champs_league: "player_shots_on_target,player_goals,player_assists",
  mma_mixed_martial_arts: "fight_winner",
  tennis_atp: "player_total_games_won",
};

// Groups fetched rows by player+stat (ignoring exact line) so a PrizePicks
// number can be compared against whatever sharp books quoted for that same
// player/stat, even when PrizePicks set a different threshold than the
// sportsbooks did — which it very often does.
function buildPPComparison(rows) {
  const byPlayerStat = {};
  rows.forEach((row) => {
    const key = `${row.player}|${row.stat}`;
    if (!byPlayerStat[key]) byPlayerStat[key] = { player: row.player, stat: row.stat, matchup: row.matchup, lines: [] };
    byPlayerStat[key].lines.push(row);
  });

  const out = [];
  Object.values(byPlayerStat).forEach((group) => {
    const ppRow = group.lines.find((r) => {
      const pp = r.books["PrizePicks"];
      return pp && (pp.over || pp.under);
    });
    if (!ppRow) return;

    const sharpCandidates = group.lines
      .map((r) => ({ row: r, result: computeFairFromBooks(r.books, "Over") }))
      .filter((c) => c.result && c.result.n >= 1);
    if (sharpCandidates.length === 0) return;

    const ref = sharpCandidates.sort((a, b) => (b.result.n || 0) - (a.result.n || 0))[0];
    const sameLine = Number(ref.row.line) === Number(ppRow.line);

    out.push({
      player: group.player, stat: group.stat, matchup: group.matchup,
      ppLine: ppRow.line, sharpLine: ref.row.line, sameLine,
      sharpFairOver: ref.result.fairProb, sharpN: ref.result.n,
    });
  });
  return out;
}

const LiveFeedPanel = memo(function LiveFeedPanel({ onQuickAdd }) {
  const [proxyUrl, setProxyUrl] = useState("");
  const [sport, setSport] = useState("basketball_wnba");
  const [markets, setMarkets] = useState(SPORT_MARKETS.basketball_wnba);
  const [marketsTouched, setMarketsTouched] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [minBooks, setMinBooks] = useState(2);
  const [minEdge, setMinEdge] = useState(3);

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get("proxy-url");
        if (res?.value) setProxyUrl(res.value);
      } catch (e) { /* no saved url yet */ }
    })();
  }, []);

  const saveUrl = (val) => {
    setProxyUrl(val);
    storage.set("proxy-url", val).catch(() => {});
  };

  const fetchLive = async () => {
    if (!proxyUrl) return setError("Paste your deployed proxy URL first.");
    setLoading(true); setError(""); setRows([]);
    try {
      const base = proxyUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/api/odds?sport=${sport}&markets=${markets}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      const parsed = parseLiveOdds(json);
      setRows(parsed);
      if (parsed.length === 0) setError("Connected, but found no player prop rows — the response shape may differ from what this expects. Check the raw JSON and let me know its structure.");
    } catch (e) {
      setError(`Fetch failed: ${e.message}. Remember this only works when Edge Board is deployed live, not inside the Claude.ai preview.`);
    }
    setLoading(false);
  };

  // rank every fetched row by its strongest side's edge off a 50% coin flip —
  // that's the real signal for a single-leg PrizePicks-style pick, since the
  // vig is already stripped out on both sides by this point
  const ranked = useMemo(() => {
    return rows
      .map((row) => {
        const overResult = computeFairFromBooks(row.books, "Over");
        const underResult = computeFairFromBooks(row.books, "Under");
        const best = (overResult?.fairProb ?? 0) >= (underResult?.fairProb ?? 0)
          ? { side: "Over", ...overResult }
          : { side: "Under", ...underResult };
        if (!best.fairProb) return null;
        const edgePts = (best.fairProb - 0.5) * 100;
        return { ...row, bestSide: best.side, bestFairProb: best.fairProb, n: best.n, edgePts };
      })
      .filter(Boolean)
      .filter((r) => r.n >= minBooks && r.edgePts >= minEdge)
      .sort((a, b) => b.edgePts - a.edgePts);
  }, [rows, minBooks, minEdge]);

  const addFromRow = (row, side) => {
    const result = computeFairFromBooks(row.books, side);
    if (!result) return;
    onQuickAdd({
      id: Date.now(), name: row.player, matchup: row.matchup, stat: row.stat, line: row.line, side,
      group: null, fairProb: result.fairProb, fairOdds: probToAmerican(result.fairProb),
      books: row.books, include: true, confidence: { n: result.n, spread: result.spread },
    }, { propName: `${row.player}-${row.stat}`, snapshot: { timestamp: Date.now(), side, fairProb: result.fairProb, line: row.line, stat: row.stat } });
  };

  const ppComparison = useMemo(() => buildPPComparison(rows), [rows]);

  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.green}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 12, color: COLORS.green, letterSpacing: "0.06em", marginBottom: 12 }}>
        <Radio size={14} /> LIVE FEED
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 10 }}>
        <Field label="Your deployed proxy URL">
          <input style={inputStyle} value={proxyUrl} onChange={(e) => saveUrl(e.target.value)} placeholder="https://edge-board-proxy.vercel.app" />
        </Field>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Field label="Favorites">
          <div style={{ display: "flex", gap: 6 }}>
            {[
              { label: "WNBA", value: "basketball_wnba" },
              { label: "NBA", value: "basketball_nba" },
              { label: "NFL", value: "americanfootball_nfl" },
            ].map((f) => (
              <button
                key={f.value}
                onClick={() => {
                  setSport(f.value);
                  if (!marketsTouched) setMarkets(SPORT_MARKETS[f.value] || "");
                }}
                style={{ ...chipStyle(sport === f.value), flex: 1 }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <Field label="Sport">
          <select style={{ ...inputStyle, cursor: "pointer" }} value={sport} onChange={(e) => {
            const next = e.target.value;
            setSport(next);
            if (!marketsTouched) setMarkets(SPORT_MARKETS[next] || "");
          }}>
            <option value="basketball_wnba">WNBA</option>
            <option value="basketball_nba">NBA</option>
            <option value="americanfootball_nfl">NFL</option>
            <option value="baseball_mlb">MLB</option>
            <option value="icehockey_nhl">NHL</option>
            <option value="soccer_epl">Soccer — EPL</option>
            <option value="soccer_uefa_champs_league">Soccer — Champions League</option>
            <option value="mma_mixed_martial_arts">MMA</option>
            <option value="tennis_atp">Tennis — ATP</option>
          </select>
        </Field>
        <Field label="Markets">
          <input style={inputStyle} value={markets} onChange={(e) => { setMarkets(e.target.value); setMarketsTouched(true); }} />
          {marketsTouched && (
            <button onClick={() => { setMarketsTouched(false); setMarkets(SPORT_MARKETS[sport] || ""); }} style={{ background: "none", border: "none", color: COLORS.green, fontFamily: mono, fontSize: 10, padding: "2px 0", cursor: "pointer", textAlign: "left" }}>
              reset to {sport} defaults
            </button>
          )}
        </Field>
      </div>
      <button onClick={fetchLive} disabled={loading} style={{ display: "flex", alignItems: "center", gap: 6, background: COLORS.green, color: "#04140D", border: "none", borderRadius: 6, padding: "9px 14px", fontFamily: sans, fontWeight: 600, fontSize: 13, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1, marginBottom: 12 }}>
        <RefreshCw size={15} /> {loading ? "Fetching…" : "Fetch live props"}
      </button>

      {error && <div style={{ display: "flex", gap: 6, color: COLORS.amber, fontSize: 12, marginBottom: 12, fontFamily: sans }}><AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {error}</div>}

      {rows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: mono, fontSize: 11, color: COLORS.faint }}>MIN BOOKS</span>
              <select style={{ ...inputStyle, width: 60, padding: "4px 6px" }} value={minBooks} onChange={(e) => setMinBooks(Number(e.target.value))}>
                <option value={1}>1+</option><option value={2}>2+</option><option value={3}>3+</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontFamily: mono, fontSize: 11, color: COLORS.faint }}>MIN EDGE</span>
              <select style={{ ...inputStyle, width: 70, padding: "4px 6px" }} value={minEdge} onChange={(e) => setMinEdge(Number(e.target.value))}>
                <option value={0}>0pt</option><option value={3}>3pt</option><option value={5}>5pt</option><option value={8}>8pt</option>
              </select>
            </div>
            <span style={{ fontFamily: mono, fontSize: 11, color: COLORS.faint }}>{ranked.length} of {rows.length} pass filters</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 400, overflowY: "auto" }}>
            {ranked.map((row, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.bg, border: `1px solid ${i < 3 ? COLORS.green : COLORS.line}`, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>{row.player} — {row.stat} {row.line}</div>
                  <div style={{ color: COLORS.faint, fontSize: 11, fontFamily: mono }}>{row.matchup}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 3, fontFamily: mono, fontSize: 11 }}>
                    <span style={{ color: COLORS.green, fontWeight: 700 }}>{row.bestSide} favored · {pct(row.bestFairProb)}</span>
                    <span style={{ color: COLORS.amber }}>+{row.edgePts.toFixed(1)}pt edge</span>
                    <span style={{ color: row.n === 1 ? COLORS.amber : COLORS.faint }}>{row.n} bk{row.n > 1 ? "s" : ""}</span>
                  </div>
                </div>
                <button onClick={() => addFromRow(row, row.bestSide)} style={{ fontFamily: mono, fontSize: 11, padding: "6px 10px", borderRadius: 5, border: `1px solid ${COLORS.green}`, color: COLORS.green, background: "transparent", cursor: "pointer", flexShrink: 0, marginLeft: 8 }}>+ Add {row.bestSide}</button>
              </div>
            ))}
            {ranked.length === 0 && <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono }}>Nothing clears your filters yet — try lowering min books or min edge.</p>}
          </div>

          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLORS.line}` }}>
            <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.text, letterSpacing: "0.06em", marginBottom: 8 }}>PRIZEPICKS VS SHARP MARKET</div>
            {ppComparison.length === 0 ? (
              <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono }}>No PrizePicks lines came back in this fetch — either this sport/market combo doesn't have them, or ParlayAPI doesn't carry PrizePicks data at all. Not something this code controls.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ppComparison.map((c, i) => (
                  <div key={i} style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "8px 10px" }}>
                    <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>{c.player} — {c.stat}</div>
                    <div style={{ color: COLORS.faint, fontSize: 11, fontFamily: mono, marginBottom: 4 }}>{c.matchup}</div>
                    {c.sameLine ? (
                      <div style={{ fontFamily: mono, fontSize: 12 }}>
                        <span style={{ color: COLORS.text }}>PP line matches sharp line: {c.ppLine}</span>{" "}
                        <span style={{ color: c.sharpFairOver > 0.5 ? COLORS.green : COLORS.red }}>
                          · Over fair {pct(c.sharpFairOver)} ({c.sharpN} bk{c.sharpN > 1 ? "s" : ""})
                        </span>
                      </div>
                    ) : (
                      <div style={{ fontFamily: mono, fontSize: 12 }}>
                        <span style={{ color: COLORS.amber }}>PP: {c.ppLine} vs sharp: {c.sharpLine}</span>{" "}
                        <span style={{ color: COLORS.faint }}>
                          — different thresholds, can't give an exact number. {Number(c.ppLine) < Number(c.sharpLine)
                            ? "PP set lower, so Over is directionally easier there than at the sharp line."
                            : "PP set higher, so Under is directionally easier there than at the sharp line."}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});

const AddLegPanel = memo(function AddLegPanel({ onAdd, defaultMatchup, defaultGroup }) {
  const [name, setName] = useState("");
  const [matchup, setMatchup] = useState(defaultMatchup || "");
  const [stat, setStat] = useState("");
  const [lineVal, setLineVal] = useState("");
  const [side, setSide] = useState("Over");
  const [group, setGroup] = useState(defaultGroup || "");
  const [bookInputs, setBookInputs] = useState(emptyBooks());
  const [quickPaste, setQuickPaste] = useState("");
  const [manualProb, setManualProb] = useState("");
  const [mode, setMode] = useState("books");
  const [error, setError] = useState("");

  const preview = useMemo(() => (mode === "books" ? computeFairFromBooks(bookInputs, side) : null), [bookInputs, side, mode]);

  const applyQuickPaste = (text) => {
    setQuickPaste(text);
    const updates = parseQuickPaste(text);
    if (Object.keys(updates).length) setBookInputs((prev) => ({ ...prev, ...updates }));
  };

  const setBookField = (bookKey, field, val) =>
    setBookInputs((prev) => ({ ...prev, [bookKey]: { ...prev[bookKey], [field]: val } }));

  const submit = () => {
    setError("");
    if (!name.trim()) return setError("Add a player name.");
    if (!stat.trim()) return setError("Add a stat (e.g. Points, Rebounds).");
    if (!lineVal.toString().trim()) return setError("Add the line number.");

    let fairProb, meta = null;
    const booksSnapshot = mode === "books" ? JSON.parse(JSON.stringify(bookInputs)) : {};

    if (mode === "books") {
      const result = computeFairFromBooks(bookInputs, side);
      if (!result) return setError("Enter Over and Under odds for at least one book.");
      fairProb = result.fairProb;
      meta = result;
    } else {
      const p = Number(manualProb) / 100;
      if (!p || p <= 0 || p >= 1) return setError("Enter a valid probability between 1 and 99%.");
      fairProb = p;
    }

    onAdd(
      { id: Date.now(), name, matchup, stat, line: lineVal, side, group: group.trim() || null,
        fairProb, fairOdds: probToAmerican(fairProb), books: booksSnapshot, include: true,
        confidence: meta ? { n: meta.n, spread: meta.spread } : null },
      mode === "books" ? { propName: `${name}-${stat}`, snapshot: { timestamp: Date.now(), side, fairProb, line: lineVal, stat } } : null
    );

    setName(""); setLineVal(""); setBookInputs(emptyBooks()); setQuickPaste(""); setManualProb("");
  };

  const handleKeyDown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };

  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20 }} onKeyDown={handleKeyDown}>
      <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
        <button onClick={() => setMode("books")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: sans, fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", paddingBottom: 6, color: mode === "books" ? COLORS.text : COLORS.faint, borderBottom: mode === "books" ? `2px solid ${COLORS.green}` : "2px solid transparent" }}>De-vig from books</button>
        <button onClick={() => setMode("manual")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: sans, fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", paddingBottom: 6, color: mode === "manual" ? COLORS.text : COLORS.faint, borderBottom: mode === "manual" ? `2px solid ${COLORS.green}` : "2px solid transparent" }}>Enter fair % manually</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Field label="Player"><input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jackie Young" /></Field>
        <Field label="Matchup"><input style={inputStyle} value={matchup} onChange={(e) => setMatchup(e.target.value)} placeholder="e.g. LVA vs. NYL" /></Field>
      </div>

      <div style={{ marginBottom: 10 }}>
        <Field label="Stat">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {STAT_PRESETS.map((s) => (
              <button key={s} onClick={() => setStat(s)} style={chipStyle(stat === s)}>{s}</button>
            ))}
          </div>
          <input style={inputStyle} value={stat} onChange={(e) => setStat(e.target.value)} placeholder="or type a custom stat" />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Field label="Line"><input style={inputStyle} value={lineVal} onChange={(e) => setLineVal(e.target.value)} placeholder="4" /></Field>
        <Field label="Side">
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setSide("Over")} style={{ ...chipStyle(side === "Over"), flex: 1 }}>Over</button>
            <button onClick={() => setSide("Under")} style={{ ...chipStyle(side === "Under"), flex: 1 }}>Under</button>
          </div>
        </Field>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Field label="Correlation group (optional)"><input style={inputStyle} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Same game tag" /></Field>
      </div>

      {mode === "books" ? (
        <>
          <div style={{ marginBottom: 10 }}>
            <Field label="Quick paste — e.g. &quot;DK -110/-120, FD +105/-125&quot;">
              <input style={inputStyle} value={quickPaste} onChange={(e) => applyQuickPaste(e.target.value)} placeholder="DK -110/-120, FD +105/-125, UD -115/-105" />
            </Field>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {BOOKS.map((b) => (
              <div key={b.key} style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr", gap: 8, alignItems: "center" }}>
                <span style={{ fontFamily: mono, fontSize: 12, color: b.color, fontWeight: 600 }}>{b.short} · {b.key}</span>
                <input style={inputStyle} placeholder="Over odds" value={bookInputs[b.key].over} onChange={(e) => setBookField(b.key, "over", e.target.value)} />
                <input style={inputStyle} placeholder="Under odds" value={bookInputs[b.key].under} onChange={(e) => setBookField(b.key, "under", e.target.value)} />
              </div>
            ))}
          </div>
          {preview != null && (
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, fontFamily: mono, marginBottom: preview.n > 1 ? 8 : 0 }}>
                <div><div style={{ fontSize: 10, color: COLORS.faint }}>VALUE (FAIR PROB, {side})</div><div style={{ color: COLORS.text, fontSize: 16 }}>{pct(preview.fairProb)}</div></div>
                <div><div style={{ fontSize: 10, color: COLORS.faint }}>FAIR ODDS</div><div style={{ color: COLORS.green, fontSize: 16 }}>{oddsFmt(probToAmerican(preview.fairProb))}</div></div>
              </div>
              <div style={{ fontFamily: mono, fontSize: 11, color: preview.n === 1 ? COLORS.amber : COLORS.faint }}>
                {preview.n} book{preview.n > 1 ? "s" : ""} used
                {preview.n === 1 ? " · single-book price, lower confidence" : ` · books agree within ${(preview.spread * 100).toFixed(1)}pt`}
              </div>
            </div>
          )}
        </>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <Field label="Fair win probability (%)"><input style={inputStyle} value={manualProb} onChange={(e) => setManualProb(e.target.value)} placeholder="e.g. 58.5" /></Field>
        </div>
      )}

      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.red, fontSize: 12, marginBottom: 10, fontFamily: sans }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <button onClick={submit} style={{ display: "flex", alignItems: "center", gap: 6, background: COLORS.green, color: "#04140D", border: "none", borderRadius: 6, padding: "9px 14px", fontFamily: sans, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
        <Plus size={15} /> Add to board <span style={{ opacity: 0.6, fontWeight: 400 }}>(Enter)</span>
      </button>
    </div>
  );
});

const BoardRow = memo(function BoardRow({ leg, onToggle, onRemove }) {
  return (
    <tr style={{ borderBottom: `1px solid ${COLORS.line}`, opacity: leg.include ? 1 : 0.35 }}>
      <td style={{ padding: "10px 10px 10px 0" }}>
        <input type="checkbox" checked={leg.include} onChange={() => onToggle(leg.id)} style={{ marginRight: 6, verticalAlign: "middle" }} />
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 6, background: "#B084F5", color: "#0A0D10", fontFamily: mono, fontSize: 10, fontWeight: 700, verticalAlign: "middle" }}>PP</span>
      </td>
      <td style={{ padding: "10px 10px 10px 0" }}>
        <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>{leg.name}</div>
        <div style={{ color: COLORS.faint, fontSize: 11, fontFamily: mono }}>{leg.matchup}{leg.group ? ` · grp: ${leg.group}` : ""}</div>
      </td>
      <td style={{ padding: "10px 10px 10px 0" }}>
        <div style={{ display: "inline-block", background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "3px 8px", fontFamily: mono, fontSize: 12, color: COLORS.text, fontWeight: 600 }}>{leg.side} {leg.line}</div>
        <div style={{ color: COLORS.faint, fontSize: 11, marginTop: 2 }}>{leg.stat}</div>
      </td>
      <td style={{ padding: "10px 10px 10px 0" }}>
        <div style={{ fontFamily: mono, fontSize: 14, color: COLORS.text, fontWeight: 600 }}>{pct(leg.fairProb)}</div>
        {leg.confidence && (
          <div style={{ fontFamily: mono, fontSize: 10, color: leg.confidence.n === 1 ? COLORS.amber : COLORS.faint }}>{leg.confidence.n} bk{leg.confidence.n > 1 ? "s" : ""}</div>
        )}
      </td>
      <td style={{ padding: "10px 10px 10px 0", fontFamily: mono, fontSize: 13, color: COLORS.text }}>{oddsFmt(leg.fairOdds) || "—"}</td>
      {BOOKS.map((b) => {
        const bk = leg.books?.[b.key];
        const over = oddsFmt(bk?.over);
        const under = oddsFmt(bk?.under);
        const color = cellColor(b.key, leg);
        const bg = color === "green" ? "rgba(53,196,140,0.18)" : color === "red" ? "rgba(255,92,92,0.15)" : "transparent";
        const fg = color === "green" ? COLORS.green : color === "red" ? COLORS.red : COLORS.faint;
        return (
          <td key={b.key} style={{ padding: "10px 10px 10px 0" }}>
            {(over || under) ? (
              <div>
                <div style={{ color: COLORS.faint, fontSize: 10, fontFamily: mono }}>{leg.line}</div>
                <div style={{ display: "inline-block", background: bg, color: fg, border: `1px solid ${fg}`, borderRadius: 5, padding: "3px 7px", fontFamily: mono, fontSize: 11, fontWeight: 600 }}>
                  {over || "—"}{under ? ` / ${under}` : ""}
                </div>
              </div>
            ) : <span style={{ color: COLORS.faint, fontSize: 12 }}>—</span>}
          </td>
        );
      })}
      <td style={{ padding: "10px 0 10px 0" }}>
        <button onClick={() => onRemove(leg.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
      </td>
    </tr>
  );
});

// Buckets graded predictions by their predicted probability and compares
// predicted rate vs actual hit rate per bucket — the core calibration check.
// A well-calibrated model's "60% picks" should hit ~60% of the time; if your
// 60% bucket is actually hitting 45%, that bucket's numbers aren't trustworthy
// even though the math inside them is internally consistent.
function buildCalibrationReport(predictions) {
  const graded = predictions.filter((p) => p.result === "hit" || p.result === "miss");
  const buckets = [
    [0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.75],
    [0.75, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 1.01],
  ];
  const report = buckets.map(([lo, hi]) => {
    const inBucket = graded.filter((p) => p.fairProb >= lo && p.fairProb < hi);
    const hits = inBucket.filter((p) => p.result === "hit").length;
    return {
      label: `${Math.round(lo * 100)}-${Math.round(Math.min(hi, 1) * 100)}%`,
      n: inBucket.length,
      predicted: inBucket.length ? (inBucket.reduce((s, p) => s + p.fairProb, 0) / inBucket.length) * 100 : null,
      actual: inBucket.length ? (hits / inBucket.length) * 100 : null,
    };
  }).filter((b) => b.n > 0);

  const brier = graded.length
    ? graded.reduce((s, p) => s + Math.pow((p.result === "hit" ? 1 : 0) - p.fairProb, 2), 0) / graded.length
    : null;

  return { report, graded, brier, totalHits: graded.filter((p) => p.result === "hit").length };
}

const CalibrationPanel = memo(function CalibrationPanel({ predictions, onGrade }) {
  const ungraded = predictions.filter((p) => p.result === null).sort((a, b) => b.timestamp - a.timestamp);
  const { report, graded, brier, totalHits } = useMemo(() => buildCalibrationReport(predictions), [predictions]);

  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
      <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em", marginBottom: 4 }}>CALIBRATION TRACKER</div>
      <p style={{ color: COLORS.faint, fontSize: 11, margin: "0 0 14px", lineHeight: 1.5 }}>
        Every leg you add gets logged automatically. Once you know how a prop actually turned out, grade it below —
        that's what lets this report tell you whether "60% fair" picks are actually hitting close to 60%.
      </p>

      {graded.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, marginBottom: 14 }}>
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
              <div style={{ fontSize: 10, color: COLORS.faint, fontFamily: mono }}>GRADED / HIT RATE</div>
              <div style={{ fontSize: 18, color: COLORS.text, fontFamily: mono, marginTop: 4 }}>{graded.length} · {((totalHits / graded.length) * 100).toFixed(1)}%</div>
            </div>
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
              <div style={{ fontSize: 10, color: COLORS.faint, fontFamily: mono }}>BRIER SCORE (lower = better)</div>
              <div style={{ fontSize: 18, color: COLORS.text, fontFamily: mono, marginTop: 4 }}>{brier.toFixed(3)}</div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 40px", fontFamily: mono, fontSize: 10, color: COLORS.faint }}>
              <span>BUCKET</span><span>PREDICTED</span><span>ACTUAL</span><span>N</span>
            </div>
            {report.map((b) => {
              const gap = b.actual - b.predicted;
              const flag = Math.abs(gap) >= 10 && b.n >= 5;
              return (
                <div key={b.label} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 40px", fontFamily: mono, fontSize: 12, alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${COLORS.line}` }}>
                  <span style={{ color: COLORS.text }}>{b.label}</span>
                  <span style={{ color: COLORS.faint }}>{b.predicted.toFixed(1)}%</span>
                  <span style={{ color: flag ? COLORS.red : COLORS.green }}>{b.actual.toFixed(1)}%{flag ? " ⚠" : ""}</span>
                  <span style={{ color: COLORS.faint }}>{b.n}</span>
                </div>
              );
            })}
          </div>
          <p style={{ color: COLORS.faint, fontSize: 10, margin: "8px 0 0", fontFamily: mono }}>
            ⚠ flags buckets where actual hit rate is 10+ points off predicted, with at least 5 graded picks — small
            sample sizes will bounce around a lot, so don't over-read a bucket with only 2-3 picks in it.
          </p>
        </div>
      )}

      {ungraded.length > 0 && (
        <div>
          <div style={{ fontFamily: mono, fontSize: 11, color: COLORS.amber, marginBottom: 8 }}>{ungraded.length} UNGRADED</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
            {ungraded.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "7px 10px" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: COLORS.text, fontSize: 12, fontWeight: 600 }}>{p.player} {p.side} {p.line} {p.stat}</div>
                  <div style={{ color: COLORS.faint, fontSize: 10, fontFamily: mono }}>{pct(p.fairProb)} fair · {p.matchup}</div>
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                  <button onClick={() => onGrade(p.id, "hit")} style={{ fontFamily: mono, fontSize: 10, padding: "4px 7px", borderRadius: 4, border: `1px solid ${COLORS.green}`, color: COLORS.green, background: "transparent", cursor: "pointer" }}>Hit</button>
                  <button onClick={() => onGrade(p.id, "miss")} style={{ fontFamily: mono, fontSize: 10, padding: "4px 7px", borderRadius: 4, border: `1px solid ${COLORS.red}`, color: COLORS.red, background: "transparent", cursor: "pointer" }}>Miss</button>
                  <button onClick={() => onGrade(p.id, "push")} style={{ fontFamily: mono, fontSize: 10, padding: "4px 7px", borderRadius: 4, border: `1px solid ${COLORS.faint}`, color: COLORS.faint, background: "transparent", cursor: "pointer" }}>Push</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {predictions.length === 0 && <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono }}>No picks logged yet — add a leg above and it'll show up here to grade later.</p>}
    </div>
  );
});

// Closing Line Value: compares the fair probability at the moment you made
// a pick against the fair probability the last time that same prop/side was
// fetched (ideally right before the game). Positive CLV — the market moving
// toward your side after you picked it — is a lower-variance signal of real
// edge than win/loss alone, since win/loss is noisy even for a genuinely
// good process over a small sample.
const CLVPanel = memo(function CLVPanel({ predictions }) {
  const [snapshotCache, setSnapshotCache] = useState({});
  const [loading, setLoading] = useState(false);

  const uniqueKeys = useMemo(
    () => [...new Set(predictions.filter((p) => p.propKey).map((p) => p.propKey))],
    [predictions]
  );

  useEffect(() => {
    (async () => {
      const missing = uniqueKeys.filter((k) => !(k in snapshotCache));
      if (missing.length === 0) return;
      setLoading(true);
      const updates = {};
      for (const key of missing) {
        try {
          const res = await storage.get(`line-history:${key}`);
          updates[key] = res ? JSON.parse(res.value) : [];
        } catch (e) {
          updates[key] = [];
        }
      }
      setSnapshotCache((prev) => ({ ...prev, ...updates }));
      setLoading(false);
    })();
  }, [uniqueKeys]);

  const rows = useMemo(() => {
    return predictions
      .filter((p) => p.propKey)
      .map((p) => {
        const snaps = (snapshotCache[p.propKey] || [])
          .filter((s) => s.side === p.side)
          .sort((a, b) => a.timestamp - b.timestamp);
        if (snaps.length < 2) return { ...p, clv: null, closeProb: null };
        const open = snaps[0].fairProb;
        const close = snaps[snaps.length - 1].fairProb;
        return { ...p, clv: (close - open) * 100, closeProb: close };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [predictions, snapshotCache]);

  const withClv = rows.filter((r) => r.clv !== null);
  const avgClv = withClv.length ? withClv.reduce((s, r) => s + r.clv, 0) / withClv.length : null;
  const beatClose = withClv.filter((r) => r.clv > 0).length;

  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
      <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em", marginBottom: 4 }}>CLOSING LINE VALUE</div>
      <p style={{ color: COLORS.faint, fontSize: 11, margin: "0 0 14px", lineHeight: 1.5 }}>
        Compares your fair number at pick time to the last fair number recorded for that same prop/side. To get a
        close value logged, re-fetch or re-add that same prop again closer to game time — right now this only works
        for props you added via "De-vig from books" or the Live Feed, since manual entries don't have snapshot history.
      </p>

      {avgClv !== null && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, marginBottom: 16 }}>
          <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
            <div style={{ fontSize: 10, color: COLORS.faint, fontFamily: mono }}>AVG CLV ({withClv.length} picks)</div>
            <div style={{ fontSize: 20, fontFamily: mono, marginTop: 4, color: avgClv > 0 ? COLORS.green : COLORS.red }}>
              {avgClv >= 0 ? "+" : ""}{avgClv.toFixed(1)}pt
            </div>
          </div>
          <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
            <div style={{ fontSize: 10, color: COLORS.faint, fontFamily: mono }}>BEAT THE CLOSE</div>
            <div style={{ fontSize: 20, fontFamily: mono, marginTop: 4, color: COLORS.text }}>
              {beatClose}/{withClv.length} ({((beatClose / withClv.length) * 100).toFixed(0)}%)
            </div>
          </div>
        </div>
      )}

      {loading && <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono }}>Loading snapshot history…</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
        {rows.map((r) => (
          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "7px 10px" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: COLORS.text, fontSize: 12, fontWeight: 600 }}>{r.player} {r.side} {r.line} {r.stat}</div>
              <div style={{ color: COLORS.faint, fontSize: 10, fontFamily: mono }}>pick: {pct(r.fairProb)}{r.closeProb !== null ? ` · close: ${pct(r.closeProb)}` : ""}</div>
            </div>
            <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, flexShrink: 0, marginLeft: 8, color: r.clv === null ? COLORS.faint : r.clv > 0 ? COLORS.green : COLORS.red }}>
              {r.clv === null ? "no close yet" : `${r.clv >= 0 ? "+" : ""}${r.clv.toFixed(1)}pt`}
            </div>
          </div>
        ))}
        {rows.length === 0 && <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono }}>No trackable picks yet.</p>}
      </div>
    </div>
  );
});

export default function EdgeBoard() {
  const [legs, setLegs] = useState([]);
  const [entryType, setEntryType] = useState("power");
  const [multipliers, setMultipliers] = useState({ ...DEFAULT_POWER });
  const [flexMultipliers, setFlexMultipliers] = useState(
    Object.fromEntries(Object.entries(DEFAULT_FLEX).map(([k, v]) => [k, { ...v }]))
  );
  const [groupCorr, setGroupCorr] = useState({});

  const [historyIndex, setHistoryIndex] = useState([]);
  const [selectedHistoryProp, setSelectedHistoryProp] = useState(null);
  const [historyData, setHistoryData] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [predictions, setPredictions] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get("predictions-log");
        setPredictions(res ? JSON.parse(res.value) : []);
      } catch (e) {
        setPredictions([]);
      }
    })();
  }, []);

  const savePredictions = useCallback(async (next) => {
    setPredictions(next);
    try {
      await storage.set("predictions-log", JSON.stringify(next));
    } catch (e) {
      console.error("storage error", e);
    }
  }, []);

  const logPrediction = useCallback((leg) => {
    setPredictions((prev) => {
      const next = [...prev, {
        id: leg.id, player: leg.name, stat: leg.stat, line: leg.line, side: leg.side,
        matchup: leg.matchup, fairProb: leg.fairProb, timestamp: Date.now(), result: null,
        propKey: slugify(`${leg.name}-${leg.stat}`),
      }];
      storage.set("predictions-log", JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const gradePrediction = useCallback((id, result) => {
    setPredictions((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, result } : p));
      storage.set("predictions-log", JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get("line-index");
        setHistoryIndex(res ? JSON.parse(res.value) : []);
      } catch (e) {
        setHistoryIndex([]);
      }
    })();
  }, []);

  const logSnapshot = useCallback(async (propName, snapshot) => {
    const slug = slugify(propName);
    try {
      let arr = [];
      try {
        const res = await storage.get(`line-history:${slug}`);
        arr = res ? JSON.parse(res.value) : [];
      } catch (e) { arr = []; }
      arr.push(snapshot);
      await storage.set(`line-history:${slug}`, JSON.stringify(arr));
      setHistoryIndex((prev) => {
        if (prev.find((i) => i.slug === slug)) return prev;
        const next = [...prev, { slug, name: propName }];
        storage.set("line-index", JSON.stringify(next)).catch(() => {});
        return next;
      });
    } catch (e) {
      console.error("storage error", e);
    }
  }, []);

  const selectHistoryProp = async (slug) => {
    setSelectedHistoryProp(slug);
    setHistoryLoading(true);
    try {
      const res = await storage.get(`line-history:${slug}`);
      setHistoryData(res ? JSON.parse(res.value) : []);
    } catch (e) {
      setHistoryData([]);
    }
    setHistoryLoading(false);
  };

  const handleAddLeg = useCallback((leg, historyEntry) => {
    setLegs((prev) => [...prev, leg]);
    if (historyEntry) logSnapshot(historyEntry.propName, historyEntry.snapshot);
    logPrediction(leg);
  }, [logSnapshot, logPrediction]);

  const removeLeg = useCallback((id) => setLegs((prev) => prev.filter((l) => l.id !== id)), []);
  const toggleLeg = useCallback((id) => setLegs((prev) => prev.map((l) => (l.id === id ? { ...l, include: !l.include } : l))), []);

  const lastLeg = legs[legs.length - 1];

  const includedLegs = useMemo(() => legs.filter((l) => l.include), [legs]);
  const n = includedLegs.length;
  const payoutTable = entryType === "power" ? { [n]: multipliers[n] || 0 } : flexMultipliers[n] || {};

  const activeGroups = useMemo(() => {
    const counts = {};
    includedLegs.forEach((l) => { if (l.group) counts[l.group] = (counts[l.group] || 0) + 1; });
    return Object.keys(counts).filter((g) => counts[g] >= 2);
  }, [includedLegs]);

  const useMonteCarlo = activeGroups.some((g) => (groupCorr[g] ?? 0.3) !== 0);

  const { ev, winProb } = useMemo(() => {
    if (n === 0) return { ev: 0, winProb: 0 };
    return useMonteCarlo ? slipEVCorrelated(includedLegs, payoutTable, groupCorr) : slipEVExact(includedLegs, payoutTable);
  }, [includedLegs, payoutTable, entryType, useMonteCarlo, groupCorr]);

  const topMult = entryType === "power" ? multipliers[n] : payoutTable[n];
  const breakeven = topMult ? 1 / topMult : null;
  const evPerDollar = ev - 1;
  const isPositive = n > 0 && evPerDollar > 0;

  const historyChart = useMemo(() => historyData.map((h, i) => ({ idx: i + 1, fairPct: +(h.fairProb * 100).toFixed(1) })), [historyData]);
  const opening = historyData[0];
  const current = historyData[historyData.length - 1];
  const delta = opening && current ? (current.fairProb - opening.fairProb) * 100 : null;

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", padding: "28px 16px", fontFamily: sans }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div style={{ borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 16, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.green, fontFamily: mono, fontSize: 12, letterSpacing: "0.1em" }}>
            <Activity size={14} /> NO-VIG PROP ENGINE
          </div>
          <h1 style={{ color: COLORS.text, fontFamily: mono, fontSize: 28, fontWeight: 600, margin: "6px 0 4px", letterSpacing: "-0.02em" }}>EDGE BOARD</h1>
          <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>De-vig lines across books, spot the value, track the move.</p>
        </div>

        <LiveFeedPanel onQuickAdd={handleAddLeg} />

        <AddLegPanel
          onAdd={handleAddLeg}
          defaultMatchup={lastLeg?.matchup}
          defaultGroup={lastLeg?.group}
          key={legs.length === 0 ? "empty" : "has-legs"}
        />

        {legs.length > 0 && (
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20, overflowX: "auto" }}>
            <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em", marginBottom: 12 }}>THE BOARD ({legs.length})</div>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 780 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  {["SITE", "PLAYER INFO", "BET DETAILS", "VALUE", "FAIR ODDS"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "0 10px 10px 0", fontFamily: sans, fontSize: 10, letterSpacing: "0.08em", color: COLORS.faint, fontWeight: 600 }}>{h}</th>
                  ))}
                  {BOOKS.map((b) => (
                    <th key={b.key} style={{ textAlign: "left", padding: "0 10px 10px 0" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: 6, background: b.color, color: "#0A0D10", fontFamily: mono, fontSize: 10, fontWeight: 700 }}>{b.short}</span>
                    </th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l) => <BoardRow key={l.id} leg={l} onToggle={toggleLeg} onRemove={removeLeg} />)}
              </tbody>
            </table>
          </div>
        )}

        {activeGroups.length > 0 && (
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.amber}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
            <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.amber, letterSpacing: "0.06em", marginBottom: 10 }}>CORRELATION GROUPS DETECTED</div>
            <p style={{ color: COLORS.muted, fontSize: 12, marginTop: 0, marginBottom: 12 }}>
              These legs share a game/player tag. Set the average pairwise correlation — the EV below then runs a Monte Carlo simulation instead of assuming independence.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {activeGroups.map((g) => (
                <div key={g} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontFamily: mono, fontSize: 12, color: COLORS.text, width: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g}</span>
                  <input type="range" min="-0.9" max="0.9" step="0.05" value={groupCorr[g] ?? 0.3} onChange={(e) => setGroupCorr({ ...groupCorr, [g]: Number(e.target.value) })} style={{ flex: 1 }} />
                  <span style={{ fontFamily: mono, fontSize: 13, color: COLORS.amber, width: 44, textAlign: "right" }}>{(groupCorr[g] ?? 0.3).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {n >= 2 && (
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em" }}>{n}-PICK {entryType.toUpperCase()} PLAY {useMonteCarlo ? "· CORRELATION-ADJUSTED" : ""}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setEntryType("power")} style={{ fontFamily: sans, fontSize: 12, padding: "5px 10px", borderRadius: 5, cursor: "pointer", background: entryType === "power" ? COLORS.line : "transparent", color: entryType === "power" ? COLORS.text : COLORS.faint, border: `1px solid ${COLORS.line}` }}>Power</button>
                <button onClick={() => setEntryType("flex")} disabled={!DEFAULT_FLEX[n]} style={{ fontFamily: sans, fontSize: 12, padding: "5px 10px", borderRadius: 5, cursor: DEFAULT_FLEX[n] ? "pointer" : "not-allowed", background: entryType === "flex" ? COLORS.line : "transparent", color: entryType === "flex" ? COLORS.text : COLORS.faint, border: `1px solid ${COLORS.line}` }}>Flex</button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
              {entryType === "power" ? (
                <Field label={`${n}-pick multiplier`}>
                  <input style={{ ...inputStyle, width: 100 }} value={multipliers[n] ?? ""} onChange={(e) => setMultipliers({ ...multipliers, [n]: Number(e.target.value) })} />
                </Field>
              ) : (
                Object.keys(flexMultipliers[n] || {}).sort((a, b) => b - a).map((k) => (
                  <Field key={k} label={`${k}/${n} correct`}>
                    <input style={{ ...inputStyle, width: 90 }} value={flexMultipliers[n][k]} onChange={(e) => setFlexMultipliers({ ...flexMultipliers, [n]: { ...flexMultipliers[n], [k]: Number(e.target.value) } })} />
                  </Field>
                ))
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 16 }}>
              <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
                <div style={{ fontSize: 11, color: COLORS.faint, fontFamily: mono }}>WIN PROB (ALL CORRECT){useMonteCarlo ? " · SIMULATED" : ""}</div>
                <div style={{ fontSize: 20, color: COLORS.text, fontFamily: mono, marginTop: 4 }}>{pct(winProb)}</div>
              </div>
              <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
                <div style={{ fontSize: 11, color: COLORS.faint, fontFamily: mono }}>BREAKEVEN PROB {topMult ? `(1 / ${topMult}x)` : ""}</div>
                <div style={{ fontSize: 20, color: COLORS.text, fontFamily: mono, marginTop: 4 }}>{pct(breakeven)}</div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: isPositive ? "rgba(53,196,140,0.1)" : "rgba(255,92,92,0.08)", border: `1px solid ${isPositive ? COLORS.green : COLORS.red}`, borderRadius: 8, padding: "14px 16px" }}>
              <div>
                <div style={{ fontSize: 11, color: COLORS.faint, fontFamily: mono, marginBottom: 2 }}>EXPECTED VALUE / $1 STAKED</div>
                <div style={{ fontSize: 24, fontFamily: mono, fontWeight: 600, color: isPositive ? COLORS.green : COLORS.red }}>{evPerDollar >= 0 ? "+" : ""}{(evPerDollar * 100).toFixed(1)}%</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: isPositive ? COLORS.green : COLORS.red, fontFamily: sans, fontWeight: 600, fontSize: 13 }}>
                {isPositive ? <TrendingUp size={18} /> : <TrendingDown size={18} />} {isPositive ? "+EV PLAY" : "-EV PLAY"}
              </div>
            </div>
          </div>
        )}

        <CalibrationPanel predictions={predictions} onGrade={gradePrediction} />

        <CLVPanel predictions={predictions} />

        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em", marginBottom: 12 }}>
            <History size={14} /> LINE HISTORY
          </div>
          {historyIndex.length === 0 ? (
            <p style={{ color: COLORS.faint, fontSize: 12, margin: 0, fontFamily: mono }}>Add a leg via "De-vig from books" to start tracking its fair probability over time.</p>
          ) : (
            <>
              <select style={{ ...inputStyle, cursor: "pointer", marginBottom: 14 }} value={selectedHistoryProp || ""} onChange={(e) => selectHistoryProp(e.target.value)}>
                <option value="" disabled>Select a tracked prop…</option>
                {historyIndex.map((h) => <option key={h.slug} value={h.slug}>{h.name}</option>)}
              </select>
              {historyLoading && <p style={{ color: COLORS.faint, fontSize: 12 }}>Loading…</p>}
              {!historyLoading && historyData.length > 0 && (
                <>
                  {historyData.length > 1 && delta != null && (
                    <div style={{ display: "flex", gap: 16, marginBottom: 12, fontFamily: mono, fontSize: 12 }}>
                      <span style={{ color: COLORS.faint }}>OPEN: <span style={{ color: COLORS.text }}>{pct(opening.fairProb)}</span></span>
                      <span style={{ color: COLORS.faint }}>NOW: <span style={{ color: COLORS.text }}>{pct(current.fairProb)}</span></span>
                      <span style={{ color: Math.abs(delta) >= 3 ? (delta > 0 ? COLORS.green : COLORS.red) : COLORS.muted }}>
                        Δ {delta >= 0 ? "+" : ""}{delta.toFixed(1)} pts {Math.abs(delta) >= 3 ? (delta > 0 ? "· steam toward your side" : "· steam away from your side") : ""}
                      </span>
                    </div>
                  )}
                  <div style={{ height: 180 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={historyChart}>
                        <CartesianGrid stroke={COLORS.line} strokeDasharray="3 3" />
                        <XAxis dataKey="idx" tick={{ fill: COLORS.faint, fontSize: 11 }} stroke={COLORS.line} />
                        <YAxis tick={{ fill: COLORS.faint, fontSize: 11 }} stroke={COLORS.line} domain={["dataMin - 3", "dataMax + 3"]} />
                        <Tooltip contentStyle={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, fontFamily: mono, fontSize: 12 }} labelFormatter={(v) => `Entry #${v}`} formatter={(v) => [`${v}%`, "Fair prob"]} />
                        <Line type="monotone" dataKey="fairPct" stroke={COLORS.green} strokeWidth={2} dot={{ r: 3 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
              {!historyLoading && selectedHistoryProp && historyData.length === 0 && <p style={{ color: COLORS.faint, fontSize: 12 }}>No snapshots yet for this prop.</p>}
            </>
          )}
        </div>

        {legs.length === 0 && (
          <div style={{ color: COLORS.faint, fontSize: 13, textAlign: "center", padding: "40px 0", fontFamily: mono }}>Add a leg above to populate the board.</div>
        )}

        <p style={{ color: COLORS.faint, fontSize: 11, marginTop: 24, lineHeight: 1.5 }}>
          Vig is now removed with the power method (compresses extreme prices better than simple proportional scaling),
          and when multiple books agree, tighter (lower-hold) lines are weighted more heavily. The "n books" tag on
          each leg tells you how much agreement backs that number — treat single-book legs with more caution.
          Correlation values are still your own estimate. PrizePicks multipliers vary by state/promotion — verify
          in-app. No calculator guarantees profit.
        </p>
      </div>
    </div>
  );
}
