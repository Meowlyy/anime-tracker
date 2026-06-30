/* ═══════════════════════════════════════════════════════════════════
   Anime Tracker — script.js  (clean rewrite)
═══════════════════════════════════════════════════════════════════ */
(function () {
"use strict";

// ══════════════════ CONSTANTS ══════════════════
const SK   = "animeTracker_v5";
const FK   = "animeTrackerFolders_v2";
const AK   = "animeTrackerAiring_v2";
const NK   = "animeTrackerNotifRead_v1";
const NWK  = "animeTrackerNews_v1";
const PER_PAGE   = 60;
const AIRING_TTL = 6 * 3600000;
const NEWS_TTL   = 30 * 60000;

const GENRES = ["Action","Adventure","Comedy","Drama","Fantasy","Horror","Mystery",
  "Romance","Sci-Fi","Slice of Life","Sports","Supernatural","Thriller","Ecchi",
  "Mecha","Psychological","Historical","Music","School","Isekai","Magic","Military",
  "Vampire","Martial Arts","Space"];

const STD_TABS = ["All","Watching","Planning","Completed","On-Hold","Dropped"];

const TO_STATUS = {
  "Watching":"Currently Watching","Planning":"Plan to Watch",
  "Completed":"Completed","On-Hold":"On Hold","Dropped":"Dropped"
};
const TO_LABEL = {
  "Currently Watching":"Watching","Plan to Watch":"Planning",
  "Completed":"Completed","On Hold":"On-Hold","Dropped":"Dropped"
};
const TO_CLASS = {
  "Currently Watching":"watching","Completed":"completed",
  "Plan to Watch":"planning","On Hold":"hold","Dropped":"dropped"
};
const EXT_STATUS = {
  "Planning":"Plan to Watch","Plan to Watch":"Plan to Watch",
  "Completed":"Completed","Watching":"Currently Watching",
  "Currently Watching":"Currently Watching","On-Hold":"On Hold",
  "On Hold":"On Hold","Dropped":"Dropped"
};

// ══════════════════ STATE ══════════════════
let list    = [];
let folders = [];
let airingCache = {};
let readNotifs  = new Set();
let cachedNews  = null;
let cachedNewsAt = 0;

// UI state
const ui = {
  tab:        "All",
  search:     "",
  franchise:  "",
  favOnly:    false,
  minRating:  0,
  genres:     [],
  sort:       "added-desc",
  grouping:   true,
  page:       1,
  selected:   new Set(),
  detailId:   null,
  editId:     null,
  pendingMal: null,
  mergeIdx:   null,
  extParsed:  [],
  extCancelled: false,
  repairCancelled: false,
  notifTab:   "episodes",
  activeNtab: "episodes"
};

// Computed caches
let _normCache = new Map();
let _franchMap = null;

// ══════════════════ HELPERS ══════════════════
const $ = id => document.getElementById(id);
const esc = s => s ? String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") : "";

// Self-hosted cover fallback (no external dependency like via.placeholder.com, which is unreliable).
const NO_COVER_SVG = "data:image/svg+xml," + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <rect width="300" height="450" fill="#111827"/>
  <rect x="0.5" y="0.5" width="299" height="449" fill="none" stroke="#1f2937" stroke-width="1"/>
  <g transform="translate(150,195)" fill="#ff4fd8" opacity=".55">
    <path d="M-26-20h52a6 6 0 0 1 6 6v34a6 6 0 0 1-6 6h-52a6 6 0 0 1-6-6v-34a6 6 0 0 1 6-6Z" fill="none" stroke="#ff4fd8" stroke-width="3"/>
    <circle cx="-9" cy="-3" r="5"/>
    <path d="M-20 16l13-13 9 8 11-13 17 18Z"/>
  </g>
  <text x="150" y="248" font-family="sans-serif" font-size="15" fill="#8891a8" text-anchor="middle">Kein Cover</text>
</svg>`.trim());
function noCover(el){ el.onerror=null; el.src=NO_COVER_SVG; }
window.noCover = noCover; // expose globally for inline onerror attributes

// Generic Jikan API request helper. Used throughout the app (imports, airing
// refresh, relations, news) — handles the relative "/..." paths and retries
// once on a 429 rate-limit response.
async function jikan(path) {
  const url = path.startsWith("http") ? path : `https://api.jikan.moe/v4${path}`;
  const isRelations = path.includes("/relations");
  const maxRetries = isRelations ? 6 : 3;
  let delay = isRelations ? 1500 : 2000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status === 504 || res.status === 502 || res.status === 503) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, delay));
          delay = Math.min(delay * 1.5, 8000); // exponential backoff, cap at 8s
          continue;
        }
        throw new Error(`Jikan ${res.status} after ${maxRetries} attempts`);
      }
      if (!res.ok) throw new Error(`Jikan request failed: ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 8000);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Jikan: max retries exceeded");
}

// Manual relation overrides for known MAL data gaps (e.g. Slime Diaries is listed as
// Spin-off of Tensura on MAL but the relation is missing in the API response on both sides).
// Key: MAL ID of the "secondary" entry. Value: { mainMalId, relation }.
const MANUAL_RELATIONS = {
  41488: { mainMalId: 37430, relation: "Spin-off" }, // The Slime Diaries → Tensura
};

// Prefer the english title (more familiar to most users) over MAL's primary
// (often japanese romaji) title, falling back if no english title exists.
const preferredTitle = a => (a.title_english && a.title_english.trim()) || a.title;

// The "other" title not chosen as primary — romaji if english was used as primary,
// or the japanese-script title as a bonus if no english title exists at all.
function altTitleFor(a) {
  const primary = preferredTitle(a);
  if (a.title_english && a.title_english.trim() && a.title && a.title !== primary) return a.title;
  if (a.title_japanese && a.title_japanese !== primary) return a.title_japanese;
  return "";
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function msg(text, isErr=false) {
  const bar = $("msgBar");
  if (!bar) return;
  bar.classList.remove("hidden","info","error");
  bar.classList.add(isErr ? "error" : "info");
  bar.innerHTML = `<span>${text}</span><span class="msg-close">✖</span>`;
  bar.querySelector(".msg-close").onclick = () => bar.classList.add("hidden");
  setTimeout(() => bar.classList.add("hidden"), 4000);
}

function save() {
  _normCache.clear();
  _franchMap = null;
  try { localStorage.setItem(SK, JSON.stringify(list)); } catch {}
  try { localStorage.setItem(FK, JSON.stringify(folders)); } catch {}
  renderFranchiseDropdown();
}

function saveAiring() { try { localStorage.setItem(AK, JSON.stringify(airingCache)); } catch {} }
function saveReadNotifs() { try { localStorage.setItem(NK, JSON.stringify([...readNotifs])); } catch {} }

// ══════════════════ LOAD ══════════════════
function load() {
  // Migrate from old storage keys (previous versions)
  const OLD_KEYS = ["animeTrackerData_v4","animeTrackerData_v3","animeTrackerData_v2","animeTrackerData"];
  const OLD_FK   = ["animeTrackerFolders_v1","animeTrackerFolders"];
  if (!localStorage.getItem(SK)) {
    for (const k of OLD_KEYS) {
      try { const d = JSON.parse(localStorage.getItem(k)); if (Array.isArray(d)&&d.length) { localStorage.setItem(SK,JSON.stringify(d)); break; } } catch {}
    }
  }
  if (!localStorage.getItem(FK)) {
    for (const k of OLD_FK) {
      try { const d = JSON.parse(localStorage.getItem(k)); if (Array.isArray(d)) { localStorage.setItem(FK,JSON.stringify(d)); break; } } catch {}
    }
  }

  try { const d = JSON.parse(localStorage.getItem(SK)); list = Array.isArray(d) && d.length ? d : sampleData(); }
  catch { list = sampleData(); }
  try { const f = JSON.parse(localStorage.getItem(FK)); folders = Array.isArray(f) ? f : []; }
  catch { folders = []; }

  // One-time cleanup: dedupe customCategories arrays (a past bug in the "merge categories"
  // feature could push the same category name onto an item twice).
  let dupesFound = false;
  list.forEach(a => {
    if (a.customCategories?.length) {
      const deduped = [...new Set(a.customCategories)];
      if (deduped.length !== a.customCategories.length) { a.customCategories = deduped; dupesFound = true; }
    }
  });
  if (dupesFound) save();
  try { airingCache = JSON.parse(localStorage.getItem(AK)) || {}; }
  catch { airingCache = {}; }
  try { readNotifs = new Set(JSON.parse(localStorage.getItem(NK) || "[]")); }
  catch { readNotifs = new Set(); }
  try {
    const nc = JSON.parse(localStorage.getItem(NWK));
    if (nc && nc.data && (Date.now() - nc.at) < NEWS_TTL) { cachedNews = nc.data; cachedNewsAt = nc.at; }
  } catch {}
  // Merge airing cache back to list
  list.forEach(a => {
    const c = a.malId ? airingCache[a.malId] : null;
    if (c) { a.airing = c.airing; a.nextEpAt = c.nextEpAt; }
  });
  save();
}

function sampleData() {
  return [];
}

// ══════════════════ FRANCHISE / GROUPING ══════════════════
function normTitle(t) {
  if (!t) return "";
  if (_normCache.has(t)) return _normCache.get(t);
  const r = t
    .replace(/\s*[:\-–]\s*(Season|Part|Cour)\s*\d+/gi,"")
    .replace(/\s*(2nd|3rd|4th|\d+th|\d+st|\d+nd|\d+rd)\s+Season/gi,"")
    .replace(/\s*Season\s*\d+/gi,"")
    .replace(/\s*Part\s*\d+/gi,"")
    .replace(/\s*Cour\s*\d+/gi,"")
    .replace(/\s*:?\s*(the\s+)?movie\s*\d*/gi,"")  // "the Movie 2", "Movie 3", etc.
    .replace(/\s*[:\-–]\s*.+$/,"")
    .replace(/\s*(Film|OVA|ONA|Special|Specials|Recap|Part)\s*$/gi,"")
    .replace(/\s+[IVXLCDM]+\s*$/i,"")
    .replace(/\s+\d+\s*$/,"")
    .replace(/\s+the\s*$/i,"")  // trailing "the" leftover
    .trim().toLowerCase();
  _normCache.set(t, r);
  return r;
}

function buildFranchMap() {
  if (_franchMap) return _franchMap;
  const byKey = {};
  list.forEach(a => {
    const k = normTitle(a.title);
    if (!k) return;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(a);
  });
  _franchMap = {};
  Object.entries(byKey).forEach(([k, items]) => {
    if (items.length < 2) return;
    const label = items.reduce((a,b) => a.title.length <= b.title.length ? a : b).title;
    _franchMap[label] = items;
  });
  return _franchMap;
}

// Builds an ordered list of "render units" (a franchise group or a single anime) from
// the FULL filtered list (not a page slice) — this is what makes sure a franchise group
// (e.g. all Slime seasons) always renders together, instead of potentially being split
// across two pages if pagination happened before grouping.
function buildRenderUnits(filtered, sortMode) {
  // Step 1: group by normalized title text (catches numbered seasons, parts, etc.)
  const byKey = {};
  filtered.forEach(a => {
    const k = normTitle(a.title);
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(a);
  });

  // Step 2: union-find over text-keys, merged further using cached relation data
  // (spin-offs / side stories / etc. whose titles don't share words with the main
  // franchise, e.g. "The Slime Diaries" vs "That Time I Got Reincarnated as a Slime").
  const parent = {};
  Object.keys(byKey).forEach(k => parent[k] = k);
  const root = k => { while (parent[k] && parent[k] !== k) k = parent[k]; return k; };
  const union = (k1, k2) => { const r1 = root(k1), r2 = root(k2); if (r1 !== r2) parent[r1] = r2; };

  const byMalId = {};
  filtered.forEach(a => { if (a.malId) byMalId[a.malId] = a; });

  // Track which items are linked in only via a "secondary" relation (spin-off/side story),
  // so they can be visually marked as not being a main numbered entry of the franchise.
  const secondaryOf = {};

  // Apply manual overrides first (for known MAL data gaps where the API returns no relations)
  filtered.forEach(a => {
    const override = a.malId && MANUAL_RELATIONS[a.malId];
    if (!override) return;
    const other = byMalId[override.mainMalId];
    if (!other) return;
    const k1 = normTitle(a.title), k2 = normTitle(other.title);
    if (byKey[k1] && byKey[k2] && root(k1) !== root(k2)) {
      union(k1, k2);
      if (!secondaryOf[a.id]) secondaryOf[a.id] = override.relation;
    }
  });

  filtered.forEach(a => {
    if (!a.relatedMalIds?.length) return;
    const k1 = normTitle(a.title);
    for (const rel of a.relatedMalIds) {
      const other = byMalId[rel.malId];
      if (!other || other.id === a.id) continue;
      const k2 = normTitle(other.title);
      if (!byKey[k1] || !byKey[k2]) continue;
      if (root(k1) === root(k2)) continue;
      union(k1, k2);
      if (rel.relation === "Side story" || rel.relation === "Spin-off") {
        if (!secondaryOf[a.id]) secondaryOf[a.id] = rel.relation;
      }
    }
  });

  // Step 3: collect final groups by union-find root and sort chronologically
  const groupsByRoot = {};
  filtered.forEach(a => {
    const r = root(normTitle(a.title));
    if (!groupsByRoot[r]) groupsByRoot[r] = [];
    groupsByRoot[r].push(a);
  });

  // Sort members: when the user picked an explicit sort (anything but the default
  // "added-desc"), respect it inside groups too. Otherwise follow the chronological
  // Prequel→Sequel chain (nicest reading order for a franchise).
  function sortGroupMembers(members) {
    if (sortMode && sortMode !== "added-desc") {
      const sorted = [...members];
      switch (sortMode) {
        case "title-asc":      sorted.sort((a,b)=>a.title.localeCompare(b.title)); break;
        case "title-desc":     sorted.sort((a,b)=>b.title.localeCompare(a.title)); break;
        case "rating-desc":    sorted.sort((a,b)=>(b.rating||0)-(a.rating||0)); break;
        case "rating-asc":     sorted.sort((a,b)=>(a.rating||0)-(b.rating||0)); break;
        case "mal-desc":       sorted.sort((a,b)=>(b.malScore||0)-(a.malScore||0)); break;
        case "progress-desc":  sorted.sort((a,b)=>((b.episodesWatched||0)/(b.totalEpisodes||1))-((a.episodesWatched||0)/(a.totalEpisodes||1))); break;
        case "completed-desc": sorted.sort((a,b)=>(b.completedAt||0)-(a.completedAt||0)); break;
        case "completed-asc":  sorted.sort((a,b)=>(a.completedAt||0)-(b.completedAt||0)); break;
      }
      return sorted;
    }
    const byMalId = {};
    members.forEach(m => { if (m.malId) byMalId[m.malId] = m; });
    const hasPrequelInGroup = new Set();
    members.forEach(m => {
      (m.relatedMalIds||[]).forEach(r => {
        if (r.relation==="Sequel" && byMalId[r.malId]) hasPrequelInGroup.add(r.malId);
      });
    });
    const score = new Map(); let counter = 0; const visited = new Set();
    function walk(m) {
      if (!m || visited.has(m.id)) return;
      visited.add(m.id); score.set(m.id, counter++);
      (m.relatedMalIds||[]).forEach(r => { if (r.relation==="Sequel" && byMalId[r.malId]) walk(byMalId[r.malId]); });
    }
    // Sort roots by type so TV series are walked first → get lower chain scores than movies
    const TYPE_PRIO = {"TV":0,"ONA":1,"OVA":2,"Special":3,"Movie":4,"Music":5};
    members.filter(m => !hasPrequelInGroup.has(m.malId))
      .sort((a,b) => (TYPE_PRIO[a.type]??3)-(TYPE_PRIO[b.type]??3) || (a.year||9999)-(b.year||9999))
      .forEach(walk);
    members.forEach(m => { if (!visited.has(m.id)) walk(m); });
    return [...members].sort((a,b) => {
      const sa = score.has(a.id)?score.get(a.id):999, sb = score.has(b.id)?score.get(b.id):999;
      // If both have chain data, use it
      if (sa!==999 || sb!==999) {
        if (sa!==sb) return sa-sb;
      }
      // Fallback: TV before movies
      const tprio = {"TV":0,"ONA":1,"OVA":2,"Special":3,"Movie":4,"Music":5}; const pa = tprio[a.type]??3, pb = tprio[b.type]??3;
      if (pa!==pb) return pa-pb;
      // Then by year
      if (a.year&&b.year&&a.year!==b.year) return a.year-b.year;
      return a.title.localeCompare(b.title);
    });
  }

  const seenRoot = new Set();
  const units = [];
  filtered.forEach(a => {
    const r = root(normTitle(a.title));
    const members = groupsByRoot[r];
    if (members.length >= 2) {
      if (seenRoot.has(r)) return;
      seenRoot.add(r);
      const mainMembers = members.filter(m => !secondaryOf[m.id]);
      const labelPool = mainMembers.length ? mainMembers : members;
      const label = labelPool.reduce((x,y) => x.title.length <= y.title.length ? x : y).title;
      const sorted = sortGroupMembers(members);
      units.push({ type: "group", label, items: sorted, size: sorted.length, secondaryOf });
    } else {
      units.push({ type: "single", item: a, size: 1 });
    }
  });
  return units;
}

// Bin-packs render units into pages of roughly PER_PAGE items each, without ever
// splitting a single unit (i.e. a franchise group) across two pages — a group that's
// bigger than PER_PAGE on its own simply makes that one page larger than usual.
function paginateUnits(units, perPage) {
  const pages = [];
  let current = [], currentSize = 0;
  units.forEach(u => {
    if (currentSize > 0 && currentSize + u.size > perPage) {
      pages.push(current); current = []; currentSize = 0;
    }
    current.push(u); currentSize += u.size;
  });
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

// ══════════════════ FILTER ══════════════════
function getFiltered() {
  let l = [...list];
  // Tab filter
  if (ui.tab !== "All") {
    const mapped = TO_STATUS[ui.tab];
    if (mapped) l = l.filter(a => a.status === mapped);
    else l = l.filter(a => (a.customCategories||[]).includes(ui.tab));
  }
  // Franchise filter
  if (ui.franchise) {
    const fm = buildFranchMap();
    const ids = new Set((fm[ui.franchise]||[]).map(a=>a.id));
    l = l.filter(a => ids.has(a.id));
  }
  // Text search — match against the saved title and the alt title (e.g. japanese
  // romaji if english is stored as primary, so it's findable either way)
  if (ui.search) {
    const q = ui.search.toLowerCase();
    l = l.filter(a => a.title.toLowerCase().includes(q) || (a.altTitle||"").toLowerCase().includes(q));
  }
  // Favorites
  if (ui.favOnly) l = l.filter(a => a.favorite);
  // Rating
  if (ui.minRating > 0) l = l.filter(a => (a.rating||0) >= ui.minRating);
  // Genres
  if (ui.genres.length) l = l.filter(a => ui.genres.every(g => (a.genres||[]).includes(g)));
  // Sort
  switch(ui.sort) {
    case "title-asc":      l.sort((a,b)=>a.title.localeCompare(b.title)); break;
    case "title-desc":     l.sort((a,b)=>b.title.localeCompare(a.title)); break;
    case "rating-desc":    l.sort((a,b)=>(b.rating||0)-(a.rating||0)); break;
    case "rating-asc":     l.sort((a,b)=>(a.rating||0)-(b.rating||0)); break;
    case "mal-desc":       l.sort((a,b)=>(b.malScore||0)-(a.malScore||0)); break;
    case "progress-desc":  l.sort((a,b)=>((b.episodesWatched||0)/(b.totalEpisodes||1))-((a.episodesWatched||0)/(a.totalEpisodes||1))); break;
    case "completed-desc": l.sort((a,b)=>(b.completedAt||0)-(a.completedAt||0)); break;
    case "completed-asc":  l.sort((a,b)=>(a.completedAt||0)-(b.completedAt||0)); break;
    default:               l.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  }
  return l;
}

// ══════════════════ STATS ══════════════════
function updateStats() {
  const total     = list.length;
  const completed = list.filter(a=>a.status==="Completed").length;
  const episodes  = list.reduce((s,a)=>s+(a.episodesWatched||0),0);
  const rated     = list.filter(a=>a.rating>0);
  const avg       = rated.length ? (rated.reduce((s,a)=>s+a.rating,0)/rated.length).toFixed(1) : "0.0";
  const watching  = list.filter(a=>a.status==="Currently Watching").length;
  const planning  = list.filter(a=>a.status==="Plan to Watch").length;
  const favs      = list.filter(a=>a.favorite).length;
  const pct       = total ? Math.round(completed/total*100) : 0;
  const se = id => { const el = $(id); if(el) el.textContent = arguments[1]; };
  const set = (id,v) => { const el=$(id); if(el) el.textContent=v; };
  set("st-total",total); set("st-completed",completed); set("st-completed-pct",pct+"%");
  set("st-episodes",episodes); set("st-avg",avg); set("st-watching",watching);
  set("st-planning",planning); set("st-favs",favs);
}

// ══════════════════ TABS ══════════════════
function renderTabs() {
  const fixed  = $("tabsFixed");
  const scroll = $("tabsScroll");
  const divider  = $("tabsDivider");
  const scrollWrap = $("tabsScrollWrap");
  if (!fixed || !scroll) return;

  fixed.innerHTML = STD_TABS.map(t =>
    `<div class="tab${ui.tab===t?" active":""}" data-tab="${esc(t)}">${t}</div>`
  ).join("");

  if (folders.length) {
    scroll.innerHTML = folders.map(f =>
      `<div class="tab${ui.tab===f?" active":""}" data-tab="${esc(f)}">${esc(f)}</div>`
    ).join("");
    divider.classList.remove("hidden");
    scrollWrap.style.display = "block";
  } else {
    scroll.innerHTML = "";
    divider.classList.add("hidden");
    scrollWrap.style.display = "none";
  }

  [fixed, scroll].forEach(el => {
    el.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        ui.tab = tab.dataset.tab;
        ui.page = 1;
        renderTabs();
        renderList();
      });
    });
  });
}

// ══════════════════ FRANCHISE DROPDOWN ══════════════════
function renderFranchiseDropdown() {
  const fm = buildFranchMap();
  const keys = Object.keys(fm).sort();
  const wrap = $("franchiseWrap");
  const sel  = $("franchiseSel");
  if (!wrap || !sel) return;
  if (!keys.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const cur = ui.franchise;
  sel.innerHTML = `<option value="">Alle Franchises</option>` +
    keys.map(k=>`<option value="${esc(k)}"${cur===k?" selected":""}>${esc(k)} (${fm[k].length})</option>`).join("");
}

// ══════════════════ MORE / FOLDERS ══════════════════
function renderMoreList() {
  const ml = $("moreList");
  if (!ml) return;
  if (!folders.length) {
    ml.innerHTML = '<div style="padding:10px;text-align:center;color:var(--dim);font-size:.78rem;">Keine eigenen Kategorien</div>';
    return;
  }
  ml.innerHTML = folders.map((f,i) => `
    <div class="more-item">
      <div class="more-item-left">
        <div class="more-reorder">
          <button onclick="AT.moveFolder(${i},-1)" ${i===0?"disabled":""}><i class="fas fa-chevron-up"></i></button>
          <button onclick="AT.moveFolder(${i},1)"  ${i===folders.length-1?"disabled":""}><i class="fas fa-chevron-down"></i></button>
        </div>
        <span class="more-item-name" ondblclick="AT.startRename(${i},this)" title="Doppelklick zum Umbenennen">
          <i class="fas fa-folder" style="color:var(--accent);margin-right:6px;"></i>${esc(f)}
        </span>
        <span class="more-item-count">${list.filter(a=>(a.customCategories||[]).includes(f)||a.status===f).length}</span>
      </div>
      <div class="more-item-actions">
        <button class="more-act-btn merge" onclick="AT.openMerge(${i})" title="Zusammenführen"><i class="fas fa-compress-arrows-alt"></i></button>
        <button class="more-act-btn del"   onclick="AT.deleteFolder('${esc(f)}')"  title="Löschen"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join("");
}

