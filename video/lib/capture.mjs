// Frame-accurate capture of a Playwright page through the Chrome DevTools screencast, and encoding to a
// constant 30 fps H.264 clip. Screen text stays sharp, unlike Playwright's built-in video recorder.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

export const CHROME = `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1248/chrome-win64/chrome.exe`;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A browser page that renders at 1920 x 1080 with the site at 120 percent zoom. */
export async function openBrowser() {
  const browser = await chromium.launch({ executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2, colorScheme: "light" });
  await context.addInitScript(CURSOR);
  return { browser, context };
}

/** Starts capturing a page; `stop()` returns the frames with their times in seconds. */
export async function startCapture(page, name) {
  const dir = `frames/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const marks = {};
  const startedAt = Date.now() / 1000;
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = `${dir}/${String(frames.length).padStart(6, "0")}.jpg`;
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  return {
    /** Records a named moment, in seconds from the start of the clip. */
    mark(label) {
      marks[label] = +(Date.now() / 1000 - startedAt).toFixed(2);
      console.log(`  ${name} ${label} at ${marks[label]} s`);
    },
    async stop() {
      await sleep(300);
      await cdp.send("Page.stopScreencast");
      const end = Date.now() / 1000;
      encode(name, frames, end);
      return { frames: frames.length, seconds: +(end - frames[0].t).toFixed(2), marks, offset: +(frames[0].t - startedAt).toFixed(2) };
    },
  };
}

/** Each frame is held until the next one arrives; the result is resampled to a constant 30 fps. */
function encode(name, frames, end) {
  mkdirSync("out/clips", { recursive: true });
  const lines = [];
  frames.forEach((frame, index) => {
    const next = index + 1 < frames.length ? frames[index + 1].t : end;
    lines.push(`file '${frame.file.replace(/^frames\//, "")}'`, `duration ${Math.max(0.001, next - frame.t).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1).file.replace(/^frames\//, "")}'`);
  writeFileSync(`frames/${name}.txt`, lines.join("\n"));
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `frames/${name}.txt`, "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "14", `out/clips/${name}.mp4`],
    { stdio: "inherit" },
  );
}

/** A visible cursor and click ring, because a headless browser draws none. */
const CURSOR = `
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = \`
      ::-webkit-scrollbar { display: none }
      #__cursor { position: fixed; z-index: 2147483647; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none;
        transform: translate(-3px, -2px); transition: transform 40ms linear; }
      #__ring { position: fixed; z-index: 2147483646; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
        border: 3px solid #1d4f8f; pointer-events: none; opacity: 0; }
      #__ring.on { animation: __ring 520ms ease-out; }
      @keyframes __ring { from { opacity: .9; transform: scale(.35) } to { opacity: 0; transform: scale(1.25) } }
    \`;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "__cursor";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 9-6.5 1.6L8.6 19z" fill="#17160f" stroke="#fbf9f3" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const ring = document.createElement("div");
    ring.id = "__ring";
    document.body.append(cursor, ring);
    const at = (window.__cursorAt ||= { x: 800, y: 450 });
    cursor.style.left = at.x + "px"; cursor.style.top = at.y + "px";
    addEventListener("mousemove", (e) => { at.x = e.clientX; at.y = e.clientY; cursor.style.left = e.clientX + "px"; cursor.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", (e) => { ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px"; ring.classList.remove("on"); void ring.offsetWidth; ring.classList.add("on"); }, true);
  });
`;

/** Moves the cursor to an element in a natural path, then clicks it. */
export async function clickOn(page, locator, { pause = 350 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
  await sleep(pause);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}

export async function hover(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 28 });
}

/** Scrolls smoothly by `pixels` over `ms`. */
export async function glide(page, pixels, ms = 1600) {
  const steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) {
    const eased = 0.5 - Math.cos((Math.PI * i) / steps) / 2;
    const previous = 0.5 - Math.cos((Math.PI * (i - 1)) / steps) / 2;
    await page.mouse.wheel(0, pixels * (eased - previous));
    await sleep(16);
  }
}
