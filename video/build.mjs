// Assembles the demo video from script.json, the Kokoro narration (audio/), the live clips (out/clips/) and the
// rendered scenes (scenes/scenes.html). Run from video/ after record.mjs and the voice render:
//   node build.mjs            render scenes that changed, then cut, mix, caption and encode
//   node build.mjs --scenes   re-render every scene
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CHROME, HEIGHT, WIDTH } from "./lib/capture.mjs";

const FPS = 30;
const LEAD = 0.6; // silence before a scene's first line
const GAP = 0.45; // between lines
const TAIL = 0.9; // after a scene's last line
const FADE = 0.25; // dip to paper between segments
const PAPER = "0xf3f0e8";

const script = JSON.parse(readFileSync("script.json", "utf8"));
const timing = JSON.parse(readFileSync("audio/timing.json", "utf8"));
const marks = JSON.parse(readFileSync("out/clips/marks.json", "utf8"));
const ffmpeg = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });

// 1. Timeline: when every segment and every line starts.
const timeline = [];
let clock = 0;
for (const segment of script.segments) {
  const lines = [];
  let duration;
  if (segment.type === "scene") {
    let t = LEAD;
    segment.lines.forEach((line, n) => {
      const length = timing[`${segment.id}-${n}`];
      lines.push({ ...line, n, start: t, length });
      t += length + GAP;
    });
    duration = t - GAP + TAIL + (segment.id === "close" ? 1.2 : 0);
  } else {
    const clip = marks[segment.clip];
    const hold = segment.holdStart ?? 0;
    const toSegment = (clipTime) => hold + clipTime - segment.in;
    // A clip time is seconds, or a recorded moment such as "cashedOut+2.2".
    const clipAt = (value) => {
      if (typeof value === "number") return value;
      const [mark, plus] = String(value).split("+");
      return clip.marks[mark] - (clip.offset ?? 0) + Number(plus || 0);
    };
    segment.outAt = clipAt(segment.out);
    // Waiting stretches can play faster: speed ranges in clip time, each shown on screen as sped up.
    segment.ranges = (segment.speed ?? []).map((r) => ({ ...r, from: clipAt(r.from), to: clipAt(r.to) }));
    const pieces = [];
    let cursor = segment.in;
    for (const r of [...segment.ranges].sort((a, b) => a.from - b.from)) {
      if (r.from > cursor) pieces.push({ from: cursor, to: r.from, x: 1 });
      pieces.push(r);
      cursor = r.to;
    }
    if (cursor < segment.outAt) pieces.push({ from: cursor, to: segment.outAt, x: 1 });
    segment.pieces = pieces;
    // Output time of a clip time, after the speed-ups.
    const warp = (t) => pieces.reduce((sum, p) => sum + Math.max(0, Math.min(t, p.to) - p.from) / p.x, 0);
    segment.warp = warp;
    const toWarped = (clipTime) => hold + warp(clipTime) - (clipTime < segment.in ? segment.in - clipTime : 0);
    let previousEnd = 0;
    segment.lines.forEach((line, n) => {
      const length = timing[`${segment.id}-${n}`];
      let at;
      if (String(line.at).startsWith("+")) at = previousEnd + Number(line.at.slice(1));
      else at = toWarped(clipAt(line.at));
      const start = Math.max(at, previousEnd + 0.3);
      lines.push({ ...line, n, start, length });
      previousEnd = start + length;
    });
    duration = Math.max(hold + warp(segment.outAt), previousEnd + 0.6);
  }
  timeline.push({ segment, start: clock, duration, lines });
  clock += duration;
}
const total = clock;
console.log(timeline.map((s) => `${s.segment.id.padEnd(8)} ${s.start.toFixed(1).padStart(6)} s  ${s.duration.toFixed(1)} s`).join("\n"));
console.log(`total ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, "0")}`);
writeFileSync("out/timeline.json", JSON.stringify(timeline.map((s) => ({ id: s.segment.id, start: s.start, duration: s.duration, lines: s.lines.map((l) => ({ start: l.start, length: l.length, caption: l.caption })) })), null, 1));

