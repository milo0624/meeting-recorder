// MP3 壓縮用的背景執行緒：在這裡跑 lamejs 編碼，主畫面才不會卡住。
// 主程式傳進來的是「已經轉成單聲道 Int16」的取樣資料，這裡只負責編碼。
importScripts("lame.min.js");

self.onmessage = (e) => {
  const { samples, sampleRate, kbps } = e.data;
  try {
    const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
    const BLOCK = 1152 * 64; // 一次編碼約 4.6 秒（16kHz）
    const parts = [];
    let lastReport = 0;

    for (let i = 0; i < samples.length; i += BLOCK) {
      const out = encoder.encodeBuffer(samples.subarray(i, i + BLOCK));
      if (out.length) parts.push(out);
      const pct = Math.floor((i / samples.length) * 100);
      if (pct !== lastReport) {
        lastReport = pct;
        self.postMessage({ type: "progress", pct });
      }
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(tail);

    self.postMessage({ type: "done", blob: new Blob(parts, { type: "audio/mpeg" }) });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
