// WAKE 無料公開版。ログイン不要。
// newhunaken456(有料版と同一のVercelプロジェクト)の公開APIを叩くだけの軽量フロント。
//   - /api/yoso        : 出走表・展示・気象を取得(ログイン不要、既存の有料版と共通)
//   - /api/stats       : 選手の過去成績(race_results)を取得(ログイン不要、既存の有料版と共通)。
//                        枠別成績(win1/ren2/ren3)をここから組み立てて/api/predictへ渡す。
//                        これが無いと印判定の「枠別成績」項目が常にneutral扱いになり、
//                        4項目チェックが最大3止まりになって◎が出せなくなる。
//   - /api/predict     : AI予想を取得。Authorizationヘッダを付けないため、サーバー側で
//                        自動的に縮小レスポンス(総合1位・2位の艇・荒れ度バッジ・見送りAI判定・
//                        1〜6号艇全艇の予想1着率、印は上位2艇のみ)になる。買い目・スコア・
//                        根拠の内訳はサーバー側で最初から除外されており、このファイルにも一切含まれない。

const API_BASE = "https://newhunaken456.vercel.app";
const RACER_CAT = "直近6ヶ月";
const RACER_CAT_DAYS = 180;

// 競艇の艇番色(有料版と同じ配色)。1白/2黒/3赤/4青/5黄/6緑。
const LANE = {
  1: { bg: "#f5f5f0", fg: "#1a1a1a" },
  2: { bg: "#1a1a1a", fg: "#ffffff" },
  3: { bg: "#d93025", fg: "#ffffff" },
  4: { bg: "#1a73e8", fg: "#ffffff" },
  5: { bg: "#f9c513", fg: "#1a1a1a" },
  6: { bg: "#188038", fg: "#ffffff" },
};

// 江戸川・常滑は展示データが無いため、無料版の選択肢からは常に除外する
// (開催中でも選べない。開催中の場だけに絞るloadActiveVenuesのフィルタ対象にもしない)。
const VENUES = [
  "桐生", "戸田", "平和島", "多摩川", "浜名湖",
  "蒲郡", "津", "三国", "びわこ", "住之江",
  "尼崎", "鳴門", "丸亀", "児島", "宮島", "徳山",
  "下関", "若松", "芦屋", "福岡", "唐津", "大村",
];

function jstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(date);
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { dateStr: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) };
}

function jstToday() {
  return jstParts().dateStr;
}

// 有料版(src/App.jsx)のhistoryResultCutoffIso()と同じ考え方: 00:00〜07:59JSTは
// 当日分の結果がまだ全国分揃っていない可能性があるため一昨日まで、8:00以降は昨日まで。
function historyResultCutoffIso() {
  const { dateStr, hour } = jstParts();
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (hour < 8 ? -2 : -1));
  return d.toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function round1(v) {
  return Math.round(Number(v || 0) * 10) / 10;
}

function $(id) { return document.getElementById(id); }

function populateVenues(venues) {
  const venueSel = $("venue");
  venueSel.innerHTML = "";
  for (const v of venues) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    venueSel.appendChild(opt);
  }
  venueSel.disabled = false;
}

async function loadActiveVenues() {
  // 開催中(今日レースがある)場だけを選択肢にする。取得に失敗した場合だけ、
  // ツールを完全に使えなくしないよう全24場にフォールバックする。
  setStatus("開催場を確認中…");
  const qs = new URLSearchParams({ action: "schedules", date: jstToday() });
  try {
    const data = await fetchJson(`${API_BASE}/api/yoso?${qs.toString()}`, { cache: "no-store" });
    const statuses = data?.statusesByVenue || {};
    const active = VENUES.filter((v) => statuses[v]?.ok !== false && !statuses[v]?.noRace);
    populateVenues(active.length ? active : VENUES);
    setStatus(active.length ? "" : "本日開催中の場を確認できませんでした。全場を表示しています");
  } catch (e) {
    populateVenues(VENUES);
    setStatus("開催場の確認に失敗したため、全場を表示しています");
  }
}

