/**
 * Cloudflare Worker：前端不會碰到 Gemini API Key，Key 存在這裡的
 * 環境變數（wrangler secret），只有這支 Worker 會用它呼叫 Gemini。
 *
 * 改用 Gemini Files API（兩段式上傳），不再受 20MB inline 請求限制，
 * 檔案最大可到 100MB——一般會議（就算超過一小時）綽綽有餘。
 *
 * 部署後，把這支 Worker 的網址填進手機網頁版的「設定 → Worker 端點網址」。
 *
 * 路由：
 *   POST /process   multipart/form-data: audio(file), model(string), extra(string)
 *                    → { text, usage: {prompt_tokens, output_tokens, total_tokens} }
 */

const MINUTES_PROMPT = `你是專業的會議記錄助理。以下附上一段會議錄音，請「先聽完整段」再用繁體中文（zh-TW）輸出一份結構化的會議記錄與資料統整。

【輸出格式：HTML】
只輸出 HTML 內容片段，不要 Markdown、不要 \`\`\`html 圍欄、不要 <html>/<head>/<body> 外層標籤。
只使用這些標籤：<h2> 區塊標題、<h3> 次標題、<p> 段落、<ul>/<li> 條列、<table>/<tr>/<th>/<td> 表格、<strong> 強調、<blockquote> 引述。
請包含以下六個 <h2> 區塊（若某區塊無內容，該區塊內寫 <p>（無）</p>）：

<h2>一、會議摘要</h2>
用 3-5 句話概述本次會議的目的與結論。

<h2>二、討論重點</h2>
以 <ul> 條列主要討論議題與各方觀點。

<h2>三、決議事項</h2>
以 <ul> 條列具體決定。

<h2>四、待辦事項（Action Items）</h2>
用 <table> 呈現，表頭為 事項 / 負責人 / 期限。
若錄音中沒提到負責人或期限，該欄填「未指定」。

<h2>五、數據與資料統整</h2>
把錄音中提到的數字、金額、日期、比例、規格、名稱等關鍵資料整理成 <ul> 或 <table>，方便後續查閱。

<h2>六、逐字稿（重點節錄）</h2>
以 <blockquote> 或 <p> 節錄關鍵對話段落（不需全部逐字），標示大致的說話者（如「發言者A」）。

注意：
- 若聽不清楚或不確定，標註「（聽不清）」，不要杜撰。
- 專有名詞、人名、料號、公司名盡量照音辨識，拿不準時保留原音並加註「(音)」。`;

// ── 報告視角：影響產出內容的側重點，不是換掉整體格式 ─────────────
const FOCUS_PRESETS = {
  engineer:
    "這份報告主要給工程師/執行端閱讀，請在不省略六大區塊的前提下，特別加強" +
    "「數據與資料統整」跟「待辦事項」的細節（規格、料號、參數、技術限制），" +
    "待辦事項盡量具體到可執行的動作。",
  manager:
    "這份報告主要給主管/決策者閱讀，請在不省略六大區塊的前提下，" +
    "「會議摘要」跟「決議事項」要更精簡有重點，並在數據統整或待辦事項裡" +
    "特別標出跟預算、時程、風險有關的項目（如果錄音中有提到的話）。",
};

// 上傳容器 → 送給 Gemini 的 mimeType。
// Gemini 官方文件列出的支援格式：WAV / MP3 / AIFF / AAC / OGG / FLAC。
// webm 不在官方清單內，先照容器原樣送出，若 Gemini 拒收要考慮改前端錄音格式。
function guessGeminiMimeType(filename, blobType) {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".m4a") || blobType.includes("mp4")) return "audio/aac";
  if (lower.endsWith(".ogg") || blobType.includes("ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mp3";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".aif") || lower.endsWith(".aiff")) return "audio/aiff";
  return "audio/webm";
}

// ── 每個人自己的 Gemini Key ──────────────────────────────────────
// 左邊是 App 裡填的「使用者代號」，右邊是這個人的 Key 存在 Cloudflare 的
// 環境變數名稱。新增一個人的步驟：
//   1. 那個人自己申請一組免費 Gemini API Key（aistudio.google.com/apikey）
//   2. 你在 Cloudflare Worker → Settings → Variables and Secrets 新增一個
//      Secret，Name 隨意取（例如 GEMINI_KEY_JIMMY），Value 貼他的 Key
//   3. 在下面這個對照表加一行，重新 Deploy
//   4. 那個人在手機 App 的「設定 → 使用者代號」填 jimmy，存檔
const USER_KEY_ENV_MAP = {
  doris: "GEMINI_API_KEY", // 沿用原本已經設定好的那組 Key
  // jimmy: "GEMINI_KEY_JIMMY",
};

