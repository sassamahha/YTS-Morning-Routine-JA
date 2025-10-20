// scripts/render.js
// Markdown を読み、背景にそのまま重ねて全文表示するだけの最小版。
// ・ぼかしなし／枠なし／ウォーターマークなし
// ・文字は style.yaml で調整（無ければデフォルト）
// ・frontmatter: title, duration, bg, bgm を任意サポート
//
// 例:
//   node scripts/render.js --slot=morning --weekday=mon --max=2 --dur=12 --tz=Asia/Tokyo
//   node scripts/render.js --file=data/morning/mon/foo.md

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import matter from "gray-matter";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ==== CLI ==== */
const ARG = (k, d = "") => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=").slice(1).join("=") : d;
};

const SLOT = (ARG("slot", "morning") || "morning").toLowerCase(); // morning|night
let WEEKDAY = (ARG("weekday", "") || "").toLowerCase();           // mon..sun|auto|""
const FILEARG = ARG("file", "");
const MAX = parseInt(ARG("max", "99"), 10);
const DUR_OVERRIDE = parseFloat(ARG("dur", "0")) || 0;
const TZ = ARG("tz", "Asia/Tokyo");

const BG_DIR = ARG("bgDir", path.join("assets", "bg"));
const BGM_DIR = ARG("bgmDir", path.join("assets", "bgm"));
const STYLE_PATH = ARG("style", path.join("data", "style.yaml"));

/* ==== utils ==== */
function nowInTZ(tz) {
  const s = new Date().toLocaleString("en-US", { timeZone: tz });
  const d = new Date(s);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const wd = ["sun","mon","tue","wed","thu","fri","sat"][d.getDay()];
  return { dateStr: `${y}-${m}-${day}`, weekday: wd };
}

function loadStyle() {
  const def = {
    font: "assets/fonts/NotoSansJP-Regular.ttf",
    fontsize: 60,
    color: "white",
    line_spacing: 8,
    // 中央寄せ（必要なら style.yaml で上書き）
    x: "(w-text_w)/2",
    y: "(h-text_h)/2",
    shadowcolor: "black@0.0", // 影なし
    shadowx: 0,
    shadowy: 0,
    include_title: true,      // タイトル行を先頭に含めるか
  };
  try {
    const raw = fs.readFileSync(STYLE_PATH, "utf8");
    const yml = yaml.load(raw) || {};
    return { ...def, ...yml };
  } catch { return def; }
}

function listMdCandidates() {
  if (FILEARG) return [FILEARG];
  const roots = [];
  const base = path.join("data", SLOT);
  if (!WEEKDAY || WEEKDAY === "auto") WEEKDAY = nowInTZ(TZ).weekday;
  roots.push(path.join(base, WEEKDAY));
  roots.push(path.join(base, "_default"));
  roots.push(base);
  const out = [];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith(".md")) out.push(path.join(dir, f));
    }
  }
  return out.sort();
}

function basicStripMd(s) {
  return s
    .replace(/\r/g, "")
    .split("\n")
    .map(line =>
      line
        .replace(/^\s*#+\s*/,"")            // # 見出し
        .replace(/^\s*[-*+]\s+/,"")         // 箇条書き
        .replace(/^\s*\d+\.\s+/,"")         // 番号付き
        .replace(/\*\*(.*?)\*\*/g,"$1")     // **太字**
        .replace(/__(.*?)__/g,"$1")
        .replace(/\*(.*?)\*/g,"$1")
        .replace(/_(.*?)_/g,"$1")
        .replace(/\[(.*?)\]\(.*?\)/g,"$1")  // リンク
    )
    .join("\n")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}

function parseMd(mdPath) {
  const raw = fs.readFileSync(mdPath, "utf8");
  const g = matter(raw);
  const fm = g.data || {};
  const title = fm.title || (g.content.match(/^#\s+(.+)/m)?.[1] ?? "");
  const dur = parseFloat(fm.duration || 0) || DUR_OVERRIDE || 12;
  const body = basicStripMd(g.content || "");
  return { title, body, dur, bg: fm.bg || "", bgm: fm.bgm || "" };
}

function pickRandom(dir, pattern) {
  try {
    const re = pattern || /\.(jpe?g|png|mp4|mov|webm|mp3|wav)$/i;
    const files = fs.readdirSync(dir).filter((f) => re.test(f));
    if (!files.length) return "";
    return path.join(dir, files[Math.floor(Math.random() * files.length)]);
  } catch { return ""; }
}

function esc(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

async function writeTempText(content) {
  await fsp.mkdir("videos", { recursive: true });
  const p = path.join("videos", `.txt_${Date.now()}_${Math.random().toString(36).slice(2)}.utf8.txt`);
  await fsp.writeFile(p, content, "utf8");
  return p;
}

async function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { stdio: "inherit" }, (err) => (err ? reject(err) : resolve()));
  });
}