// ══════════════════ STATUS OPTIONS ══════════════════
function statusOptions(selected="") {
  const base = [
    {v:"Currently Watching",l:"Aktuell"},
    {v:"Completed",l:"Abgeschlossen"},
    {v:"Plan to Watch",l:"Geplant"},
    {v:"On Hold",l:"Pausiert"},
    {v:"Dropped",l:"Abgebrochen"}
  ];
  let h = base.map(o=>`<option value="${o.v}"${selected===o.v?" selected":""}>${o.l}</option>`).join("");
  if (folders.length) {
    h += `<optgroup label="── Eigene Kategorien ──">`;
    h += folders.map(f=>`<option value="${esc(f)}"${selected===f?" selected":""}>${esc(f)}</option>`).join("");
    h += `</optgroup>`;
  }
  return h;
}

function customCatCheckboxes(current=[]) {
  if (!folders.length) return "";
  return `<div class="form-field full">
    <label><i class="fas fa-folder"></i> Eigene Kategorien <span style="font-weight:400;opacity:.6;">(mehrere möglich)</span></label>
    <div class="custom-cats-wrap">
      ${folders.map(f=>`<label class="cb-wrap">
        <input type="checkbox" class="cat-cb" value="${esc(f)}"${current.includes(f)?" checked":""}>
        <span class="cb-box"></span><span>${esc(f)}</span>
      </label>`).join("")}
    </div>
  </div>`;
}

// ══════════════════ AIRING ══════════════════
function timeUntil(ts) {
  if (!ts) return null;
  const d = ts - Date.now();
  if (d < 0) return "kürzlich";
  const h = Math.floor(d/3600000), day = Math.floor(h/24);
  if (day > 0) return `in ${day} Tag${day>1?"en":""}`;
  if (h > 0)   return `in ${h} Std.`;
  return `in ${Math.floor(d/60000)} Min.`;
}

async function fetchAiring(malId) {
  try {
    const resp = await jikan(`/anime/${malId}`);
    const a = resp.data;
    if (!a) return null;
    const info = { airing: a.airing===true, nextEpAt: null, fetchedAt: Date.now() };
    if (a.broadcast?.day && a.broadcast?.time) {
      const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const di = days.findIndex(d=>a.broadcast.day.startsWith(d));
      if (di!==-1) {
        const [hh,mm] = (a.broadcast.time||"00:00").split(":").map(Number);
        const now = new Date();
        const jst = new Date(now.getTime()+9*3600000);
        const diff = (di-jst.getUTCDay()+7)%7||7;
        const next = new Date(jst);
        next.setUTCDate(next.getUTCDate()+diff);
        next.setUTCHours(hh-9,mm,0,0);
        info.nextEpAt = next.getTime();
      }
    }
    return info;
  } catch { return null; }
}

async function refreshAiringOne(anime) {
  if (!anime.malId) return;
  const cached = airingCache[anime.malId];
  if (cached && (Date.now()-cached.fetchedAt)<AIRING_TTL) return;
  await new Promise(r=>setTimeout(r,350));
  const info = await fetchAiring(anime.malId);
  if (info) {
    airingCache[anime.malId] = info;
    anime.airing = info.airing; anime.nextEpAt = info.nextEpAt;
  }
  saveAiring();
}

async function refreshAllAiring() {
  const candidates = list.filter(a=>a.malId&&(a.status==="Currently Watching"||a.status==="Plan to Watch"||a.airing));
  for (const a of candidates) await refreshAiringOne(a);
  save(); renderList(); updateNotifBadge();
}

// ══════════════════ RENDER CARD ══════════════════
function makeCard(anime, relationLabel) {
  const pct = anime.totalEpisodes ? Math.round((anime.episodesWatched||0)/anime.totalEpisodes*100) : 0;
  const stars = anime.rating ? "★".repeat(Math.floor(anime.rating/2))+"☆".repeat(5-Math.floor(anime.rating/2)) : "☆☆☆☆☆";
  const sc = TO_CLASS[anime.status]||"planning";
  const sl = TO_LABEL[anime.status]||anime.status;
  const cats = anime.customCategories||[];
  const div = document.createElement("div");
  div.className = "anime-card";
  div.dataset.id = anime.id;
  div.innerHTML = `
    <div class="card-media">
      <img src="${esc(anime.imageUrl||NO_COVER_SVG)}" alt="${esc(anime.title)}" loading="lazy"
           onerror="noCover(this)">
      <div class="card-badges">
        <span class="card-status ${sc}">${sl}</span>
        <div class="card-fav-btn${anime.favorite?" on":""}" data-id="${anime.id}"><i class="fas fa-star"></i></div>
        ${relationLabel ? `<span class="card-relation-tag"><i class="fas fa-code-branch"></i> ${esc(relationLabel)}</span>` : ""}
      </div>
      ${cats.length?`<div class="card-badges card-badges-bottom">
        <span class="card-custom-pill"><i class="fas fa-folder"></i> ${esc(cats[0])}${cats.length>1?" +"+(cats.length-1):""}</span>
      </div>`:""}
    </div>
    <div class="card-select-wrap">
      <label class="cb-wrap"><input type="checkbox" class="card-cb" data-id="${anime.id}"${ui.selected.has(String(anime.id))?" checked":""}><span class="cb-box"></span></label>
    </div>
    <div class="card-body">
      <div class="card-title" title="${esc(anime.title)}">${esc(anime.title)}</div>
      ${anime.altTitle ? `<div class="card-alt-title" title="${esc(anime.altTitle)}">${esc(anime.altTitle)}</div>` : ""}
      <div class="card-prog-bar"><div class="card-prog-fill" style="width:${pct}%"></div></div>
      <div class="card-prog-txt">${anime.episodesWatched||0}/${anime.totalEpisodes||"?"} Ep.</div>
      <div class="card-stars">${stars}</div>
      ${anime.malScore?`<div class="card-mal">MAL: ${anime.malScore.toFixed(1)}</div>`:""}
      ${anime.airing?`<div class="card-airing"><span class="airing-dot"></span>AIRING${anime.nextEpAt?`<span class="airing-next">${esc(timeUntil(anime.nextEpAt))}</span>`:""}</div>`:""}
      <div class="card-actions"><button class="ep-btn" data-id="${anime.id}">+1 Ep.</button></div>
    </div>`;
  return div;
}

// ══════════════════ RENDER LIST ══════════════════
let _renderTimeout = null;
function renderList() {
  clearTimeout(_renderTimeout);
  _renderTimeout = setTimeout(_doRender, 0);
}

function _doRender() {
  const grid    = $("animeGrid");
  const empty   = $("emptyState");
  const pagEl   = $("pagination");
  if (!grid) return;

  const filtered = getFiltered();
  grid.innerHTML = "";

  if (!filtered.length) {
    if (empty) empty.classList.remove("hidden");
    if (pagEl) pagEl.innerHTML = "";
    return;
  }
  if (empty) empty.classList.add("hidden");

  // Pagination
  if (ui.grouping) {
    const units = buildRenderUnits(filtered, ui.sort);
    const pages = paginateUnits(units, PER_PAGE);
    if (ui.page > pages.length) ui.page = 1;
    const pageUnits = pages[ui.page-1] || [];
    pageUnits.forEach(u => {
      if (u.type === "group") {
        const { label, items } = u;
        const wrap = document.createElement("div");
        wrap.className = "sg-wrap open";
        wrap.style.gridColumn = "1/-1";
        const header = document.createElement("div");
        header.className = "sg-header";
        header.innerHTML = `
          <div class="sg-title"><i class="fas fa-layer-group"></i><span>${esc(label)}</span><span class="sg-count">${items.length}</span></div>
          <i class="fas fa-chevron-down sg-arrow"></i>`;
        header.addEventListener("click", () => wrap.classList.toggle("open"));
        const body = document.createElement("div");
        body.className = "sg-body";
        items.forEach(a => body.appendChild(makeCard(a, u.secondaryOf?.[a.id])));
        wrap.append(header, body);
        grid.appendChild(wrap);
      } else {
        grid.appendChild(makeCard(u.item));
      }
    });
    renderPagination(pages.length, filtered.length);
  } else {
    const totalPages = Math.ceil(filtered.length / PER_PAGE);
    if (ui.page > totalPages) ui.page = 1;
    const pageItems = filtered.slice((ui.page-1)*PER_PAGE, ui.page*PER_PAGE);
    pageItems.forEach(a => grid.appendChild(makeCard(a)));
    renderPagination(totalPages, filtered.length);
  }

  updateBulkUI();
}

function renderPagination(totalPages, totalItems) {
  const el = $("pagination");
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = `<span class="page-info">${totalItems} Anime</span>`; return; }

  const p = ui.page;
  let html = `<span class="page-info">${totalItems} Anime</span>`;
  html += `<button class="page-btn" ${p<=1?"disabled":""} onclick="AT.goPage(${p-1})"><i class="fas fa-chevron-left"></i></button>`;

  // Smart page buttons
  const pages = new Set([1, totalPages, p-1, p, p+1].filter(x=>x>=1&&x<=totalPages));
  let prev = 0;
  [...pages].sort((a,b)=>a-b).forEach(pg => {
    if (prev && pg - prev > 1) html += `<span class="page-info">…</span>`;
    html += `<button class="page-btn${pg===p?" active":""}" onclick="AT.goPage(${pg})">${pg}</button>`;
    prev = pg;
  });

  html += `<button class="page-btn" ${p>=totalPages?"disabled":""} onclick="AT.goPage(${p+1})"><i class="fas fa-chevron-right"></i></button>`;
  el.innerHTML = html;
}

// Bulk UI
function updateBulkUI() {
  const cbs  = document.querySelectorAll(".card-cb");
  const all  = $("selectAll");
  const cnt  = $("bulkCount");
  // Sync checked state with ui.selected
  cbs.forEach(cb => { cb.checked = ui.selected.has(String(cb.dataset.id)); });
  if (all) all.checked = cbs.length > 0 && [...cbs].every(cb=>cb.checked);
  if (cnt) cnt.textContent = `${ui.selected.size} ausgewählt`;
}