function init() {
  const raceSel = $("raceNo");
  for (let r = 1; r <= 12; r++) {
    const opt = document.createElement("option");
    opt.value = String(r); opt.textContent = `${r}R`;
    raceSel.appendChild(opt);
  }
  // 日付は当日固定(選択不可)。過去日の予想は的中が確認できてしまい無料版の
  // 位置づけと合わないため、常に本日のレースだけを対象にする。
  $("raceDateDisplay").textContent = `${jstToday()}（本日）`;
  $("go").addEventListener("click", onGo);
  loadActiveVenues();
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function boatsFromRacers(racers) {
  const byBoat = {};
  for (const r of racers || []) {
    if (r?.boat) byBoat[r.boat] = r;
  }
  return byBoat;
}

async function fetchRaceResultsForRacers(regnos) {
  const nums = [...new Set((regnos || []).map((v) => Number(v)).filter(Boolean))];
  if (!nums.length) return [];
  const qs = new URLSearchParams({
    action: "race_results_by_regno",
    regnos: nums.join(","),
    days: String(RACER_CAT_DAYS),
    toDate: historyResultCutoffIso(),
  });
  const data = await fetchJson(`${API_BASE}/api/stats?${qs.toString()}`, { cache: "no-store" });
  if (!data?.ok) throw new Error(data?.error || "選手成績の取得に失敗しました");
  return Array.isArray(data.rows) ? data.rows : [];
}

// 有料版のbuildRacerCourseStatsFromDb(src/App.jsx)と同じ集計。
// 本人の登録番号×進入コースで絞った直近成績から1着率/2連対率/3連対率を出す。
function buildRacerStats(rows, regnoByBoat, coursesByBoat) {
  const win1 = Array(6).fill(null);
  const ren2 = Array(6).fill(null);
  const ren3 = Array(6).fill(null);
  const from = daysAgoIso(RACER_CAT_DAYS);

  for (let b = 1; b <= 6; b++) {
    const regno = Number(regnoByBoat[b] || 0);
    const course = Number(coursesByBoat[b] || 0);
    if (!regno || !course) continue;
    const filtered = (rows || []).filter((r) => {
      const rd = String(r.race_date || "").slice(0, 10);
      return Number(r.regno) === regno && Number(r.course) === course && rd >= from && r.rank != null;
    });
    const n = filtered.length;
    if (!n) continue;
    win1[b - 1] = round1((filtered.filter((r) => Number(r.rank) === 1).length / n) * 100);
    ren2[b - 1] = round1((filtered.filter((r) => Number(r.rank) <= 2).length / n) * 100);
    ren3[b - 1] = round1((filtered.filter((r) => Number(r.rank) <= 3).length / n) * 100);
  }

  return { win1: { [RACER_CAT]: win1 }, ren2: { [RACER_CAT]: ren2 }, ren3: { [RACER_CAT]: ren3 } };
}

async function onGo() {
  const venue = $("venue").value;
  const raceNo = $("raceNo").value;
  const raceDate = jstToday();
  if (!venue) return;

  $("go").disabled = true;
  $("resultCard").classList.add("hidden");
  setStatus("出走表・展示を確認中…");

  try {
    const yosoQs = new URLSearchParams({ venue, race: raceNo, date: raceDate });
    const yoso = await fetchJson(`${API_BASE}/api/yoso?${yosoQs.toString()}`, { cache: "no-store" });
    if (!yoso?.ok) throw new Error(yoso?.error || "出走表の取得に失敗しました");

    const byBoat = boatsFromRacers(yoso.racers);
    if (!Object.keys(byBoat).length) {
      throw new Error("この場・Rの出走表がまだ見つかりません。時間をおいて再度お試しください");
    }

    const rows = Array.isArray(yoso.rows) ? yoso.rows : [];
    const rowsByBoat = {};
    for (const r of rows) if (r?.boat) rowsByBoat[r.boat] = r;
    const hasFullDisplay = !yoso.displayPending
      && [1, 2, 3, 4, 5, 6].every((b) => rowsByBoat[b]?.tenji);

    if (!hasFullDisplay) {
      // 展示未取得(締切が近すぎる/遠すぎる等)の間は、根拠の薄い出走表だけの
      // 表示はせず、その旨だけを伝える。
      setStatus("展示未取得のため表示出来ません。");
      return;
    }

    setStatus("AI予想を計算中…");

    const courses = {};
    const inputs = {};
    for (let b = 1; b <= 6; b++) {
      const row = rowsByBoat[b] || {};
      courses[b] = Number(row.course) >= 1 && Number(row.course) <= 6 ? Number(row.course) : b;
      inputs[b] = {
        tenji: row.tenji || "",
        isshu: row.isshu || "",
        mawari: row.mawari || "",
        chokusen: row.chokusen || "",
      };
    }

    const regnoByBoat = {};
    const sts = {};
    for (let b = 1; b <= 6; b++) {
      regnoByBoat[b] = Number(byBoat[b]?.regNo || 0);
      sts[b] = byBoat[b]?.avgST || "";
    }
    // motors(モーター2連率/3連率)は出走表(str3)の時点で分かっている値。/api/yosoが
    // 既にracersToMotorMap()で組み立て済みのものをそのまま使う。
    const motors = yoso.motors && typeof yoso.motors === "object" ? yoso.motors : {};

    const raceResultRows = await fetchRaceResultsForRacers(Object.values(regnoByBoat));
    const racerStats = buildRacerStats(raceResultRows, regnoByBoat, courses);

    // Authorizationヘッダを付けない = 匿名呼び出し。サーバー側(api/predict.js)が
    // これを検知して、総合1位・2位の艇・荒れ度バッジ・見送りAI判定だけの縮小レスポンスを返す。
    const predict = await fetchJson(`${API_BASE}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venue, raceDate, raceNo, courses, inputs, sts, motors,
        racerStats, racerCat: RACER_CAT, wind: "無風",
      }),
    });
    if (!predict?.ok) throw new Error(predict?.error || "予想の計算に失敗しました");

    renderResult(byBoat, courses, predict.aiEval, venue, raceNo, raceDate);
    setStatus("");
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    $("go").disabled = false;
  }
}

function renderResult(byBoat, courses, aiEval, venue, raceNo, raceDate) {
  $("resultTitle").textContent = `${venue} ${raceNo}R（${raceDate}）AI予想`;

  const boatsEl = $("boats");
  boatsEl.innerHTML = "";
  // 印(◎○)は従来どおり総合上位2艇だけ。予想1着率は1〜6号艇すべて表示する。
  const win1ByBoat = {};
  for (const w of aiEval?.win1ByBoat || []) win1ByBoat[w.boat] = w;

  // 表示順は艇番ではなく進入コース順(1コース→6コース)にする。
  const boatByCourse = {};
  for (let b = 1; b <= 6; b++) boatByCourse[Number(courses[b]) || b] = b;

  for (let c = 1; c <= 6; c++) {
    const b = boatByCourse[c] || c;
    const r = byBoat[b];
    const w = win1ByBoat[b];
    const lane = LANE[b] || LANE[1];
    const div = document.createElement("div");
    div.className = w?.mark ? "boat top" : "boat";
    div.innerHTML = `
      <div class="no" style="background:${lane.bg};color:${lane.fg};">${b}</div>
      <div class="name">${r?.name || "―"}<span class="grade">${r?.grade || ""}コース${c}</span>
        ${w?.win1 != null ? `<div class="win1">予想1着率 <b>${w.win1}%</b></div>` : ""}
      </div>
      <div class="mark">${w?.mark || ""}</div>
    `;
    boatsEl.appendChild(div);
  }

  const pillsEl = $("pills");
  pillsEl.innerHTML = "";
  if (aiEval?.badge) {
    pillsEl.appendChild(makePill("荒れ度", aiEval.badge, aiEval.badgeColor));
  }
  if (aiEval?.miokuri?.verdict) {
    pillsEl.appendChild(makePill("見送りAI", aiEval.miokuri.verdict, aiEval.miokuri.color));
  }

  $("resultCard").classList.remove("hidden");
}

function makePill(label, value, color) {
  const span = document.createElement("span");
  span.className = "pill";
  span.style.color = color || "#e8eef5";
  span.innerHTML = `<span class="k">${label}</span>${value}`;
  return span;
}

init();
