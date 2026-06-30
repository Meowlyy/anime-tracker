/* ═══════════════════════════════════════════════════════════════
   stats.js — standalone stats & recommendations page
   Reads the same localStorage keys as the main tracker.
═══════════════════════════════════════════════════════════════ */
(function () {
"use strict";

const SK = "animeTracker_v5";
const $ = id => document.getElementById(id);
const esc = s => s ? String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") : "";
const NO_COVER_SVG = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><rect width="300" height="450" fill="#111827"/><g transform="translate(150,195)" fill="#ff4fd8" opacity=".55"><path d="M-26-20h52a6 6 0 0 1 6 6v34a6 6 0 0 1-6 6h-52a6 6 0 0 1-6-6v-34a6 6 0 0 1 6-6Z" fill="none" stroke="#ff4fd8" stroke-width="3"/><circle cx="-9" cy="-3" r="5"/><path d="M-20 16l13-13 9 8 11-13 17 18Z"/></g><text x="150" y="248" font-family="sans-serif" font-size="15" fill="#8891a8" text-anchor="middle">Kein Cover</text></svg>`);
function noCover(el){ el.onerror=null; el.src=NO_COVER_SVG; }
window.noCover = noCover;

// ── Load data from localStorage ──
let list = [];
try { const d = JSON.parse(localStorage.getItem(SK)); list = Array.isArray(d) ? d : []; } catch {}

// ── msg helper ──
function msg(text, isErr) {
  const bar = $("msgBar"); if (!bar) return;
  bar.textContent = text; bar.className = "msg-bar" + (isErr ? " err" : "");
  clearTimeout(msg._t); msg._t = setTimeout(() => bar.classList.add("hidden"), 3000);
}

// ── jikan helper ──
async function jikan(path) {
  const url = path.startsWith("http") ? path : `https://api.jikan.moe/v4${path}`;
  let retries = 3;
  while (retries-- > 0) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 504) { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    return res.json();
  }
  throw new Error("Jikan rate limit exceeded");
}

