// Vercel serverless function: /api/standings
// Live FIFA World Cup 2026 data from ESPN (server-side, no key, no CORS).
// Group stage -> ESPN standings endpoint. Knockouts -> ESPN scoreboard fetched
// PER DAY (date ranges are unreliable / time out), phase taken from event.season.slug.

const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings";
const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

// knockout window: 28 Jun 2026 .. 20 Jul 2026 (inclusive), one fetch per day
const KO_START = Date.UTC(2026, 5, 28);
const KO_END   = Date.UTC(2026, 6, 20);

const TEAM_MAP = {
  por: { abbr: "POR", names: ["Portugal"] },
  eng: { abbr: "ENG", names: ["England"] },
  tur: { abbr: "TUR", names: ["Türkiye", "Turkey", "Turkiye"] },
  col: { abbr: "COL", names: ["Colombia"] },
  nor: { abbr: "NOR", names: ["Norway"] },
  civ: { abbr: "CIV", names: ["Ivory Coast", "Côte d'Ivoire", "Cote d'Ivoire"] },
  cze: { abbr: "CZE", names: ["Czechia", "Czech Republic"] },
  gha: { abbr: "GHA", names: ["Ghana"] },
  esp: { abbr: "ESP", names: ["Spain"] },
  arg: { abbr: "ARG", names: ["Argentina"] },
  fra: { abbr: "FRA", names: ["France"] },
  sen: { abbr: "SEN", names: ["Senegal"] },
  egy: { abbr: "EGY", names: ["Egypt"] },
  swe: { abbr: "SWE", names: ["Sweden"] },
  uzb: { abbr: "UZB", names: ["Uzbekistan"] },
  par: { abbr: "PAR", names: ["Paraguay"] },
};

const STG  = { r32: 1, r16: 2, qf: 3, sf: 4, final: 5 }; // stageIndex when REACHING a round
const NEXT = { r32: 2, r16: 3, qf: 4, sf: 5, final: 6 }; // stageIndex when WINNING a round

function norm(s) { return (s || "").toString().toLowerCase().replace(/[^a-zа-яё0-9]/gi, ""); }
function buildIndex() {
  const idx = {};
  for (const [id, info] of Object.entries(TEAM_MAP)) {
    idx[info.abbr.toLowerCase()] = id;
    for (const n of info.names) idx[norm(n)] = id;
  }
  return idx;
}
function matchTeam(idx, team) {
  if (!team) return null;
  if (team.abbreviation && idx[team.abbreviation.toLowerCase()]) return idx[team.abbreviation.toLowerCase()];
  for (const key of ["displayName", "name", "shortDisplayName", "location"]) {
    const v = team[key];
    if (v && idx[norm(v)]) return idx[norm(v)];
  }
  return null;
}
function getStat(entry, keys) {
  const stats = (entry && entry.stats) || [];
  for (const st of stats) {
    if (keys.includes(st.name) || keys.includes(st.type) || keys.includes(st.abbreviation)) {
      if (st.value != null) return st.value;
      const n = parseFloat(st.displayValue);
      return isNaN(n) ? null : n;
    }
  }
  return null;
}
function phaseFromCalendar(cal, dateStr) {
  if (!cal || !dateStr) return null;
  const d = new Date(dateStr).getTime();
  for (const e of cal) {
    const label = (e.label || "").toLowerCase();
    let phase = null;
    if (/round of 32/.test(label)) phase = "r32";
    else if (/rd of 16|round of 16/.test(label)) phase = "r16";
    else if (/quarter/.test(label)) phase = "qf";
    else if (/semi/.test(label)) phase = "sf";
    else if (/3rd|third|place/.test(label)) phase = "third";
    else if (/final/.test(label)) phase = "final";
    if (!phase) continue;
    const s = new Date(e.startDate).getTime();
    const en = new Date(e.endDate).getTime();
    if (d >= s && d < en) return phase;
  }
  return null;
}
// phase of a knockout event: prefer season.slug, fall back to calendar by date
function phaseOf(ev, cal) {
  const slug = (ev && ev.season && ev.season.slug) || "";
  if (/round-?of-?32|roundof32/.test(slug)) return "r32";
  if (/round-?of-?16|roundof16/.test(slug)) return "r16";
  if (/quarter/.test(slug)) return "qf";
  if (/semi/.test(slug)) return "sf";
  if (/third|3rd/.test(slug)) return "third";
  if (/(^|[^a-z])final/.test(slug)) return "final";
  const date = ev.date || (ev.competitions && ev.competitions[0] && ev.competitions[0].date);
  return phaseFromCalendar(cal, date);
}

