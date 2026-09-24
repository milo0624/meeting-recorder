"use strict";

/* ── 設定與用量：存在 localStorage（單一裝置使用，跟原 Windows 版
   用同一台電腦的 SQLite 概念相同，只是換成瀏覽器儲存）───────────── */
const STORAGE_KEY = "meeting_recorder_settings_v1";
const USAGE_KEY = "meeting_recorder_usage_v1";

const MODEL_LIMITS = {
  "gemini-flash-latest": { rpm: 10, rpd: 250, tpm: 250000 },
  "gemini-flash-lite-latest": { rpm: 15, rpd: 1000, tpm: 250000 },
  "gemini-pro-latest": { rpm: 5, rpd: 100, tpm: 250000 },
};

// Worker 目前是把整個音檔用 inline base64 塞進 Gemini 的 generateContent 請求，
// 而不是先呼叫 Gemini File API 拿 URI 再引用——inline 請求本身有大小上限，
// 實測大約 14MB 原始檔案（base64 後接近 19MB）左右就會被拒絕或逾時。
// 這裡在送出前先擋掉超過上限的檔案，避免使用者等了老半天才收到失敗訊息，
// 完全不會影響 App 內建錄音（見上面 24kbps 的調整）；但既有的大檔案上傳
// （例如外部錄的 1 小時 40MB 錄音）沒辦法用調位元率解決，真的要處理這種
// 檔案，Worker 端要改成先呼叫 File API 上傳、再用 URI 呼叫 generateContent。
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;

function loadSettings() {
  try {
    return { model: "gemini-flash-latest", workerUrl: "", userId: "", ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return { model: "gemini-flash-latest", workerUrl: "", userId: "" };
  }
}
function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function loadUsage() {
  try {
    return JSON.parse(localStorage.getItem(USAGE_KEY) || "[]");
  } catch {
    return [];
  }
}
function recordUsage(entry) {
  const rows = loadUsage();
  rows.push({ ts: Date.now(), ...entry });
  // 只留 3 天內的資料，避免 localStorage 無限長大
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  localStorage.setItem(USAGE_KEY, JSON.stringify(rows.filter(r => r.ts >= cutoff)));
}
function usageStats(model) {
  const limits = MODEL_LIMITS[model] || MODEL_LIMITS["gemini-flash-latest"];
  const rows = loadUsage();
  const now = Date.now();

  // RPD 用「太平洋時間」的日期分界，跟原本 Windows 版一致
  const pacToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);

  let rpd = 0, rpm = 0, tpm = 0, tokensToday = 0;
  for (const r of rows) {
    const pacDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(r.ts);
    if (pacDate === pacToday) { rpd += 1; tokensToday += r.total || 0; }
    if (now - r.ts <= 60_000) { rpm += 1; tpm += r.total || 0; }
  }
  return {
    rpd: { used: rpd, limit: limits.rpd },
    rpm: { used: rpm, limit: limits.rpm },
    tpm: { used: tpm, limit: limits.tpm },
  };
}
function wouldExceed(model) {
  const s = usageStats(model);
  const hit = [];
  if (s.rpd.limit && s.rpd.used >= s.rpd.limit) hit.push(`今日請求數已達上限 ${s.rpd.used}/${s.rpd.limit}（RPD）`);
  if (s.rpm.limit && s.rpm.used >= s.rpm.limit) hit.push(`本分鐘請求數已達上限 ${s.rpm.used}/${s.rpm.limit}（RPM）`);
  if (s.tpm.limit && s.tpm.used >= s.tpm.limit) hit.push(`本分鐘 token 數已達上限 ${s.tpm.used}/${s.tpm.limit}（TPM）`);
  return hit;
}

