// WAKE 無料公開版。ログイン不要。
// newhunaken456(有料版と同一のVercelプロジェクト)の公開APIを叩くだけの軽量フロント。
//   - /api/yoso        : 出走表・展示・気象を取得(ログイン不要、既存の有料版と共通)
//   - /api/predict     : AI予想を取得。Authorizationヘッダを付けないため、サーバー側で
//                        自動的に縮小レスポンス(総合1位の艇・荒れ度バッジ・見送りAI判定のみ)になる。
//                        買い目・全艇スコア・根拠の内訳はサーバー側で最初から除外されており、
//                        このファイルにも一切含まれない。

const API_BASE = "https://newhunaken456.vercel.app";

const VENUES = [
  "桐生", "戸田", "江戸川", "平和島", "多摩川", "浜名湖",
  "蒲郡", "常滑", "津", "三国", "びわこ", "住之江",
  "尼崎", "鳴門", "丸亀", "児島", "宮島", "徳山",
  "下関", "若松", "芦屋", "福岡", "唐津", "大村",
];

function jstToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}

function $(id) { return document.getElementById(id); }

function init() {
  const venueSel = $("venue");
  for (const v of VENUES) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    venueSel.appendChild(opt);
  }
  const raceSel = $("raceNo");
  for (let r = 1; r <= 12; r++) {
    const opt = document.createElement("option");
    opt.value = String(r); opt.textContent = `${r}R`;
    raceSel.appendChild(opt);
  }
  $("raceDate").value = jstToday();
  $("go").addEventListener("click", onGo);
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

async function onGo() {
  const venue = $("venue").value;
  const raceNo = $("raceNo").value;
  const raceDate = $("raceDate").value;
  if (!venue || !raceDate) return;

  $("go").disabled = true;
  $("resultCard").classList.add("hidden");
  setStatus("出走表・展示を確認中…");

  try {
    const yosoQs = new URLSearchParams({ venue, race: raceNo, date: raceDate });
    const yoso = await fetchJson(`${API_BASE}/api/yoso?${yosoQs.toString()}`, { cache: "no-store" });
    if (!yoso?.ok) throw new Error(yoso?.error || "出走表の取得に失敗しました");

    const byBoat = boatsFromRacers(yoso.racers);
    if (!Object.keys(byBoat).length) {
      throw new Error("この場・Rの出走表がまだ見つかりません。日付やRを確認してください");
    }

    const rows = Array.isArray(yoso.rows) ? yoso.rows : [];
    const rowsByBoat = {};
    for (const r of rows) if (r?.boat) rowsByBoat[r.boat] = r;
    const hasFullDisplay = !yoso.displayPending
      && [1, 2, 3, 4, 5, 6].every((b) => rowsByBoat[b]?.tenji);

    if (!hasFullDisplay) {
      renderBoatsOnly(byBoat, venue, raceNo, raceDate);
      setStatus("この場・Rはまだ展示が発表されていません。展示発表後にAI予想が表示されます。");
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

    // Authorizationヘッダを付けない = 匿名呼び出し。サーバー側(api/predict.js)が
    // これを検知して、総合1位の艇・荒れ度バッジ・見送りAI判定だけの縮小レスポンスを返す。
    const predict = await fetchJson(`${API_BASE}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venue, raceDate, raceNo, courses, inputs, wind: "無風",
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

function renderBoatsOnly(byBoat, venue, raceNo, raceDate) {
  $("resultTitle").textContent = `${venue} ${raceNo}R（${raceDate}）出走表`;
  const boatsEl = $("boats");
  boatsEl.innerHTML = "";
  for (let b = 1; b <= 6; b++) {
    const r = byBoat[b];
    const div = document.createElement("div");
    div.className = "boat";
    div.innerHTML = `
      <div class="no">${b}</div>
      <div class="name">${r?.name || "―"}<span class="grade">${r?.grade || ""}</span></div>
    `;
    boatsEl.appendChild(div);
  }
  $("pills").innerHTML = "";
  $("resultCard").classList.remove("hidden");
}

function renderResult(byBoat, courses, aiEval, venue, raceNo, raceDate) {
  $("resultTitle").textContent = `${venue} ${raceNo}R（${raceDate}）AI予想`;
  const topBoat = aiEval?.top?.boat || null;

  const boatsEl = $("boats");
  boatsEl.innerHTML = "";
  for (let b = 1; b <= 6; b++) {
    const r = byBoat[b];
    const isTop = topBoat === b;
    const div = document.createElement("div");
    div.className = `boat${isTop ? " top" : ""}`;
    div.innerHTML = `
      <div class="no">${b}</div>
      <div class="name">${r?.name || "―"}<span class="grade">${r?.grade || ""}コース${courses[b]}</span></div>
      <div class="mark">${isTop ? (aiEval?.top?.mark || "◎") : ""}</div>
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