// ══════════════════ EVENT DELEGATION ══════════════════
function initGridDelegation() {
  const grid = $("animeGrid");
  if (!grid) return;

  grid.addEventListener("click", e => {
    // Favorite
    const fav = e.target.closest(".card-fav-btn");
    if (fav) {
      e.stopPropagation();
      const a = list.find(x=>String(x.id)===String(fav.dataset.id));
      if (a) {
        a.favorite = !a.favorite;
        fav.classList.toggle("on", a.favorite);
        save(); updateStats(); updateNotifBadge();
      }
      return;
    }
    // +1 Ep
    const epBtn = e.target.closest(".ep-btn");
    if (epBtn) {
      e.stopPropagation();
      const a = list.find(x=>String(x.id)===String(epBtn.dataset.id));
      if (!a) return;
      if (a.totalEpisodes && (a.episodesWatched||0) >= a.totalEpisodes) { msg("Alle Episoden bereits gesehen!"); return; }
      a.episodesWatched = (a.episodesWatched||0)+1;
      // In-place DOM update
      const card = epBtn.closest(".anime-card");
      if (card) {
        const pct = a.totalEpisodes ? Math.round(a.episodesWatched/a.totalEpisodes*100) : 0;
        const fill = card.querySelector(".card-prog-fill"); if(fill) fill.style.width=pct+"%";
        const txt  = card.querySelector(".card-prog-txt");  if(txt)  txt.textContent=`${a.episodesWatched}/${a.totalEpisodes||"?"} Ep.`;
      }
      save(); updateStats();
      return;
    }
    // Checkbox — handled by change event
    if (e.target.classList.contains("card-cb")) return;
    // Open detail
    const card = e.target.closest(".anime-card");
    if (card && !e.target.closest(".card-select-wrap")) {
      const a = list.find(x=>String(x.id)===String(card.dataset.id));
      if (a) openDetail(a);
    }
  });

  grid.addEventListener("change", e => {
    if (e.target.classList.contains("card-cb")) {
      const id = String(e.target.dataset.id);
      if (e.target.checked) ui.selected.add(id); else ui.selected.delete(id);
      updateBulkUI();
    }
  });
}

// ══════════════════ SHARE ══════════════════
function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
    setTimeout(rej, 4000);
  });
}

async function buildShareCanvas(anime) {
  const W = 720, H = 960; // portrait "story" style card
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // ── Blurred cover as full background ──
  ctx.fillStyle = "#0b1020";
  ctx.fillRect(0, 0, W, H);
  let coverImg = null;
  try { coverImg = await loadImg(anime.imageUrl); } catch {}
  if (coverImg) {
    ctx.save();
    ctx.filter = "blur(28px) brightness(0.45) saturate(1.3)";
    // Oversize + center-crop so the blur doesn't reveal edges
    const scale = Math.max(W/coverImg.width, H/coverImg.height) * 1.15;
    const dw = coverImg.width*scale, dh = coverImg.height*scale;
    ctx.drawImage(coverImg, (W-dw)/2, (H-dh)/2, dw, dh);
    ctx.restore();
  }

  // Dark gradient overlay for text legibility (stronger toward bottom)
  const overlay = ctx.createLinearGradient(0, 0, 0, H);
  overlay.addColorStop(0,   "rgba(5,8,22,.55)");
  overlay.addColorStop(0.45,"rgba(5,8,22,.35)");
  overlay.addColorStop(0.7, "rgba(5,8,22,.75)");
  overlay.addColorStop(1,   "rgba(5,8,22,.96)");
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, W, H);

  // ── Brand mark, top ──
  ctx.font = "700 22px 'Poppins', sans-serif";
  ctx.fillStyle = "#ff7fe0";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("˚ʚ Meowly ₊✧", 36, 56);
  ctx.font = "500 13px 'Poppins', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.fillText("Anime Tracker", 36, 76);

  // ── Sharp cover thumbnail, upper-middle ──
  const cw = 280, ch = 396, cx = (W-cw)/2, cy = 120;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.5)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.beginPath();
  roundRectPath(ctx, cx, cy, cw, ch, 16);
  ctx.fillStyle = "#111827";
  ctx.fill();
  ctx.restore();
  if (coverImg) {
    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, cx, cy, cw, ch, 16);
    ctx.clip();
    const s2 = Math.max(cw/coverImg.width, ch/coverImg.height);
    const dw2 = coverImg.width*s2, dh2 = coverImg.height*s2;
    ctx.drawImage(coverImg, cx+(cw-dw2)/2, cy+(ch-dh2)/2, dw2, dh2);
    ctx.restore();
  }
  // thin border on cover
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, cx, cy, cw, ch, 16);
  ctx.stroke();

  let y = cy + ch + 48;

  // ── Status badge, centered ──
  const statusColors = {"Completed":"#34d399","Currently Watching":"#22d3ee","Plan to Watch":"#fbbf24","On Hold":"#a78bfa","Dropped":"#f87171"};
  const statusLabels = {"Completed":"Abgeschlossen","Currently Watching":"Watching","Plan to Watch":"Geplant","On Hold":"Pausiert","Dropped":"Abgebrochen"};
  const sc = statusColors[anime.status]||"#9aa3b8";
  const sl = (statusLabels[anime.status]||anime.status).toUpperCase();
  ctx.font = "700 13px 'Poppins', sans-serif";
  const slw = ctx.measureText(sl).width;
  const badgeW = slw + 36, badgeH = 30;
  const bx = (W-badgeW)/2;
  ctx.fillStyle = sc + "26";
  ctx.strokeStyle = sc + "99";
  ctx.lineWidth = 1.3;
  roundRectPath(ctx, bx, y, badgeW, badgeH, badgeH/2);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = sc;
  ctx.textAlign = "center";
  ctx.fillText(sl, W/2, y + badgeH/2 + 4.5);
  ctx.textAlign = "left";
  y += badgeH + 28;

  // ── Title, centered, wrapped ──
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 30px 'Poppins', sans-serif";
  const maxTitleW = W - 80;
  const words = anime.title.split(" ");
  let line = "", titleLines = [];
  for (const w of words) {
    const test = line ? line+" "+w : w;
    if (ctx.measureText(test).width > maxTitleW) { if(line) titleLines.push(line); line = w; }
    else line = test;
  }
  if (line) titleLines.push(line);
  titleLines.slice(0,2).forEach((l,i) => ctx.fillText(l, W/2, y + i*38));
  y += titleLines.slice(0,2).length * 38 + 4;

  if (anime.altTitle) {
    ctx.font = "400 15px 'Poppins', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.5)";
    const alt = anime.altTitle.length>48 ? anime.altTitle.slice(0,48)+"…" : anime.altTitle;
    ctx.fillText(alt, W/2, y + 14);
    y += 34;
  } else {
    y += 14;
  }

  // ── Stars ──
  const starCount = anime.rating ? Math.round(anime.rating/2) : 0;
  ctx.font = "26px sans-serif";
  ctx.fillStyle = "#fbbf24";
  ctx.fillText("★".repeat(starCount) + "☆".repeat(5-starCount), W/2, y + 24);
  if (anime.rating) {
    ctx.font = "600 14px 'Poppins', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.fillText(`${anime.rating.toFixed(1)} / 10`, W/2, y + 48);
    y += 70;
  } else {
    y += 46;
  }

  // ── Meta row (type · episodes · MAL score) ──
  ctx.font = "500 14px 'Poppins', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,.65)";
  const metaParts = [
    anime.type || "TV",
    anime.totalEpisodes ? `${anime.episodesWatched||0}/${anime.totalEpisodes} Episoden` : null,
    anime.malScore ? `MAL ${anime.malScore.toFixed(1)}` : null
  ].filter(Boolean);
  ctx.fillText(metaParts.join("   ·   "), W/2, y);
  y += 38;

  // ── Genre pills, centered, wrap row ──
  if (anime.genres?.length) {
    ctx.font = "600 13px 'Poppins', sans-serif";
    const pills = anime.genres.slice(0,4);
    const pillW = pills.map(g => ctx.measureText(g).width + 28);
    const gap = 10;
    const totalW = pillW.reduce((s,w)=>s+w,0) + gap*(pills.length-1);
    let gx = (W - totalW)/2;
    pills.forEach((g,i) => {
      const w = pillW[i];
      ctx.fillStyle = "rgba(255,79,216,.16)";
      ctx.strokeStyle = "rgba(255,79,216,.5)";
      ctx.lineWidth = 1;
      roundRectPath(ctx, gx, y, w, 28, 14);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#ff9fe8";
      ctx.fillText(g, gx + w/2, y + 19);
      gx += w + gap;
    });
  }
  ctx.textAlign = "left";

  return canvas;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

async function shareAnime(anime) {
  const canvas = await buildShareCanvas(anime);
  openSharePreview(canvas, anime);
}

function openSharePreview(canvas, anime) {
  let modal = $("sharePreviewModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "sharePreviewModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-bg"></div>
      <div class="modal-box" style="max-width:420px">
        <div class="modal-head">
          <h2><i class="fas fa-share-nodes"></i> Teilen</h2>
          <button class="icon-btn" id="sharePreviewClose"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;align-items:center">
          <img id="sharePreviewImg" style="width:100%;border-radius:12px;border:1px solid var(--border)" alt="">
          <div style="display:flex;gap:10px;width:100%">
            <button class="btn-ghost" id="shareCopyBtn" style="flex:1"><i class="fas fa-copy"></i> Kopieren</button>
            <button class="btn-accent" id="shareDownloadBtn" style="flex:1"><i class="fas fa-download"></i> Speichern</button>
          </div>
          <button class="btn-ghost" id="shareNativeBtn" style="width:100%;display:none"><i class="fas fa-paper-plane"></i> Teilen…</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target===modal.querySelector(".modal-bg")) modal.classList.add("hidden"); });
    $("sharePreviewClose").addEventListener("click", ()=>modal.classList.add("hidden"));
  }

  const dataUrl = canvas.toDataURL("image/png");
  $("sharePreviewImg").src = dataUrl;

  const filename = `${anime.title.replace(/[^a-z0-9]/gi,"_").toLowerCase()}_meowly.png`;

  $("shareDownloadBtn").onclick = () => {
    const link = document.createElement("a");
    link.download = filename;
    link.href = dataUrl;
    link.click();
    msg("Bild gespeichert!");
  };

  $("shareCopyBtn").onclick = async () => {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      msg("In Zwischenablage kopiert!");
    } catch {
      msg("Kopieren nicht unterstützt – nutze 'Speichern'.", true);
    }
  };

  const nativeBtn = $("shareNativeBtn");
  if (navigator.share && navigator.canShare) {
    canvas.toBlob(blob => {
      const file = new File([blob], filename, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        nativeBtn.style.display = "";
        nativeBtn.onclick = () => navigator.share({ files: [file], title: anime.title }).catch(()=>{});
      }
    });
  }

  modal.classList.remove("hidden");
}

// ══════════════════ DETAIL MODAL ══════════════════
function openDetail(anime) {
  ui.detailId = anime.id;
  const title = $("detailModalTitle"), body = $("detailBody");
  if (title) title.textContent = anime.title;
  const altEl = $("detailModalAlt");
  if (altEl) altEl.textContent = anime.altTitle || "";
  const sl = TO_LABEL[anime.status]||anime.status;
  const malLink = anime.malId
    ? `<a href="https://myanimelist.net/anime/${anime.malId}" target="_blank" rel="noopener" class="mal-link"><i class="fab fa-myanimelist"></i> Auf MAL öffnen</a>`
    : "";
  const notes = anime.notes||anime.synopsis||"";
  const cats = (anime.customCategories||[]).filter(Boolean);
  if (body) body.innerHTML = `
    <div class="detail-layout">
      <div class="detail-poster">
        <img src="${esc(anime.imageUrl||NO_COVER_SVG)}" alt="${esc(anime.title)}"
             onerror="noCover(this)">
      </div>
      <div>
        <div class="detail-meta-row">
          <div class="detail-meta-item"><i class="fas fa-flag"></i><strong>${esc(sl)}</strong></div>
          <div class="detail-meta-item"><i class="fas fa-star"></i><strong>${anime.rating?anime.rating.toFixed(1)+"/10":"Nicht bewertet"}</strong></div>
          <div class="detail-meta-item"><i class="fas fa-heart"></i><strong>${anime.favorite?"Ja ❤️":"Nein"}</strong></div>
        </div>
        <div class="detail-section">
          <h4>Fortschritt</h4>
          <p>${anime.episodesWatched||0} / ${anime.totalEpisodes||"?"} Episoden · ${anime.type||"Anime"}</p>
        </div>
        <div class="detail-section">
          <h4>MAL Info</h4>
          <div class="detail-meta-row" style="margin:0;border:none;padding:0;gap:12px;">
            <div class="detail-meta-item"><i class="fas fa-star"></i> Score: ${anime.malScore?anime.malScore.toFixed(1):"—"}</div>
            ${anime.airing?`<div class="detail-meta-item"><span class="airing-dot" style="display:inline-block;margin-right:4px;"></span><strong style="color:var(--success);">Aktuell am Laufen${anime.nextEpAt?" – "+esc(timeUntil(anime.nextEpAt)):""}</strong></div>`:""}
            <div class="detail-meta-item">${malLink}</div>
          </div>
        </div>
        ${anime.genres&&anime.genres.length?`<div class="detail-section"><h4>Genres</h4><div class="detail-tags">${anime.genres.map(g=>`<span class="detail-tag">${esc(g)}</span>`).join("")}</div></div>`:""}
        ${cats.length?`<div class="detail-section"><h4>Eigene Kategorien</h4><div class="detail-tags">${cats.map(c=>`<span class="detail-tag blue">${esc(c)}</span>`).join("")}</div></div>`:""}
        ${notes?`<div class="detail-section"><h4>Beschreibung</h4><p>${esc(notes)}</p></div>`:""}
      </div>
    </div>`;
  $("detailModal")?.classList.remove("hidden");
}

// ══════════════════ EDIT MODAL ══════════════════
function toggleCompletedDateField(status) {
  const wrap = $("editCompletedDateWrap");
  if (wrap) wrap.style.display = status === "Completed" ? "" : "none";
}

function openEdit(anime) {
  ui.editId = anime.id;
  const img   = $("editImg");   if(img)   img.src = anime.imageUrl||NO_COVER_SVG;
  const name  = $("editName");  if(name)  name.textContent = anime.title;
  const meta  = $("editMeta");  if(meta)  meta.textContent = `${anime.type||"Anime"} · ${anime.totalEpisodes||"?"} Ep.`;
  const stat  = $("editStatus"); if(stat) {
    stat.innerHTML = statusOptions(anime.status);
    stat.onchange = () => toggleCompletedDateField(stat.value);
  }
  const epW   = $("editEpWatched"); if(epW) epW.value = anime.episodesWatched||0;
  const epT   = $("editEpTotal");   if(epT) epT.textContent = anime.totalEpisodes||"?";
  const rat   = $("editRating");  const ratV = $("editRatingVal");
  if (rat) {
    rat.value = anime.rating||0;
    if(ratV) ratV.textContent = (anime.rating||0).toFixed(1);
    rat.oninput = () => { if(ratV) ratV.textContent = parseFloat(rat.value).toFixed(1); };
  }
  const fav = $("editFav"); if(fav) fav.checked = anime.favorite||false;
  const catF = $("editCatField"); if(catF) catF.innerHTML = customCatCheckboxes(anime.customCategories||[]);

  // Completed date field
  const dateInp = $("editCompletedDate");
  if (dateInp) {
    if (anime.completedAt) {
      const d = new Date(anime.completedAt);
      // Format as YYYY-MM-DD for the date input
      dateInp.value = d.toISOString().slice(0,10);
    } else {
      dateInp.value = "";
    }
  }
  toggleCompletedDateField(anime.status);
  $("editModal")?.classList.remove("hidden");
}

function saveEdit() {
  const a = list.find(x=>String(x.id)===String(ui.editId));
  if (!a) return;
  const oldStatus = a.status;
  const stat = $("editStatus"); if(stat) a.status = stat.value;
  const epW  = $("editEpWatched");
  if (epW) a.episodesWatched = Math.min(parseInt(epW.value)||0, a.totalEpisodes||Infinity);
  const rat  = $("editRating"); if(rat) a.rating = parseFloat(rat.value)||0;
  const fav  = $("editFav");    if(fav) a.favorite = fav.checked;
  a.customCategories = [...document.querySelectorAll(".cat-cb:checked")].map(c=>c.value);

  // Handle completedAt
  const dateInp = $("editCompletedDate");
  if (a.status === "Completed") {
    if (dateInp?.value) {
      // Manual date set — keep the chosen day but stamp the current time so multiple
      // anime completed on the same day still sort in the order they were entered.
      const chosen = new Date(dateInp.value);
      const now = new Date();
      chosen.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
      a.completedAt = chosen.getTime();
    } else if (dateInp && !dateInp.value) {
      // Date field shown but cleared with Reset → remove date
      a.completedAt = null;
    } else if (oldStatus !== "Completed") {
      // Auto-set to now when switching to Completed for the first time
      a.completedAt = Date.now();
    }
    // If already Completed and date field not shown → keep existing
  } else {
    if (oldStatus === "Completed") a.completedAt = null;
  }

  save(); updateStats(); renderList();
  $("editModal")?.classList.add("hidden");
  msg("Anime aktualisiert!");
}

