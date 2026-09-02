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
  prophetx: "ProphetX",
  pinnacle: "Pinnacle",
  bet365: "Bet365",
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

// Maps our stat display names to both the correct MLB Stats API stat
// group (hitting vs pitching) and the actual gameLog field name — these
// are two separate mismatches with our naming, not just one. Strikeouts
// specifically means pitcher Ks thrown in almost every player-prop context,
// which lives under "pitching," not "hitting" — a real bug caught by an
// actual failed lookup on a pitcher prop, not a hypothetical.
const MLB_STAT_CONFIG = {
  "hits": { group: "hitting", field: "hits" },
  "home runs": { group: "hitting", field: "homeRuns" },
  "runs": { group: "hitting", field: "runs" },
  "rbis": { group: "hitting", field: "rbi" },
  "total bases": { group: "hitting", field: "totalBases" },
  "walks": { group: "hitting", field: "baseOnBalls" },
  "strikeouts": { group: "pitching", field: "strikeOuts" },
};

// Independent forecast, not derived from any bookmaker price — literally
// what fraction of the player's actual recent games cleared this exact line.
// This is intentionally simple and auditable: no hidden weighting, nothing
// you can't verify by counting the games yourself.
function computeEmpiricalModel(games, statField, line, side, lookback = 20) {
  const recent = games.slice(-lookback);
  const values = recent
    .map((g) => g.stat?.[statField])
    .filter((v) => v != null);
  if (values.length === 0) return null;
  const clears = values.filter((v) => (side === "Over" ? v > line : v < line)).length;
  return { modelProb: clears / values.length, gamesUsed: values.length };
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
          // Some bookmakers' feeds occasionally leak unresolved template
          // placeholders (like "{optionTypeAbbr}{value}") into the player
          // name field instead of a real name — bad upstream data, not
          // something worth displaying as if it's a real pick.
          if (player.includes("{") || player.includes("}")) return;
          const line = oc.point;
          const id = `${player}|${stat}|${line}|${matchup}`;
          if (!rows[id]) rows[id] = { player, stat, line, matchup, startTime: ev.commence_time, books: emptyBooks() };
          rows[id].books[bookKey][side.toLowerCase()] = oc.price;
          rows[id].books[bookKey].lastUpdate = mkt.last_update || bm.last_update || null;
        });
      });
    });
  });
  return Object.values(rows);
}

// Moneyline (h2h) parsing. Reuses the exact same two-sided de-vig math as
// player props — a team's win probability vs its opponent's is structurally
// identical to Over vs Under, just with team names instead. Home team gets
// stored in the "over" slot, away team in "under", purely so every existing
// function (computeFairFromBooks, gradeForPick, summarizePick) works
// unchanged instead of needing a parallel set of team-specific versions.
// Reads from the SAME response parseLiveOdds already receives — no extra
// fetch, since h2h markets just show up in the odds response if requested.
function parseTeamOdds(json) {
  const events = Array.isArray(json) ? json : Object.values(json || {}).flat();
  const rows = {};
  (events || []).forEach((ev) => {
    const matchup = `${ev.away_team} @ ${ev.home_team}`;
    (ev.bookmakers || []).forEach((bm) => {
      const bookKey = BOOKMAKER_KEY_MAP[bm.key];
      if (!bookKey) return;
      (bm.markets || []).forEach((mkt) => {
        if (mkt.key !== "h2h") return;
        const id = matchup;
        if (!rows[id]) {
          rows[id] = {
            matchup, startTime: ev.commence_time, homeTeam: ev.home_team, awayTeam: ev.away_team,
            marketType: "Moneyline", books: emptyBooks(),
          };
        }
        (mkt.outcomes || []).forEach((oc) => {
          if (oc.name === ev.home_team) rows[id].books[bookKey].over = oc.price;
          else if (oc.name === ev.away_team) rows[id].books[bookKey].under = oc.price;
          rows[id].books[bookKey].lastUpdate = mkt.last_update || bm.last_update || null;
        });
      });
    });
  });
  return Object.values(rows);
}

// Extracts spread magnitude per matchup — a real, verifiable signal from the
// same trusted odds feed, used only to FLAG risk, never to silently adjust a
// probability. A large spread genuinely correlates with game-script distortion
// (garbage time, clock-bleeding, abandoning the run) for football yardage
// props specifically. This surfaces that as context for you to weigh, rather
// than guessing a "correct" adjustment magnitude we have no real data for.
function parseSpreadRisk(json) {
  const events = Array.isArray(json) ? json : Object.values(json || {}).flat();
  const risk = {};
  (events || []).forEach((ev) => {
    const matchup = `${ev.away_team} @ ${ev.home_team}`;
    (ev.bookmakers || []).forEach((bm) => {
      (bm.markets || []).forEach((mkt) => {
        if (mkt.key !== "spreads") return;
        (mkt.outcomes || []).forEach((oc) => {
          const magnitude = Math.abs(oc.point ?? 0);
          if (!risk[matchup] || magnitude > risk[matchup]) risk[matchup] = magnitude;
        });
      });
    });
  });
  return risk;
}

function blowoutRiskLevel(spread) {
  if (spread == null) return null;
  if (spread >= 17) return { label: "High blowout risk", color: "#FF5C5C" };
  if (spread >= 10) return { label: "Moderate blowout risk", color: "#E8A33D" };
  return null;
}

const FOOTBALL_YARDAGE_STATS = ["passing yards", "rushing yards", "receiving yards", "pass yds", "rush yds", "receiving yds"];

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

// Shows the point estimate plus its heuristic range, e.g. "62% (56–68%)" —
// makes the false precision of a single number visible instead of implying
// certainty a 1-2 book price doesn't actually support.
const pctRange = (fairProb, halfWidth) => {
  if (fairProb == null) return "—";
  if (halfWidth == null) return pct(fairProb);
  const lo = Math.max(0, fairProb - halfWidth) * 100;
  const hi = Math.min(1, fairProb + halfWidth) * 100;
  return `${(fairProb * 100).toFixed(1)}% (${lo.toFixed(0)}–${hi.toFixed(0)}%)`;
};
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
  { key: "ProphetX", short: "PX", color: "#FF8A5C" },
  { key: "Pinnacle", short: "PN", color: "#5CE0E0" },
  { key: "Bet365", short: "B3", color: "#FFD447" },
];
const SHORT_TO_KEY = Object.fromEntries(BOOKS.map((b) => [b.short, b.key]));
const emptyBooks = () => Object.fromEntries(BOOKS.map((b) => [b.key, { over: "", under: "", lastUpdate: null }]));
const STAT_PRESETS = ["Points", "Rebounds", "Assists", "PRA", "3PT Made", "Steals", "Blocks"];

// Combines fair probabilities across books, weighting lower-hold (tighter) lines
// more heavily since a tighter two-sided price is generally a more trustworthy
// signal than a book quoting a wide, loose market on the same prop.
// Older quotes count for less. A price under a minute old gets full weight;
// it decays linearly down to a floor of 0.3 by 15 minutes old. Never zero —
// an old quote is still weak evidence, just weaker, and zeroing it out
// entirely could break the calc if every book happens to be stale at once.
function freshnessWeight(lastUpdate) {
  if (!lastUpdate) return 0.7; // unknown age — treat as moderately trustworthy
  const ageSec = (Date.now() - new Date(lastUpdate).getTime()) / 1000;
  if (ageSec <= 60) return 1;
  if (ageSec >= 900) return 0.3;
  return 1 - ((ageSec - 60) / (900 - 60)) * 0.7;
}