/* ── 報告樣板（對應原本的 report.py）─────────────────────────── */
function cleanFragment(raw) {
  let text = (raw || "").trim();
  const m = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (m) text = m[1].trim();
  return text;
}
function buildDocument(fragment, title = "會議記錄") {
  const generatedAt = new Date().toLocaleString("zh-TW", { hour12: false });
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:"PingFang TC","Noto Sans TC",-apple-system,sans-serif;line-height:1.7;color:#222;background:#f5f6f8;margin:0;padding:32px 16px;}
  .report{max-width:860px;margin:0 auto;background:#fff;padding:40px 48px;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);}
  h1{font-size:24px;margin:0 0 4px;}
  .meta{color:#888;font-size:13px;margin-bottom:28px;border-bottom:2px solid #eee;padding-bottom:16px;}
  h2{font-size:19px;color:#1a5e2e;margin:32px 0 12px;border-left:4px solid #2c7a3d;padding-left:10px;}
  h3{font-size:16px;margin:20px 0 8px;}
  ul,ol{padding-left:22px;} li{margin:4px 0;}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;}
  th,td{border:1px solid #d9dce1;padding:8px 12px;text-align:left;vertical-align:top;}
  th{background:#eef3ef;font-weight:600;}
  blockquote{border-left:3px solid #ccc;margin:12px 0;padding:4px 16px;color:#555;}
</style></head><body><div class="report">
<h1>${title}</h1><div class="meta">產生時間：${generatedAt}　·　會議錄音助理（Gemini）</div>
${cleanFragment(fragment)}
</div></body></html>`;
}
function buildPreview(fragment) {
  return `<style>
    body{font-family:"PingFang TC","Noto Sans TC",-apple-system,sans-serif;color:#222;margin:12px;}
    h2{color:#1a5e2e;} table{border-collapse:collapse;} th,td{border:1px solid #bbb;padding:4px 8px;} th{background:#eef3ef;}
  </style>${cleanFragment(fragment)}`;
}

/* ── DOM 參照 ─────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const elapsedEl = $("elapsed");
const statusText = $("statusText");
const statusDot = $("statusDot");
const recordBtn = $("recordBtn");
const recordLabel = $("recordLabel");
const extraInput = $("extraInput");
const busyRow = $("busyRow");
const busyText = $("busyText");
const vuSegs = Array.from(document.querySelectorAll(".vu__seg"));
const resultSection = $("resultSection");
const resultFrame = $("resultFrame");
const saveBtn = $("saveBtn");
const downloadRawBtn = $("downloadRawBtn");

let settings = loadSettings();
let lastReportHtml = null;
let lastFailedBlob = null; // 處理失敗時保留這次的錄音，供使用者下載救援

/* ── 錄音狀態 ─────────────────────────────────────────────────── */
let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let recording = false;
let starting = false; // 防止快速連點時重複啟動（會造成多組計時器疊加，停止時清不乾淨）
let startedAt = 0;
let timerHandle = null;
let audioCtx = null, analyser = null, analyserData = null, vuHandle = null;

async function startRecording() {
  if (recording || starting) return; // 錄音中或正在啟動時，忽略重複點擊
  starting = true;
  downloadRawBtn.hidden = true;
  lastFailedBlob = null;
  recordBtn.disabled = true; // 取得麥克風權限的過程中先鎖住按鈕，避免連點

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("無法取得麥克風權限：" + e.message);
    starting = false;
    recordBtn.disabled = false;
    return;
  }

  chunks = [];
  // 錄音格式優先順序：iOS/Safari 只支援 audio/mp4（AAC）——這剛好是 Gemini
  // 官方支援的格式之一。Chrome/Android 才會落到 ogg/webm。
  // webm 不在 Gemini 官方文件列出的支援格式（WAV/MP3/AIFF/AAC/OGG/FLAC）內，
  // 只是實務上多半也能被接受；若上傳失敗，優先確認是不是卡在這裡。
  const candidates = ["audio/mp4", "audio/ogg;codecs=opus", "audio/webm;codecs=opus"];
  const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  // 語音錄音不需要音樂等級的位元率。原本用 48kbps，1 小時的會議約 21.6MB，
  // 已經超過下面 MAX_UPLOAD_BYTES（14MB）的安全上限；降到 24kbps 之後
  // 1 小時約 10.8MB，錄到 80 分鐘左右才會撞到上限，語音清晰度仍然足夠。
  const recorderOptions = mimeType ? { mimeType, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 };
  mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start(1000);

  // VU 音量表：AnalyserNode 讀即時音量
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyserData = new Uint8Array(analyser.frequencyBinCount);
  src.connect(analyser);

  // 保險起見，啟動新計時器前先清掉任何殘留的舊計時器（理論上不該有，但避免萬一）
  if (timerHandle) clearInterval(timerHandle);
  if (vuHandle) clearInterval(vuHandle);

  recording = true;
  starting = false;
  recordBtn.disabled = false;
  startedAt = Date.now();
  recordBtn.setAttribute("aria-pressed", "true");
  statusDot.classList.add("live");
  recordLabel.textContent = "再按一次停止";
  statusText.textContent = "錄音中…";

  timerHandle = setInterval(tick, 200);
  vuHandle = setInterval(updateVu, 80);
}

function tick() {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  elapsedEl.textContent = `${m}:${s}`;
}

function updateVu() {
  analyser.getByteTimeDomainData(analyserData);
  let sum = 0;
  for (const v of analyserData) { const d = v - 128; sum += d * d; }
  const rms = Math.sqrt(sum / analyserData.length) / 128; // 0~1
  const level = Math.min(1, rms * 4); // 稍微放大方便觀察
  const litCount = Math.round(level * vuSegs.length);
  vuSegs.forEach((seg, i) => seg.classList.toggle("on", i < litCount));

  if (level < 0.02) {
    statusText.textContent = "錄音中… ⚠ 目前收不到聲音，請確認麥克風權限與是否靜音";
  } else {
    statusText.textContent = "錄音中… 🔊 有收到聲音";
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  clearInterval(timerHandle);
  clearInterval(vuHandle);
  vuSegs.forEach((seg) => seg.classList.remove("on"));
  recordBtn.setAttribute("aria-pressed", "false");
  statusDot.classList.remove("live");
  recordLabel.textContent = "按下開始錄音";
  mediaRecorder.stop();
  mediaStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
}

async function onRecordingStopped() {
  statusText.textContent = "錄音結束，準備送出給 Gemini…";
  const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
  await processAudio(blob);
}

/* ── 呼叫 Worker（Gemini 處理）────────────────────────────────── */
async function processAudio(blob) {
  if (!settings.workerUrl) {
    alert("尚未設定 Worker 端點網址，請先到「⚙ 設定」填寫。");
    openSettings();
    return;
  }

  if (blob.size > MAX_UPLOAD_BYTES) {
    const mb = (blob.size / 1024 / 1024).toFixed(1);
    const limitMb = (MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0);
    statusText.textContent = `檔案 ${mb}MB 超過目前上限（約 ${limitMb}MB），已取消上傳。`;
    alert(
      `這個音檔有 ${mb}MB，超過目前後端單次請求支援的上限（約 ${limitMb}MB）。\n\n` +
      `可以試試：\n` +
      `1) 之後改用這個 App 內建的錄音功能——已經調成 24kbps，1 小時約 10.8MB，安全很多；\n` +
      `2) 用其他工具把這個檔案轉成較低位元率的單聲道 AAC/Opus（例如 24～32kbps）再上傳；\n` +
      `3) 把長會議切成幾段，分開上傳、分開產生記錄。`
    );
    return;
  }

  const hit = wouldExceed(settings.model);
  if (hit.length && !confirm(hit.join("\n") + "\n\n仍要嘗試送出嗎？")) {
    statusText.textContent = "已取消送出。";
    return;
  }

  setBusy(true, "上傳音檔並請 Gemini 整理會議記錄…");
  try {
    // 上傳的既有檔案（File 物件）保留原始檔名/副檔名，錄音產生的 Blob 才用猜的
    const filename =
      typeof File !== "undefined" && blob instanceof File && blob.name
        ? blob.name
        : "meeting." + (blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm");
    const form = new FormData();
    form.append("audio", blob, filename);
    form.append("model", settings.model);
    form.append("user", settings.userId || "");
    form.append("extra", extraInput.value || "");
    form.append("focus", $("focusSelect").value || "general");

    const res = await fetch(settings.workerUrl.replace(/\/$/, "") + "/process", {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `伺服器錯誤（${res.status}）`);
    }

    const data = await res.json(); // { text, usage: {prompt_tokens, output_tokens, total_tokens} }
    recordUsage({
      model: settings.model,
      prompt: data.usage?.prompt_tokens || 0,
      output: data.usage?.output_tokens || 0,
      total: data.usage?.total_tokens || 0,
    });
    lastReportHtml = data.text;
    resultFrame.srcdoc = buildPreview(data.text);
    resultSection.hidden = false;
    saveBtn.disabled = false;
    statusText.textContent = `完成。本次用了 ${(data.usage?.total_tokens || 0).toLocaleString()} tokens。`;
    downloadRawBtn.hidden = true; // 成功了就不用留救援按鈕
    lastFailedBlob = null;
  } catch (e) {
    const msg = String(e.message || e);
    if (/429|resource_exhausted|quota|rate limit/i.test(msg)) {
      statusText.textContent = "已達免費額度上限（429），請稍後再試。";
    } else {
      statusText.textContent = "處理失敗，請重試。";
    }
    lastFailedBlob = blob; // 保留這次的錄音，讓使用者能救回原始檔案
    downloadRawBtn.hidden = false;
    alert("處理失敗：\n" + msg);
  } finally {
    setBusy(false);
    updateQuotaPanel();
  }
}

function setBusy(busy, msg) {
  busyRow.hidden = !busy;
  busyText.textContent = msg || "處理中…";
  recordBtn.disabled = busy;
  uploadTriggerBtn.disabled = busy;
}

/* ── 用量面板 ─────────────────────────────────────────────────── */
function updateQuotaPanel() {
  const s = usageStats(settings.model);
  applyMeter("rpd", s.rpd);
  applyMeter("rpm", s.rpm);
  applyMeter("tpm", s.tpm);
}
function applyMeter(key, item) {
  const ratio = item.limit ? item.used / item.limit : 0;
  $(key + "Num").textContent = `${item.used.toLocaleString()}/${item.limit.toLocaleString()}`;
  const fill = $(key + "Fill");
  fill.style.width = Math.min(100, ratio * 100) + "%";
  fill.style.background = ratio >= 1 ? "var(--danger)" : ratio >= 0.8 ? "var(--warn)" : "var(--ok)";
}

/* ── 設定畫面（版面切換，不是懸浮視窗）───────────────────────── */
const mainView = $("mainView");
const settingsView = $("settingsView");
function openSettings() {
  $("workerUrl").value = settings.workerUrl;
  $("modelSelect").value = settings.model;
  $("userIdInput").value = settings.userId || "";
  mainView.hidden = true;
  settingsView.hidden = false;
}
function closeSettings() {
  settingsView.hidden = true;
  mainView.hidden = false;
}

$("settingsBtn").addEventListener("click", openSettings);
$("settingsCancel").addEventListener("click", closeSettings);
$("settingsBack").addEventListener("click", closeSettings);
$("settingsSave").addEventListener("click", () => {
  try {
    let url = $("workerUrl").value.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      url = "https://" + url; // 忘記打 https:// 時自動補上
    }
    settings.workerUrl = url;
    settings.model = $("modelSelect").value;
    settings.userId = $("userIdInput").value.trim();
    saveSettings(settings);
    updateQuotaPanel();
    closeSettings();
    statusText.textContent = "設定已儲存。";
  } catch (e) {
    alert("儲存失敗：" + (e && e.message ? e.message : e));
  }
});

/* ── 錄音按鈕 ─────────────────────────────────────────────────── */
recordBtn.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

/* ── 上傳既有錄音檔（不用錄音，直接選檔案） ───────────────────── */
const uploadTriggerBtn = $("uploadTriggerBtn");
const fileInput = $("fileInput");

uploadTriggerBtn.addEventListener("click", () => {
  if (recording) {
    alert("正在錄音中，請先停止錄音再上傳檔案。");
    return;
  }
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = ""; // 清空，讓同一個檔案下次還能再選一次
  if (!file) return;

  elapsedEl.textContent = "--:--";
  statusText.textContent = `已選擇檔案：${file.name}，準備送出給 Gemini…`;
  await processAudio(file);
});

/* ── 下載 / 分享報告 ──────────────────────────────────────────── */
saveBtn.addEventListener("click", async () => {
  if (!lastReportHtml) return;
  const html = buildDocument(lastReportHtml);
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const file = new File([html], `minutes_${ts}.html`, { type: "text/html" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "會議記錄" });
      return;
    } catch { /* 使用者取消分享，改走下載 */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

/* ── 處理失敗時的救援：下載原始錄音檔 ─────────────────────────── */
downloadRawBtn.addEventListener("click", async () => {
  if (!lastFailedBlob) return;
  const ext = lastFailedBlob.type.includes("mp4") ? "m4a" : lastFailedBlob.type.includes("ogg") ? "ogg" : "webm";
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const filename = lastFailedBlob.name || `meeting_${ts}.${ext}`;
  const file = new File([lastFailedBlob], filename, { type: lastFailedBlob.type || "application/octet-stream" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "會議錄音（處理失敗，原始檔案）" });
      return;
    } catch { /* 使用者取消分享，改走下載 */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

/* ── 初始化 ───────────────────────────────────────────────────── */
updateQuotaPanel();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
