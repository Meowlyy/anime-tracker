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

// ISO week key like "2026-W05" — used by both the timeframe chart and the recap
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2,"0")}`;
}
// Given an ISO week key, returns the Monday date of that week
function dateFromIsoWeekKey(key) {
  const [y, w] = key.split("-W").map(Number);
  const simple = new Date(Date.UTC(y, 0, 1 + (w-1)*7));
  const dow = simple.getUTCDay();
  const monday = new Date(simple);
  if (dow <= 4) monday.setUTCDate(simple.getUTCDate() - dow + 1);
  else monday.setUTCDate(simple.getUTCDate() + 8 - dow);
  return monday;
}
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

function buildStatsData(timeframe = "year") {
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

  // Timeframe bucketing for the "completed over time" chart
  const hasCompletedAt = completed.some(a => a.completedAt);
  const bucketCount = {};
  let noDateCount = 0;

  completed.forEach(a => {
    if (!a.completedAt) { if (a.year) noDateCount++; return; }
    const d = new Date(a.completedAt);
    let key;
    if (timeframe === "year") key = String(d.getFullYear());
    else if (timeframe === "month") key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    else key = isoWeekKey(d);
    bucketCount[key] = (bucketCount[key]||0)+1;
  });

  let bucketEntries = Object.entries(bucketCount).sort((a,b)=>a[0].localeCompare(b[0]));
  if (timeframe !== "year") bucketEntries = bucketEntries.slice(-24);
  const years = bucketEntries;

  return { topGenres, ratingDist, statusCounts, topStudios, years, totalEp, hours,
    hasCompletedAt, noDateCount, timeframe,
    completedCount: completed.length,
    avgRating: rated.length ? (rated.reduce((s,a)=>s+a.rating,0)/rated.length).toFixed(1) : "—",
    favCount: list.filter(a=>a.favorite).length };
}

let _currentTimeframe = "year";
function renderStats(timeframe) {
  if (timeframe) _currentTimeframe = timeframe;
  const d = buildStatsData(_currentTimeframe);
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
      onHover:(e,els)=>{ e.native.target.style.cursor = els.length ? "pointer" : "default"; },
      onClick:(e,els)=>{ if(els.length) openGenreDrilldown(d.topGenres[els[0].index][0]); },
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
        <div class="sp-bar-item" data-studio="${esc(name)}" style="cursor:pointer">
          <div class="sp-bar-row">
            <span class="sp-bar-name">${esc(name)}</span>
            <span class="sp-bar-count">${count}</span>
          </div>
          <div class="sp-bar-track"><div class="sp-bar-fill" style="width:${Math.round(count/max*100)}%"></div></div>
        </div>`).join("");
      stEl.querySelectorAll(".sp-bar-item").forEach(el => {
        el.addEventListener("click", () => openStudioDrilldown(el.dataset.studio));
      });
    } else {
      stEl.innerHTML = `<div class="sp-reco-empty">Noch keine Studio-Daten — einmal "Daten reparieren" in der Hauptansicht ausführen.</div>`;
    }
  }

  // Update year chart title dynamically
  const tfLabels = { year:"Jahr", month:"Monat", week:"Woche" };
  const yearTitle = $("yearChartTitle");
  const yearSub = $("yearChartSub");
  if (yearTitle) yearTitle.textContent = `Anime abgeschlossen pro ${tfLabels[d.timeframe]}`;
  if (yearSub) yearSub.textContent = d.hasCompletedAt
    ? (d.noDateCount > 0
        ? `Basiert auf manuell eingetragenen Daten · ${d.noDateCount} abgeschlossene Anime ohne Datum sind hier nicht erfasst`
        : "Basiert auf deinen eingetragenen Abschluss-Daten")
    : "Noch keine Abschluss-Daten eingetragen — trag sie im Bearbeiten-Menü nach, um diesen Chart zu befüllen";

  // Friendlier label formatting per timeframe (e.g. "2026-03" → "Mär 2026")
  const MONTH_NAMES = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
  function formatBucketLabel(key) {
    if (d.timeframe === "month") {
      const [y,m] = key.split("-");
      return `${MONTH_NAMES[parseInt(m)-1]} ${y}`;
    }
    if (d.timeframe === "week") {
      return key.replace("-W", " · W");
    }
    return key; // year
  }

  destroyChart("year");
  const yCtx = $("yearChart")?.getContext("2d");
  if (yCtx && d.years.length) _charts.year = new Chart(yCtx, {
    type:"bar", data:{ labels:d.years.map(y=>formatBucketLabel(y[0])),
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
    if (results.length >= 60) break;
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
  const top = scored.slice(0,16);

  if (!top.length) {
    grid.innerHTML = `<div class="sp-reco-empty">Keine Empfehlungen gefunden – versuch "Neu laden".</div>`;
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate"></i> Neu laden';
    return;
  }

  grid.innerHTML = top.map(({ a }) => {
    const genres = (a.genres||[]).slice(0,3).map(g=>`<span class="reco-genre">${esc(g.name)}</span>`).join("");
    return `
      <div class="reco-card" id="reco-${a.mal_id}" data-mal-id="${a.mal_id}">
        <img src="${esc(a.images?.jpg?.large_image_url||NO_COVER_SVG)}" alt="" loading="lazy" onerror="noCover(this)">
        <div class="reco-info">
          <div class="reco-title">${esc(a.title_english||a.title)}</div>
          <div class="reco-meta">
            <span>${a.type||"TV"}</span>
            <span>${a.episodes||"?"} Ep.</span>
            <span>⭐ ${a.score?.toFixed(1)||"—"}</span>
          </div>
          <div class="reco-genres">${genres}</div>
          <div class="reco-spacer"></div>
          <div class="reco-links">
            <a href="https://myanimelist.net/anime/${a.mal_id}" target="_blank" class="reco-link" title="Auf MAL ansehen" onclick="event.stopPropagation()"><i class="fas fa-external-link-alt"></i> MAL</a>
            <a href="https://www.anime-planet.com/anime/all?include=${encodeURIComponent(a.title_english||a.title)}" target="_blank" class="reco-link" title="Dub/Sub-Verfügbarkeit prüfen" onclick="event.stopPropagation()"><i class="fas fa-language"></i> Dub/Sub</a>
          </div>
          <button class="reco-add-btn" data-mal-id="${a.mal_id}"><i class="fas fa-plus"></i> Hinzufügen</button>
        </div>
      </div>`;
  }).join("");

  // Store full data for detail view lookups
  window._recoDataByMalId = window._recoDataByMalId || {};
  top.forEach(({a}) => window._recoDataByMalId[a.mal_id] = a);

  // Click card (but not its buttons/links) → open detail view
  grid.querySelectorAll(".reco-card").forEach(card => {
    card.addEventListener("click", e => {
      if (e.target.closest("a") || e.target.closest("button")) return;
      const malId = parseInt(card.dataset.malId);
      const data = window._recoDataByMalId[malId];
      if (data) openRecoDetail(data);
    });
  });

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


// ── Year recap ("Wrapped" style) ──
function roundRectPathStats(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}
function loadImgStats(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
    setTimeout(rej, 4000);
  });
}

let _recapTimeframe = "year";

function populateRecapPeriods() {
  const sel = $("recapPeriodSel");
  if (!sel) return;
  const now = new Date();

  if (_recapTimeframe === "year") {
    const years = new Set([now.getFullYear()]);
    list.forEach(a => { if (a.completedAt) years.add(new Date(a.completedAt).getFullYear()); });
    const sorted = [...years].sort((a,b)=>b-a);
    sel.innerHTML = sorted.map(y => `<option value="${y}">${y}</option>`).join("");
  } else if (_recapTimeframe === "month") {
    const months = new Set([`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`]);
    list.forEach(a => { if (a.completedAt) { const d=new Date(a.completedAt); months.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`); } });
    const MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
    const sorted = [...months].sort().reverse();
    sel.innerHTML = sorted.map(key => {
      const [y,m] = key.split("-");
      return `<option value="${key}">${MONTH_NAMES[parseInt(m)-1]} ${y}</option>`;
    }).join("");
  } else { // week
    const weeks = new Set([isoWeekKey(now)]);
    list.forEach(a => { if (a.completedAt) weeks.add(isoWeekKey(new Date(a.completedAt))); });
    const sorted = [...weeks].sort().reverse();
    sel.innerHTML = sorted.map(key => {
      const monday = dateFromIsoWeekKey(key);
      const label = monday.toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit"});
      return `<option value="${key}">${key.split("-W")[1]?.replace(/^0/,"")===""?key:"KW "+parseInt(key.split("-W")[1])} · ab ${label}</option>`;
    }).join("");
  }
}

function matchesPeriod(completedAt, timeframe, periodKey) {
  const d = new Date(completedAt);
  if (timeframe === "year") return String(d.getFullYear()) === String(periodKey);
  if (timeframe === "month") return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}` === periodKey;
  return isoWeekKey(d) === periodKey; // week
}

function formatPeriodLabel(timeframe, periodKey) {
  if (timeframe === "year") return periodKey;
  if (timeframe === "month") {
    const MONTH_NAMES = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
    const [y,m] = periodKey.split("-");
    return `${MONTH_NAMES[parseInt(m)-1]} ${y}`;
  }
  const monday = dateFromIsoWeekKey(periodKey);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate()+6);
  const fmt = d => d.toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit"});
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

function getRecapData(timeframe, periodKey) {
  const inPeriod = list.filter(a => a.completedAt && matchesPeriod(a.completedAt, timeframe, periodKey));
  const totalEp = inPeriod.reduce((s,a)=>s+(a.totalEpisodes||a.episodesWatched||0),0);
  const hours = Math.round(totalEp * 24 / 60);

  const genreCount = {};
  inPeriod.forEach(a => (a.genres||[]).forEach(g => genreCount[g]=(genreCount[g]||0)+1));
  const topGenre = Object.entries(genreCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

  const rated = inPeriod.filter(a=>a.rating).sort((a,b)=>b.rating-a.rating);
  const topThree = rated.slice(0,3);

  const addedInPeriod = list.filter(a => a.addedAt && matchesPeriod(a.addedAt, timeframe, periodKey)).length;

  return { timeframe, periodKey, label: formatPeriodLabel(timeframe, periodKey),
    count: inPeriod.length, hours, topGenre, topThree, addedInPeriod };
}

async function buildRecapCanvas(timeframe, periodKey) {
  try { await document.fonts.load("700 26px Poppins"); await document.fonts.ready; } catch {}
  const d = getRecapData(timeframe, periodKey);
  const showCount = Math.min(3, d.topThree.length); // adapts to 0-3 automatically
  const items = d.topThree.slice(0, showCount);

  // ── Deterministic vertical layout: every offset is computed from the one before it,
  // so nothing overlaps and no space is wasted regardless of how many top-anime are shown. ──
  const W = 720;
  const M = 44; // side margin

  const brandY = 50, brandSubY = 73;
  const topPad = 118;                    // space after brand block
  const periodTagY = topPad;             // small caps "JAHRES-RECAP" baseline
  const periodTitleY = periodTagY + 46;  // big period label baseline

  const statsGapAbove = 58;
  const statY = periodTitleY + statsGapAbove;      // big stat numbers baseline
  const statLabelY = statY + 30;                    // "Anime abgeschlossen" / "Stunden" baseline

  const pillsGapAbove = 44;
  const pillsTop = statLabelY + pillsGapAbove;      // top of genre/added pills
  const pillH = 36;
  const pillsBottom = pillsTop + pillH;

  const hasPills = !!(d.topGenre || d.addedInPeriod > 0);
  const sectionGapAbove = hasPills ? 46 : 30;
  const sectionLabelY = (hasPills ? pillsBottom : statLabelY) + sectionGapAbove; // "TOP ANIME" baseline

  const cardGapAbove = 26;
  const cw = showCount === 1 ? 240 : showCount === 2 ? 220 : 195;
  const baseCh = cw * 1.42;
  const rankExtra = showCount === 3 ? 24 : 0; // podium raise for #1 only makes sense with 3
  const cardTopMax = sectionLabelY + cardGapAbove; // topmost point among all cards (rank 1 if raised)
  const cardBottom = cardTopMax + rankExtra + baseCh; // shared bottom edge for every card

  const titleGapBelow = 26;
  const bottomPad = 40;
  const H = showCount > 0 ? Math.round(cardBottom + titleGapBelow + bottomPad) : Math.round(sectionLabelY + 60);

  const SCALE = 1.35;
  const canvas = document.createElement("canvas");
  canvas.width = W*SCALE; canvas.height = H*SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  // Preload cover images for the shown items
  const topImgs = await Promise.all(items.map(a => a.imageUrl ? loadImgStats(a.imageUrl).catch(()=>null) : Promise.resolve(null)));

  // ── Background ──
  ctx.fillStyle = "#0b1020";
  ctx.fillRect(0,0,W,H);
  if (topImgs[0]) {
    ctx.save();
    ctx.filter = "blur(34px) brightness(0.38) saturate(1.35)";
    const sc = Math.max(W/topImgs[0].width, H/topImgs[0].height) * 1.2;
    const dw = topImgs[0].width*sc, dh = topImgs[0].height*sc;
    ctx.drawImage(topImgs[0], (W-dw)/2, (H-dh)/2, dw, dh);
    ctx.restore();
  } else {
    const g = ctx.createRadialGradient(W/2,H*0.3,50,W/2,H*0.3,W*0.9);
    g.addColorStop(0,"rgba(255,79,216,.18)"); g.addColorStop(1,"rgba(11,16,32,1)");
    ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
  }
  const overlay = ctx.createLinearGradient(0,0,0,H);
  overlay.addColorStop(0,"rgba(5,8,22,.65)"); overlay.addColorStop(0.35,"rgba(5,8,22,.45)");
  overlay.addColorStop(0.65,"rgba(5,8,22,.8)"); overlay.addColorStop(1,"rgba(5,8,22,.98)");
  ctx.fillStyle = overlay; ctx.fillRect(0,0,W,H);

  // Decorative top accent line — the only "sign-off" flourish, kept once, no repeated branding
  const accentGrad = ctx.createLinearGradient(0,0,W,0);
  accentGrad.addColorStop(0,"#ff4fd8"); accentGrad.addColorStop(1,"#a855f7");
  ctx.fillStyle = accentGrad;
  ctx.fillRect(0,0,W,5);

  // ── Brand mark (appears exactly once) ──
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.font = "700 26px 'Poppins', sans-serif"; ctx.fillStyle = "#ff7fe0";
  ctx.fillText("˚ʚ Meowly ₊✧", M, brandY);
  ctx.font = "600 12px 'Poppins', sans-serif"; ctx.fillStyle = "rgba(255,255,255,.5)";
  ctx.fillText("A N I M E   T R A C K E R", M, brandSubY);
  ctx.textBaseline = "alphabetic";

  const TF_LABEL = { year:"JAHRES-RECAP", month:"MONATS-RECAP", week:"WOCHEN-RECAP" };

  // ── Period heading ──
  ctx.textAlign = "center";
  ctx.font = "700 15px 'Poppins', sans-serif"; ctx.fillStyle = "#c084fc";
  ctx.fillText(TF_LABEL[timeframe] || "RECAP", W/2, periodTagY);
  ctx.font = "800 42px 'Poppins', sans-serif"; ctx.fillStyle = "#fff";
  ctx.fillText(d.label, W/2, periodTitleY);

  // ── Stat row: count + hours side by side ──
  const statGapFromCenter = 130;
  ctx.font = "800 72px 'Poppins', sans-serif"; ctx.fillStyle = "#ff4fd8";
  ctx.fillText(String(d.count), W/2 - statGapFromCenter, statY);
  ctx.font = "800 72px 'Poppins', sans-serif"; ctx.fillStyle = "#a855f7";
  ctx.fillText(String(d.hours), W/2 + statGapFromCenter, statY);

  ctx.font = "600 15px 'Poppins', sans-serif"; ctx.fillStyle = "rgba(255,255,255,.7)";
  ctx.fillText("Anime abgeschlossen", W/2 - statGapFromCenter, statLabelY);
  ctx.fillText("Stunden geschätzt", W/2 + statGapFromCenter, statLabelY);

  ctx.strokeStyle = "rgba(255,255,255,.15)"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(W/2, statY-52); ctx.lineTo(W/2, statLabelY+6); ctx.stroke();

  // ── Info pills row: genre + newly-added, side by side, fills the width evenly ──
  if (hasPills) {
    ctx.font = "700 14px 'Poppins', sans-serif";
    const pills = [];
    if (d.topGenre) pills.push({ text: `✦ ${d.topGenre}`, color: "#ff4fd8", textColor: "#ff9fe8" });
    if (d.addedInPeriod > 0) pills.push({ text: `+${d.addedInPeriod} neu hinzugefügt`, color: "#a855f7", textColor: "#d8b4fe" });

    const widths = pills.map(p => ctx.measureText(p.text).width + 38);
    const pillGap = 14;
    const totalPillsW = widths.reduce((s,w)=>s+w,0) + pillGap*(pills.length-1);
    let px = W/2 - totalPillsW/2;
    pills.forEach((p,i) => {
      const w = widths[i];
      ctx.fillStyle = p.color+"28"; ctx.strokeStyle = p.color+"70"; ctx.lineWidth = 1.3;
      roundRectPathStats(ctx, px, pillsTop, w, pillH, pillH/2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = p.textColor;
      ctx.fillText(p.text, px+w/2, pillsTop+pillH/2+5);
      px += w + pillGap;
    });
  }

  // ── Top anime section ──
  if (showCount > 0) {
    ctx.font = "700 16px 'Poppins', sans-serif"; ctx.fillStyle = "rgba(255,255,255,.6)";
    const sectionLabel = showCount === 1 ? "DEIN TOP-ANIME" : `DEINE TOP ${showCount}`;
    ctx.fillText(sectionLabel, W/2, sectionLabelY);

    const RANK_COLORS = ["#fbbf24","#d1d5db","#f0a875"];
    const RANK_ICONS = ["🥇","🥈","🥉"];
    const gap = 20;
    const totalW = cw*showCount + gap*(showCount-1);
    let cx = W/2 - totalW/2;

    items.forEach((a, i) => {
      const extra = (showCount === 3 && i === 0) ? rankExtra : 0;
      const ch = baseCh + extra;
      const thisCy = cardBottom - ch;

      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 28; ctx.shadowOffsetY = 12;
      roundRectPathStats(ctx, cx, thisCy, cw, ch, 14);
      ctx.fillStyle = "#111827"; ctx.fill();
      ctx.restore();

      const img = topImgs[i];
      if (img) {
        ctx.save();
        roundRectPathStats(ctx, cx, thisCy, cw, ch, 14);
        ctx.clip();
        const s2 = Math.max(cw/img.width, ch/img.height);
        const dw2 = img.width*s2, dh2 = img.height*s2;
        ctx.drawImage(img, cx+(cw-dw2)/2, thisCy+(ch-dh2)/2, dw2, dh2);
        ctx.restore();
      } else {
        ctx.save();
        roundRectPathStats(ctx, cx, thisCy, cw, ch, 14);
        ctx.clip();
        ctx.fillStyle = "#1a2035";
        ctx.fillRect(cx, thisCy, cw, ch);
        ctx.strokeStyle = "rgba(255,79,216,.35)"; ctx.lineWidth = 2;
        roundRectPathStats(ctx, cx+cw/2-24, thisCy+ch/2-30, 48, 34, 6); ctx.stroke();
        ctx.font = "600 11px 'Poppins', sans-serif"; ctx.fillStyle = "rgba(255,255,255,.4)";
        ctx.fillText("Kein Cover", cx+cw/2, thisCy+ch/2+22);
        ctx.restore();
      }

      ctx.strokeStyle = "rgba(255,255,255,.1)"; ctx.lineWidth = 1;
      roundRectPathStats(ctx, cx, thisCy, cw, ch, 14); ctx.stroke();

      if (showCount > 1) {
        ctx.font = "24px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(RANK_ICONS[i] || "", cx+8, thisCy+30);
        ctx.textAlign = "center";
      }

      ctx.font = "700 13px 'Poppins', sans-serif";
      const rs = a.rating.toFixed(1);
      const rw = ctx.measureText(`⭐ ${rs}`).width + 22;
      const pillHgt = 28, pillBottomGap = 10;
      const ratingPillTop = cardBottom - pillBottomGap - pillHgt;
      ctx.fillStyle = "rgba(5,8,22,.88)"; ctx.strokeStyle = (RANK_COLORS[i]||"#ff4fd8")+"90"; ctx.lineWidth = 1.2;
      roundRectPathStats(ctx, cx+cw/2-rw/2, ratingPillTop, rw, pillHgt, pillHgt/2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fbbf24";
      ctx.fillText(`⭐ ${rs}`, cx+cw/2, ratingPillTop+pillHgt/2+4.5);

      ctx.font = "700 13px 'Poppins', sans-serif"; ctx.fillStyle = "#fff";
      const maxChars = showCount === 1 ? 28 : 22;
      const title = a.title.length > maxChars ? a.title.slice(0,maxChars)+"…" : a.title;
      ctx.fillText(title, cx+cw/2, cardBottom+titleGapBelow);

      cx += cw + gap;
    });
  } else {
    ctx.font = "500 16px 'Poppins', sans-serif"; ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.fillText("Noch keine Bewertung in diesem Zeitraum", W/2, sectionLabelY+40);
  }

  ctx.textAlign = "left";
  return canvas;
}

function openRecapPreview(canvas, year) {
  const dataUrl = canvas.toDataURL("image/png");
  $("recapPreviewImg").src = dataUrl;
  const filename = `meowly_recap_${year}.png`;
  $("recapDownloadBtn").onclick = () => {
    const link = document.createElement("a");
    link.download = filename; link.href = dataUrl; link.click();
    msg("Recap gespeichert!");
  };
  $("recapCopyBtn").onclick = async () => {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      msg("In Zwischenablage kopiert!");
    } catch { msg("Kopieren nicht unterstützt – nutze 'Speichern'.", true); }
  };
  $("recapPreviewModal")?.classList.remove("hidden");
}

// ── Genre / Studio drilldown ──
function renderDrillGrid(title, icon, items) {
  $("drillTitle").innerHTML = `<i class="${icon}"></i> ${esc(title)} <span class="sg-count">${items.length}</span>`;
  const body = $("drillBody");
  if (!items.length) { body.innerHTML = `<div class="sp-reco-empty">Keine Anime gefunden.</div>`; }
  else {
    const avgRating = items.filter(a=>a.rating).length
      ? (items.filter(a=>a.rating).reduce((s,a)=>s+a.rating,0) / items.filter(a=>a.rating).length).toFixed(1)
      : "—";
    body.innerHTML = `
      <div class="ext-info" style="margin-bottom:16px"><i class="fas fa-star" style="color:var(--accent2);margin-right:6px"></i>Ø Bewertung: <strong>${avgRating}</strong> über ${items.length} Anime</div>
      <div class="bigsearch-grid">
        ${items.sort((a,b)=>(b.rating||0)-(a.rating||0)).map(a => `
          <div class="bsr-card" style="cursor:default">
            <img src="${esc(a.imageUrl||NO_COVER_SVG)}" alt="" loading="lazy" onerror="noCover(this)">
            <div class="bsr-info">
              <div class="bsr-title">${esc(a.title)}</div>
              <div class="bsr-meta">
                <span>${a.type||"TV"}</span>
                <span>${a.episodesWatched||0}/${a.totalEpisodes||"?"} Ep.</span>
                <span>${a.rating?("⭐ "+a.rating.toFixed(1)):"unbewertet"}</span>
              </div>
            </div>
          </div>`).join("")}
      </div>`;
  }
  $("drillModal")?.classList.remove("hidden");
}
function openGenreDrilldown(genre) {
  renderDrillGrid(genre, "fas fa-tag", list.filter(a => (a.genres||[]).includes(genre)));
}
function openStudioDrilldown(studio) {
  renderDrillGrid(studio, "fas fa-building", list.filter(a => (a.studios||[]).some(s => (typeof s==="string"?s:s.name)===studio)));
}

// ── Recommendation detail view ──
let _recoDetailMalId = null;
function openRecoDetail(a) {
  _recoDetailMalId = a.mal_id;
  const modal = $("recoDetailModal"), body = $("recoDetailBody"), titleEl = $("recoDetailTitle");
  if (!modal || !body) return;
  const title = a.title_english || a.title;
  if (titleEl) titleEl.textContent = title;
  const genres = (a.genres||[]).map(g=>`<span class="reco-genre">${esc(g.name)}</span>`).join("");
  body.innerHTML = `
    <div class="reco-detail-layout">
      <img src="${esc(a.images?.jpg?.large_image_url||NO_COVER_SVG)}" alt="" onerror="noCover(this)">
      <div class="reco-detail-info">
        ${a.title !== title ? `<div class="franchise-alt" style="margin-bottom:8px">${esc(a.title)}</div>` : ""}
        <div class="reco-meta" style="font-size:.85rem;margin-bottom:10px">
          <span>${a.type||"TV"}</span>
          <span>${a.episodes||"?"} Episoden</span>
          <span>⭐ ${a.score?.toFixed(1)||"—"} / 10</span>
          <span>${a.year||"?"}</span>
        </div>
        <div class="reco-genres" style="margin-bottom:14px">${genres}</div>
        <p style="font-size:.85rem;line-height:1.55;color:var(--dim);max-height:220px;overflow-y:auto">${esc(a.synopsis||"Keine Beschreibung verfügbar.")}</p>
        <div class="reco-links" style="margin-top:14px">
          <a href="https://myanimelist.net/anime/${a.mal_id}" target="_blank" class="reco-link"><i class="fas fa-external-link-alt"></i> Auf MAL ansehen</a>
          <a href="https://www.anime-planet.com/anime/all?include=${encodeURIComponent(title)}" target="_blank" class="reco-link"><i class="fas fa-language"></i> Dub/Sub prüfen</a>
        </div>
      </div>
    </div>`;
  modal.classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  populateRecapPeriods();
  document.querySelectorAll("#recapTfToggle .sp-tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#recapTfToggle .sp-tf-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      _recapTimeframe = btn.dataset.tf;
      populateRecapPeriods();
    });
  });
  $("recapBtn")?.addEventListener("click", async () => {
    const btn = $("recapBtn");
    const periodKey = $("recapPeriodSel")?.value;
    if (!periodKey) { msg("Kein Zeitraum verfügbar.", true); return; }
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Erstelle…';
    try {
      const canvas = await buildRecapCanvas(_recapTimeframe, periodKey);
      openRecapPreview(canvas, periodKey);
    } catch { msg("Fehler beim Erstellen des Recaps.", true); }
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Recap erstellen';
  });
  $("recapPreviewClose")?.addEventListener("click", ()=>$("recapPreviewModal")?.classList.add("hidden"));
  $("recapPreviewModal")?.addEventListener("click", e => { if (e.target===$("recapPreviewModal")?.querySelector(".modal-bg")) $("recapPreviewModal")?.classList.add("hidden"); });
  $("drillClose")?.addEventListener("click", ()=>$("drillModal")?.classList.add("hidden"));
  $("drillModal")?.addEventListener("click", e => { if (e.target===$("drillModal")?.querySelector(".modal-bg")) $("drillModal")?.classList.add("hidden"); });

  $("recoDetailClose")?.addEventListener("click", ()=>$("recoDetailModal")?.classList.add("hidden"));
  $("recoDetailCancel")?.addEventListener("click", ()=>$("recoDetailModal")?.classList.add("hidden"));
  $("recoDetailModal")?.addEventListener("click", e => { if (e.target===$("recoDetailModal")?.querySelector(".modal-bg")) $("recoDetailModal")?.classList.add("hidden"); });
  $("recoDetailAdd")?.addEventListener("click", async () => {
    if (!_recoDetailMalId) return;
    const btn = $("recoDetailAdd");
    btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    try {
      const resp = await jikan(`/anime/${_recoDetailMalId}`);
      if (resp.data) { $("recoDetailModal")?.classList.add("hidden"); openAddModal(resp.data); }
    } catch { msg("Fehler beim Laden.", true); }
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus"></i> Zur Liste hinzufügen';
  });
});

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
  document.querySelectorAll(".sp-tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sp-tf-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderStats(btn.dataset.tf);
    });
  });
  $("recoLoadBtn")?.addEventListener("click", loadRecommendations);
  $("addClose")?.addEventListener("click",  () => $("addModal")?.classList.add("hidden"));
  $("addCancel")?.addEventListener("click", () => $("addModal")?.classList.add("hidden"));
  $("addConfirm")?.addEventListener("click", confirmAdd);
  $("addModal")?.addEventListener("click", e => {
    if (e.target === $("addModal")?.querySelector(".modal-bg")) $("addModal")?.classList.add("hidden");
  });
});

})();