function resolveApiKey(env, user) {
  const envName = USER_KEY_ENV_MAP[(user || "").toLowerCase().trim()];
  if (!envName) return null;
  return env[envName] || null;
}
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 兩段式上傳到 Gemini Files API ────────────────────────────────
async function uploadToGeminiFiles(apiKey, blob, mimeType) {
  // 第 1 段：跟 Gemini 要一個上傳網址
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(blob.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "meeting_audio" } }),
    }
  );
  if (!startRes.ok) {
    throw new Error("Gemini 檔案上傳初始化失敗：" + (await startRes.text()));
  }
  const uploadUrl = startRes.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) throw new Error("Gemini 沒有回傳上傳網址");

  // 第 2 段：把音檔的原始 bytes 傳上去
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(blob.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: blob,
  });
  if (!uploadRes.ok) {
    throw new Error("Gemini 檔案上傳失敗：" + (await uploadRes.text()));
  }
  const fileInfo = await uploadRes.json();
  return fileInfo.file; // { name, uri, mimeType, state, ... }
}

// 上傳完成後，Gemini 需要幾秒鐘處理音檔，要等狀態變成 ACTIVE 才能用來生成內容。
async function waitUntilActive(apiKey, fileName, progressLabel) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
    );
    const info = await res.json();
    if (info.state === "ACTIVE") return info;
    if (info.state === "FAILED") throw new Error("Gemini 音檔處理失敗（FAILED）");
    await sleep(1500);
  }
  throw new Error("Gemini 音檔處理逾時，請稍後再試（音檔可能過長）");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/process" || request.method !== "POST") {
      return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
    }

    try {
      const form = await request.formData();
      const audio = form.get("audio");
      const model = (form.get("model") || "gemini-flash-latest").toString();
      const extra = (form.get("extra") || "").toString();
      const focus = (form.get("focus") || "general").toString();
      const user = (form.get("user") || "").toString();

      const apiKey = resolveApiKey(env, user);
      if (!apiKey) {
        return new Response(
          `找不到使用者「${user || "(空白)"}」對應的 Gemini Key，請確認 App 設定裡的「使用者代號」有沒有打對，或請管理員幫忙新增。`,
          { status: 401, headers: corsHeaders(origin) }
        );
      }

      if (!audio || typeof audio === "string") {
        return new Response("缺少音訊檔（audio）", { status: 400, headers: corsHeaders(origin) });
      }

      // Files API 上限是 100MB，一般會議（就算超過一小時）都在範圍內。
      if (audio.size > 95 * 1024 * 1024) {
        return new Response(
          "錄音檔過大（超過約 95MB），請考慮分段錄音。",
          { status: 413, headers: corsHeaders(origin) }
        );
      }

      const mimeType = guessGeminiMimeType(audio.name, audio.type);

      const uploaded = await uploadToGeminiFiles(apiKey, audio, mimeType);
      const active = await waitUntilActive(apiKey, uploaded.name);

      let prompt = MINUTES_PROMPT;
      if (FOCUS_PRESETS[focus]) {
        prompt += `\n\n## 報告視角\n${FOCUS_PRESETS[focus]}`;
      }
      if (extra.trim()) {
        prompt += `\n\n## 額外指示\n${extra.trim()}`;
      }

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  { fileData: { mimeType: active.mimeType || mimeType, fileUri: active.uri } },
                ],
              },
            ],
          }),
        }
      );

      const geminiJson = await geminiRes.json();

      // 用完清掉雲端暫存檔（不影響回傳結果，失敗就算了）
      fetch(`https://generativelanguage.googleapis.com/v1beta/${uploaded.name}?key=${apiKey}`, {
        method: "DELETE",
      }).catch(() => {});

      if (!geminiRes.ok) {
        const msg = geminiJson?.error?.message || JSON.stringify(geminiJson);
        return new Response(msg, { status: geminiRes.status, headers: corsHeaders(origin) });
      }

      const text =
        geminiJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ||
        "（Gemini 沒有回傳內容）";
      const um = geminiJson?.usageMetadata || {};
      const usage = {
        prompt_tokens: um.promptTokenCount || 0,
        output_tokens: um.candidatesTokenCount || 0,
        total_tokens: um.totalTokenCount || 0,
      };

      return new Response(JSON.stringify({ text, usage }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (e) {
      return new Response("處理失敗：" + (e?.message || String(e)), {
        status: 500,
        headers: corsHeaders(origin),
      });
    }
  },
};
