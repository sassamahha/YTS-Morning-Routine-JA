// scripts/render.js
// ObsidianのMarkdownから縦動画(1080x1920)を生成して videos/queue/YYYY-MM-DD/ に出力
// ・背景は assets/bg から（frontmatterの bg: 優先、無ければランダム）
// ・BGMは assets/bgm から任意（frontmatterの bgm: 優先、無ければランダム／無ければ無音）
// ・ぼかし無し／ウォーターマーク無し
// ・箇条書きを“一覧で”表示（1文ずつの切替なし）
// 使い方：
//   node scripts/render.js --slot=morning --weekday=auto --max=2 --dur=12 --tz=Asia/Tokyo
//   node scripts/render.js --slot=night   --weekday=mon  --max=2 --tz=Asia/Tokyo
//   node scripts/render.js --file=data/morning/mon/example.md
//
// 必要：ffmpeg, gray-matter, 日本語フォント(assets/fonts/NotoSansJP-Regular.ttf など)

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import matter from "gray-matter";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------ CLI args ------------------------ */
const ARG = (k, d = "") => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=").slice(1).join("=") : d;
};

const SLOT = (ARG("slot", "morning") || "morning").toLowerCase(); // morning|night
let WEEKDAY = (ARG("weekday", "") || "").toLowerCase();           // mon..sun|auto|""
const FILEARG = ARG("file", "");
const MAX = parseInt(ARG("max", "99"), 10);
const DUR_OVERRIDE = parseFloat(ARG("dur", "0")) || 0;            // 秒
const TZ = ARG("tz", "Asia/Tokyo");

const BG_DIR = ARG("bgDir", path.join("assets", "bg"));
const BGM_DIR = ARG("bgmDir", path.join("assets", "bgm"));
const FONT = ARG("font", path.join("assets", "fonts", "NotoSansJP-Regular.ttf"));

/* ------------------------ utils ------------------------ */
function nowInTZ(tz) {
  const s = new Date().toLocaleString("en-US", { timeZone: tz });
  const d = new Date(s);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const wd = ["sun","mon","tue","wed","thu","fri","sat"][d.getDay()];
  return { dateStr: `${y}-${m}-${day}`, weekday: wd };
}

function listMdCandidates() {
  if (FILEARG) return [FILEARG];
  const roots = [];
  const base = path.join("data", SLOT);
  if (!WEEKDAY || WEEKDAY === "auto") WEEKDAY = nowInTZ(TZ).weekday;
  roots.push(path.join(base, WEEKDAY));
  roots.push(path.join(base, "_default")); // フォールバック
  roots.push(base); // 直置き許容
  const out = [];
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith(".md")) out.push(path.join(dir, f));
    }
  }
  return out.sort();
}

function parseMd(mdPath) {
  const raw = fs.readFileSync(mdPath, "utf8");
  const g = matter(raw);
  const fm = g.data || {};
  const title =
    fm.title ||
    (g.content.match(/^#\s+(.+)/m)?.[1] ?? path.basename(mdPath, ".md"));
  const dur = parseFloat(fm.duration || 0) || DUR_OVERRIDE || 12;

  // 箇条書き抽出（- / * / 1. など）
  const bullets = [];
  for (const line of g.content.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/);
    if (m) bullets.push(m[1]);
  }
  // 箇条書きが無ければ、段落をまとめて使う
  const lines = bullets.length
    ? bullets
    : g.content
        .split(/\n{2,}/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean);

  return { title, lines, dur, bg: fm.bg || "", bgm: fm.bgm || "" };
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
  return String(s)
    .normalize("NFKC")
    .replace(/[^\w\-一-龠ぁ-んァ-ヴー]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/* ------------------------ core ------------------------ */
async function renderOne(mdPath) {
  const meta = parseMd(mdPath);
  if (!meta.lines.length) { console.warn("[skip empty]", mdPath); return null; }

  const { dateStr } = nowInTZ(TZ);
  const outDir = path.join("videos", "queue", dateStr);
  await fsp.mkdir(outDir, { recursive: true });

  // 背景（指定優先 → 無ければランダム）
  let bg = meta.bg ? path.join(BG_DIR, meta.bg) : "";
  if (!bg || !fs.existsSync(bg)) bg = pickRandom(BG_DIR, /\.(jpe?g|png|mp4|mov|webm)$/i);
  if (!bg || !fs.existsSync(bg)) throw new Error(`No background in ${BG_DIR}`);

  // BGM（任意）
  let bgm = meta.bgm ? path.join(BGM_DIR, meta.bgm) : "";
  if (!bgm || !fs.existsSync(bgm)) bgm = pickRandom(BGM_DIR, /\.(mp3|wav)$/i);
  if (bgm && !fs.existsSync(bgm)) bgm = ""; // 無ければ無音

  const dur = meta.dur;

  // 一覧テキスト（• の箇条書き）
  const bullets = meta.lines.map(s => `• ${s}`).join("\n");
  const listFile = await writeTempText(bullets); // UTF-8

  // 背景：ぼかし無し。1080x1920にカバーでフィット
  const vBase = [
    "[0:v]scale=1080:1920:force_original_aspect_ratio=cover,crop=1080:1920,setsar=1,format=yuv420p[v0]"
  ];

  // オーバーレイ（タイトル＋一覧を“通しで”表示）
  const overlays = [];
  if (meta.title) {
    overlays.push(
      `drawtext=fontfile='${esc(FONT)}':text='${esc(meta.title)}':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.50:boxborderw=20:line_spacing=6:x=(w-text_w)/2:y=110:enable='between(t,0,${dur.toFixed(2)})':fix_bounds=1`
    );
  }
  overlays.push(
    `drawtext=fontfile='${esc(FONT)}':textfile='${esc(listFile)}':fontsize=56:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=24:line_spacing=10:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0,${dur.toFixed(2)})':fix_bounds=1`
  );

  vBase.push(`[v0]${overlays.join(",")}[vout]`);

  // オーディオ（任意）
  const aFilter = bgm
    ? `[1:a]volume=0.27,afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, dur - 0.8)}:d=0.8[aout]`
    : "";

  // 入力：画像なら -loop 1、動画なら -stream_loop -1 で繰り返し
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

  try {
    await runFFmpeg(args);
  } finally {
    try { await fsp.unlink(listFile); } catch {}
  }

  console.log("[rendered]", mdPath);
  return true;
}

/* ------------------------ main ------------------------ */
(async () => {
  const files = listMdCandidates();
  if (!files.length) {
    console.log("[no md] data/<slot>/<weekday> または _default が空");
    process.exit(0);
  }

  let done = 0;
  for (const f of files) {
    if (done >= MAX) break;
    try {
      if (await renderOne(f)) done++;
    } catch (e) {
      console.warn("[render fail]", f, e?.message || e);
    }
  }
  console.log(`[done] ${done} video(s) -> videos/queue/<date>/`);
})();