function slug(s) {
  return String(s).normalize("NFKC")
    .replace(/[^\w\-一-龠ぁ-んァ-ヴー]/g, "_")
    .replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/* ==== core ==== */
async function renderOne(mdPath) {
  const st = loadStyle();
  const meta = parseMd(mdPath);

  const text = st.include_title && meta.title
    ? `${meta.title}\n\n${meta.body}`
    : meta.body;

  if (!text.trim()) { console.warn("[skip empty]", mdPath); return null; }

  const { dateStr } = nowInTZ(TZ);
  const outDir = path.join("videos", "queue", dateStr);
  await fsp.mkdir(outDir, { recursive: true });

  // 背景：指定優先 → 無ければランダム（画像 or 動画）
  let bg = meta.bg ? path.join(BG_DIR, meta.bg) : "";
  if (!bg || !fs.existsSync(bg)) bg = pickRandom(BG_DIR, /\.(jpe?g|png|mp4|mov|webm)$/i);
  if (!bg || !fs.existsSync(bg)) throw new Error(`No background in ${BG_DIR}`);

  // BGM（任意）
  let bgm = meta.bgm ? path.join(BGM_DIR, meta.bgm) : "";
  if (!bgm || !fs.existsSync(bgm)) bgm = pickRandom(BGM_DIR, /\.(mp3|wav)$/i);
  if (bgm && !fs.existsSync(bgm)) bgm = "";

  const dur = meta.dur;
  const textFile = await writeTempText(text);

  // 背景：ぼかし無し。1080x1920 カバー
  const vBase = [
    "[0:v]" +
    "scale=if(gt(a,0.5625),-2,1080):if(gt(a,0.5625),1920,-2)," + // a=iw/ih
    "crop=1080:1920:(in_w-1080)/2:(in_h-1920)/2,setsar=1,format=yuv420p[v0]"
  ];

  // テキスト一括表示（装飾なし）
  const overlay =
    `drawtext=fontfile='${esc(st.font)}':textfile='${esc(textFile)}'` +
    `:fontsize=${st.fontsize}:fontcolor=${st.color}` +
    `:line_spacing=${st.line_spacing}:x=${st.x}:y=${st.y}` +
    `:shadowcolor=${st.shadowcolor}:shadowx=${st.shadowx}:shadowy=${st.shadowy}` +
    `:enable='between(t,0,${dur.toFixed(2)})':fix_bounds=1`;

  vBase.push(`[v0]${overlay}[vout]`);

  const aFilter = bgm
    ? `[1:a]volume=0.27,afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, dur - 0.8)}:d=0.8[aout]`
    : "";

  const isVideoBg = /\.(mp4|mov|webm)$/i.test(bg);
  const args = [
    "-y",
    ...(isVideoBg ? ["-stream_loop","-1"] : ["-loop","1"]),
    "-t", String(dur), "-i", bg,
    ...(bgm ? ["-i", bgm] : []),
    "-r", "30",
    "-filter_complex", aFilter ? `${vBase.join(";")};${aFilter}` : vBase.join(";"),
    "-map", "[vout]",
    ...(bgm ? ["-map", "[aout]"] : []),
    "-shortest",
    "-c:v", "libx264",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    ...(bgm ? ["-c:a", "aac", "-b:a", "128k"] : []),
    path.join(outDir, `${slug(path.basename(mdPath, ".md"))}.${SLOT}.${Date.now().toString().slice(-6)}.mp4`)
  ];

  try { await runFFmpeg(args); }
  finally { try { await fsp.unlink(textFile); } catch {} }

  console.log("[rendered]", mdPath);
  return true;
}

/* ==== main ==== */
(async () => {
  const files = listMdCandidates();
  if (!files.length) { console.log("[no md] data/<slot>/<weekday> or _default is empty"); process.exit(0); }

  let done = 0;
  for (const f of files) {
    if (done >= MAX) break;
    try { if (await renderOne(f)) done++; }
    catch (e) { console.warn("[render fail]", f, e?.message || e); }
  }
  console.log(`[done] ${done} video(s) -> videos/queue/<date>/`);
})();