async function fetchAnimeSearch(q, { limit = 20 } = {}) {
  const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=${limit}&sfw`);
  if (!res.ok) return [];
  const d = await res.json();
  return d.data || [];
}

// ── Charts ──
const CHART_COLORS = [
  "#ff4fd8","#a855f7","#06b6d4","#10b981","#f59e0b",
  "#ef4444","#8b5cf6","#ec4899","#14b8a6","#f97316",
  "#6366f1","#84cc16","#0ea5e9","#e879f9","#22d3ee"
];
let _charts = {};
function destroyChart(id) { if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; } }

function buildStatsData() {
  const completed = list.filter(a => a.status === "Completed");
  const rated = list.filter(a => a.rating > 0);
  const totalEp = list.reduce((s,a) => s+(a.episodesWatched||0), 0);
  const hours = Math.round(totalEp * 24 / 60);

  const genreCount = {};
  list.forEach(a => {
    const w = a.status==="Completed" ? 2 : 1;
    (a.genres||[]).forEach(g => genreCount[g] = (genreCount[g]||0) + w);
  });
  const topGenres = Object.entries(genreCount).sort((a,b)=>b[1]-a[1]).slice(0,12);

  const ratingDist = Array.from({length:10},(_,i) =>
    list.filter(a => a.rating && Math.round(a.rating) === i+1).length);

  const STATUS_CFG = [
    { key:"Currently Watching", label:"Watching",    color:"#ff4fd8" },
    { key:"Completed",          label:"Completed",   color:"#a855f7" },
    { key:"Plan to Watch",      label:"Geplant",     color:"#06b6d4" },
    { key:"On Hold",            label:"Pausiert",    color:"#f59e0b" },
    { key:"Dropped",            label:"Abgebrochen", color:"#ef4444" },
  ];
  const statusCounts = STATUS_CFG
    .map(s => ({ ...s, count: list.filter(a=>a.status===s.key).length }))
    .filter(s=>s.count>0);

  const studioCount = {};
  list.forEach(a => {
    (a.studios||[]).forEach(s => {
      const n = typeof s==="string" ? s : s.name;
      if (n) studioCount[n] = (studioCount[n]||0)+1;
    });
  });
  const topStudios = Object.entries(studioCount).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const hasCompletedAt = completed.some(a => a.completedAt);
  const yearCount = {};
  completed.forEach(a => {
    const y = a.completedAt
      ? new Date(a.completedAt).getFullYear()
      : (a.year || null);
    if (y) yearCount[y] = (yearCount[y]||0)+1;
  });
  const years = Object.entries(yearCount).sort((a,b)=>a[0]-b[0]);

  return { topGenres, ratingDist, statusCounts, topStudios, years, totalEp, hours,
    hasCompletedAt,
    completedCount: completed.length,
    avgRating: rated.length ? (rated.reduce((s,a)=>s+a.rating,0)/rated.length).toFixed(1) : "—",
    favCount: list.filter(a=>a.favorite).length };
}

function renderStats() {
  const d = buildStatsData();
  const sumEl = $("spSummary");
  if (sumEl) sumEl.innerHTML = [
    { val: list.length,       lbl: "Anime gesamt" },
    { val: d.completedCount,  lbl: "Abgeschlossen" },
    { val: d.totalEp,         lbl: "Episoden gesehen" },
    { val: d.hours + " h",    lbl: "≈ Stunden" },
    { val: d.avgRating,       lbl: "Ø Bewertung" },
    { val: d.favCount,        lbl: "Favoriten" },
  ].map(c=>`<div class="sp-sum-card"><div class="sp-sum-val">${c.val}</div><div class="sp-sum-lbl">${c.lbl}</div></div>`).join("");

  const textColor="#8891a8", gridColor="rgba(255,255,255,.06)";
  Chart.defaults.color = textColor;
  Chart.defaults.font.family = "'Poppins', sans-serif";

  destroyChart("genre");
  const gCtx = $("genreChart")?.getContext("2d");
  if (gCtx && d.topGenres.length) _charts.genre = new Chart(gCtx, {
    type:"bar", data:{ labels:d.topGenres.map(g=>g[0]),
      datasets:[{ data:d.topGenres.map(g=>g[1]), backgroundColor:CHART_COLORS, borderRadius:5, borderSkipped:false }]},
    options:{ indexAxis:"y", responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ x:{grid:{color:gridColor},ticks:{stepSize:1}}, y:{grid:{display:false}} }}
  });

  destroyChart("rating");
  const rCtx = $("ratingChart")?.getContext("2d");
  if (rCtx) _charts.rating = new Chart(rCtx, {
    type:"bar", data:{ labels:["1","2","3","4","5","6","7","8","9","10"],
      datasets:[{ data:d.ratingDist, backgroundColor:CHART_COLORS.slice(0,10), borderRadius:4, borderSkipped:false }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}},
      scales:{ y:{grid:{color:gridColor},ticks:{stepSize:1}}, x:{grid:{display:false}} }}
  });

  destroyChart("status");
  const sCtx = $("statusChart")?.getContext("2d");
  if (sCtx && d.statusCounts.length) {
    const total = d.statusCounts.reduce((s,x)=>s+x.count,0);
    // enforce a minimum visual slice of 3% so tiny segments (e.g. 1-2 entries out of 800+)
    // are still clearly visible in the donut
    const MIN_PCT = 0.03;
    const displayData = d.statusCounts.map(s => Math.max(s.count, total * MIN_PCT));

    _charts.status = new Chart(sCtx, {
      type:"doughnut",
      data:{
        labels: d.statusCounts.map(s=>`${s.label} (${s.count})`),
        datasets:[{
          data: displayData,
          backgroundColor: d.statusCounts.map(s=>s.color),
          borderWidth: 3,
          borderColor: "#0b1020",
          hoverOffset: 10,
        }]
      },
      options:{
        responsive:true, maintainAspectRatio:false, cutout:"55%",
        plugins:{
          legend:{
            position:"bottom",
            labels:{
              padding:10, boxWidth:12, boxHeight:12, font:{size:11},
              color:"#8891a8",
              generateLabels: chart => d.statusCounts.map((s,i) => ({
                text: `${s.label} (${s.count})`,
                fillStyle: s.color,
                strokeStyle: s.color,
                fontColor: "#8891a8",
                lineWidth: 0,
                hidden: false,
                index: i
              }))
            }
          },
          tooltip:{
            callbacks:{
              label: item => {
                const real = d.statusCounts[item.dataIndex];
                return ` ${real.label}: ${real.count} (${Math.round(real.count/total*100)}%)`;
              }
            }
          }
        }
      }
    });
  }

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
      stEl.innerHTML = `<div class="sp-reco-empty">Noch keine Studio-Daten — einmal "Daten reparieren" in der Hauptansicht ausführen.</div>`;
    }
  }

  // Update year chart title dynamically
  const yearTitle = $("yearChartTitle");
  const yearSub = $("yearChartSub");
  if (yearTitle) yearTitle.textContent = d.hasCompletedAt
    ? "Anime abgeschlossen pro Jahr"
    : "Abgeschlossene Anime nach Erscheinungsjahr";
  if (yearSub) yearSub.textContent = d.hasCompletedAt
    ? "Wann du einen Anime abgeschlossen hast — Einträge ohne Datum nutzen das Erscheinungsjahr als Fallback"
    : "Noch kein Abschlussdatum gesetzt — Erscheinungsjahr wird genutzt. Datum im Bearbeiten-Menü nachtragen.";

  destroyChart("year");
  const yCtx = $("yearChart")?.getContext("2d");
  if (yCtx && d.years.length) _charts.year = new Chart(yCtx, {
    type:"bar", data:{ labels:d.years.map(y=>y[0]),
      datasets:[{ data:d.years.map(y=>y[1]), backgroundColor:CHART_COLORS[2], borderRadius:4, borderSkipped:false, label:"Abgeschlossene Anime" }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{ callbacks:{ title: items => `${items[0].label}`, label: item => ` ${item.raw} Anime abgeschlossen` } }
      },
      scales:{ y:{grid:{color:gridColor},ticks:{stepSize:1}}, x:{grid:{display:false}} }}
  });
}

// ── Recommendations ──
const GENRE_IDS = {
  "Action":1,"Adventure":2,"Comedy":4,"Drama":8,"Fantasy":10,
  "Horror":14,"Mystery":7,"Romance":22,"Sci-Fi":24,"Slice of Life":36,
  "Sports":30,"Supernatural":37,"Thriller":41,"Ecchi":9,"Isekai":62,
  "Mecha":18,"Music":19,"Psychological":40,"Shounen":27,"Seinen":42,
  "Historical":13,"Martial Arts":17,"Magic":16,"School":23
};

async function loadRecommendations() {
  const btn = $("recoLoadBtn"), grid = $("recoGrid");
  if (!btn || !grid) return;
  btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Lade…';

  const genreWeight = {};
  list.forEach(a => {
    if (!a.rating || a.rating < 6) return;
    const w = (a.status==="Completed" ? 1 : 0.4) * (a.rating / 5);
    (a.genres||[]).forEach(g => genreWeight[g] = (genreWeight[g]||0) + w);
  });
  const topGenres = Object.entries(genreWeight).sort((a,b)=>b[1]-a[1]).slice(0,6).map(g=>g[0]);

  if (!topGenres.length) {
    grid.innerHTML = `<div class="sp-reco-empty">Noch keine bewerteten Anime (min. 6/10) — bewerte ein paar und probier es nochmal.</div>`;
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate"></i> Empfehlungen laden';
    return;
  }

  const ratedCompleted = list.filter(a=>a.status==="Completed"&&a.rating>=7);
  const avgRating = ratedCompleted.length ? ratedCompleted.reduce((s,a)=>s+a.rating,0)/ratedCompleted.length : 7;
  const minMalScore = Math.max(6.5, avgRating * 0.7);

  const existingMalIds = new Set(list.map(a=>a.malId).filter(Boolean));
  const seen = new Set(); let results = [];

  const page = Math.floor(Math.random() * 5) + 1;
  for (const genre of topGenres.slice(0,4)) {
    if (results.length >= 40) break;
    const gid = GENRE_IDS[genre];
    try {
      const url = gid
        ? `https://api.jikan.moe/v4/anime?genres=${gid}&min_score=${minMalScore.toFixed(1)}&order_by=score&sort=desc&limit=20&page=${page}&type=tv&sfw`
        : `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(genre)}&min_score=${minMalScore.toFixed(1)}&limit=20&sfw`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const d = await res.json();
      for (const a of (d.data||[])) {
        if (existingMalIds.has(a.mal_id) || seen.has(a.mal_id)) continue;
        seen.add(a.mal_id); results.push(a);
      }
      await new Promise(r => setTimeout(r, 350));
    } catch {}
  }

  const scored = results.map(a => {
    const aGenres = (a.genres||[]).map(g=>g.name);
    const overlap = topGenres.reduce((s,g,i) => aGenres.includes(g) ? s+(1-i*0.1) : s, 0);
    return { a, score: (a.score||0)*0.7 + overlap*0.3 };
  });
  // Shuffle for variety, then sort
  for (let i=scored.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[scored[i],scored[j]]=[scored[j],scored[i]];}
  scored.sort((a,b)=>b.score-a.score);
  const top = scored.slice(0,10);

  if (!top.length) {
    grid.innerHTML = `<div class="sp-reco-empty">Keine Empfehlungen gefunden – versuch "Neu laden".</div>`;
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate"></i> Neu laden';
    return;
  }

  grid.innerHTML = top.map(({ a }) => {
    const genres = (a.genres||[]).slice(0,3).map(g=>`<span class="reco-genre">${esc(g.name)}</span>`).join("");
    return `
      <div class="reco-card" id="reco-${a.mal_id}">
        <img src="${esc(a.images?.jpg?.large_image_url||NO_COVER_SVG)}" alt="" loading="lazy" onerror="noCover(this)">
        <div class="reco-info">
          <div class="reco-title">${esc(a.title_english||a.title)}</div>
          <div class="reco-meta">
            <span>${a.type||"TV"}</span>
            <span>${a.episodes||"?"} Ep.</span>
            <span>⭐ ${a.score?.toFixed(1)||"—"}</span>
          </div>
          <div class="reco-genres">${genres}</div>
          <div class="reco-links">
            <a href="https://myanimelist.net/anime/${a.mal_id}" target="_blank" class="reco-link" title="Auf MAL ansehen"><i class="fas fa-external-link-alt"></i> MAL</a>
            <a href="https://www.anime-planet.com/anime/all?include=${encodeURIComponent(a.title_english||a.title)}" target="_blank" class="reco-link" title="Dub/Sub-Verfügbarkeit prüfen"><i class="fas fa-language"></i> Dub/Sub</a>
          </div>
          <button class="reco-add-btn" data-mal-id="${a.mal_id}"><i class="fas fa-plus"></i> Hinzufügen</button>
        </div>
      </div>`;
  }).join("");

  grid.querySelectorAll(".reco-add-btn").forEach(b => {
    b.addEventListener("click", async e => {
      e.stopPropagation();
      const malId = parseInt(b.dataset.malId);
      const card = document.getElementById(`reco-${malId}`);
      b.disabled=true; b.innerHTML='<i class="fas fa-spinner fa-spin"></i>';
      try {
        const resp = await jikan(`/anime/${malId}`);
        if (resp.data) {
          openAddModal(resp.data);
          if (card) card.style.opacity="0.4";
          // Poll for the anime being saved, then fade-remove the card
          const check = setInterval(() => {
            try {
              const saved = JSON.parse(localStorage.getItem(SK)||"[]");
              if (saved.some(a=>a.malId===malId)) {
                clearInterval(check);
                if (card) { card.style.transition="opacity .4s,transform .4s"; card.style.opacity="0"; card.style.transform="scale(0.9)"; setTimeout(()=>card.remove(),400); }
              }
            } catch {}
          }, 600);
          setTimeout(()=>clearInterval(check), 60000);
        }
      } catch { msg("Fehler beim Laden.", true); b.disabled=false; b.innerHTML='<i class="fas fa-plus"></i> Hinzufügen'; if(card) card.style.opacity="1"; }
    });
  });

  btn.disabled=false; btn.innerHTML='<i class="fas fa-rotate"></i> Neu laden';
  const hint = $("spRecoWrap")?.querySelector(".sp-reco-hint");
  if (hint) hint.textContent = `Basierend auf: ${topGenres.slice(0,4).join(", ")} · Mindest-MAL-Score: ${minMalScore.toFixed(1)}`;
}