// 2. Scenes: each frame is drawn by renderAt(scene, t) and captured.
const realData = JSON.parse(readFileSync("../measurements/morpho-base-2026-11-16.json", "utf8"));
const sceneData = {
  taken: realData.events.filter((e) => e.taken && !e.sameTx).map((e) => e.takenAfterMs),
  never: realData.events.filter((e) => !e.taken).length,
  hostile: marks.hostile,
};
const scenes = timeline.filter((s) => s.segment.type === "scene");
const sceneKey = (s) => JSON.stringify([s.duration.toFixed(3), s.lines.map((l) => l.start.toFixed(3)), readFileSync("scenes/scenes.html", "utf8").length]);
const stale = scenes.filter((s) => process.argv.includes("--scenes") || !existsSync(`out/pieces/${s.segment.id}.mp4`) || readFileSync(`out/pieces/${s.segment.id}.key`, "utf8") !== sceneKey(s));
mkdirSync("out/pieces", { recursive: true });
if (stale.length) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.addInitScript((data) => (window.SCENE_DATA = data), sceneData);
  await page.goto(pathToFileURL("scenes/scenes.html").href);
  await page.evaluate(() => document.fonts.ready);
  for (const s of stale) {
    const dir = `frames/scene-${s.segment.id}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const cues = s.lines.map((l) => l.start);
    const frames = Math.round(s.duration * FPS);
    for (let f = 0; f < frames; f++) {
      await page.evaluate(([id, t, c, d]) => window.renderAt(id, t, c, d), [s.segment.id, f / FPS, cues, s.duration]);
      await page.screenshot({ path: `${dir}/${String(f).padStart(6, "0")}.jpg`, type: "jpeg", quality: 94 });
      if (f % 150 === 0) process.stdout.write(`\r  scene ${s.segment.id} ${f}/${frames}   `);
    }
    process.stdout.write("\n");
    ffmpeg(["-framerate", String(FPS), "-i", `${dir}/%06d.jpg`, "-vf", fades(s.duration), "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", `out/pieces/${s.segment.id}.mp4`]);
    writeFileSync(`out/pieces/${s.segment.id}.key`, sceneKey(s));
  }
  await browser.close();
}

function fades(duration) {
  return `fade=t=in:st=0:d=${FADE}:color=${PAPER},fade=t=out:st=${(duration - FADE).toFixed(3)}:d=${FADE}:color=${PAPER},format=yuv420p`;
}

// 3. Clips: trimmed, held on the first frame where the script asks, extended on the last frame if speech runs on.
for (const s of timeline.filter((x) => x.segment.type === "clip")) {
  const { segment } = s;
  const hold = segment.holdStart ?? 0;
  const length = segment.warp(segment.outAt);
  const extra = Math.max(0, s.duration - hold - length);
  const parts = segment.pieces.map((p, i) => `[0:v]trim=start=${p.from.toFixed(3)}:end=${p.to.toFixed(3)},setpts=(PTS-STARTPTS)/${p.x}[p${i}]`).join(";");
  const joined = `${segment.pieces.map((_, i) => `[p${i}]`).join("")}concat=n=${segment.pieces.length}:v=1:a=0[c]`;
  const finish = `[c]tpad=start_mode=clone:start_duration=${hold}:stop_mode=clone:stop_duration=${extra.toFixed(3)},fps=${FPS},${fades(s.duration)}[v]`;
  ffmpeg([
    "-i", `out/clips/${segment.clip}.mp4`, "-filter_complex", `${parts};${joined};${finish}`, "-map", "[v]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-an", `out/pieces/${segment.id}.mp4`,
  ]);
}

// 4. Picture: every piece in order.
writeFileSync("out/pieces.txt", timeline.map((s) => `file 'pieces/${s.segment.id}.mp4'`).join("\n"));
ffmpeg(["-f", "concat", "-safe", "0", "-i", "out/pieces.txt", "-c", "copy", "out/picture.mp4"]);

// 5. Narration: each line placed at its start, then loudness-normalised for speech.
const lines = timeline.flatMap((s) => s.lines.map((l) => ({ file: `audio/${s.segment.id}-${l.n}.wav`, at: s.start + l.start })));
const inputs = lines.flatMap((l) => ["-i", l.file]);
const delays = lines.map((l, i) => `[${i}:a]aresample=48000,adelay=${Math.round(l.at * 1000)}:all=1[a${i}]`).join(";");
const mix = `${delays};${lines.map((_, i) => `[a${i}]`).join("")}amix=inputs=${lines.length}:normalize=0,apad=whole_dur=${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=7[out]`;
ffmpeg([...inputs, "-filter_complex", mix, "-map", "[out]", "-ar", "48000", "-c:a", "pcm_s16le", "out/narration.wav"]);

// 6. Captions: one or two short lines at a time, timed to the speech.
const ts = (t) => {
  const cs = Math.round(t * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
function chunks(text) {
  if (text.length <= 84) return [text];
  const middle = text.length / 2;
  let best = -1;
  for (const mark of [". ", ": ", ", ", "; "]) {
    let i = text.indexOf(mark);
    while (i !== -1) {
      if (best === -1 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
      i = text.indexOf(mark, i + 1);
    }
  }
  if (best === -1) best = text.lastIndexOf(" ", middle);
  return [...chunks(text.slice(0, best + 1).trim()), ...chunks(text.slice(best + 1).trim())];
}
// Captions are burned in only when script.json asks; a subtitle file is always written for upload (YouTube).
const events = [];
const srt = [];
const srtTime = (t) => {
  const ms = Math.round(t * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};
for (const s of timeline) {
  for (const l of s.lines) {
    const parts = chunks(l.caption);
    const totalChars = parts.reduce((sum, p) => sum + p.length, 0);
    let t = s.start + l.start;
    for (const part of parts) {
      const length = (l.length * part.length) / totalChars;
      if (script.burnCaptions) events.push(`Dialogue: 0,${ts(t)},${ts(t + length + 0.08)},Caption,,0,0,0,,${part}`);
      srt.push(`${srt.length + 1}\n${srtTime(t)} --> ${srtTime(t + length + 0.08)}\n${part}\n`);
      t += length;
    }
  }
  if (s.segment.type === "clip") {
    events.push(`Dialogue: 1,${ts(s.start + 0.3)},${ts(s.start + s.duration - 0.3)},Live,,0,0,0,,LIVE · spillway-phi.vercel.app · Base Sepolia`);
    const hold = s.segment.holdStart ?? 0;
    for (const r of s.segment.ranges) {
      const from = s.start + hold + s.segment.warp(r.from), to = s.start + hold + s.segment.warp(r.to);
      events.push(`Dialogue: 2,${ts(from)},${ts(to)},Live,,0,0,0,,{\\an7\\pos(36,150)}Played ${r.x}× faster · ${r.why}`);
    }
  }
}
writeFileSync(
  "out/captions.ass",
  `[Script Info]
ScriptType: v4.00+
PlayResX: ${WIDTH}
PlayResY: ${HEIGHT}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Segoe UI Semibold,46,&H00E8F0F3,&H00E8F0F3,&H260F1617,&H260F1617,0,0,0,0,100,100,0,0,3,18,0,2,220,220,64,1
Style: Live,Consolas,24,&H00E8F0F3,&H00E8F0F3,&H008F4F1D,&H008F4F1D,0,0,0,0,100,100,1,0,3,9,0,7,36,36,96,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`,
);

writeFileSync("out/spillway-demo.srt", srt.join("\n"));

// 7. Final encode: picture, captions burned in, narration.
ffmpeg([
  "-i", "out/picture.mp4", "-i", "out/narration.wav",
  "-vf", "subtitles=out/captions.ass", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", "out/spillway-demo.mp4",
]);
console.log(`wrote out/spillway-demo.mp4 (${total.toFixed(1)} s)`);
