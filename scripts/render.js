// ObsidianのMarkdownから縦動画(1080x1920)を生成して videos/queue/YYYY-MM-DD/ に出力
// 使い方例：
//   node scripts/render.js --slot=morning --weekday=auto --max=2 --dur=12 --tz=Asia/Tokyo
//   node scripts/render.js --slot=night   --weekday=mon  --max=2 --tz=Asia/Tokyo
//   node scripts/render.js --file=data/morning/mon/foo.md
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import matter from "gray-matter";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const FONT = ARG("font", path.join("assets", "fonts", "NotoSansJP-Regular.ttf"));

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
  const bullets = [];
  for (const line of g.content.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/);
    if (m) bullets.push(m[1]);
  }
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
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function buildDrawtextChain({ title, lines, dur }) {
  const chain = [];
  const titleDur = Math.min(1.2, Math.max(0.8, dur * 0.1));
  chain.push(
    `drawtext=fontfile='${esc(FONT)}':text='${esc(title)}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=20:line_spacing=6:x=(w-text_w)/2:y=h*0.12:enable='between(t,0,${titleDur.toFixed(2)})'`
  );
  const bodyStart = titleDur + 0.1;
  const per = Math.max(0.8, (dur - bodyStart - 0.3) / Math.max(lines.length, 1));
  lines.forEach((txt, i) => {
    const st = bodyStart + per * i;
    const ed = Math.min(dur, st + per - 0.05);
    chain.push(
      `drawtext=fontfile='${esc(FONT)}':text='${esc(txt)}':fontsize=58:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=28:line_spacing=8:x=(w-text_w)/2:y=(h*0.58 - text_h/2):enable='between(t,${st.toFixed(2)},${ed.toFixed(2)})'`
    );
  });
  chain.push(
    `drawtext=fontfile='${esc(FONT)}':text='@MorningComfort':fontsize=30:fontcolor=white@0.9:box=1:boxcolor=black@0.35:boxborderw=12:x=w-tw-40:y=40:enable='between(t,0,${dur.toFixed(2)})'`
  );
  return chain.join(",");
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { stdio: "inherit" }, (err) => (err ? reject(err) : resolve()));
  });
}

async function renderOne(mdPath) {
  const meta = parseMd(mdPath);
  if (!meta.lines.length) { console.warn("[skip empty]", mdPath); return null; }
  const { dateStr } = nowInTZ(TZ);
  const outDir = path.join("videos", "queue", dateStr);
  await fsp.mkdir(outDir, { recursive: true });

  const bg = meta.bg ? path.join(BG_DIR, meta.bg) : pickRandom(BG_DIR, /\.(jpe?g|png|mp4|mov|webm)$/i);
  if (!bg || !fs.existsSync(bg)) throw new Error(`No background in ${BG_DIR}`);

  const bgm = meta.bgm ? path.join(BGM_DIR, meta.bgm) : pickRandom(BGM_DIR, /\.(mp3|wav)$/i);
  const dur = meta.dur;

  const vBase = ["[0:v]scale=1080:-2,boxblur=lr=10:lp=2:cr=10:cp=2,setsar=1,format=yuv420p[v0]"];
  const draw = buildDrawtextChain({ title: meta.title, lines: meta.lines, dur });
  vBase.push(`[v0]crop=1080:1920:(iw-1080)/2:(ih-1920)/2,${draw}[vout]`);

  const aFilter = bgm && fs.existsSync(bgm)
    ? `[1:a]volume=0.27,afade=t=in:st=0:d=0.8,afade=t=out:st=${Math.max(0, dur - 0.8)}:d=0.8[aout]`
    : "";

  const args = [
    "-y",
    ...(bg.toLowerCase().match(/\.(mp4|mov|webm)$/) ? ["-stream_loop","-1"] : ["-loop","1"]),
    "-t", String(dur), "-i", bg,
    ...(bgm && fs.existsSync(bgm) ? ["-i", bgm] : []),
    "-r", "30",
    "-filter_complex", aFilter ? `${vBase.join(";")};${aFilter}` : vBase.join(";"),
    "-map", "[vout]",
    ...(bgm && fs.existsSync(bgm) ? ["-map", "[aout]"] : []),
    "-shortest", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
    ...(bgm && fs.existsSync(bgm) ? ["-c:a", "aac", "-b:a", "128k"] : []),
    path.join(outDir, `${path.basename(mdPath, ".md")}.${SLOT}.${Date.now().toString().slice(-6)}.mp4`)
  ];
  await runFFmpeg(args);
  console.log("[rendered]", mdPath);
  return true;
}

(async () => {
  const files = listMdCandidates();
  if (!files.length) { console.log("[no md] data/<slot>/<weekday> or _default is empty"); process.exit(0); }
  let done = 0;
  for (const f of files) {
    if (done >= MAX) break;
    try { if (await renderOne(f)) done++; } catch (e) { console.warn("[render fail]", f, e?.message || e); }
  }
  console.log(`[done] ${done} video(s) -> videos/queue/<date>/`);
})();