function computeFairFromBooks(books, side) {
  let rows = [];
  BOOKS.forEach(({ key }) => {
    const b = books[key];
    if (b && b.over && b.under) {
      const nv = powerDevig(b.over, b.under);
      if (nv) rows.push({ fair: side === "Over" ? nv.overFair : nv.underFair, hold: Math.max(nv.hold, 0.001), lastUpdate: b.lastUpdate });
    }
  });
  if (rows.length === 0) return null;

  // Outlier rejection: only meaningful with 3+ books (with 2, "outlier" vs
  // "disagreement" isn't distinguishable), and never rejects down below 2
  // remaining — a book that's merely different isn't necessarily wrong, but
  // one that's wildly off the rest shouldn't quietly drag the average.
  let excludedCount = 0;
  if (rows.length >= 3) {
    const sortedFair = [...rows.map((r) => r.fair)].sort((a, b) => a - b);
    const mid = Math.floor(sortedFair.length / 2);
    const median = sortedFair.length % 2 ? sortedFair[mid] : (sortedFair[mid - 1] + sortedFair[mid]) / 2;
    const kept = rows.filter((r) => Math.abs(r.fair - median) <= 0.08);
    if (kept.length >= 2) {
      excludedCount = rows.length - kept.length;
      rows = kept;
    }
  }

  const weights = rows.map((r) => (1 / r.hold) * freshnessWeight(r.lastUpdate));
  const totalW = weights.reduce((a, c) => a + c, 0);
  const fairProb = rows.reduce((sum, r, i) => sum + r.fair * weights[i], 0) / totalW;
  const spread = rows.length > 1 ? Math.max(...rows.map((r) => r.fair)) - Math.min(...rows.map((r) => r.fair)) : 0;
  const timestamps = rows.map((r) => r.lastUpdate).filter(Boolean).map((t) => new Date(t).getTime());
  const oldestUpdate = timestamps.length ? Math.min(...timestamps) : null;

  // Heuristic uncertainty range, not a real statistical CI — there's no
  // sampling distribution here, just book disagreement as a proxy for how
  // trustworthy the point estimate is. A single book gets a flat assumed
  // uncertainty since there's nothing to compare it against; 2+ books
  // shrink the range as they agree more and as more of them pile on.
  const halfWidth = rows.length === 1 ? 0.05 : Math.max(0.015, (spread / 2) / Math.sqrt(rows.length));

  return { fairProb, n: rows.length, spread, oldestUpdate, excludedCount, halfWidth };
}