// ══════════════════ MAL SEARCH ══════════════════
let _malTimer = null;

// Search uses direct fetch with its own rate-limit handling (not the queue)
// so background tasks (airing, etc.) don't block search results
let _malSearchId = 0;

// Shared search helper used by both the small dropdown search and the big search modal.
// Tries the full query first, then falls back to shorter word-chunks if nothing is found.
// Jikan's /anime?q= already matches against english/japanese/synonym titles, not just
// the romaji title, so searching "Attack on Titan" or "進撃の巨人" both work here.
async function fetchAnimeSearch(q, { limit = 20, onRetryWait } = {}) {
  const queries = [q];
  const words = q.split(/\s+/);
  if (words.length > 4) queries.push(words.slice(0, 5).join(" "));
  if (words.length > 2) queries.push(words.slice(0, 3).join(" "));

  for (const query of queries) {
    let retries = 2;
    while (retries-- > 0) {
      try {
        const res = await fetch(
          `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=${limit}&sfw`
        );
        if (res.status === 429) {
          if (onRetryWait) onRetryWait();
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (!res.ok) break;
        const data = await res.json();
        const results = data.data || [];
        if (results.length) return results;
        break;
      } catch {
        break;
      }
    }
  }
  return [];
}

async function malSearch() {
  const inp  = $("malInput");
  const drop = $("malDropdown");
  const clr  = $("malClear");
  const q    = inp ? inp.value.trim() : "";
  if (!q) { if(drop) { drop.classList.add("hidden"); drop.innerHTML=""; } return; }

  clearTimeout(_malTimer);
  _malTimer = setTimeout(async () => {
    const searchId = ++_malSearchId; // track this specific search run
    if(drop) { drop.classList.remove("hidden"); drop.innerHTML='<div class="notif-loading"><i class="fas fa-spinner fa-spin"></i> Suche…</div>'; }

    let results;
    try {
      results = await fetchAnimeSearch(q, {
        limit: 20,
        onRetryWait: () => { if(drop && searchId===_malSearchId) drop.innerHTML='<div class="notif-loading" style="color:var(--warning);"><i class="fas fa-clock"></i> Kurz warten…</div>'; }
      });
    } catch {
      if(drop && searchId===_malSearchId) drop.innerHTML='<div class="notif-loading" style="color:var(--danger);">Verbindung fehlgeschlagen. Bitte Seite neu laden.</div>';
      return;
    }

    if (searchId !== _malSearchId) return; // stale result

    if (!results.length) {
      if(drop) drop.innerHTML='<div class="notif-loading">Keine Ergebnisse — versuche einen kürzeren Suchbegriff.</div>';
      return;
    }

    if (drop) {
      drop.innerHTML = results.map(a=>`
        <div class="sdrop-item" data-mal-id="${a.mal_id}">
          <img src="${esc(a.images?.jpg?.small_image_url||"")}" alt="" loading="lazy"
               onerror="this.style.display='none'">
          <div>
            <div class="sdrop-title">${esc(a.title)}</div>
            <div class="sdrop-meta">
              <span>${a.type||"Anime"}</span>
              <span>${a.episodes||"?"} Ep.</span>
              <span>⭐ ${a.score?.toFixed(1)||"—"}</span>
              <span>${a.year||"?"}</span>
            </div>
          </div>
        </div>`).join("");

      drop.querySelectorAll(".sdrop-item").forEach(item => {
        item.addEventListener("click", async () => {
          const malId = parseInt(item.dataset.malId);
          drop.innerHTML='<div class="notif-loading"><i class="fas fa-spinner fa-spin"></i> Lade Details…</div>';
          try {
            const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
            const d = await res.json();
            if (d.data) {
              openAddModal(d.data);
              drop.classList.add("hidden");
              if(inp) inp.value="";
              if(clr) clr.classList.add("hidden");
            }
          } catch { msg("Fehler beim Laden der Details.", true); }
        });
      });
    }
  }, 600);
}

// ══════════════════ BIG SEARCH MODAL ══════════════════
let _bigSearchId = 0, _bigSearchTimer = null;

function openBigSearchModal() {
  $("bigSearchModal")?.classList.remove("hidden");
  const bi = $("bigSearchInput");
  if (bi) { bi.value = ""; setTimeout(() => bi.focus(), 50); }
  const res = $("bigSearchResults");
  if (res) res.innerHTML = '<div class="bigsearch-hint"><i class="fas fa-info-circle"></i> Tipp wenn du einen Anime nicht findest: probier mal nur ein einzelnes Schlüsselwort statt des ganzen Titels.</div>';
  $("bigSearchClear")?.classList.add("hidden");
}

function closeBigSearchModal() {
  $("bigSearchModal")?.classList.add("hidden");
}

async function bigSearch() {
  const inp = $("bigSearchInput");
  const res = $("bigSearchResults");
  const q = inp ? inp.value.trim() : "";
  if (!q) {
    if (res) res.innerHTML = '<div class="bigsearch-hint"><i class="fas fa-info-circle"></i> Tipp wenn du einen Anime nicht findest: probier mal nur ein einzelnes Schlüsselwort statt des ganzen Titels.</div>';
    return;
  }

  clearTimeout(_bigSearchTimer);
  _bigSearchTimer = setTimeout(async () => {
    const searchId = ++_bigSearchId;
    if (res) res.innerHTML = '<div class="notif-loading"><i class="fas fa-spinner fa-spin"></i> Suche…</div>';

    let results;
    try {
      results = await fetchAnimeSearch(q, {
        limit: 24,
        onRetryWait: () => { if (res && searchId === _bigSearchId) res.innerHTML = '<div class="notif-loading" style="color:var(--warning);"><i class="fas fa-clock"></i> Kurz warten…</div>'; }
      });
    } catch {
      if (res && searchId === _bigSearchId) res.innerHTML = '<div class="notif-loading" style="color:var(--danger);">Verbindung fehlgeschlagen. Bitte Seite neu laden.</div>';
      return;
    }

    if (searchId !== _bigSearchId) return;

    if (!results.length) {
      if (res) res.innerHTML = '<div class="notif-loading">Keine Ergebnisse — versuche einen kürzeren oder anderen Suchbegriff.</div>';
      return;
    }

    if (!res) return;
    res.innerHTML = `<div class="bigsearch-grid">${results.map(a => {
      const altTitle = (a.title_english && a.title_english !== a.title) ? a.title_english
        : (a.title_synonyms && a.title_synonyms[0]) || "";
      const genres = (a.genres || []).slice(0, 3).map(g => `<span class="bsr-genre-tag">${esc(g.name)}</span>`).join("");
      return `
        <div class="bsr-card" data-mal-id="${a.mal_id}">
          <img src="${esc(a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || "")}" alt="" loading="lazy" onerror="this.style.display='none'">
          <div class="bsr-info">
            <div class="bsr-title">${esc(a.title)}</div>
            ${altTitle ? `<div class="bsr-alt">${esc(altTitle)}</div>` : ""}
            <div class="bsr-genres">${genres}</div>
            <div class="bsr-meta">
              <span>${a.type || "Anime"}</span>
              <span>${a.episodes || "?"} Ep.</span>
              <span>⭐ ${a.score?.toFixed(1) || "—"}</span>
              <span>${a.year || "?"}</span>
            </div>
            <div class="bsr-actions">
              <button class="bsr-add-btn" data-mal-id="${a.mal_id}"><i class="fas fa-plus"></i> Hinzufügen</button>
              <button class="bsr-franchise-btn" data-mal-id="${a.mal_id}" data-title="${esc(a.title_english||a.title)}" title="Alle Staffeln & Filme anzeigen"><i class="fas fa-layer-group"></i> Alle Staffeln</button>
            </div>
          </div>
        </div>`;
    }).join("")}</div>`;

    // Single add
    res.querySelectorAll(".bsr-add-btn").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const malId = parseInt(btn.dataset.malId);
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        btn.disabled = true;
        try {
          const r = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
          const d = await r.json();
          if (d.data) { closeBigSearchModal(); openAddModal(d.data); }
        } catch { msg("Fehler beim Laden der Details.", true); btn.disabled=false; btn.innerHTML='<i class="fas fa-plus"></i> Hinzufügen'; }
      });
    });

    // Franchise (all seasons) modal
    res.querySelectorAll(".bsr-franchise-btn").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const malId = parseInt(btn.dataset.malId);
        const title = btn.dataset.title;
        closeBigSearchModal();
        openFranchiseModal(malId, title);
      });
    });
  }, 500);
}

// ══════════════════ ADD MODAL ══════════════════
function openAddModal(anime) {
  ui.pendingMal = anime;
  const body = $("addBody");
  if (!body) return;
  body.innerHTML = `
    <div class="add-preview">
      <img src="${esc(anime.images?.jpg?.large_image_url||"")}" alt="">
      <div>
        <h3>${esc(preferredTitle(anime))}</h3>
        <div class="add-meta">
          <span><i class="fas fa-tv"></i> ${anime.type||"Anime"}</span>
          <span><i class="fas fa-list"></i> ${anime.episodes||"?"} Ep.</span>
          <span><i class="fas fa-star"></i> ${anime.score?.toFixed(1)||"—"}</span>
          <span><i class="fas fa-calendar"></i> ${anime.year||"?"}</span>
        </div>
        <div class="add-synopsis">${esc((anime.synopsis||"Keine Beschreibung.").substring(0,400))}${(anime.synopsis?.length||0)>400?"...":""}</div>
      </div>
    </div>
    <div class="add-form">
      <div class="form-grid">
        <div class="form-field"><label>Status</label><select id="addStatus" class="filter-select" style="width:100%">${statusOptions("Plan to Watch")}</select></div>
        <div class="form-field" id="addCompletedDateWrap" style="display:none">
          <label><i class="fas fa-calendar-check" style="color:var(--accent);margin-right:4px"></i> Abgeschlossen am</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="date" id="addCompletedDate" class="filter-select" style="flex:1;color-scheme:dark">
            <button type="button" id="addDateClear" class="btn-ghost" title="Datum löschen" style="padding:4px 8px;font-size:.75rem">✕</button>
          </div>
        </div>
      </div>
      <div class="form-field">
        <label>Bereits gesehen</label>
        <div class="ep-row">
          <input type="number" id="addEpWatched" min="0" max="${anime.episodes||9999}" value="0" class="ep-input" style="width:80px">
          <span class="dim">/ ${anime.episodes||"?"} Ep.</span>
        </div>
      </div>
      <div class="form-field"><label>Bewertung: <strong id="addRatVal">0.0</strong></label>
        <input type="range" id="addRat" min="0" max="10" step=".5" value="0" class="filter-range" style="width:100%"></div>
      <label class="cb-wrap"><input type="checkbox" id="addFav"><span class="cb-box"></span><span><i class="fas fa-heart"></i> Favorit</span></label>
      ${folders.length?customCatCheckboxes([]):""}
    </div>`;
  const rat = $("addRat"), ratV = $("addRatVal");
  if (rat && ratV) rat.oninput = () => { ratV.textContent = parseFloat(rat.value).toFixed(1); };

  // Show/hide date field based on status
  const addStat = $("addStatus"), addDateWrap = $("addCompletedDateWrap");
  const toggleAddDate = () => { if(addDateWrap) addDateWrap.style.display = addStat?.value==="Completed" ? "" : "none"; };
  addStat?.addEventListener("change", toggleAddDate);
  $("addDateClear")?.addEventListener("click", () => { const d=$("addCompletedDate"); if(d) d.value=""; });

  $("addModal")?.classList.remove("hidden");
}

function confirmAdd() {
  const pm = ui.pendingMal;
  if (!pm) return;
  const newAnime = {
    id: Date.now() + Math.floor(Math.random()*1000),
    malId: pm.mal_id,
    title: preferredTitle(pm),
    altTitle: altTitleFor(pm),
    status: $("addStatus")?.value||"Plan to Watch",
    episodesWatched: Math.min(parseInt($("addEpWatched")?.value)||0, pm.episodes||999999),
    totalEpisodes: pm.episodes||0,
    rating: parseFloat($("addRat")?.value)||0,
    favorite: $("addFav")?.checked||false,
    notes: pm.synopsis||"",
    genres: (pm.genres||[]).map(g=>g.name),
    studios: (pm.studios||[]).map(s=>s.name).filter(Boolean),
    year: pm.year||0,
    imageUrl: pm.images?.jpg?.large_image_url||"",
    type: pm.type||"",
    malScore: pm.score||0,
    airing: pm.airing||false,
    nextEpAt: null,
    completedAt: (() => {
      if ($("addStatus")?.value !== "Completed") return null;
      const d = $("addCompletedDate")?.value;
      if (!d) return Date.now();
      const chosen = new Date(d);
      const now = new Date();
      chosen.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
      return chosen.getTime();
    })(),
    addedAt: Date.now(),
    customCategories: [...document.querySelectorAll(".cat-cb:checked")].map(c=>c.value)
  };
  list.unshift(newAnime);
  save(); updateStats(); renderList(); renderTabs();
  $("addModal")?.classList.add("hidden");
  msg(`✅ "${pm.title}" wurde hinzugefügt!`);
  // Refresh airing + load relations in background
  refreshAiringOne(newAnime).then(()=>{ save(); renderList(); });
  if (newAnime.malId) fetchAndShowRelations(newAnime);
}

async function fetchAndShowRelations(entry) {
  try {
    const data = await jikan(`/anime/${entry.malId}/relations`);
    const rels = data.data || [];
    const existIds = new Set(list.filter(a=>a.malId).map(a=>a.malId));
    const relevant = [];
    const linked = [];
    for (const rel of rels) {
      if (!RELATION_TYPES.includes(rel.relation)) continue;
      for (const e of (rel.entry||[])) {
        if (e.type !== "anime") continue;
        linked.push({ malId: e.mal_id, relation: rel.relation });
        if (!existIds.has(e.mal_id)) relevant.push({ malId: e.mal_id, name: e.name, relation: rel.relation });
      }
    }
    entry.relatedMalIds = linked;
    entry.relationsAt = Date.now();
    save(); renderList();
    if (relevant.length) showRelationsBanner(entry.title, relevant);
  } catch {}
}

function showRelationsBanner(baseTitle, relations) {
  document.getElementById("relBanner")?.remove();

  const banner = document.createElement("div");
  banner.id = "relBanner";
  banner.className = "rel-banner";

  const relLabels = { "Sequel":"Fortsetzung", "Prequel":"Vorgeschichte",
    "Alternative version":"Alt. Version", "Side story":"Side Story",
    "Parent story":"Hauptstory", "Spin-off":"Spin-off" };

  banner.innerHTML = `
    <div class="rel-banner-head">
      <span><i class="fas fa-layer-group"></i>
        Weitere Anime zur Serie <strong>${esc(baseTitle.length>35?baseTitle.substring(0,35)+"…":baseTitle)}</strong> — noch nicht in deiner Liste:
      </span>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn-ghost" style="font-size:.78rem;padding:4px 12px" id="relBannerBulkBtn"><i class="fas fa-layer-group"></i> Alle auf einmal</button>
        <span class="rel-banner-close" onclick="document.getElementById('relBanner')?.remove()">
          <i class="fas fa-times"></i>
        </span>
      </div>
    </div>
    <div class="rel-banner-items">
      ${relations.slice(0,8).map(r=>`
        <button class="rel-banner-item" data-mal-id="${r.malId}">
          <span class="rel-badge">${esc(relLabels[r.relation]||r.relation)}</span>
          <span class="rel-name">${esc(r.name)}</span>
          <span class="rel-plus"><i class="fas fa-plus"></i></span>
        </button>`).join("")}
    </div>`;

  banner.querySelectorAll(".rel-banner-item").forEach(btn => {
    btn.addEventListener("click", async () => {
      const mid = parseInt(btn.dataset.malId);
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Laden…';
      btn.disabled = true;
      try {
        const d = await jikan(`/anime/${mid}`);
        if (d.data) { openAddModal(d.data); banner.remove(); }
      } catch { btn.textContent = "Fehler"; }
    });
  });

  document.getElementById("relBannerBulkBtn")?.addEventListener("click", () => {
    banner.remove();
    // Find the base entry malId from the relations list to pass to franchise modal
    // We need to search back for the anime we just added to get its malId
    const lastAdded = list[0];
    if (lastAdded?.malId) openFranchiseModal(lastAdded.malId, baseTitle);
  });

  // Insert right above the anime grid
  const grid = $("animeGrid");
  if (grid) grid.parentNode.insertBefore(banner, grid);
  setTimeout(() => banner.remove(), 45000);
}

// ══════════════════ FRANCHISE / ALL SEASONS MODAL ══════════════════
const RELATION_ORDER = ["Prequel","Parent story","Full story","Sequel","Side story","Spin-off","Alternative version","Summary","Other"];
const RELATION_LABELS = { "Sequel":"Fortsetzung","Prequel":"Vorgeschichte","Side story":"Side Story",
  "Spin-off":"Spin-off","Alternative version":"Alt. Version","Parent story":"Hauptstory",
  "Full story":"Vollversion","Summary":"Zusammenfassung","Other":"Sonstiges" };