// ── Minimal Add Modal (saves back to localStorage) ──
let pendingMal = null;
function openAddModal(anime) {
  pendingMal = anime;
  const body = $("addBody"); if (!body) return;
  const preferredTitle = a => (a.title_english&&a.title_english.trim())||a.title;
  body.innerHTML = `
    <div class="add-preview">
      <img src="${esc(anime.images?.jpg?.large_image_url||"")}" alt="" onerror="noCover(this)">
      <div>
        <h3>${esc(preferredTitle(anime))}</h3>
        <div class="add-meta">
          <span><i class="fas fa-tv"></i> ${anime.type||"Anime"}</span>
          <span><i class="fas fa-list"></i> ${anime.episodes||"?"} Ep.</span>
          <span><i class="fas fa-star"></i> ${anime.score?.toFixed(1)||"—"}</span>
        </div>
      </div>
    </div>
    <div class="add-field">
      <label>Status</label>
      <select id="addStatus">
        <option value="Plan to Watch">Geplant</option>
        <option value="Currently Watching">Watching</option>
        <option value="Completed">Abgeschlossen</option>
        <option value="On Hold">Pausiert</option>
        <option value="Dropped">Abgebrochen</option>
      </select>
    </div>
    <div class="add-field">
      <label>Bewertung: <span id="addRatLabel">0.0</span></label>
      <input type="range" id="addRat" min="0" max="10" step="0.5" value="0">
    </div>
    <label class="add-fav-row"><input type="checkbox" id="addFav"> <i class="fas fa-heart" style="color:var(--accent)"></i> Favorit</label>`;
  $("addRat").addEventListener("input", e => { $("addRatLabel").textContent = parseFloat(e.target.value).toFixed(1); });
  $("addModal")?.classList.remove("hidden");
}