// Formats a timestamp's age as short, color-coded text — green under a
// minute, amber under 10, red beyond that (a price that old may no longer
// reflect where the market actually is).
function formatAge(ms) {
  if (!ms) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  let text;
  if (seconds < 60) text = `${seconds}s ago`;
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)}m ago`;
  else text = `${Math.floor(seconds / 3600)}h ago`;
  const color = seconds < 60 ? COLORS.green : seconds < 600 ? COLORS.amber : COLORS.red;
  return { text, color };
}

function formatGameTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return null;
  }
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

// A composite grade for how much to TRUST a number, not how likely it is to
// win — those are different things, and treating them as the same is exactly
// the overconfidence that gets people in trouble. A "C" pick can hit and an
// "A+" pick can miss; the grade only reflects edge size, book agreement,
// how many books back the number, and recent line movement in the pick's
// favor. It cannot and does not predict outcomes.
function gradeForPick(edgePts, n, spread, steamPts) {
  const confidenceMult = n >= 3 ? 1 : n === 2 ? 0.8 : 0.55;
  const spreadPenalty = (spread || 0) * 100 * 0.6;
  // only steam moving toward the pick's side counts as a bonus — movement
  // against it isn't penalized here since that's already reflected in the
  // fair probability itself, not double-counted as a separate ding
  const steamBonus = steamPts > 0 ? Math.min(steamPts, 10) * 0.4 : 0;
  const score = Math.max(0, edgePts * confidenceMult - spreadPenalty + steamBonus);

  if (score >= 12) return { letter: "A+", color: "#35C48C", score };
  if (score >= 8) return { letter: "A", color: "#35C48C", score };
  if (score >= 5) return { letter: "B", color: "#3E9CFF", score };
  if (score >= 2) return { letter: "C", color: "#E8A33D", score };
  return { letter: "D", color: "#7C8894", score };
}

// Pure synthesis of signals already computed elsewhere — no new data, no new
// fetches, nothing that can go down. Just combines edge, book agreement,
// steam, outlier rejection, and (when available) the MLB model into one
// readable line, so you're not manually cross-referencing five separate
// badges to form a verdict every time.
function summarizePick(row, model) {
  const bits = [];

  bits.push(row.n >= 3 ? `${row.n} books agree` : row.n === 2 ? "2 books agree" : "only 1 book — low confidence");

  if (row.steamPts >= 3) bits.push("line moved your way");
  else if (row.steamPts <= -3) bits.push("line moved against you");

  if (row.excludedCount > 0) bits.push(`${row.excludedCount} outlier excluded`);

  if (row.halfWidth != null && row.halfWidth >= 0.08) bits.push("wide uncertainty range");

  if (row.blowoutRisk) bits.push(row.blowoutRisk.label.toLowerCase());

  if (model?.modelProb != null) {
    const gapPts = Math.abs(model.modelProb - row.bestFairProb) * 100;
    if (gapPts < 5) bits.push("model confirms");
    else if (gapPts >= 15) bits.push(`model disagrees by ${gapPts.toFixed(0)}pt`);
  }

  const verdict = row.grade.score >= 8 ? "Strong" : row.grade.score >= 5 ? "Decent" : row.grade.score >= 2 ? "Weak" : "Skip";
  return `${verdict}: ${bits.join(", ")}`;
}

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
  basketball_ncaab: "player_points,player_rebounds,player_assists",
  baseball_mlb: "player_hits,player_home_runs,player_strikeouts",
  americanfootball_nfl: "player_pass_yds,player_rush_yds,player_receptions",
  americanfootball_nfl_preseason: "player_pass_yds,player_rush_yds,player_receptions",
  americanfootball_ncaaf: "player_passing_yards,player_rushing_yards,player_receiving_yards",
  icehockey_nhl: "player_points,player_shots_on_goal,player_goals",
  soccer_epl: "player_shots_on_target,player_goals,player_assists",
  soccer_uefa_champs_league: "player_shots_on_target,player_goals,player_assists",
  mma_mixed_martial_arts: "fight_winner",
  tennis_atp: "player_total_games_won",
};

// PrizePicks' own league naming doesn't match the-odds-api-style sport keys,
// so this bridges the two. These are best-effort based on common PrizePicks
// league_ppid values — worth confirming against a real fetch, since
// PrizePicks controls this naming and could differ from what's assumed here.
const SPORT_TO_PP_LEAGUE = {
  basketball_wnba: "WNBA",
  basketball_nba: "NBA",
  basketball_ncaab: "CBB",
  baseball_mlb: "MLB",
  americanfootball_nfl: "NFL",
  americanfootball_nfl_preseason: "NFL",
  americanfootball_ncaaf: "CFB",
  icehockey_nhl: "NHL",
  soccer_epl: "EPL",
  soccer_uefa_champs_league: "UEFA CHAMPIONS LEAGUE",
  mma_mixed_martial_arts: "MMA",
  tennis_atp: "TENNIS",
};

// Groups fetched rows by player+stat (ignoring exact line) so a PrizePicks
// number can be compared against whatever sharp books quoted for that same
// player/stat, even when PrizePicks set a different threshold than the
// sportsbooks did — which it very often does.
// Parses the raw PrizePicks projections response into flat rows. Handles
// both player props (event_type "matchup") and team props (event_type
// "team", e.g. a team's total pitches thrown) — PrizePicks' own "description"
// field already holds the right name either way, so both come through the
// same path. Filters to the requested league and to standard lines only
// (goblin/demon are boosted/discounted variants of the same prop, not a
// separate line worth comparing against the sharp market).
//
// Also joins against the "included" player records (fetched via
// include=new_player) to surface real player status — active/questionable/
// out — separate from projection-level status like "pre_game"/"final".
// The exact field name here (status vs injury_status) is unverified against
// a live response, since PrizePicks doesn't document this endpoint at all.
// If this doesn't populate correctly, check a raw fetch and the actual
// field name needs correcting.
function parsePrizePicksData(json, ppLeague) {
  const items = json?.data || [];
  const included = json?.included || [];

  const playerLookup = {};
  included.forEach((inc) => {
    if (inc.type === "new_player" || inc.type === "player") {
      playerLookup[inc.id] = inc.attributes?.status || inc.attributes?.injury_status || null;
    }
  });

  return items
    .filter((it) => it.attributes?.odds_type === "standard")
    .filter((it) => !ppLeague || (it.attributes?.league_ppid || "").toUpperCase() === ppLeague.toUpperCase())
    .map((it) => {
      const playerId = it.relationships?.new_player?.data?.id;
      return {
        name: it.attributes?.description || "Unknown",
        stat: it.attributes?.stat_display_name || it.attributes?.stat_type || "",
        line: it.attributes?.line_score,
        isTeam: it.attributes?.event_type === "team",
        startTime: it.attributes?.start_time,
        projectionStatus: it.attributes?.status,
        playerStatus: playerId ? playerLookup[playerId] || null : null,
      };
    })
    .filter((r) => r.line != null);
}

// Values worth flagging as a real warning — not exhaustive, since the exact
// vocabulary PrizePicks/its data source uses isn't confirmed.
const CONCERNING_STATUSES = ["out", "doubtful", "questionable", "gtd", "injured", "inactive", "suspended"];
function isConcerningStatus(status) {
  if (!status) return false;
  const s = status.toLowerCase();
  return CONCERNING_STATUSES.some((c) => s.includes(c));
}

// Matches real PrizePicks projections (fetched separately, since PrizePicks
// isn't a bookmaker inside the sharp-odds feed) against sharp-book rows by
// player/team name + stat. Same exact/interpolated/nearest tiering as
// before, just fed from two independent sources instead of one merged feed.
function buildPPComparison(sharpRows, ppRows) {
  const bySharpKey = {};
  sharpRows.forEach((row) => {
    const key = `${row.player.toLowerCase()}|${row.stat.toLowerCase()}`;
    if (!bySharpKey[key]) bySharpKey[key] = { player: row.player, stat: row.stat, matchup: row.matchup, lines: [] };
    bySharpKey[key].lines.push(row);
  });

  const out = [];
  ppRows.forEach((ppRow) => {
    const key = `${ppRow.name.toLowerCase()}|${ppRow.stat.toLowerCase()}`;
    const group = bySharpKey[key];
    if (!group) return;
    const ppLine = Number(ppRow.line);
    if (isNaN(ppLine)) return;

    const sharpCandidates = group.lines
      .map((r) => ({ line: Number(r.line), result: computeFairFromBooks(r.books, "Over") }))
      .filter((c) => c.result && c.result.n >= 1 && !isNaN(c.line))
      .sort((a, b) => a.line - b.line);
    if (sharpCandidates.length === 0) return;

    const exact = sharpCandidates.find((c) => c.line === ppLine);
    if (exact) {
      out.push({
        player: ppRow.name, stat: ppRow.stat, matchup: group.matchup, ppLine, isTeam: ppRow.isTeam, playerStatus: ppRow.playerStatus,
        sharpLine: `${exact.line}`, method: "exact",
        sharpFairOver: exact.result.fairProb, sharpN: exact.result.n,
      });
      return;
    }

    const below = [...sharpCandidates].reverse().find((c) => c.line < ppLine);
    const above = sharpCandidates.find((c) => c.line > ppLine);

    if (below && above) {
      const weight = (ppLine - below.line) / (above.line - below.line);
      const interpFair = below.result.fairProb + (above.result.fairProb - below.result.fairProb) * weight;
      out.push({
        player: ppRow.name, stat: ppRow.stat, matchup: group.matchup, ppLine, isTeam: ppRow.isTeam, playerStatus: ppRow.playerStatus,
        sharpLine: `${below.line}–${above.line}`, method: "interpolated",
        sharpFairOver: interpFair, sharpN: Math.min(below.result.n, above.result.n),
      });
      return;
    }

    const nearest = [...sharpCandidates].sort((a, b) => Math.abs(a.line - ppLine) - Math.abs(b.line - ppLine))[0];
    out.push({
      player: ppRow.name, stat: ppRow.stat, matchup: group.matchup, ppLine, isTeam: ppRow.isTeam, playerStatus: ppRow.playerStatus,
      sharpLine: `${nearest.line}`, method: "nearest", distance: Math.abs(nearest.line - ppLine),
      sharpFairOver: nearest.result.fairProb, sharpN: nearest.result.n,
    });
  });
  return out;
}


// Greedy-builds a slip for each size 2-6: sorts candidates by fair
// probability, takes the strongest leg from each distinct matchup (never two
// legs from the same game, so legs stay independent and the combined math
// stays honest rather than silently overstating win odds via hidden
// correlation). Since multiplier is fixed for a given size, maximizing win
// probability for that size IS maximizing EV for that size — the real
// tradeoff is between sizes, which is what this surfaces instead of hiding.
function buildAutoSlips(ranked, maxSize = 6) {
  const sorted = [...ranked].sort((a, b) => b.bestFairProb - a.bestFairProb);
  const results = [];
  for (let size = 2; size <= maxSize; size++) {
    const chosen = [];
    const usedMatchups = new Set();
    for (const cand of sorted) {
      if (chosen.length >= size) break;
      if (usedMatchups.has(cand.matchup)) continue;
      chosen.push(cand);
      usedMatchups.add(cand.matchup);
    }
    if (chosen.length < size) {
      results.push({ size, insufficientGames: true });
      continue;
    }
    const combinedProb = chosen.reduce((p, c) => p * c.bestFairProb, 1);
    const mult = DEFAULT_POWER[size] || 0;
    const ev = mult ? combinedProb * mult - 1 : null;
    const breakeven = mult ? 1 / mult : null;
    results.push({ size, legs: chosen, combinedProb, mult, ev, breakeven });
  }
  return results;
}

const AutoSlipBuilder = memo(function AutoSlipBuilder({ ranked, onBuild }) {
  const slips = useMemo(() => buildAutoSlips(ranked), [ranked]);
  const valid = slips.filter((s) => !s.insufficientGames);
  const bestByEV = valid.length ? valid.reduce((a, b) => (b.ev > a.ev ? b : a)) : null;

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLORS.line}` }}>
      <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.text, letterSpacing: "0.06em", marginBottom: 6 }}>AUTO SLIP BUILDER</div>
      <p style={{ color: COLORS.faint, fontSize: 11, margin: "0 0 12px", lineHeight: 1.5 }}>
        One leg per game max, picked by highest fair probability, so nothing here silently doubles up on the same
        outcome. Win rate and EV are shown separately on purpose — smaller slips win more often but pay less; bigger
        slips pay more but win less. The green-bordered one is the highest EV, not necessarily the highest win rate.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {slips.map((s) => (
          <div key={s.size} style={{ background: COLORS.bg, border: `1px solid ${bestByEV && s.size === bestByEV.size ? COLORS.green : COLORS.line}`, borderRadius: 6, padding: "10px 12px" }}>
            {s.insufficientGames ? (
              <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.faint }}>{s.size}-pick: not enough distinct games in current results</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontFamily: mono, fontSize: 13, color: COLORS.text, fontWeight: 700 }}>
                    {s.size}-pick {bestByEV && s.size === bestByEV.size ? "· BEST EV" : ""}
                  </span>
                  <button onClick={() => onBuild(s.legs)} style={{ fontFamily: mono, fontSize: 11, padding: "5px 10px", borderRadius: 5, border: `1px solid ${COLORS.green}`, color: COLORS.green, background: "transparent", cursor: "pointer" }}>Build this slip</button>
                </div>
                <div style={{ display: "flex", gap: 14, fontFamily: mono, fontSize: 11, flexWrap: "wrap" }}>
                  <span style={{ color: COLORS.text }}>Win: {pct(s.combinedProb)}</span>
                  <span style={{ color: COLORS.faint }}>Breakeven: {pct(s.breakeven)}</span>
                  <span style={{ color: s.ev > 0 ? COLORS.green : COLORS.red }}>EV: {s.ev >= 0 ? "+" : ""}{(s.ev * 100).toFixed(1)}%</span>
                  <span style={{ color: COLORS.faint }}>{s.mult}x payout</span>
                </div>
                <div style={{ color: COLORS.faint, fontSize: 10, marginTop: 4 }}>
                  {s.legs.map((l) => `${l.player} ${l.bestSide} ${l.line}`).join(" · ")}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

const LiveFeedPanel = memo(function LiveFeedPanel({ onQuickAdd, onRowsFetched }) {
  const [proxyUrl, setProxyUrl] = useState("");
  const [sport, setSport] = useState("basketball_wnba");
  const [markets, setMarkets] = useState(SPORT_MARKETS.basketball_wnba);
  const [marketsTouched, setMarketsTouched] = useState(false);
  const [rows, setRows] = useState([]);
  const [teamRows, setTeamRows] = useState([]);
  const [spreadRisk, setSpreadRisk] = useState({});
  const [ppRows, setPpRows] = useState([]);
  const [ppError, setPpError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [minBooks, setMinBooks] = useState(2);
  const [minEdge, setMinEdge] = useState(3);
  const [steamMap, setSteamMap] = useState({});
  const [modelResults, setModelResults] = useState({});
  const [modelLoading, setModelLoading] = useState({});

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
    setLoading(true); setError(""); setPpError(""); setRows([]); setPpRows([]); setTeamRows([]);
    try {
      const base = proxyUrl.replace(/\/$/, "");

      const [oddsRes, ppRes] = await Promise.all([
        fetch(`${base}/api/odds?sport=${sport}&markets=${markets}`),
        fetch(`${base}/api/prizepicks`).catch(() => null),
      ]);

      const oddsJson = await oddsRes.json();
      if (oddsJson.error) throw new Error(oddsJson.error);
      const parsed = parseLiveOdds(oddsJson);
      const parsedTeams = parseTeamOdds(oddsJson);
      const parsedSpreadRisk = parseSpreadRisk(oddsJson);
      setRows(parsed);
      setTeamRows(parsedTeams);
      setSpreadRisk(parsedSpreadRisk);
      if (onRowsFetched) onRowsFetched(parsed);
      if (parsed.length === 0 && parsedTeams.length === 0) {
        setError("Connected, but found no rows at all — the response shape may differ from what this expects, or nothing's posted for this sport/market yet. Check the raw JSON and let me know its structure.");
      }

      // Steam: compare this fetch's fair probability against the last fetch's
      // for the same exact prop, to catch line movement between successive
      // "Fetch live props" taps. Snapshot fully overwritten each fetch so
      // storage doesn't grow unbounded with props no longer being tracked.
      try {
        let priorSnapshots = {};
        try {
          const res = await storage.get("steam-snapshots");
          priorSnapshots = res ? JSON.parse(res.value) : {};
        } catch (e) { priorSnapshots = {}; }

        const nextSnapshots = {};
        const steam = {};
        parsed.forEach((row) => {
          const key = `${row.player}|${row.stat}|${row.line}|${row.matchup}`;
          const overResult = computeFairFromBooks(row.books, "Over");
          if (overResult) {
            nextSnapshots[key] = { overFair: overResult.fairProb, timestamp: Date.now() };
            const prior = priorSnapshots[key];
            if (prior) steam[key] = (overResult.fairProb - prior.overFair) * 100;
          }
        });
        setSteamMap(steam);
        storage.set("steam-snapshots", JSON.stringify(nextSnapshots)).catch(() => {});
      } catch (e) {
        // steam detection failing should never block the main fetch above
      }

      // PrizePicks is an unofficial endpoint and fails intermittently — that's
      // expected, not a bug. Never let it block or blank out the sharp-odds
      // side of the fetch above; just surface it clearly and move on.
      if (!ppRes) {
        setPpError("PrizePicks fetch didn't complete — network issue reaching the proxy. Sharp odds above are unaffected.");
      } else if (!ppRes.ok) {
        setPpError(`PrizePicks returned an error (status ${ppRes.status}) — this unofficial endpoint fails intermittently. Try fetching again in a bit.`);
      } else {
        try {
          const ppJson = await ppRes.json();
          setPpRows(parsePrizePicksData(ppJson, SPORT_TO_PP_LEAGUE[sport]));
        } catch (e) {
          setPpError("PrizePicks responded but the data couldn't be read — likely a temporary hiccup on their end.");
        }
      }
    } catch (e) {
      setError(`Fetch failed: ${e.message}. Remember this only works when Edge Board is deployed live, not inside the Claude.ai preview.`);
    }
    setLoading(false);
  };

  const fetchModel = async (row) => {
    const rowKey = `${row.player}|${row.stat}|${row.line}|${row.matchup}`;
    const config = MLB_STAT_CONFIG[row.stat.toLowerCase()];
    if (!config) {
      setModelResults((prev) => ({ ...prev, [rowKey]: { error: `No model mapping for stat "${row.stat}" yet.` } }));
      return;
    }
    setModelLoading((prev) => ({ ...prev, [rowKey]: true }));
    try {
      const base = proxyUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/api/mlb-stats?player=${encodeURIComponent(row.player)}&group=${config.group}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      const result = computeEmpiricalModel(json.games || [], config.field, Number(row.line), row.bestSide);
      if (!result) throw new Error(`Player found, but no recent ${config.group} data to build a model from.`);
      setModelResults((prev) => ({ ...prev, [rowKey]: result }));
    } catch (e) {
      setModelResults((prev) => ({ ...prev, [rowKey]: { error: e.message } }));
    }
    setModelLoading((prev) => ({ ...prev, [rowKey]: false }));
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
        const steamKey = `${row.player}|${row.stat}|${row.line}|${row.matchup}`;
        const rawSteam = steamMap[steamKey];
        // rawSteam tracks Over-side movement; translate to "movement toward
        // the side actually being picked" so Under picks benefit from the
        // market moving down, not just Over picks benefiting from it moving up
        const steamPts = rawSteam == null ? 0 : best.side === "Over" ? rawSteam : -rawSteam;
        const grade = gradeForPick(edgePts, best.n, best.spread, steamPts);
        const isYardageStat = FOOTBALL_YARDAGE_STATS.some((s) => row.stat.toLowerCase().includes(s));
        const blowoutRisk = isYardageStat ? blowoutRiskLevel(spreadRisk[row.matchup]) : null;
        return { ...row, bestSide: best.side, bestFairProb: best.fairProb, n: best.n, spread: best.spread, edgePts, grade, oldestUpdate: best.oldestUpdate, excludedCount: best.excludedCount, halfWidth: best.halfWidth, steamPts, blowoutRisk };
      })
      .filter(Boolean)
      .filter((r) => r.n >= minBooks && r.edgePts >= minEdge)
      .sort((a, b) => b.edgePts - a.edgePts);
  }, [rows, minBooks, minEdge, steamMap, spreadRisk]);

  // Same math as player ranked, minus steam — no snapshot history exists yet
  // for team markets since that's built around the player-prop propKey scheme.
  const teamRanked = useMemo(() => {
    return teamRows
      .map((row) => {
        const homeResult = computeFairFromBooks(row.books, "Over");
        const awayResult = computeFairFromBooks(row.books, "Under");
        const best = (homeResult?.fairProb ?? 0) >= (awayResult?.fairProb ?? 0)
          ? { side: "Over", team: row.homeTeam, ...homeResult }
          : { side: "Under", team: row.awayTeam, ...awayResult };
        if (!best.fairProb) return null;
        const edgePts = (best.fairProb - 0.5) * 100;
        const grade = gradeForPick(edgePts, best.n, best.spread, 0);
        return { ...row, bestSide: best.side, bestTeam: best.team, bestFairProb: best.fairProb, n: best.n, spread: best.spread, edgePts, grade, oldestUpdate: best.oldestUpdate, excludedCount: best.excludedCount, halfWidth: best.halfWidth, steamPts: 0 };
      })
      .filter(Boolean)
      .filter((r) => r.n >= minBooks && r.edgePts >= minEdge)
      .sort((a, b) => b.edgePts - a.edgePts);
  }, [teamRows, minBooks, minEdge]);

  const addFromRow = (row, side) => {
    const result = computeFairFromBooks(row.books, side);
    if (!result) return;
    onQuickAdd({
      id: Date.now(), name: row.player, matchup: row.matchup, stat: row.stat, line: row.line, side,
      group: null, fairProb: result.fairProb, fairOdds: probToAmerican(result.fairProb), startTime: row.startTime,
      books: row.books, include: true, confidence: { n: result.n, spread: result.spread, oldestUpdate: result.oldestUpdate, excludedCount: result.excludedCount, halfWidth: result.halfWidth },
    }, { propName: `${row.player}-${row.stat}`, snapshot: { timestamp: Date.now(), side, fairProb: result.fairProb, line: row.line, stat: row.stat } });
  };

  // Team name goes in leg.name so it displays like any other pick. side
  // stays "Over"/"Under" internally (matching how the team's odds were
  // stored in the books object) so every existing function keeps working
  // unchanged — BoardRow just checks stat === "Moneyline" to render it right.
  const addTeamPick = (row, side) => {
    const result = computeFairFromBooks(row.books, side);
    if (!result) return;
    const teamName = side === "Over" ? row.homeTeam : row.awayTeam;
    onQuickAdd({
      id: Date.now(), name: teamName, matchup: row.matchup, stat: "Moneyline", line: "", side,
      group: null, fairProb: result.fairProb, fairOdds: probToAmerican(result.fairProb), startTime: row.startTime,
      books: row.books, include: true, confidence: { n: result.n, spread: result.spread, oldestUpdate: result.oldestUpdate, excludedCount: result.excludedCount, halfWidth: result.halfWidth },
    }, null);
  };

  const ppComparison = useMemo(() => buildPPComparison(rows, ppRows), [rows, ppRows]);

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
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[
              { label: "WNBA", value: "basketball_wnba" },
              { label: "NBA", value: "basketball_nba" },
              { label: "NFL", value: "americanfootball_nfl" },
              { label: "NFL Pre", value: "americanfootball_nfl_preseason" },
              { label: "CFB", value: "americanfootball_ncaaf" },
              { label: "CBB", value: "basketball_ncaab" },
            ].map((f) => (
              <button
                key={f.value}
                onClick={() => {
                  setSport(f.value);
                  if (!marketsTouched) setMarkets(SPORT_MARKETS[f.value] || "");
                }}
                style={{ ...chipStyle(sport === f.value), flex: "1 1 30%" }}
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
            <option value="basketball_ncaab">College Basketball</option>
            <option value="americanfootball_nfl">NFL</option>
            <option value="americanfootball_nfl_preseason">NFL Preseason</option>
            <option value="americanfootball_ncaaf">College Football</option>
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

          <p style={{ color: COLORS.faint, fontSize: 10, fontFamily: mono, marginTop: 0, marginBottom: 10 }}>
            Grade = trust in the number, not win chance. 🔥 = line moved your way since last fetch.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 400, overflowY: "auto" }}>
            {ranked.map((row, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.bg, border: `1px solid ${i < 3 ? COLORS.green : COLORS.line}`, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 6, background: "rgba(255,255,255,0.05)", border: `1px solid ${row.grade.color}`, color: row.grade.color, fontFamily: mono, fontSize: 13, fontWeight: 700, flexShrink: 0, marginRight: 10 }}>
                  {row.grade.letter}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>{row.player} — {row.stat} {row.line}</div>
                  <div style={{ color: COLORS.faint, fontSize: 11, fontFamily: mono }}>
                    {row.matchup}{formatGameTime(row.startTime) ? ` · ${formatGameTime(row.startTime)}` : ""}
                  </div>
                  {(() => {
                    const rowKey = `${row.player}|${row.stat}|${row.line}|${row.matchup}`;
                    const model = modelResults[rowKey];
                    return (
                      <div style={{ color: row.grade.score >= 8 ? COLORS.green : row.grade.score >= 5 ? COLORS.text : row.grade.score >= 2 ? COLORS.amber : COLORS.faint, fontSize: 11, fontFamily: sans, fontWeight: 600, marginTop: 3 }}>
                        {summarizePick(row, model?.modelProb != null ? model : null)}
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", gap: 8, marginTop: 3, fontFamily: mono, fontSize: 11, flexWrap: "wrap" }}>
                    <span style={{ color: COLORS.green, fontWeight: 700 }}>{row.bestSide} favored · {pctRange(row.bestFairProb, row.halfWidth)}</span>
                    <span style={{ color: COLORS.amber }}>+{row.edgePts.toFixed(1)}pt edge</span>
                    <span style={{ color: row.n === 1 ? COLORS.amber : COLORS.faint }}>{row.n} bk{row.n > 1 ? "s" : ""}</span>
                    {formatAge(row.oldestUpdate) && (
                      <span style={{ color: formatAge(row.oldestUpdate).color }}>· {formatAge(row.oldestUpdate).text}</span>
                    )}
                    {row.excludedCount > 0 && (
                      <span style={{ color: COLORS.red }}>· {row.excludedCount} outlier excluded</span>
                    )}
                    {row.steamPts >= 3 && (
                      <span style={{ color: COLORS.green, fontWeight: 700 }}>🔥 steam +{row.steamPts.toFixed(1)}pt</span>
                    )}
                    {row.blowoutRisk && (
                      <span style={{ color: row.blowoutRisk.color, fontWeight: 700 }}>⚠ {row.blowoutRisk.label} (spread {spreadRisk[row.matchup]})</span>
                    )}
                  </div>
                  {sport === "baseball_mlb" && (() => {
                    const rowKey = `${row.player}|${row.stat}|${row.line}|${row.matchup}`;
                    const model = modelResults[rowKey];
                    const isLoading = modelLoading[rowKey];
                    return (
                      <div style={{ marginTop: 4 }}>
                        {!model && !isLoading && (
                          <button onClick={() => fetchModel(row)} style={{ fontFamily: mono, fontSize: 10, padding: "3px 7px", borderRadius: 4, border: `1px solid ${COLORS.faint}`, color: COLORS.faint, background: "transparent", cursor: "pointer" }}>
                            Get model (last 20 games)
                          </button>
                        )}
                        {isLoading && <span style={{ fontFamily: mono, fontSize: 10, color: COLORS.faint }}>Loading model…</span>}
                        {model?.error && <span style={{ fontFamily: mono, fontSize: 10, color: COLORS.amber }}>{model.error}</span>}
                        {model?.modelProb != null && (() => {
                          const gapPts = Math.abs(model.modelProb - row.bestFairProb) * 100;
                          const agreeColor = gapPts < 5 ? COLORS.green : gapPts < 15 ? COLORS.amber : COLORS.red;
                          return (
                            <div style={{ fontFamily: mono, fontSize: 11 }}>
                              <span style={{ color: COLORS.text }}>Model: {pct(model.modelProb)}</span>
                              <span style={{ color: COLORS.faint }}> ({model.gamesUsed} games) vs Market: {pct(row.bestFairProb)} </span>
                              <span style={{ color: agreeColor, fontWeight: 700 }}>
                                {gapPts < 5 ? "· agree" : gapPts < 15 ? `· ${gapPts.toFixed(0)}pt gap` : `· ⚠ ${gapPts.toFixed(0)}pt disagreement`}
                              </span>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()}
                </div>
                <button onClick={() => addFromRow(row, row.bestSide)} style={{ fontFamily: mono, fontSize: 11, padding: "6px 10px", borderRadius: 5, border: `1px solid ${COLORS.green}`, color: COLORS.green, background: "transparent", cursor: "pointer", flexShrink: 0, marginLeft: 8 }}>+ Add {row.bestSide}</button>
              </div>
            ))}
            {ranked.length === 0 && <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono }}>Nothing clears your filters yet — try lowering min books or min edge.</p>}
          </div>

          {ranked.length >= 2 && (
            <AutoSlipBuilder ranked={ranked} onBuild={(legs) => legs.forEach((l) => addFromRow(l, l.bestSide))} />
          )}

          {teamRows.length > 0 && teamRanked.length === 0 && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLORS.line}` }}>
              <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.text, letterSpacing: "0.06em", marginBottom: 8 }}>GAME LINES — MONEYLINE</div>
              <p style={{ color: COLORS.amber, fontSize: 12, fontFamily: mono, margin: 0 }}>
                Found {teamRows.length} game{teamRows.length > 1 ? "s" : ""} with moneyline data, but none cleared the
                current MIN BOOKS / MIN EDGE filters above — try lowering them to see these games.
              </p>
            </div>
          )}

          {teamRanked.length > 0 && (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLORS.line}` }}>
              <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.text, letterSpacing: "0.06em", marginBottom: 4 }}>GAME LINES — MONEYLINE</div>
              <p style={{ color: COLORS.faint, fontSize: 10, fontFamily: mono, margin: "0 0 10px" }}>
                Same de-vig math as props, applied to which team wins. Separate section since a moneyline pick isn't Over/Under.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 400, overflowY: "auto" }}>
                {teamRanked.map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.bg, border: `1px solid ${i < 3 ? COLORS.green : COLORS.line}`, borderRadius: 6, padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 6, background: "rgba(255,255,255,0.05)", border: `1px solid ${row.grade.color}`, color: row.grade.color, fontFamily: mono, fontSize: 13, fontWeight: 700, flexShrink: 0, marginRight: 10 }}>
                      {row.grade.letter}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>{row.bestTeam} ML</div>
                      <div style={{ color: COLORS.faint, fontSize: 11, fontFamily: mono }}>
                        {row.matchup}{formatGameTime(row.startTime) ? ` · ${formatGameTime(row.startTime)}` : ""}
                      </div>
                      <div style={{ color: row.grade.score >= 8 ? COLORS.green : row.grade.score >= 5 ? COLORS.text : row.grade.score >= 2 ? COLORS.amber : COLORS.faint, fontSize: 11, fontFamily: sans, fontWeight: 600, marginTop: 3 }}>
                        {summarizePick(row, null)}
                      </div>
                      <div style={{ display: "flex", gap: 8, marginTop: 3, fontFamily: mono, fontSize: 11, flexWrap: "wrap" }}>
                        <span style={{ color: COLORS.green, fontWeight: 700 }}>{pctRange(row.bestFairProb, row.halfWidth)} to win</span>
                        <span style={{ color: COLORS.amber }}>+{row.edgePts.toFixed(1)}pt edge</span>
                        <span style={{ color: row.n === 1 ? COLORS.amber : COLORS.faint }}>{row.n} bk{row.n > 1 ? "s" : ""}</span>
                        {formatAge(row.oldestUpdate) && (
                          <span style={{ color: formatAge(row.oldestUpdate).color }}>· {formatAge(row.oldestUpdate).text}</span>
                        )}
                        {row.excludedCount > 0 && (
                          <span style={{ color: COLORS.red }}>· {row.excludedCount} outlier excluded</span>
                        )}
                      </div>
                    </div>
                    <button onClick={() => addTeamPick(row, row.bestSide)} style={{ fontFamily: mono, fontSize: 11, padding: "6px 10px", borderRadius: 5, border: `1px solid ${COLORS.green}`, color: COLORS.green, background: "transparent", cursor: "pointer", flexShrink: 0, marginLeft: 8 }}>+ Add</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLORS.line}` }}>
            <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.text, letterSpacing: "0.06em", marginBottom: 4 }}>PRIZEPICKS VS SHARP MARKET</div>
            <p style={{ color: COLORS.faint, fontSize: 10, fontFamily: mono, margin: "0 0 10px", lineHeight: 1.5 }}>
              Red border = player flagged out/questionable/doubtful. This is best-effort — the exact status field isn't documented by PrizePicks, so absence of a flag isn't a guarantee the player is active. Check the app before betting on anything here.
            </p>
            {ppError && (
              <div style={{ display: "flex", gap: 6, color: COLORS.amber, fontSize: 12, marginBottom: 10, fontFamily: sans }}>
                <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> {ppError}
              </div>
            )}
            {ppComparison.length === 0 ? (
              <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono }}>No matches — either PrizePicks doesn't have this league live right now, or none of its lines matched a name+stat from the sharp fetch above. This now pulls PrizePicks directly (unofficial endpoint), so an empty result here is about matching or timing, not missing data entirely.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {ppComparison.map((c, i) => {
                  const isFlagged = isConcerningStatus(c.playerStatus);
                  return (
                  <div key={i} style={{ background: COLORS.bg, border: `1px solid ${isFlagged ? COLORS.red : COLORS.line}`, borderRadius: 6, padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>{c.player} — {c.stat}</div>
                      {isFlagged && (
                        <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(255,92,92,0.15)", border: `1px solid ${COLORS.red}`, color: COLORS.red }}>
                          {c.playerStatus.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div style={{ color: COLORS.faint, fontSize: 11, fontFamily: mono, marginBottom: 4 }}>{c.matchup}</div>

                    {c.method === "exact" && (
                      <div style={{ fontFamily: mono, fontSize: 12 }}>
                        <span style={{ color: COLORS.green }}>EXACT MATCH</span>{" "}
                        <span style={{ color: COLORS.text }}>PP {c.ppLine} = sharp {c.sharpLine}</span>{" "}
                        <span style={{ color: c.sharpFairOver > 0.5 ? COLORS.green : COLORS.red }}>
                          · Over fair {pct(c.sharpFairOver)} ({c.sharpN} bk{c.sharpN > 1 ? "s" : ""})
                        </span>
                      </div>
                    )}

                    {c.method === "interpolated" && (
                      <div style={{ fontFamily: mono, fontSize: 12 }}>
                        <span style={{ color: COLORS.amber }}>INTERPOLATED</span>{" "}
                        <span style={{ color: COLORS.text }}>PP {c.ppLine} sits between sharp lines {c.sharpLine}</span>{" "}
                        <span style={{ color: c.sharpFairOver > 0.5 ? COLORS.green : COLORS.red }}>
                          · est. Over fair {pct(c.sharpFairOver)}
                        </span>
                        <div style={{ color: COLORS.faint, fontSize: 10, marginTop: 2 }}>
                          Estimated by straight-line interpolation between the two nearest sharp lines — treat as a rough estimate, not a precise price.
                        </div>
                      </div>
                    )}

                    {c.method === "nearest" && (
                      <div style={{ fontFamily: mono, fontSize: 12 }}>
                        <span style={{ color: COLORS.red }}>NEAREST ONLY ({c.distance} pt away)</span>{" "}
                        <span style={{ color: COLORS.text }}>PP {c.ppLine} vs closest sharp {c.sharpLine}</span>{" "}
                        <span style={{ color: COLORS.faint }}>
                          — no sharp line on the other side to interpolate with, so this gap is a rough directional read only, not a real number.
                        </span>
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});

const AddLegPanel = memo(function AddLegPanel({ onAdd, defaultMatchup, defaultGroup, liveRows }) {
  const [name, setName] = useState("");
  const [matchup, setMatchup] = useState(defaultMatchup || "");
  const [stat, setStat] = useState("");
  const [lineVal, setLineVal] = useState("");
  const [side, setSide] = useState("Over");
  const [oddsType, setOddsType] = useState("Standard");
  const [group, setGroup] = useState(defaultGroup || "");
  const [bookInputs, setBookInputs] = useState(emptyBooks());
  const [quickPaste, setQuickPaste] = useState("");
  const [manualProb, setManualProb] = useState("");
  const [mode, setMode] = useState("books");
  const [error, setError] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [startTime, setStartTime] = useState(null);

  const preview = useMemo(() => (mode === "books" ? computeFairFromBooks(bookInputs, side) : null), [bookInputs, side, mode]);

  // Auto-devig: matches whatever's already been fetched via Live Feed against
  // what's typed here, so picking a suggestion fills matchup/stat/line/book
  // odds — and the favored side — in one tap instead of typing or
  // quick-pasting odds by hand.
  const suggestions = useMemo(() => {
    if (mode !== "books" || name.trim().length < 2 || !liveRows?.length) return [];
    const q = name.trim().toLowerCase();
    return liveRows.filter((r) => r.player.toLowerCase().includes(q)).slice(0, 6);
  }, [name, liveRows, mode]);

  const applySuggestion = (row) => {
    const overResult = computeFairFromBooks(row.books, "Over");
    const underResult = computeFairFromBooks(row.books, "Under");
    const favoredSide = (overResult?.fairProb ?? 0) >= (underResult?.fairProb ?? 0) ? "Over" : "Under";
    setName(row.player);
    setMatchup(row.matchup);
    setStat(row.stat);
    setLineVal(row.line);
    setSide(favoredSide);
    setBookInputs(JSON.parse(JSON.stringify(row.books)));
    setStartTime(row.startTime || null);
    setShowSuggestions(false);
  };

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
      { id: Date.now(), name, matchup, stat, line: lineVal, side, group: group.trim() || null, startTime,
        fairProb, fairOdds: probToAmerican(fairProb), books: booksSnapshot, include: true,
        confidence: meta ? { n: meta.n, spread: meta.spread, oldestUpdate: meta.oldestUpdate, excludedCount: meta.excludedCount, halfWidth: meta.halfWidth } : null },
      mode === "books" ? { propName: `${name}-${stat}`, snapshot: { timestamp: Date.now(), side, fairProb, line: lineVal, stat } } : null
    );

    setName(""); setLineVal(""); setBookInputs(emptyBooks()); setQuickPaste(""); setManualProb(""); setStartTime(null);
  };

  const handleKeyDown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };

  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20 }} onKeyDown={handleKeyDown}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: expanded ? 14 : 0 }}
      >
        <span style={{ fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em" }}>
          MANUAL ENTRY <span style={{ color: COLORS.faint, fontWeight: 400 }}>· for props outside the live fetch</span>
        </span>
        <span style={{ color: COLORS.green, fontFamily: mono, fontSize: 12 }}>{expanded ? "− collapse" : "+ expand"}</span>
      </button>

      {expanded && (
        <>
          <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
            <button onClick={() => setMode("books")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: sans, fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", paddingBottom: 6, color: mode === "books" ? COLORS.text : COLORS.faint, borderBottom: mode === "books" ? `2px solid ${COLORS.green}` : "2px solid transparent" }}>De-vig from books</button>
            <button onClick={() => setMode("manual")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: sans, fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", paddingBottom: 6, color: mode === "manual" ? COLORS.text : COLORS.faint, borderBottom: mode === "manual" ? `2px solid ${COLORS.green}` : "2px solid transparent" }}>Enter fair % manually</button>
          </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Field label="Player / Team">
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => { setName(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            placeholder="e.g. Jackie Young, or CIN for a team total"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div style={{ marginTop: 4, background: COLORS.bg, border: `1px solid ${COLORS.green}`, borderRadius: 6, overflow: "hidden" }}>
              {suggestions.map((r, i) => (
                <button
                  key={i}
                  onClick={() => applySuggestion(r)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: i < suggestions.length - 1 ? `1px solid ${COLORS.line}` : "none", padding: "8px 10px", cursor: "pointer", color: COLORS.text, fontFamily: mono, fontSize: 12 }}
                >
                  <span style={{ fontWeight: 600 }}>{r.player}</span> — {r.stat} {r.line}
                  <span style={{ color: COLORS.faint }}> · {r.matchup}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
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
                {preview.excludedCount > 0 && <span style={{ color: COLORS.red }}> · {preview.excludedCount} outlier book{preview.excludedCount > 1 ? "s" : ""} excluded</span>}
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
        </>
      )}
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
        <div style={{ color: COLORS.faint, fontSize: 11, fontFamily: mono }}>
          {leg.matchup}{leg.group ? ` · grp: ${leg.group}` : ""}{formatGameTime(leg.startTime) ? ` · ${formatGameTime(leg.startTime)}` : ""}
        </div>
      </td>
      <td style={{ padding: "10px 10px 10px 0" }}>
        <div style={{ display: "inline-block", background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "3px 8px", fontFamily: mono, fontSize: 12, color: COLORS.text, fontWeight: 600 }}>
          {leg.stat === "Moneyline" ? "ML" : `${leg.side} ${leg.line}`}
        </div>
        <div style={{ color: COLORS.faint, fontSize: 11, marginTop: 2 }}>{leg.stat}</div>
      </td>
      <td style={{ padding: "10px 10px 10px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontFamily: mono, fontSize: 14, color: COLORS.text, fontWeight: 600 }}>{pctRange(leg.fairProb, leg.confidence?.halfWidth)}</div>
          {leg.confidence && (
            <span style={{ fontFamily: mono, fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, border: `1px solid ${gradeForPick((leg.fairProb - 0.5) * 100, leg.confidence.n, leg.confidence.spread).color}`, color: gradeForPick((leg.fairProb - 0.5) * 100, leg.confidence.n, leg.confidence.spread).color }}>
              {gradeForPick((leg.fairProb - 0.5) * 100, leg.confidence.n, leg.confidence.spread).letter}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {leg.confidence && (
            <span style={{ fontFamily: mono, fontSize: 10, color: leg.confidence.n === 1 ? COLORS.amber : COLORS.faint }}>{leg.confidence.n} bk{leg.confidence.n > 1 ? "s" : ""}</span>
          )}
          {leg.confidence && formatAge(leg.confidence.oldestUpdate) && (
            <span style={{ fontFamily: mono, fontSize: 10, color: formatAge(leg.confidence.oldestUpdate).color }}>· {formatAge(leg.confidence.oldestUpdate).text}</span>
          )}
          {leg.confidence?.excludedCount > 0 && (
            <span style={{ fontFamily: mono, fontSize: 10, color: COLORS.red }}>· {leg.confidence.excludedCount} excl.</span>
          )}
        </div>
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

// Same idea as the probability-bucket report, sliced by stat type instead —
// reveals whether calibration varies by category (e.g. points props running
// well-calibrated while assists props run consistently hot), which a single
// pooled report can't show since it averages that difference away.
function buildCategoryCalibration(predictions) {
  const graded = predictions.filter((p) => p.result === "hit" || p.result === "miss");
  const byCategory = {};
  graded.forEach((p) => {
    const cat = (p.stat || "unknown").trim().toLowerCase() || "unknown";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  });
  return Object.entries(byCategory)
    .map(([cat, picks]) => {
      const hits = picks.filter((p) => p.result === "hit").length;
      const brier = picks.reduce((s, p) => s + Math.pow((p.result === "hit" ? 1 : 0) - p.fairProb, 2), 0) / picks.length;
      return {
        category: cat,
        n: picks.length,
        predicted: (picks.reduce((s, p) => s + p.fairProb, 0) / picks.length) * 100,
        actual: (hits / picks.length) * 100,
        brier,
      };
    })
    .filter((c) => c.n >= 2)
    .sort((a, b) => b.n - a.n);
}

const CalibrationPanel = memo(function CalibrationPanel({ predictions, onGrade }) {
  const ungraded = predictions.filter((p) => p.result === null).sort((a, b) => b.timestamp - a.timestamp);
  const { report, graded, brier, totalHits } = useMemo(() => buildCalibrationReport(predictions), [predictions]);
  const categoryReport = useMemo(() => buildCategoryCalibration(predictions), [predictions]);

  const [proxyUrl, setProxyUrl] = useState("");
  const [autoGrading, setAutoGrading] = useState(false);
  const [autoGradeLog, setAutoGradeLog] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get("proxy-url");
        if (res?.value) setProxyUrl(res.value);
      } catch (e) { /* no saved url yet */ }
    })();
  }, []);

  // Reuses the same MLB Stats API proxy the model feature uses. Only
  // attempts props whose stat name matches a known MLB stat — a heuristic,
  // not a real sport tag on the prediction, since that isn't tracked.
  // Matches by exact game date, so an ungraded pick with no completed game
  // yet on that date is correctly left alone rather than guessed at.
  const autoGradeMLB = async () => {
    if (!proxyUrl) { setAutoGradeLog(["No proxy URL saved yet — fetch something in Live Feed first so it's remembered."]); return; }
    setAutoGrading(true);
    const log = [];
    const base = proxyUrl.replace(/\/$/, "");
    const candidates = ungraded.filter((p) => MLB_STAT_CONFIG[(p.stat || "").toLowerCase()]);

    if (candidates.length === 0) {
      setAutoGradeLog(["No ungraded picks match a known MLB stat right now."]);
      setAutoGrading(false);
      return;
    }

    for (const p of candidates) {
      const config = MLB_STAT_CONFIG[p.stat.toLowerCase()];
      try {
        const res = await fetch(`${base}/api/mlb-stats?player=${encodeURIComponent(p.player)}&group=${config.group}`);
        const json = await res.json();
        if (json.error) { log.push(`${p.player}: ${json.error}`); continue; }
        const games = json.games || [];
        let game = null;
        if (p.startTime) {
          // MLB's own API reports the game date in US Eastern terms, but
          // commence_time is UTC — a night game like 8:40 PM ET is already
          // past midnight UTC, which silently shifted this to the wrong day.
          // toLocaleDateString with an explicit timezone fixes that instead
          // of naively slicing a UTC ISO string.
          const targetDate = new Date(p.startTime).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
          game = games.find((g) => g.date === targetDate);
        }
        if (!game) { log.push(`${p.player} ${p.stat}: no completed game found for that date yet — try again later.`); continue; }
        const value = game.stat?.[config.field];
        if (value == null) { log.push(`${p.player} ${p.stat}: stat field missing from that game's data.`); continue; }
        const hit = p.side === "Over" ? value > Number(p.line) : value < Number(p.line);
        onGrade(p.id, hit ? "hit" : "miss");
        log.push(`${p.player} ${p.stat} ${p.line}: actual ${value} → ${hit ? "HIT" : "MISS"}`);
      } catch (e) {
        log.push(`${p.player}: ${e.message}`);
      }
    }
    setAutoGradeLog(log);
    setAutoGrading(false);
  };

  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, padding: 18, marginBottom: 20 }}>
      <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em", marginBottom: 4 }}>
        CALIBRATION TRACKER
        {graded.length > 0 && (
          <span style={{ color: COLORS.faint, fontWeight: 400 }}> · {graded.length} graded, {((totalHits / graded.length) * 100).toFixed(0)}% hit rate</span>
        )}
      </div>
      <p style={{ color: COLORS.faint, fontSize: 11, margin: "0 0 14px" }}>Grade props after they play out to check if your "X% fair" calls actually hit X%.</p>

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
          <p style={{ color: COLORS.faint, fontSize: 10, margin: "8px 0 0", fontFamily: mono }}>⚠ = 10+pt off, 5+ picks. Fewer picks bounce around, don't over-read them.</p>

          {categoryReport.length > 0 && (
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${COLORS.line}` }}>
              <div style={{ fontFamily: mono, fontSize: 11, color: COLORS.muted, marginBottom: 8 }}>BY STAT CATEGORY</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 40px", fontFamily: mono, fontSize: 10, color: COLORS.faint }}>
                  <span>STAT</span><span>PREDICTED</span><span>ACTUAL</span><span>BRIER</span><span>N</span>
                </div>
                {categoryReport.map((c) => {
                  const gap = c.actual - c.predicted;
                  const flag = Math.abs(gap) >= 10 && c.n >= 5;
                  return (
                    <div key={c.category} style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 40px", fontFamily: mono, fontSize: 12, alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${COLORS.line}` }}>
                      <span style={{ color: COLORS.text, textTransform: "capitalize" }}>{c.category}</span>
                      <span style={{ color: COLORS.faint }}>{c.predicted.toFixed(1)}%</span>
                      <span style={{ color: flag ? COLORS.red : COLORS.green }}>{c.actual.toFixed(1)}%{flag ? " ⚠" : ""}</span>
                      <span style={{ color: COLORS.faint }}>{c.brier.toFixed(3)}</span>
                      <span style={{ color: COLORS.faint }}>{c.n}</span>
                    </div>
                  );
                })}
              </div>
              <p style={{ color: COLORS.faint, fontSize: 10, margin: "8px 0 0", fontFamily: mono }}>By stat only, not sport + stat — "points" blends every sport logged.</p>
            </div>
          )}
        </div>
      )}

      {ungraded.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontFamily: mono, fontSize: 11, color: COLORS.amber }}>{ungraded.length} UNGRADED</div>
            <button onClick={autoGradeMLB} disabled={autoGrading} style={{ fontFamily: mono, fontSize: 10, padding: "4px 8px", borderRadius: 4, border: `1px solid ${COLORS.green}`, color: COLORS.green, background: "transparent", cursor: autoGrading ? "default" : "pointer", opacity: autoGrading ? 0.6 : 1 }}>
              {autoGrading ? "Grading…" : "Auto-grade MLB"}
            </button>
          </div>
          {autoGradeLog.length > 0 && (
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "8px 10px", marginBottom: 10, maxHeight: 140, overflowY: "auto" }}>
              {autoGradeLog.map((line, i) => (
                <div key={i} style={{ fontFamily: mono, fontSize: 10, color: line.includes("HIT") ? COLORS.green : line.includes("MISS") ? COLORS.red : COLORS.faint, marginBottom: 2 }}>{line}</div>
              ))}
            </div>
          )}
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
      <div style={{ fontFamily: mono, fontSize: 12, color: COLORS.muted, letterSpacing: "0.06em", marginBottom: 4 }}>
        CLOSING LINE VALUE
        {avgClv !== null && (
          <span style={{ color: avgClv > 0 ? COLORS.green : COLORS.red, fontWeight: 400 }}> · {avgClv >= 0 ? "+" : ""}{avgClv.toFixed(1)}pt avg</span>
        )}
      </div>
      <p style={{ color: COLORS.faint, fontSize: 11, margin: "0 0 14px" }}>Compares your fair % at pick time vs. the last fair % seen for that prop — re-fetch closer to game time to fill this in.</p>

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
  const [liveRows, setLiveRows] = useState([]);
  const [entryType, setEntryType] = useState("power");
  const [multipliers, setMultipliers] = useState({ ...DEFAULT_POWER });
  const [flexMultipliers, setFlexMultipliers] = useState(
    Object.fromEntries(Object.entries(DEFAULT_FLEX).map(([k, v]) => [k, { ...v }]))
  );
  const [groupCorr, setGroupCorr] = useState({});
  const [bankroll, setBankroll] = useState("");
  const [kellyFraction, setKellyFraction] = useState(0.25);

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

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get("bankroll");
        if (res?.value) setBankroll(res.value);
      } catch (e) { /* no saved bankroll yet */ }
    })();
  }, []);

  const saveBankroll = (val) => {
    setBankroll(val);
    storage.set("bankroll", val).catch(() => {});
  };

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
        propKey: slugify(`${leg.name}-${leg.stat}`), startTime: leg.startTime || null,
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

  // Heuristic starting point, not measured correlation — real correlation
  // needs historical box scores this app doesn't have. Same player across
  // different stats (points+rebounds) tends to move together more than two
  // different players in the same game do, so that's reflected in the
  // default; still just a starting guess, and the slider still overrides it.
  const groupDefaults = useMemo(() => {
    const defaults = {};
    activeGroups.forEach((g) => {
      const legsInGroup = includedLegs.filter((l) => l.group === g);
      const names = new Set(legsInGroup.map((l) => l.name.toLowerCase()));
      defaults[g] = names.size === 1 ? 0.45 : 0.2;
    });
    return defaults;
  }, [activeGroups, includedLegs]);

  const effectiveGroupCorr = useMemo(() => ({ ...groupDefaults, ...groupCorr }), [groupDefaults, groupCorr]);

  const useMonteCarlo = activeGroups.some((g) => (effectiveGroupCorr[g] ?? 0.3) !== 0);

  const { ev, winProb } = useMemo(() => {
    if (n === 0) return { ev: 0, winProb: 0 };
    return useMonteCarlo ? slipEVCorrelated(includedLegs, payoutTable, effectiveGroupCorr) : slipEVExact(includedLegs, payoutTable);
  }, [includedLegs, payoutTable, entryType, useMonteCarlo, effectiveGroupCorr]);

  const topMult = entryType === "power" ? multipliers[n] : payoutTable[n];
  const breakeven = topMult ? 1 / topMult : null;
  const evPerDollar = ev - 1;

  // Kelly criterion: the stake fraction that maximizes long-run bankroll
  // growth given this exact win probability and payout. Full Kelly is
  // aggressive and assumes the probability estimate is exactly right —
  // which it never is, hence offering fractional Kelly (typically 1/4 or
  // 1/2) as the safer default, matching how it's used in practice.
  const fullKelly = topMult && topMult > 1 ? Math.max(0, (winProb * topMult - 1) / (topMult - 1)) : 0;
  const suggestedFraction = fullKelly * kellyFraction;
  const bankrollNum = Number(bankroll) || 0;
  const suggestedStake = bankrollNum * suggestedFraction;
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

        <LiveFeedPanel onQuickAdd={handleAddLeg} onRowsFetched={setLiveRows} />

        <AddLegPanel
          onAdd={handleAddLeg}
          defaultMatchup={lastLeg?.matchup}
          defaultGroup={lastLeg?.group}
          liveRows={liveRows}
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
              These legs share a game/player tag. Starting values are auto-suggested (higher for same-player legs, lower for different players in the same game) — still a heuristic, not measured data, so adjust freely.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {activeGroups.map((g) => {
                const isCustom = g in groupCorr;
                const value = effectiveGroupCorr[g] ?? 0.3;
                return (
                  <div key={g}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontFamily: mono, fontSize: 12, color: COLORS.text, width: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g}</span>
                      <input type="range" min="-0.9" max="0.9" step="0.05" value={value} onChange={(e) => setGroupCorr({ ...groupCorr, [g]: Number(e.target.value) })} style={{ flex: 1 }} />
                      <span style={{ fontFamily: mono, fontSize: 13, color: COLORS.amber, width: 44, textAlign: "right" }}>{value.toFixed(2)}</span>
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: COLORS.faint, marginLeft: 192 }}>
                      {isCustom ? "manually set" : `auto-suggested (${groupDefaults[g] === 0.45 ? "same player" : "different players"})`}
                    </div>
                  </div>
                );
              })}
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

            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${COLORS.line}` }}>
              <div style={{ fontFamily: mono, fontSize: 11, color: COLORS.muted, marginBottom: 8 }}>SUGGESTED STAKE (KELLY)</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <Field label="Bankroll ($)">
                  <input style={inputStyle} value={bankroll} onChange={(e) => saveBankroll(e.target.value)} placeholder="e.g. 200" />
                </Field>
                <Field label="Kelly fraction">
                  <select style={{ ...inputStyle, cursor: "pointer" }} value={kellyFraction} onChange={(e) => setKellyFraction(Number(e.target.value))}>
                    <option value={1}>Full Kelly</option>
                    <option value={0.5}>Half Kelly</option>
                    <option value={0.25}>Quarter Kelly</option>
                    <option value={0.1}>Tenth Kelly</option>
                  </select>
                </Field>
              </div>
              {!isPositive ? (
                <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono, margin: 0 }}>Kelly stake is $0 for a -EV play — the math says don't bet this, not just bet less.</p>
              ) : bankrollNum <= 0 ? (
                <p style={{ color: COLORS.faint, fontSize: 12, fontFamily: mono, margin: 0 }}>Enter a bankroll to see a suggested stake.</p>
              ) : (
                <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.green}`, borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: COLORS.green }}>${suggestedStake.toFixed(2)}</div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: COLORS.faint, marginTop: 2 }}>
                    {(suggestedFraction * 100).toFixed(1)}% of bankroll · full Kelly would be {(fullKelly * 100).toFixed(1)}%
                  </div>
                </div>
              )}
              <p style={{ color: COLORS.faint, fontSize: 10, fontFamily: mono, margin: "8px 0 0" }}>
                Full Kelly assumes your probability is exactly right, which it never is — that's why the default here
                is a quarter, not full. This is a starting point, not a rule; never stake more than you can afford to lose.
              </p>
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