// standings = ESPN standings json; scoreboard = { leagues:[{calendar:[{entries}]}], events:[...] }
function derive(standings, scoreboard) {
  const idx = buildIndex();
  const out = { updatedAt: new Date().toISOString(), tournamentStarted: false, teams: {} };
  for (const id of Object.keys(TEAM_MAP)) {
    out.teams[id] = {
      stageIndex: 0, groupWinner: false, status: "unknown",
      group: null, rank: null, gp: null, points: null, note: null,
      groupComplete: false, found: false,
    };
  }

  // ---------- GROUP STAGE ----------
  const groups = (standings && standings.children) || [];
  for (const g of groups) {
    const entries = (g.standings && g.standings.entries) || [];
    const gps = entries.map((e) => getStat(e, ["gamesPlayed", "gamesplayed", "GP"]) || 0);
    const groupComplete = entries.length > 0 && gps.every((x) => x >= 3);
    if (gps.some((x) => x > 0)) out.tournamentStarted = true;
    for (const e of entries) {
      const id = matchTeam(idx, e.team);
      if (!id) continue;
      const rank = getStat(e, ["rank", "R"]);
      const gp = getStat(e, ["gamesPlayed", "gamesplayed", "GP"]) || 0;
      const points = getStat(e, ["points", "P"]);
      const note = (e.note && e.note.description) || null;
      const noteAdv = note && /advance|best|qualif/i.test(note);
      const noteElim = note && /eliminat/i.test(note);
      const t = out.teams[id];
      t.found = true; t.group = g.name; t.rank = rank; t.gp = gp; t.points = points;
      t.note = note; t.groupComplete = groupComplete;
      t._advanced = !!(noteAdv || (groupComplete && rank != null && rank <= 2));
      t._groupEliminated = !!(noteElim || (groupComplete && !t._advanced));
    }
  }

  // ---------- KNOCKOUTS ----------
  const cal = scoreboard && scoreboard.leagues && scoreboard.leagues[0] &&
    scoreboard.leagues[0].calendar && scoreboard.leagues[0].calendar[0] &&
    scoreboard.leagues[0].calendar[0].entries;
  const events = (scoreboard && scoreboard.events) || [];
  const ko = {};
  for (const ev of events) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const phase = phaseOf(ev, cal);
    if (!phase || phase === "third") continue; // ignore group + 3rd-place match
    const completed = !!(comp.status && comp.status.type && comp.status.type.completed);
    if (completed) out.tournamentStarted = true;
    for (const c of comp.competitors || []) {
      const id = matchTeam(idx, c.team);
      if (!id) continue;
      ko[id] = ko[id] || { reached: 0, eliminated: false };
      ko[id].reached = Math.max(ko[id].reached, STG[phase]);
      if (completed) {
        if (c.winner === true) ko[id].reached = Math.max(ko[id].reached, NEXT[phase]);
        else if (c.winner === false) ko[id].eliminated = true;
      }
    }
  }

  // ---------- COMBINE ----------
  for (const id of Object.keys(TEAM_MAP)) {
    const t = out.teams[id];
    let stage = t._advanced ? 1 : 0;
    const k = ko[id];
    if (k) stage = Math.max(stage, k.reached);
    t.stageIndex = stage;
    t.groupWinner = !!(t.groupComplete && Math.round(t.rank) === 1 && t._advanced);
    const koElim = !!(k && k.eliminated && stage < 6);
    const eliminated = t._groupEliminated || koElim;
    if (stage === 6) t.status = "champion";
    else if (eliminated) t.status = "out";
    else if (t._advanced || (k && k.reached > 0)) t.status = "alive";
    else if (t.found && !t.groupComplete) t.status = "pending";
    else if (t.found && t.groupComplete && !t._advanced) t.status = "out";
    else t.status = t.found ? "pending" : "unknown";
    delete t._advanced;
    delete t._groupEliminated;
  }
  return out;
}

function knockoutDates() {
  const out = [];
  for (let t = KO_START; t <= KO_END; t += 86400000) {
    const d = new Date(t);
    out.push("" + d.getUTCFullYear() +
      String(d.getUTCMonth() + 1).padStart(2, "0") +
      String(d.getUTCDate()).padStart(2, "0"));
  }
  return out;
}
async function getJSON(url) {
  try { const r = await fetch(url); return await r.json(); } catch (e) { return null; }
}

async function handler(req, res) {
  const ct = "application/json; charset=utf-8";
  try {
    const dates = knockoutDates();
    const results = await Promise.all([
      getJSON(ESPN_STANDINGS),
      ...dates.map((dt) => getJSON(ESPN_SCOREBOARD + "?dates=" + dt)),
    ]);
    const standings = results[0] || {};
    const seen = new Set();
    let events = [], cal = null;
    for (let i = 1; i < results.length; i++) {
      const sb = results[i];
      if (!sb) continue;
      if (!cal) { try { cal = sb.leagues[0].calendar[0].entries; } catch (e) {} }
      if (Array.isArray(sb.events)) {
        for (const ev of sb.events) { if (ev && ev.id && !seen.has(ev.id)) { seen.add(ev.id); events.push(ev); } }
      }
    }
    const data = derive(standings, { leagues: cal ? [{ calendar: [{ entries: cal }] }] : [], events });
    res.statusCode = 200;
    res.setHeader("content-type", ct);
    res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", ct);
    res.end(JSON.stringify({ error: String((e && e.message) || e), updatedAt: new Date().toISOString(), tournamentStarted: false, teams: {} }));
  }
}

module.exports = handler;
module.exports.derive = derive;
module.exports.TEAM_MAP = TEAM_MAP;