function confirmAdd() {
  if (!pendingMal) return;
  const pm = pendingMal;
  const preferredTitle = a => (a.title_english&&a.title_english.trim())||a.title;
  const altTitle = a => {
    const p = preferredTitle(a);
    if (a.title_english&&a.title_english.trim()&&a.title&&a.title!==p) return a.title;
    if (a.title_japanese&&a.title_japanese!==p) return a.title_japanese;
    return "";
  };

  let savedList = [];
  try { savedList = JSON.parse(localStorage.getItem(SK))||[]; } catch {}

  if (savedList.some(a=>a.malId===pm.mal_id)) { msg("Bereits in der Liste!"); $("addModal")?.classList.add("hidden"); return; }

  savedList.unshift({
    id: Date.now()+Math.floor(Math.random()*1000),
    malId: pm.mal_id,
    title: preferredTitle(pm),
    altTitle: altTitle(pm),
    status: $("addStatus")?.value||"Plan to Watch",
    episodesWatched: 0,
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
    addedAt: Date.now(),
    customCategories: [],
    relationsAt: null,
    relatedMalIds: []
  });

  try { localStorage.setItem(SK, JSON.stringify(savedList)); list = savedList; } catch {}
  $("addModal")?.classList.add("hidden");
  msg(`"${preferredTitle(pm)}" hinzugefügt!`);
  pendingMal = null;
}

// ── Wire up ──
document.addEventListener("DOMContentLoaded", () => {
  renderStats();
  $("recoLoadBtn")?.addEventListener("click", loadRecommendations);
  $("addClose")?.addEventListener("click",  () => $("addModal")?.classList.add("hidden"));
  $("addCancel")?.addEventListener("click", () => $("addModal")?.classList.add("hidden"));
  $("addConfirm")?.addEventListener("click", confirmAdd);
  $("addModal")?.addEventListener("click", e => {
    if (e.target === $("addModal")?.querySelector(".modal-bg")) $("addModal")?.classList.add("hidden");
  });
});

})();