const TYPE_BADGES = { "TV":"TV","Movie":"Movie","OVA":"OVA","ONA":"ONA","Special":"Special","Music":"Music" };

let _franchiseEntries = []; // [{malId, title, relation, type, episodes, score, imageUrl, year, checked}]

async function openFranchiseModal(baseMalId, baseTitle) {
  _franchiseEntries = [];
  const modal = $("franchiseModal"), body = $("franchiseBody"), titleEl = $("franchiseModalTitle");
  const confirmBtn = $("franchiseConfirm");
  if (!modal || !body) return;

  if (titleEl) titleEl.textContent = baseTitle.length > 40 ? baseTitle.slice(0,40)+"…" : baseTitle;
  body.innerHTML = '<div class="notif-loading"><i class="fas fa-spinner fa-spin"></i> Lade Serieninformationen…</div>';
  modal.classList.remove("hidden");
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const existingMalIds = new Set(list.map(a=>a.malId).filter(Boolean));
    const rd = await jikan(`/anime/${baseMalId}/relations`);
    const rels = rd.data || [];
    const relMap = {};
    for (const rel of rels) {
      for (const e of (rel.entry||[])) {
        if (e.type !== "anime") continue;
        if (!relMap[e.mal_id]) relMap[e.mal_id] = { malId:e.mal_id, name:e.name, relation:rel.relation };
      }
    }

    // Sort by relation type importance
    const sorted = Object.values(relMap).sort((a,b) => {
      const ia = RELATION_ORDER.indexOf(a.relation), ib = RELATION_ORDER.indexOf(b.relation);
      return (ia===-1?99:ia) - (ib===-1?99:ib);
    });

    // Fetch details for each entry (capped at 12 to avoid rate limits)
    const details = [];
    for (const rel of sorted.slice(0,12)) {
      try {
        await new Promise(r=>setTimeout(r,350));
        const d = await jikan(`/anime/${rel.malId}`);
        if (d.data) details.push({ ...rel, data: d.data });
      } catch {}
    }

    _franchiseEntries = details.map(e => ({
      malId: e.malId,
      title: preferredTitle(e.data),
      altTitle: altTitleFor(e.data),
      relation: e.relation,
      type: e.data.type||"TV",
      episodes: e.data.episodes||0,
      score: e.data.score||0,
      year: e.data.year||0,
      imageUrl: e.data.images?.jpg?.large_image_url||"",
      synopsis: e.data.synopsis||"",
      alreadyInList: existingMalIds.has(e.malId),
      checked: !existingMalIds.has(e.malId), // pre-check things not yet in list
      defaultStatus: "Plan to Watch"
    }));

    renderFranchiseBody();
  } catch (err) {
    body.innerHTML = `<div class="notif-loading" style="color:var(--danger)">Fehler beim Laden. Bitte erneut versuchen.</div>`;
  }
}

function renderFranchiseBody() {
  const body = $("franchiseBody"), confirmBtn = $("franchiseConfirm");
  if (!body) return;

  if (!_franchiseEntries.length) {
    body.innerHTML = '<div class="sp-reco-empty">Keine weiteren Einträge zur Serie gefunden.</div>';
    return;
  }

  body.innerHTML = `
    <div class="franchise-grid">
      ${_franchiseEntries.map((e,i) => `
        <div class="franchise-item ${e.alreadyInList?"franchise-item--owned":""}" data-idx="${i}">
          <label class="franchise-check-wrap">
            <input type="checkbox" class="franchise-cb" data-idx="${i}" ${e.checked&&!e.alreadyInList?"checked":""} ${e.alreadyInList?"disabled":""}>
            <span class="cb-box"></span>
          </label>
          <img src="${esc(e.imageUrl||NO_COVER_SVG)}" alt="" onerror="noCover(this)" loading="lazy">
          <div class="franchise-info">
            <div class="franchise-badges">
              <span class="franchise-relation-badge">${esc(RELATION_LABELS[e.relation]||e.relation)}</span>
              ${TYPE_BADGES[e.type]?`<span class="franchise-type-badge franchise-type-${e.type.toLowerCase()}">${e.type}</span>`:""}
              ${e.alreadyInList?`<span class="franchise-owned-badge"><i class="fas fa-check"></i> In Liste</span>`:""}
            </div>
            <div class="franchise-title">${esc(e.title)}</div>
            ${e.altTitle?`<div class="franchise-alt">${esc(e.altTitle)}</div>`:""}
            <div class="franchise-meta">
              ${e.episodes?`<span>${e.episodes} Ep.</span>`:""}
              ${e.score?`<span>⭐ ${e.score.toFixed(1)}</span>`:""}
              ${e.year?`<span>${e.year}</span>`:""}
            </div>
            ${!e.alreadyInList?`
            <select class="franchise-status filter-select" data-idx="${i}" style="margin-top:6px;width:100%;font-size:.75rem">
              <option value="Plan to Watch"${e.defaultStatus==="Plan to Watch"?" selected":""}>Geplant</option>
              <option value="Currently Watching"${e.defaultStatus==="Currently Watching"?" selected":""}>Watching</option>
              <option value="Completed"${e.defaultStatus==="Completed"?" selected":""}>Abgeschlossen</option>
              <option value="On Hold"${e.defaultStatus==="On Hold"?" selected":""}>Pausiert</option>
              <option value="Dropped"${e.defaultStatus==="Dropped"?" selected":""}>Abgebrochen</option>
            </select>`:"<div style='font-size:.72rem;color:var(--dim);margin-top:6px'>Bereits vorhanden</div>"}
          </div>
        </div>`).join("")}
    </div>`;

  // Wire checkboxes
  body.querySelectorAll(".franchise-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const idx = parseInt(cb.dataset.idx);
      _franchiseEntries[idx].checked = cb.checked;
      updateFranchiseConfirmBtn();
    });
  });

  // Wire status dropdowns
  body.querySelectorAll(".franchise-status").forEach(sel => {
    sel.addEventListener("change", () => {
      const idx = parseInt(sel.dataset.idx);
      _franchiseEntries[idx].defaultStatus = sel.value;
    });
  });

  updateFranchiseConfirmBtn();
}

function updateFranchiseConfirmBtn() {
  const btn = $("franchiseConfirm");
  const count = _franchiseEntries.filter(e=>e.checked&&!e.alreadyInList).length;
  if (btn) {
    btn.disabled = count === 0;
    btn.innerHTML = count > 0
      ? `<i class="fas fa-plus"></i> ${count} Anime hinzufügen`
      : `<i class="fas fa-plus"></i> Ausgewählte hinzufügen`;
  }
}

async function confirmFranchiseAdd() {
  const toAdd = _franchiseEntries.filter(e=>e.checked&&!e.alreadyInList);
  if (!toAdd.length) return;

  const btn = $("franchiseConfirm"); if(btn) { btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Füge hinzu…'; }

  let added = 0;
  for (const e of toAdd) {
    try {
      await new Promise(r=>setTimeout(r,300));
      const d = await jikan(`/anime/${e.malId}`);
      if (d.data) {
        const pm = d.data;
        list.unshift({
          id: Date.now()+Math.floor(Math.random()*1000)+added,
          malId: pm.mal_id,
          title: preferredTitle(pm),
          altTitle: altTitleFor(pm),
          status: e.defaultStatus,
          episodesWatched: e.defaultStatus==="Completed"?(pm.episodes||0):0,
          totalEpisodes: pm.episodes||0,
          rating: 0,
          favorite: false,
          notes: "",
          genres: (pm.genres||[]).map(g=>g.name),
          studios: (pm.studios||[]).map(s=>s.name).filter(Boolean),
          year: pm.year||0,
          imageUrl: pm.images?.jpg?.large_image_url||"",
          type: pm.type||"",
          malScore: pm.score||0,
          airing: pm.airing||false,
          nextEpAt: null,
          completedAt: e.defaultStatus==="Completed"?Date.now():null,
          addedAt: Date.now()+added,
          customCategories: [],
          relationsAt: null, relatedMalIds: []
        });
        added++;
      }
    } catch {}
  }

  save(); updateStats(); renderList(); renderTabs(); invalidateFranchMap();
  $("franchiseModal")?.classList.add("hidden");
  msg(`${added} Anime hinzugefügt!`);
}

function invalidateFranchMap() {
  _franchMap = null;
  _normCache.clear();
}
function initGenres() {
  const panel = $("genrePanel");
  if (!panel) return;
  panel.innerHTML = GENRES.map(g=>`<span class="genre-chip${ui.genres.includes(g)?" on":""}" data-g="${esc(g)}">${esc(g)}</span>`).join("");
  panel.querySelectorAll(".genre-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      chip.classList.toggle("on");
      ui.genres = [...panel.querySelectorAll(".genre-chip.on")].map(c=>c.dataset.g);
      const txt = $("genreBtnText");
      if (txt) txt.textContent = ui.genres.length ? ui.genres.slice(0,2).join(", ")+(ui.genres.length>2?"…":"") : "Genres";
      ui.page = 1; renderList();
    });
  });
}

// ══════════════════ NOTIFICATIONS ══════════════════
function buildEpNotifs() {
  const now = Date.now();
  const notifs = [];
  list.forEach(a => {
    if (!a.airing||!a.malId) return;
    const c = airingCache[a.malId];
    if (!c) return;
    if (c.nextEpAt && c.nextEpAt < now && (now-c.nextEpAt)<7*86400000) {
      notifs.push({ id:`ep_${a.malId}_${c.nextEpAt}`, type:"aired", title:a.title, text:"Neue Episode verfügbar!", sub:"Bereits ausgestrahlt", img:a.imageUrl, malId:a.malId, animeId:a.id, ts:c.nextEpAt });
    } else if (c.nextEpAt && c.nextEpAt > now && (c.nextEpAt-now)<24*3600000) {
      notifs.push({ id:`soon_${a.malId}_${c.nextEpAt}`, type:"soon", title:a.title, text:"Neue Episode bald!", sub:timeUntil(c.nextEpAt)||"", img:a.imageUrl, malId:a.malId, animeId:a.id, ts:c.nextEpAt });
    }
  });
  return notifs.sort((a,b)=>b.ts-a.ts);
}

function updateNotifBadge() {
  const badge = $("notifBadge");
  if (!badge) return;
  const unread = buildEpNotifs().filter(n=>!readNotifs.has(n.id)).length;
  if (unread > 0) { badge.textContent = unread>9?"9+":unread; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");
}

function renderNotifEpisodes() {
  const body = $("notifBody");
  if (!body) return;
  const notifs = buildEpNotifs();
  if (!notifs.length) {
    body.innerHTML='<div class="notif-empty"><i class="fas fa-check-circle"></i><p>Alles aktuell!</p><span>Keine neuen Episoden in 7 Tagen.</span></div>';
    return;
  }
  body.innerHTML = notifs.map(n=>`
    <div class="notif-item${readNotifs.has(n.id)?" read":""}" data-nid="${esc(n.id)}" data-anime-id="${esc(n.animeId)}">
      <div class="notif-thumb">${n.img?`<img src="${esc(n.img)}" alt="">`:'<i class="fas fa-tv"></i>'}
        <span class="notif-dot ${n.type==="aired"?"green":"yellow"}"></span>
      </div>
      <div class="notif-info">
        <div class="notif-name">${esc(n.title)}</div>
        <div class="notif-text ${n.type==="aired"?"green":"yellow"}">${n.text}</div>
        <div class="notif-sub">${esc(n.sub)}</div>
      </div>
    </div>`).join("");
  body.querySelectorAll(".notif-item").forEach(el => {
    el.addEventListener("click", () => {
      readNotifs.add(el.dataset.nid); saveReadNotifs(); updateNotifBadge();
      // Navigate to anime
      const animeId = el.dataset.animeId;
      const anime = list.find(x=>String(x.id)===String(animeId));
      if (anime) {
        $("notifPanel")?.classList.add("hidden");
        ui.tab="All"; ui.franchise=""; ui.search=""; ui.page=1;
        renderTabs(); renderList();
        setTimeout(() => {
          const card = document.querySelector(`.anime-card[data-id="${animeId}"]`);
          if (card) {
            card.scrollIntoView({behavior:"smooth",block:"center"});
            card.style.boxShadow="0 0 0 3px var(--accent),0 0 30px rgba(255,79,216,.5)";
            setTimeout(()=>card.style.boxShadow="",2500);
          }
          openDetail(anime);
        }, 300);
      }
      renderNotifEpisodes();
    });
  });
}

async function renderNotifNews() {
  const body = $("notifBody");
  if (!body) return;
  body.innerHTML='<div class="notif-loading"><i class="fas fa-spinner fa-spin"></i> News laden…</div>';
  if (!cachedNews) {
    try {
      const stored = JSON.parse(localStorage.getItem(NWK)||"null");
      if (stored?.data && (Date.now()-stored.at)<NEWS_TTL) { cachedNews=stored.data; cachedNewsAt=stored.at; }
    } catch {}
  }
  if (!cachedNews || (Date.now()-cachedNewsAt)>NEWS_TTL) {
    // Try news endpoint first, fall back to current season
    const endpoints = [
      { path: "/news/anime?limit=20", isNews: true },
      { path: "/seasons/now?limit=20", isNews: false }
    ];
    for (const ep of endpoints) {
      try {
        const d = await jikan(ep.path);
        const items = d.data||[];
        if (!items.length) continue;
        cachedNews = items.slice(0,20).map((n,i)=>({
          id: "news_"+(n.mal_id||n.forum_url||i),
          title: n.title||"",
          text: (ep.isNews ? (n.excerpt||"") : (n.synopsis||"Läuft aktuell in dieser Season.")).substring(0,120),
          img: ep.isNews
            ? (n.images?.jpg?.image_url||null)
            : (n.images?.jpg?.small_image_url||n.images?.jpg?.image_url||null),
          url: n.url||(n.mal_id?("https://myanimelist.net/anime/"+n.mal_id):"#"),
          ts: ep.isNews ? new Date(n.date||Date.now()).getTime() : Date.now()
        }));
        cachedNewsAt = Date.now();
        try { localStorage.setItem(NWK, JSON.stringify({data:cachedNews,at:cachedNewsAt})); } catch {}
        break;
      } catch { continue; }
    }
  }
  if (!cachedNews?.length) {
    body.innerHTML=`<div class="notif-empty"><i class="fas fa-newspaper"></i><p>Keine News</p><span>API nicht erreichbar.</span><button class="notif-retry-btn" onclick="window._retryNews()">Erneut versuchen</button></div>`;
    window._retryNews = ()=>{ cachedNews=null; renderNotifNews(); };
    return;
  }
  body.innerHTML = cachedNews.map(n=>`
    <a class="notif-item${readNotifs.has(n.id)?" read":""}" href="${esc(n.url)}" target="_blank" rel="noopener" data-nid="${esc(n.id)}">
      <div class="notif-thumb news-thumb">${n.img?`<img src="${esc(n.img)}" alt="">`:'<i class="fas fa-newspaper"></i>'}</div>
      <div class="notif-info">
        <div class="notif-name">${esc(n.title)}</div>
        <div class="notif-text">${esc(n.text)}</div>
        <div class="notif-sub">${n.ts?new Date(n.ts).toLocaleDateString("de-DE"):""}</div>
      </div>
    </a>`).join("");
  body.querySelectorAll(".notif-item").forEach(el=>{
    el.addEventListener("click",()=>{ readNotifs.add(el.dataset.nid); saveReadNotifs(); updateNotifBadge(); });
  });
}

// ══════════════════ EXTERNAL IMPORT ══════════════════
function parseExtFile(text, filename) {
  const ext = filename.split(".").pop().toLowerCase();
  if (ext==="xml"||text.trim().startsWith("<")) return parseXML(text);
  if (ext==="json"||text.trim().startsWith("{")) return parseJSON(text);
  return parseTXT(text);
}

function parseXML(xml) {
  const doc = new DOMParser().parseFromString(xml,"text/xml");
  const out = [];
  doc.querySelectorAll("anime").forEach(n=>{
    const malId = parseInt(n.querySelector("series_animedb_id")?.textContent||"0");
    const title = n.querySelector("series_title")?.textContent?.trim()||"";
    const ep    = parseInt(n.querySelector("my_watched_episodes")?.textContent||"0");
    const stat  = n.querySelector("my_status")?.textContent?.trim()||"Plan to Watch";
    if (title) out.push({title,malId,status:EXT_STATUS[stat]||"Plan to Watch",episodesWatched:ep});
  });
  return out;
}

function parseJSON(text) {
  const data = JSON.parse(text);
  const out = [];
  Object.entries(data).forEach(([key,items])=>{
    const status = EXT_STATUS[key]||"Plan to Watch";
    (items||[]).forEach(item=>{
      const title = item.name||item.title||"";
      if (!title) return;
      const malUrl = item.mal||"";
      const malId  = malUrl?parseInt(malUrl.split("/anime/")[1])||0:0;
      out.push({title,malId,status,episodesWatched:item.episodesWatched||0});
    });
  });
  return out;
}

function parseTXT(text) {
  const out = [];
  let curStatus="Plan to Watch", curTitle=null, curMalUrl=null;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) { if(curTitle&&curMalUrl){const malId=parseInt(curMalUrl.split("/anime/")[1])||0;out.push({title:curTitle,malId,status:curStatus,episodesWatched:0});}curTitle=null;curMalUrl=null;continue; }
    if (t.startsWith("###")) { curStatus=EXT_STATUS[t.replace(/^#+\s*/,"").trim()]||"Plan to Watch";curTitle=null;curMalUrl=null; }
    else if (t.startsWith("#")) { if(curTitle&&curMalUrl){const malId=parseInt(curMalUrl.split("/anime/")[1])||0;out.push({title:curTitle,malId,status:curStatus,episodesWatched:0});}curTitle=t.replace(/^#+\s*/,"").trim();curMalUrl=null; }
    else if (t.includes("myanimelist.net/anime/")) curMalUrl=t;
  }
  if(curTitle&&curMalUrl){const malId=parseInt(curMalUrl.split("/anime/")[1])||0;out.push({title:curTitle,malId,status:curStatus,episodesWatched:0});}
  return out;
}

function showExtPreview(entries) {
  ui.extParsed = entries;
  ui.extDone = false;
  const body = $("extBody"), startBtn = $("extStart"), cancelBtn = $("extCancel");
  if (!body) return;
  const existIds = new Set(list.filter(a=>a.malId).map(a=>a.malId));
  const dupes = entries.filter(e=>e.malId&&existIds.has(e.malId)).length;
  const newCount = entries.length - dupes;
  const byStatus = {};
  entries.forEach(e=>{(byStatus[e.status]=byStatus[e.status]||[]).push(e);});
  body.innerHTML = `
    <div class="ext-stats">
      <div class="ext-stat"><div class="stat-icon"><i class="fas fa-film"></i></div><div><div class="ext-stat-val">${entries.length}</div><div class="ext-stat-lbl">Gefunden</div></div></div>
      <div class="ext-stat"><div class="stat-icon" style="color:var(--success)"><i class="fas fa-plus-circle"></i></div><div><div class="ext-stat-val" style="color:var(--success)">${newCount}</div><div class="ext-stat-lbl">Neu</div></div></div>
      <div class="ext-stat"><div class="stat-icon" style="color:var(--warning)"><i class="fas fa-copy"></i></div><div><div class="ext-stat-val" style="color:var(--warning)">${dupes}</div><div class="ext-stat-lbl">Vorhanden</div></div></div>
    </div>
    <div class="ext-info"><i class="fas fa-info-circle" style="color:var(--accent2);margin-right:6px;"></i>
      Cover &amp; Details werden von MAL geladen. Bereits vorhandene Anime werden übersprungen. Bei 851 Anime ca. 5-6 Minuten.
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
      ${Object.entries(byStatus).map(([s,items])=>`<span class="detail-tag">${esc(TO_LABEL[s]||s)}: ${items.length}</span>`).join("")}
    </div>
    <div class="ext-progress hidden" id="extProgressWrap">
      <div class="ext-prog-row"><span id="extProgText">Starte…</span><span id="extProgCount">0 / ${entries.length}</span></div>
      <div class="ext-prog-bar"><div class="ext-prog-fill" id="extProgFill" style="width:0%"></div></div>
      <div class="ext-log" id="extLog"></div>
    </div>`;
  if (startBtn) { startBtn.disabled = newCount===0; startBtn.innerHTML = '<i class="fas fa-rocket"></i> Import starten'; }
  if (cancelBtn) cancelBtn.textContent = "Abbrechen";
}

async function runExtImport() {
  const startBtn = $("extStart"), cancelBtn = $("extCancel");
  if (startBtn) { startBtn.disabled=true; startBtn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Importiere…'; }
  ui.extCancelled = false;
  const pw = $("extProgressWrap"); if(pw) pw.classList.remove("hidden");

  const existIds = new Set(list.filter(a=>a.malId).map(a=>a.malId));
  const toImport = ui.extParsed.filter(e=>!(e.malId&&existIds.has(e.malId)));
  const total = toImport.length;
  let done = 0;

  const log = s => { const el=$("extLog"); if(el){el.innerHTML+=`<div>${s}</div>`;el.scrollTop=el.scrollHeight;} };

  for (const entry of toImport) {
    if (ui.extCancelled) { log("⛔ Abgebrochen."); break; }
    const pt=$("extProgText"), pc=$("extProgCount"), pf=$("extProgFill");
    if(pt) pt.textContent=`Lade: ${entry.title.substring(0,40)}…`;
    if(pc) pc.textContent=`${done} / ${total}`;
    if(pf) pf.style.width=`${(done/total*100).toFixed(0)}%`;
    let ad = null;
    if (entry.malId) {
      try {
        await new Promise(r=>setTimeout(r,350));
        const d = await jikan(`/anime/${entry.malId}`);
        ad = d.data;
      } catch {}
    }
    list.push({
      id: Date.now()+Math.floor(Math.random()*1000),
      malId: entry.malId||(ad?.mal_id)||0,
      title: ad?preferredTitle(ad):entry.title,
      altTitle: ad?altTitleFor(ad):"",
      status: entry.status,
      episodesWatched: entry.episodesWatched||0,
      totalEpisodes: ad?.episodes||0,
      rating:0, favorite:false,
      notes: ad?.synopsis||"",
      genres: (ad?.genres||[]).map(g=>g.name),
      imageUrl: ad?.images?.jpg?.large_image_url||"",
      type: ad?.type||"", malScore: ad?.score||0,
      airing: ad?.airing||false, nextEpAt:null,
      addedAt: Date.now(), customCategories:[]
    });
    done++;
    log(`✅ ${esc(ad?.title||entry.title)}`);
  }
  save(); updateStats(); renderList(); renderTabs();
  const pt=$("extProgText"),pc=$("extProgCount"),pf=$("extProgFill");
  if(pt) pt.textContent=ui.extCancelled?"Abgebrochen":"✅ Fertig!";
  if(pc) pc.textContent=`${done} / ${total}`;
  if(pf) pf.style.width="100%";
  if(startBtn) startBtn.innerHTML='<i class="fas fa-check"></i> Fertig';
  if(cancelBtn) cancelBtn.textContent="Schließen";
  if(startBtn) startBtn.disabled = false;
  ui.extDone = true;
  msg(`${done} Anime importiert!`);
}

// ══════════════════ REPAIR EXISTING ENTRIES ══════════════════
// Backfills missing data (cover, episode count, score, alt title, genres) for entries
// that were added/imported before a fix, or where the source API returned incomplete
// data at the time. Only re-fetches entries that look incomplete — doesn't touch
// personal fields (status, progress, rating, favorite, notes, categories).
function needsRepair(a) {
  if (!a.malId) return false;
  if (a.repairedAt) return false;
  return !a.altTitle || !a.imageUrl || !a.totalEpisodes || !a.studios;
}

// Relation links (spin-offs, side stories, etc.) used for grouping entries whose
// titles don't share enough words to be matched by normTitle (e.g. "The Slime Diaries"
// vs "That Time I Got Reincarnated as a Slime"). Fetched + cached once per entry.
const RELATION_TYPES = ["Side story", "Spin-off", "Alternative version", "Parent story", "Sequel", "Prequel", "Full story", "Summary"];
function needsRelations(a) {
  if (!a.malId) return false;
  if (!a.relationsAt) return true; // never fetched
  // Re-fetch if relations were fetched but came back empty AND the anime has genres
  // that suggest it belongs to a franchise (e.g. might have been a 504 error)
  if (a.relationsAt && (!a.relatedMalIds || a.relatedMalIds.length === 0)) {
    // Only re-fetch if explicitly requested via force mode
    return ui.repairForceRelations || false;
  }
  return false;
}
function needsAnyRepair(a) {
  return needsRepair(a) || needsRelations(a);
}

function openRepairModal() {
  ui.repairDone = false;
  ui.repairCancelled = false;
  ui.repairForceRelations = false;
  const toRepair = list.filter(needsAnyRepair);
  const groupedMalIds = new Set();
  const normMap = {};
  list.forEach(a => {
    const k = normTitle(a.title);
    if (!normMap[k]) normMap[k] = [];
    normMap[k].push(a);
  });
  Object.values(normMap).forEach(grp => {
    if (grp.length >= 2) grp.forEach(a => { if (a.malId) groupedMalIds.add(a.malId); });
  });
  const withEmptyRels = list.filter(a =>
    a.malId && a.relationsAt && (!a.relatedMalIds||a.relatedMalIds.length===0) && groupedMalIds.has(a.malId) && !a.relationsVerified
  ).length;
  const body = $("repairBody"), startBtn = $("repairStart"), cancelBtn = $("repairCancel");
  if (!body) return;
  ui.repairList = toRepair;
  body.innerHTML = `
    <div class="ext-stats">
      <div class="ext-stat"><div class="stat-icon"><i class="fas fa-list"></i></div><div><div class="ext-stat-val">${list.length}</div><div class="ext-stat-lbl">Gesamt</div></div></div>
      <div class="ext-stat"><div class="stat-icon" style="color:var(--warning)"><i class="fas fa-triangle-exclamation"></i></div><div><div class="ext-stat-val" style="color:var(--warning)">${toRepair.length}</div><div class="ext-stat-lbl">Zu bearbeiten</div></div></div>
    </div>
    <div class="ext-info"><i class="fas fa-info-circle" style="color:var(--accent2);margin-right:6px;"></i>
      Lädt fehlendes Cover, Episodenzahl, Score, Genres &amp; den Alternativtitel nach, und lädt zusätzlich die Verknüpfungen (Spin-offs, Side Storys, Sequels) für die Gruppierung. Deine Bewertungen, Notizen und Fortschritt bleiben unangetastet. Bei ${toRepair.length} Einträgen ca. ${Math.ceil(toRepair.length*0.6/60)} Minuten — der Tab muss währenddessen offen bleiben, der Fortschritt wird laufend zwischengespeichert.
    </div>
    ${withEmptyRels > 0 ? `
    <div class="ext-info" style="border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.07);margin-top:8px">
      <i class="fas fa-link" style="color:#f59e0b;margin-right:6px;flex-shrink:0"></i>
      <div><strong style="color:#f59e0b">${withEmptyRels} Anime</strong> haben leere Beziehungsdaten (z.B. durch frühere 504-Fehler). 
      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-top:4px">
        <input type="checkbox" id="forceRelationsCheck"> Beziehungsdaten neu abrufen (für korrekte Sortierung in Gruppen)
      </label></div>
    </div>` : ""}
    <div class="ext-progress hidden" id="repairProgressWrap">
      <div class="ext-prog-row"><span id="repairProgText">Starte…</span><span id="repairProgCount">0 / ${toRepair.length}</span></div>
      <div class="ext-prog-bar"><div class="ext-prog-fill" id="repairProgFill" style="width:0%"></div></div>
      <div class="ext-log" id="repairLog"></div>
    </div>`;
  if (startBtn) { startBtn.disabled = toRepair.length === 0 && withEmptyRels === 0; startBtn.innerHTML = '<i class="fas fa-rocket"></i> Reparatur starten'; }
  if (cancelBtn) cancelBtn.textContent = "Abbrechen";

  $("forceRelationsCheck")?.addEventListener("change", e => {
    ui.repairForceRelations = e.target.checked;
    if (e.target.checked) {
      // Only re-fetch relations for anime that are already in a group (29, not all 487)
      const inGroupWithEmpty = list.filter(a =>
        a.malId && a.relationsAt && (!a.relatedMalIds||a.relatedMalIds.length===0) && groupedMalIds.has(a.malId) && !a.relationsVerified
      );
      ui.repairList = [...list.filter(needsRepair), ...inGroupWithEmpty.filter(a=>!needsRepair(a))];
    } else {
      ui.repairList = list.filter(needsAnyRepair);
    }
    if (startBtn) startBtn.disabled = ui.repairList.length === 0;
    const pw = $("repairProgressWrap"); if(pw) pw.classList.add("hidden");
    const pt = $("repairProgText"); if(pt) pt.textContent = "Starte…";
    const pc = $("repairProgCount"); if(pc) pc.textContent = `0 / ${ui.repairList.length}`;
    const pf = $("repairProgFill"); if(pf) pf.style.width = "0%";
  });

  $("repairModal")?.classList.remove("hidden");
}

async function runRepair() {
  const startBtn = $("repairStart"), cancelBtn = $("repairCancel");
  const toRepair = ui.repairList || [];
  if (startBtn) { startBtn.disabled = true; startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Repariere…'; }
  ui.repairCancelled = false;
  const pw = $("repairProgressWrap"); if (pw) pw.classList.remove("hidden");

  const total = toRepair.length;
  let done = 0, fixed = 0, failed = 0;
  const log = s => { const el = $("repairLog"); if (el) { el.innerHTML += `<div>${s}</div>`; el.scrollTop = el.scrollHeight; } };

  for (const entry of toRepair) {
    if (ui.repairCancelled) { log("⛔ Abgebrochen."); break; }
    const pt = $("repairProgText"), pc = $("repairProgCount"), pf = $("repairProgFill");
    if (pt) pt.textContent = `Lade: ${(entry.title || "?").substring(0, 40)}…`;
    if (pc) pc.textContent = `${done} / ${total}`;
    if (pf) pf.style.width = `${(done / total * 100).toFixed(0)}%`;

    try {
      const live = list.find(a => a.id === entry.id);
      if (!live) { done++; continue; }

      const baseDelay = ui.repairForceRelations ? 800 : 350;

      if (needsRepair(live)) {
        await new Promise(r => setTimeout(r, baseDelay));
        const d = await jikan(`/anime/${live.malId}`);
        const ad = d.data;
        if (ad) {
          if (!live.title || live.title === ad.title) live.title = preferredTitle(ad); // keep a manual rename if user made one
          live.altTitle = altTitleFor(ad);
          if (!live.imageUrl) live.imageUrl = ad.images?.jpg?.large_image_url || "";
          if (!live.totalEpisodes) live.totalEpisodes = ad.episodes || 0;
          if (!live.malScore) live.malScore = ad.score || 0;
          if (!live.genres?.length) live.genres = (ad.genres || []).map(g => g.name);
          if (!live.type) live.type = ad.type || "";
          if (!live.studios?.length) live.studios = (ad.studios || []).map(s => s.name).filter(Boolean);
          if (!live.year) live.year = ad.year || 0;
          live.repairedAt = Date.now();
          fixed++;
          log(`✅ ${esc(preferredTitle(ad))}`);
        } else {
          failed++; log(`⚠️ Keine Daten: ${esc(live.title || "?")}`);
        }
      }

      if (needsRelations(live)) {
        // In force mode, clear relationsAt first so the fetch actually runs
        if (ui.repairForceRelations) live.relationsAt = null;
        await new Promise(r => setTimeout(r, 1000)); // longer delay to avoid rate limits
        try {
          const rd = await jikan(`/anime/${live.malId}/relations`);
          const rels = rd.data || [];
          const linked = [];
          for (const rel of rels) {
            if (!RELATION_TYPES.includes(rel.relation)) continue;
            for (const e of (rel.entry || [])) {
              if (e.type !== "anime") continue;
              linked.push({ malId: e.mal_id, relation: rel.relation });
            }
          }
          live.relatedMalIds = linked;
          live.relationsAt = Date.now();
          if (ui.repairForceRelations) live.relationsVerified = true; // mark as verified even if empty
        } catch {
          // Don't set relationsAt on failure → will retry next time
          log(`⚠️ Beziehungen fehlgeschlagen: ${esc(live.title||"?")}`);
        }
      }
    } catch {
      failed++; log(`❌ Fehler: ${esc(entry.title || "?")}`);
    }

    done++;
    if (done % 20 === 0) save(); // checkpoint periodically in case the tab gets closed
  }

  save(); updateStats(); renderList(); renderTabs();
  const pt = $("repairProgText"), pc = $("repairProgCount"), pf = $("repairProgFill");
  if (pt) pt.textContent = ui.repairCancelled ? "Abgebrochen" : "✅ Fertig!";
  if (pc) pc.textContent = `${done} / ${total}`;
  if (pf) pf.style.width = "100%";
  if (startBtn) startBtn.innerHTML = '<i class="fas fa-check"></i> Fertig';
  if (cancelBtn) cancelBtn.textContent = "Schließen";
  if (startBtn) startBtn.disabled = false;
  ui.repairDone = true;
  msg(`${fixed} repariert, ${failed} fehlgeschlagen.`);
}

// ══════════════════ STATS PAGE ══════════════════
const CHART_COLORS = [
  "#ff4fd8","#a855f7","#06b6d4","#10b981","#f59e0b",
  "#ef4444","#8b5cf6","#ec4899","#14b8a6","#f97316",
  "#6366f1","#84cc16","#0ea5e9","#e879f9","#22d3ee"
];
let _charts = {};

function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

function buildStatsData() {
  const completed = list.filter(a => a.status === "Completed");
  const rated = list.filter(a => a.rating > 0);
  const totalEp = list.reduce((s,a) => s+(a.episodesWatched||0), 0);
  const hours = Math.round(totalEp * 24 / 60); // ~24 min avg episode length

  // Genre counts (weighted: completed+rated anime count more)
  const genreCount = {};
  list.forEach(a => {
    const w = (a.status==="Completed" ? 2 : 1);
    (a.genres||[]).forEach(g => genreCount[g] = (genreCount[g]||0) + w);
  });
  const topGenres = Object.entries(genreCount).sort((a,b)=>b[1]-a[1]).slice(0,12);

  // Rating distribution (1-10, step 1)
  const ratingDist = Array.from({length:10},(_,i)=>{
    const r = i+1;
    return list.filter(a => a.rating && Math.round(a.rating) === r).length;
  });

  // Status distribution
  const statusMap = {
    "Currently Watching":"Watching","Completed":"Completed",
    "Plan to Watch":"Geplant","On Hold":"Pausiert","Dropped":"Abgebrochen"
  };
  const statusCounts = Object.entries(statusMap).map(([k,l]) => ({
    label: l, count: list.filter(a=>a.status===k).length
  })).filter(s=>s.count>0);

  // Studios (from a.studios array if stored, else skip)
  const studioCount = {};
  list.forEach(a => {
    (a.studios||[]).forEach(s => {
      const n = typeof s === "string" ? s : s.name;
      if (n) studioCount[n] = (studioCount[n]||0)+1;
    });
  });
  const topStudios = Object.entries(studioCount).sort((a,b)=>b[1]-a[1]).slice(0,10);

  // Year distribution (completed only)
  const yearCount = {};
  completed.forEach(a => {
    if (a.year) yearCount[a.year] = (yearCount[a.year]||0)+1;
  });
  const years = Object.entries(yearCount).sort((a,b)=>a[0]-b[0]).slice(-15);

  return { topGenres, ratingDist, statusCounts, topStudios, years, totalEp, hours,
    completedCount: completed.length, ratedCount: rated.length,
    avgRating: rated.length ? (rated.reduce((s,a)=>s+a.rating,0)/rated.length).toFixed(1) : "—",
    favCount: list.filter(a=>a.favorite).length };
}

function renderStatsPage() {
  const d = buildStatsData();

  // Summary cards
  const sumEl = $("spSummary");
  if (sumEl) sumEl.innerHTML = [
    { val: list.length,         lbl: "Anime gesamt" },
    { val: d.completedCount,    lbl: "Abgeschlossen" },
    { val: d.totalEp,           lbl: "Episoden gesehen" },
    { val: d.hours + " h",      lbl: "≈ Stunden" },
    { val: d.avgRating,         lbl: "Ø Bewertung" },
    { val: d.favCount,          lbl: "Favoriten" },
  ].map(c=>`<div class="sp-sum-card"><div class="sp-sum-val">${c.val}</div><div class="sp-sum-lbl">${c.lbl}</div></div>`).join("");

  const font = "'Poppins', sans-serif";
  const textColor = "#8891a8";
  const gridColor = "rgba(255,255,255,.06)";
  Chart.defaults.color = textColor;
  Chart.defaults.font.family = font;

  // Genre chart (horizontal bar)
  destroyChart("genre");
  const gCtx = $("genreChart")?.getContext("2d");
  if (gCtx && d.topGenres.length) {
    _charts.genre = new Chart(gCtx, {
      type: "bar",
      data: {
        labels: d.topGenres.map(g=>g[0]),
        datasets: [{ data: d.topGenres.map(g=>g[1]), backgroundColor: CHART_COLORS, borderRadius: 5, borderSkipped: false }]
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { stepSize: 1 } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  // Rating distribution (bar)
  destroyChart("rating");
  const rCtx = $("ratingChart")?.getContext("2d");
  if (rCtx) {
    _charts.rating = new Chart(rCtx, {
      type: "bar",
      data: {
        labels: ["1","2","3","4","5","6","7","8","9","10"],
        datasets: [{ data: d.ratingDist, backgroundColor: CHART_COLORS.slice(0,10), borderRadius: 4, borderSkipped: false }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: gridColor }, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  // Status donut
  destroyChart("status");
  const sCtx = $("statusChart")?.getContext("2d");
  if (sCtx && d.statusCounts.length) {
    _charts.status = new Chart(sCtx, {
      type: "doughnut",
      data: {
        labels: d.statusCounts.map(s=>s.label),
        datasets: [{ data: d.statusCounts.map(s=>s.count), backgroundColor: CHART_COLORS, borderWidth: 0, hoverOffset: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { padding: 12, boxWidth: 10, font: { size: 11 } } } },
        cutout: "65%"
      }
    });
  }

  // Studios bar list
  const stEl = $("studioList");
  if (stEl) {
    if (d.topStudios.length) {
      const max = d.topStudios[0][1];
      stEl.innerHTML = d.topStudios.map(([name,count]) => `
        <div class="sp-bar-item">
          <div class="sp-bar-row">
            <span class="sp-bar-name">${esc(name)}</span>
            <span class="sp-bar-count">${count}</span>
          </div>
          <div class="sp-bar-track"><div class="sp-bar-fill" style="width:${Math.round(count/max*100)}%"></div></div>
        </div>`).join("");
    } else {
      stEl.innerHTML = `<div class="sp-reco-empty">Noch keine Studio-Daten — einmal "Daten reparieren" ausführen.</div>`;
    }
  }

  // Year chart (bar)
  destroyChart("year");
  const yCtx = $("yearChart")?.getContext("2d");
  if (yCtx && d.years.length) {
    _charts.year = new Chart(yCtx, {
      type: "bar",
      data: {
        labels: d.years.map(y=>y[0]),
        datasets: [{ data: d.years.map(y=>y[1]), backgroundColor: CHART_COLORS[2], borderRadius: 4, borderSkipped: false }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { grid: { color: gridColor }, ticks: { stepSize: 1 } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  $("recoGrid").innerHTML = "";
  $("spRecoWrap").querySelector(".sp-reco-hint").textContent = "Basierend auf deinen Top-Genres und Bewertungen.";
}

// ── Recommendations ──
async function loadRecommendations() {
  const btn = $("recoLoadBtn"), grid = $("recoGrid");
  if (!btn || !grid) return;
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Lade…';

  // Build weighted genre profile from completed+rated anime
  const genreWeight = {};
  list.forEach(a => {
    if (!a.rating) return;
    const boost = a.status === "Completed" ? 1 : 0.5;
    (a.genres||[]).forEach(g => genreWeight[g] = (genreWeight[g]||0) + a.rating * boost);
  });
  const topGenres = Object.entries(genreWeight).sort((a,b)=>b[1]-a[1]).slice(0,5).map(g=>g[0]);

  if (!topGenres.length) {
    grid.innerHTML = `<div class="sp-reco-empty">Noch keine bewerteten Anime — bewerte ein paar und probier es nochmal.</div>`;
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate"></i> Empfehlungen laden';
    return;
  }

  const existingMalIds = new Set(list.map(a=>a.malId).filter(Boolean));
  const seen = new Set();
  const results = [];

  // Search Jikan for top genres, collect results not in list
  for (const genre of topGenres.slice(0,3)) {
    if (results.length >= 20) break;
    try {
      const d = await fetchAnimeSearch(genre, { limit: 20 });
      for (const a of d) {
        if (existingMalIds.has(a.mal_id) || seen.has(a.mal_id)) continue;
        seen.add(a.mal_id); results.push(a);
      }
      await new Promise(r => setTimeout(r, 400));
    } catch {}
  }

  // Score results: bonus if matches multiple top genres
  const scored = results.map(a => {
    const aGenres = (a.genres||[]).map(g=>g.name);
    const overlap = topGenres.filter(g => aGenres.includes(g)).length;
    return { a, score: (a.score||0) + overlap * 0.5 };
  }).sort((a,b) => b.score - a.score).slice(0, 10);

  if (!scored.length) {
    grid.innerHTML = `<div class="sp-reco-empty">Keine Empfehlungen gefunden – versuch es gleich nochmal.</div>`;
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate"></i> Empfehlungen laden';
    return;
  }

  grid.innerHTML = scored.map(({ a }) => {
    const genres = (a.genres||[]).slice(0,3).map(g=>`<span class="reco-genre">${esc(g.name)}</span>`).join("");
    return `
      <div class="reco-card" data-mal-id="${a.mal_id}">
        <img src="${esc(a.images?.jpg?.large_image_url||NO_COVER_SVG)}" alt="" loading="lazy" onerror="noCover(this)">
        <div class="reco-info">
          <div class="reco-title">${esc(a.title_english||a.title)}</div>
          <div class="reco-meta">
            <span>${a.type||"TV"}</span>
            <span>${a.episodes||"?"} Ep.</span>
            <span>⭐ ${a.score?.toFixed(1)||"—"}</span>
          </div>
          <div class="reco-genres">${genres}</div>
          <button class="reco-add-btn" data-mal-id="${a.mal_id}"><i class="fas fa-plus"></i> Hinzufügen</button>
        </div>
      </div>`;
  }).join("");

  // Wire up "add" buttons
  grid.querySelectorAll(".reco-add-btn").forEach(b => {
    b.addEventListener("click", async e => {
      e.stopPropagation();
      const malId = parseInt(b.dataset.malId);
      b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      try {
        const resp = await jikan(`/anime/${malId}`);
        if (resp.data) { openAddModal(resp.data); }
      } catch { msg("Fehler beim Laden.", true); }
      b.disabled = false; b.innerHTML = '<i class="fas fa-plus"></i> Hinzufügen';
    });
  });

  btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate"></i> Neu laden';
  $("spRecoWrap").querySelector(".sp-reco-hint").textContent =
    `Basierend auf deinen Top-Genres: ${topGenres.slice(0,3).join(", ")}.`;
}

function showStatsPage() {
  $("statsPage")?.classList.remove("hidden");
  $("statsBtn").innerHTML = '<i class="fas fa-list"></i> Zur Liste';
  $("statsBtn").dataset.open = "1";
  renderStatsPage();
  $("statsPage")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hideStatsPage() {
  $("statsPage")?.classList.add("hidden");
  $("statsBtn").innerHTML = '<i class="fas fa-chart-bar"></i> Statistiken';
  delete $("statsBtn").dataset.open;
}

// ══════════════════ EXPORT / IMPORT ══════════════════
function exportData() {
  const blob = new Blob([JSON.stringify(list,null,2)],{type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download="anime-data.json"; a.click();
  URL.revokeObjectURL(url); msg("JSON exportiert!");
}

// ══════════════════ ZIP EXPORT WITH IMAGES ══════════════════
// Bundles data.json + every cover image into one ZIP, so the list can later be
// re-imported without needing internet access for the covers. Whether this works
// depends on the image host allowing cross-origin reads (not just <img> display) —
// entries whose image can't be fetched this way are simply skipped and logged,
// the rest of the export still succeeds.
ui.zipExportCancelled = false;

function openZipExportModal() {
  ui.zipExportDone = false;
  ui.zipExportCancelled = false;
  const withImg = list.filter(a => a.imageUrl);
  const body = $("zipExportBody"), startBtn = $("zipExportStart"), cancelBtn = $("zipExportCancel");
  if (!body) return;
  body.innerHTML = `
    <div class="ext-stats">
      <div class="ext-stat"><div class="stat-icon"><i class="fas fa-list"></i></div><div><div class="ext-stat-val">${list.length}</div><div class="ext-stat-lbl">Gesamt</div></div></div>
      <div class="ext-stat"><div class="stat-icon" style="color:var(--accent2)"><i class="fas fa-image"></i></div><div><div class="ext-stat-val" style="color:var(--accent2)">${withImg.length}</div><div class="ext-stat-lbl">Mit Cover</div></div></div>
    </div>
    <div class="ext-info"><i class="fas fa-info-circle" style="color:var(--accent2);margin-right:6px;"></i>
      Lädt alle Cover-Bilder herunter und packt sie zusammen mit deinen Daten in eine ZIP-Datei. Bei ${withImg.length} Bildern kann das ein paar Minuten dauern — falls einzelne Bilder vom Server nicht ausgelesen werden können, werden sie übersprungen (steht im Log), der Rest des Exports läuft trotzdem durch.
    </div>
    <div class="ext-progress hidden" id="zipExportProgressWrap">
      <div class="ext-prog-row"><span id="zipExportProgText">Starte…</span><span id="zipExportProgCount">0 / ${withImg.length}</span></div>
      <div class="ext-prog-bar"><div class="ext-prog-fill" id="zipExportProgFill" style="width:0%"></div></div>
      <div class="ext-log" id="zipExportLog"></div>
    </div>`;
  if (startBtn) { startBtn.disabled = withImg.length === 0; startBtn.innerHTML = '<i class="fas fa-rocket"></i> Export starten'; }
  if (cancelBtn) cancelBtn.textContent = "Abbrechen";
  $("zipExportModal")?.classList.remove("hidden");
}

function fileExtFromUrl(u) {
  const m = (u || "").match(/\.(jpe?g|png|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

async function runZipExport() {
  if (typeof JSZip === "undefined") { msg("ZIP-Bibliothek konnte nicht geladen werden (offline?).", true); return; }
  const startBtn = $("zipExportStart"), cancelBtn = $("zipExportCancel");
  const withImg = list.filter(a => a.imageUrl);
  if (startBtn) { startBtn.disabled = true; startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Exportiere…'; }
  ui.zipExportCancelled = false;
  const pw = $("zipExportProgressWrap"); if (pw) pw.classList.remove("hidden");

  const zip = new JSZip();
  const coversFolder = zip.folder("covers");
  const total = withImg.length;
  let done = 0, ok = 0, failed = 0;
  const log = s => { const el = $("zipExportLog"); if (el) { el.innerHTML += `<div>${s}</div>`; el.scrollTop = el.scrollHeight; } };

  // Build a lookup so we can attach the right local filename to each list entry afterwards.
  const localImageById = {};

  for (const entry of withImg) {
    if (ui.zipExportCancelled) { log("⛔ Abgebrochen."); break; }
    const pt = $("zipExportProgText"), pc = $("zipExportProgCount"), pf = $("zipExportProgFill");
    if (pt) pt.textContent = `Lade Cover: ${(entry.title || "?").substring(0, 40)}…`;
    if (pc) pc.textContent = `${done} / ${total}`;
    if (pf) pf.style.width = `${(done / total * 100).toFixed(0)}%`;

    try {
      const res = await fetch(entry.imageUrl, { mode: "cors" });
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      const filename = `${entry.malId || entry.id}.${fileExtFromUrl(entry.imageUrl)}`;
      coversFolder.file(filename, blob);
      localImageById[entry.id] = `covers/${filename}`;
      ok++;
    } catch {
      failed++; log(`⚠️ Cover nicht ladbar: ${esc(entry.title || "?")}`);
    }
    done++;
  }

  if (!ui.zipExportCancelled) {
    const pt = $("zipExportProgText");
    if (pt) pt.textContent = "Erstelle ZIP-Datei…";
    const dataWithLocalImages = list.map(a => localImageById[a.id] ? { ...a, localImage: localImageById[a.id] } : a);
    zip.file("data.json", JSON.stringify(dataWithLocalImages, null, 2));
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a"); a.href = url; a.download = "anime-tracker-export.zip"; a.click();
    URL.revokeObjectURL(url);
  }

  const pt = $("zipExportProgText"), pc = $("zipExportProgCount"), pf = $("zipExportProgFill");
  if (pt) pt.textContent = ui.zipExportCancelled ? "Abgebrochen" : "✅ Fertig!";
  if (pc) pc.textContent = `${done} / ${total}`;
  if (pf) pf.style.width = "100%";
  if (startBtn) startBtn.innerHTML = '<i class="fas fa-check"></i> Fertig';
  if (cancelBtn) cancelBtn.textContent = "Schließen";
  if (startBtn) startBtn.disabled = false;
  ui.zipExportDone = true;
  msg(ui.zipExportCancelled ? "Export abgebrochen." : `${ok} Cover exportiert, ${failed} übersprungen.`);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error();
      if (!confirm("Import ersetzt deine aktuellen Daten?")) return;
      list = data.map(a=>({addedAt:Date.now(),customCategories:[],...a}));
      save(); updateStats(); renderTabs(); renderList();
      msg("Import erfolgreich!");
    } catch { msg("Ungültiges Format!", true); }
  };
  reader.readAsText(file);
}

// ══════════════════ FOLDER ACTIONS ══════════════════
// exposed as AT.* so HTML onclick can call them
const AT = window.AT = {
  addFolder() {
    const inp = $("folderInput");
    const name = inp?.value.trim()||"";
    if (!name||folders.includes(name)||STD_TABS.includes(name)) return;
    folders.push(name); save(); renderTabs(); renderMoreList();
    if(inp) inp.value="";
    AT.hideFolderInput();
    msg(`Kategorie "${name}" erstellt!`);
  },
  showFolderInput() {
    $("moreInputRow")?.classList.remove("hidden");
    $("moreAddBtn").style.display="none";
    $("folderInput")?.focus();
  },
  hideFolderInput() {
    $("moreInputRow")?.classList.add("hidden");
    const ab = $("moreAddBtn"); if(ab) ab.style.display="block";
    const fi = $("folderInput"); if(fi) fi.value="";
  },
  deleteFolder(f) {
    if (!confirm(`Kategorie "${f}" löschen?`)) return;
    folders = folders.filter(x=>x!==f);
    list.forEach(a=>{ if(a.status===f) a.status="Plan to Watch"; if(a.customCategories) a.customCategories=a.customCategories.filter(c=>c!==f); });
    if(ui.tab===f) ui.tab="All";
    save(); renderTabs(); renderMoreList(); renderList();
    msg(`"${f}" gelöscht.`);
  },
  moveFolder(i, dir) {
    const j = i+dir;
    if (j<0||j>=folders.length) return;
    [folders[i],folders[j]]=[folders[j],folders[i]];
    save(); renderTabs(); renderMoreList();
  },
  startRename(idx, el) {
    const old = folders[idx];
    const inp = document.createElement("input");
    inp.className="folder-rename-input"; inp.value=old;
    el.replaceWith(inp); inp.focus(); inp.select();
    const commit = ()=>{
      const nv = inp.value.trim();
      if (nv&&nv!==old&&!folders.includes(nv)&&!STD_TABS.includes(nv)) {
        list.forEach(a=>{
          if(a.status===old) a.status=nv;
          if(a.customCategories){const i2=a.customCategories.indexOf(old);if(i2!==-1)a.customCategories[i2]=nv;}
        });
        if(ui.tab===old) ui.tab=nv;
        folders[idx]=nv; save(); renderTabs(); msg(`Umbenannt zu "${nv}"`);
      }
      renderMoreList();
    };
    inp.addEventListener("blur",commit);
    inp.addEventListener("keydown",e=>{if(e.key==="Enter")inp.blur();if(e.key==="Escape")renderMoreList();});
  },
  openMerge(idx) {
    ui.mergeIdx=idx;
    const src = folders[idx];
    const lbl=$("mergeSrcLabel"),tgt=$("mergeTarget"),nm=$("mergeName");
    if(lbl) lbl.textContent=`"${src}"`;
    if(tgt) tgt.innerHTML=folders.filter((_,i)=>i!==idx).map(f=>`<option value="${esc(f)}">${esc(f)} (${list.filter(a=>(a.customCategories||[]).includes(f)).length} Anime)</option>`).join("");
    if(!tgt?.options?.length){msg("Keine weitere Kategorie zum Mergen.",true);return;}
    if(nm) nm.value=src;
    $("mergeModal")?.classList.remove("hidden");
  },
  confirmMerge() {
    const src=folders[ui.mergeIdx], tgt=$("mergeTarget")?.value, nv=$("mergeName")?.value.trim()||tgt;
    if(!tgt) return;
    list.forEach(a=>{
      if(a.status===src||a.status===tgt) a.status=nv;
      if(a.customCategories){
        const hs=a.customCategories.includes(src),ht=a.customCategories.includes(tgt);
        a.customCategories=a.customCategories.filter(c=>c!==src&&c!==tgt);
        if((hs||ht)&&!a.customCategories.includes(nv)) a.customCategories.push(nv);
      }
    });
    folders=folders.filter(f=>f!==src&&f!==tgt);
    if(!folders.includes(nv)) folders.push(nv);
    if(ui.tab===src||ui.tab===tgt) ui.tab=nv;
    save(); renderTabs(); renderMoreList(); renderList();
    $("mergeModal")?.classList.add("hidden");
    msg(`✅ "${src}" und "${tgt}" zu "${nv}" zusammengeführt!`);
  },
  goPage(p) { ui.page=p; renderList(); window.scrollTo({top:$("animeGrid")?.offsetTop-20||0,behavior:"smooth"}); }
};

// ══════════════════ INIT EVENTS ══════════════════
function initEvents() {
  // MAL search
  $("malInput")?.addEventListener("input", e => {
    const clr=$("malClear"); if(clr) clr.classList.toggle("hidden",!e.target.value);
    malSearch();
  });
  $("malClear")?.addEventListener("click",()=>{
    const inp=$("malInput"),drop=$("malDropdown"),clr=$("malClear");
    if(inp) inp.value=""; if(drop){drop.classList.add("hidden");drop.innerHTML="";} if(clr) clr.classList.add("hidden");
  });
  document.addEventListener("click",e=>{
    if(!e.target.closest(".search-box")) $("malDropdown")?.classList.add("hidden");
  });

  // Big search modal
  $("searchExpandBtn")?.addEventListener("click", openBigSearchModal);
  $("bigSearchClose")?.addEventListener("click", closeBigSearchModal);
  $("bigSearchModal")?.addEventListener("click", e => {
    if (e.target === $("bigSearchModal")?.querySelector(".modal-bg")) closeBigSearchModal();
  });
  $("bigSearchInput")?.addEventListener("input", e => {
    const clr = $("bigSearchClear"); if (clr) clr.classList.toggle("hidden", !e.target.value);
    bigSearch();
  });
  $("bigSearchClear")?.addEventListener("click", () => {
    const inp = $("bigSearchInput"), clr = $("bigSearchClear");
    if (inp) { inp.value = ""; inp.focus(); }
    if (clr) clr.classList.add("hidden");
    bigSearch();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("bigSearchModal")?.classList.contains("hidden")) closeBigSearchModal();
  });

  // Filters
  const ls=$("listSearch"),lsc=$("listSearchClear");
  ls?.addEventListener("input", debounce(e=>{ ui.search=e.target.value; if(lsc) lsc.classList.toggle("hidden",!ui.search); ui.page=1; renderList(); },200));
  lsc?.addEventListener("click",()=>{ if(ls) ls.value=""; ui.search=""; lsc.classList.add("hidden"); ui.page=1; renderList(); });

  $("franchiseSel")?.addEventListener("change",e=>{ ui.franchise=e.target.value; ui.page=1; renderList(); });
  $("favToggle")?.addEventListener("change",e=>{ ui.favOnly=e.target.checked; ui.page=1; renderList(); });
  $("ratingRange")?.addEventListener("input",e=>{
    ui.minRating=parseFloat(e.target.value);
    const v=$("ratingVal"); if(v) v.textContent=ui.minRating%1===0?ui.minRating:ui.minRating.toFixed(1);
    ui.page=1; renderList();
  });
  $("sortSel")?.addEventListener("change",e=>{ ui.sort=e.target.value; ui.page=1; renderList(); });

  const gb=$("genreBtn"),gp=$("genrePanel");
  gb?.addEventListener("click",e=>{ e.stopPropagation(); gp?.classList.toggle("hidden"); });
  document.addEventListener("click",e=>{ if(!e.target.closest(".genre-wrap")) gp?.classList.add("hidden"); });

  $("groupingBtn")?.addEventListener("click",()=>{
    ui.grouping=!ui.grouping;
    $("groupingBtn")?.classList.toggle("active",ui.grouping);
    ui.page=1; renderList();
  });

  $("resetBtn")?.addEventListener("click",()=>{
    ui.search=""; ui.franchise=""; ui.favOnly=false; ui.minRating=0; ui.genres=[]; ui.sort="added-desc"; ui.grouping=true; ui.page=1;
    const ls=$("listSearch"); if(ls) ls.value="";
    const lsc=$("listSearchClear"); if(lsc) lsc.classList.add("hidden");
    const rr=$("ratingRange"); if(rr) rr.value=0;
    const rv=$("ratingVal"); if(rv) rv.textContent="0";
    const ss=$("sortSel"); if(ss) ss.value="added-desc";
    const fs=$("franchiseSel"); if(fs) fs.value="";
    const gb_=$("groupingBtn"); if(gb_) gb_.classList.add("active");
    const ft=$("favToggle"); if(ft) ft.checked=false;
    document.querySelectorAll(".genre-chip.on").forEach(c=>c.classList.remove("on"));
    const gt=$("genreBtnText"); if(gt) gt.textContent="Genres";
    renderList();
  });

  // Bulk
  $("selectAll")?.addEventListener("change",e=>{
    document.querySelectorAll(".card-cb").forEach(cb=>{ cb.checked=e.target.checked; const id=String(cb.dataset.id); if(e.target.checked)ui.selected.add(id);else ui.selected.delete(id); });
    updateBulkUI();
  });
  $("bulkApplyBtn")?.addEventListener("click",()=>{
    const s=$("bulkStatus")?.value; if(!s||!ui.selected.size) return;
    list.forEach(a=>{ if(ui.selected.has(String(a.id))) a.status=s; });
    save(); updateStats(); renderList(); msg(`Status für ${ui.selected.size} Anime gesetzt.`);
  });
  $("bulkDeleteBtn")?.addEventListener("click",()=>{
    if(!ui.selected.size) return;
    if(!confirm(`${ui.selected.size} Anime löschen?`)) return;
    list=list.filter(a=>!ui.selected.has(String(a.id)));
    ui.selected.clear(); save(); updateStats(); renderList(); msg("Gelöscht.");
  });

  // Export/Import
  $("exportBtn")?.addEventListener("click",exportData);
  $("importInput")?.addEventListener("change",e=>{ if(e.target.files[0]) importData(e.target.files[0]); e.target.value=""; });

  // Ext import
  $("extImportInput")?.addEventListener("change",e=>{
    const f=e.target.files[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=ev=>{ try{ const entries=parseExtFile(ev.target.result,f.name); if(!entries.length){msg("Keine Anime gefunden!",true);return;} showExtPreview(entries); $("extModal")?.classList.remove("hidden"); }catch(err){msg("Fehler: "+err.message,true);} };
    reader.readAsText(f); e.target.value="";
  });
  $("extClose")?.addEventListener("click",()=>{ ui.extCancelled=true; $("extModal")?.classList.add("hidden"); });
  $("extCancel")?.addEventListener("click",()=>{ ui.extCancelled=true; $("extModal")?.classList.add("hidden"); });
  $("extModal")?.addEventListener("click",e=>{ if(e.target===$("extModal").querySelector(".modal-bg")){ ui.extCancelled=true; $("extModal")?.classList.add("hidden"); } });
  $("extStart")?.addEventListener("click",()=>{
    if (ui.extDone) { $("extModal")?.classList.add("hidden"); return; }
    runExtImport();
  });

  // Repair existing entries
  $("franchiseClose")?.addEventListener("click",  ()=>$("franchiseModal")?.classList.add("hidden"));
  $("franchiseCancel")?.addEventListener("click", ()=>$("franchiseModal")?.classList.add("hidden"));
  $("franchiseModal")?.addEventListener("click", e=>{if(e.target===$("franchiseModal")?.querySelector(".modal-bg"))$("franchiseModal")?.classList.add("hidden");});
  $("franchiseSelectAll")?.addEventListener("click", ()=>{
    const anyUnchecked = _franchiseEntries.some(e=>!e.alreadyInList&&!e.checked);
    _franchiseEntries.forEach(e=>{ if(!e.alreadyInList) e.checked=anyUnchecked; });
    renderFranchiseBody();
  });
  $("franchiseConfirm")?.addEventListener("click", confirmFranchiseAdd);

  // Repair existing entries
  $("repairBtn")?.addEventListener("click", openRepairModal);
  $("repairClose")?.addEventListener("click", () => { ui.repairCancelled = true; $("repairModal")?.classList.add("hidden"); });
  $("repairCancel")?.addEventListener("click", () => { ui.repairCancelled = true; $("repairModal")?.classList.add("hidden"); });
  $("repairModal")?.addEventListener("click", e => {
    if (e.target === $("repairModal")?.querySelector(".modal-bg")) { ui.repairCancelled = true; $("repairModal")?.classList.add("hidden"); }
  });
  $("repairStart")?.addEventListener("click", () => {
    if (ui.repairDone) { $("repairModal")?.classList.add("hidden"); return; }
    runRepair();
  });

  // ZIP export with images
  $("exportZipBtn")?.addEventListener("click", openZipExportModal);
  $("zipExportClose")?.addEventListener("click", () => { ui.zipExportCancelled = true; $("zipExportModal")?.classList.add("hidden"); });
  $("zipExportCancel")?.addEventListener("click", () => { ui.zipExportCancelled = true; $("zipExportModal")?.classList.add("hidden"); });
  $("zipExportModal")?.addEventListener("click", e => {
    if (e.target === $("zipExportModal")?.querySelector(".modal-bg")) { ui.zipExportCancelled = true; $("zipExportModal")?.classList.add("hidden"); }
  });
  $("zipExportStart")?.addEventListener("click", () => {
    if (ui.zipExportDone) { $("zipExportModal")?.classList.add("hidden"); return; }
    runZipExport();
  });

  // Detail modal
  $("detailClose")?.addEventListener("click",()=>$("detailModal")?.classList.add("hidden"));
  $("detailModal")?.addEventListener("click",e=>{ if(e.target===$("detailModal").querySelector(".modal-bg"))$("detailModal")?.classList.add("hidden"); });
  $("detailDelete")?.addEventListener("click",()=>{
    if(!ui.detailId||!confirm("Anime löschen?")) return;
    list=list.filter(a=>String(a.id)!==String(ui.detailId));
    save(); updateStats(); renderList(); $("detailModal")?.classList.add("hidden"); msg("Gelöscht.");
  });
  $("detailEdit")?.addEventListener("click",()=>{
    const a=list.find(x=>String(x.id)===String(ui.detailId));
    if(a){$("detailModal")?.classList.add("hidden");openEdit(a);}
  });
  $("detailShare")?.addEventListener("click", async ()=>{
    const a=list.find(x=>String(x.id)===String(ui.detailId));
    if(!a) return;
    const btn = $("detailShare");
    btn.disabled=true; btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Erstelle…';
    try { await shareAnime(a); } catch { msg("Fehler beim Erstellen der Karte.", true); }
    btn.disabled=false; btn.innerHTML='<i class="fas fa-share-nodes"></i> Teilen';
  });

  // Edit modal
  $("editClose")?.addEventListener("click",()=>$("editModal")?.classList.add("hidden"));
  $("editCancel")?.addEventListener("click",()=>$("editModal")?.classList.add("hidden"));
  $("editDateClear")?.addEventListener("click",()=>{ const d=$("editCompletedDate"); if(d) d.value=""; });
  $("editModal")?.addEventListener("click",e=>{ if(e.target===$("editModal").querySelector(".modal-bg"))$("editModal")?.classList.add("hidden"); });
  $("editSave")?.addEventListener("click",saveEdit);

  // Add modal
  $("addClose")?.addEventListener("click",()=>$("addModal")?.classList.add("hidden"));
  $("addCancel")?.addEventListener("click",()=>$("addModal")?.classList.add("hidden"));
  $("addModal")?.addEventListener("click",e=>{ if(e.target===$("addModal").querySelector(".modal-bg"))$("addModal")?.classList.add("hidden"); });
  $("addConfirm")?.addEventListener("click",confirmAdd);

  // Merge modal
  $("mergeClose")?.addEventListener("click",()=>$("mergeModal")?.classList.add("hidden"));
  $("mergeCancel")?.addEventListener("click",()=>$("mergeModal")?.classList.add("hidden"));
  $("mergeConfirm")?.addEventListener("click",AT.confirmMerge);

  // More panel
  $("moreBtn")?.addEventListener("click",e=>{ e.stopPropagation(); $("morePanel")?.classList.toggle("hidden"); renderMoreList(); });
  document.addEventListener("click",e=>{ if(!e.target.closest(".more-wrap"))$("morePanel")?.classList.add("hidden"); });

  // Notifications
  $("notifBtn")?.addEventListener("click",e=>{
    e.stopPropagation();
    const panel=$("notifPanel");
    if(panel?.classList.contains("hidden")){ panel.classList.remove("hidden"); renderNotifEpisodes(); }
    else panel?.classList.add("hidden");
  });
  document.addEventListener("click",e=>{ if(!e.target.closest(".notif-wrap"))$("notifPanel")?.classList.add("hidden"); });
  document.querySelectorAll(".notif-tab").forEach(tab=>{
    tab.addEventListener("click",()=>{
      document.querySelectorAll(".notif-tab").forEach(t=>t.classList.remove("active"));
      tab.classList.add("active");
      ui.activeNtab=tab.dataset.ntab;
      if(ui.activeNtab==="episodes") renderNotifEpisodes(); else renderNotifNews();
    });
  });
  $("notifMarkAll")?.addEventListener("click",()=>{
    buildEpNotifs().forEach(n=>readNotifs.add(n.id));
    saveReadNotifs(); updateNotifBadge(); renderNotifEpisodes();
  });
}

// ══════════════════ INIT ══════════════════
function init() {
  load();
  initGenres();
  initEvents();
  initGridDelegation();
  renderTabs();
  renderFranchiseDropdown();
  updateStats();
  renderList();
  updateBulkUI();
  updateNotifBadge();
  // Background airing refresh
  setTimeout(()=>refreshAllAiring(), 2500);
}

if (document.readyState==="loading") document.addEventListener("DOMContentLoaded",init);
else init();

// Temporary debug helpers — remove after diagnosing Slime Diaries grouping
window._debugAnime = (q) => {
  const r = list.filter(a => a.title.toLowerCase().includes(q.toLowerCase()) || (a.altTitle||"").toLowerCase().includes(q.toLowerCase()));
  r.forEach(a => console.log(a.title, "| malId:", a.malId, "| relationsAt:", a.relationsAt, "| relatedMalIds:", JSON.stringify(a.relatedMalIds)));
  return r;
};
window._debugNorm = (t) => normTitle(t);

})();
