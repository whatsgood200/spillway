// Renders one still per scene at chosen times, for checking layout. Run from video/: node preview.mjs
import { readFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { CHROME } from "./lib/capture.mjs";
const realData = JSON.parse(readFileSync("../measurements/morpho-base-2026-11-16.json", "utf8"));
const marks = JSON.parse(readFileSync("out/clips/marks.json", "utf8"));
const data = { taken: realData.events.filter((e) => e.taken && !e.sameTx).map((e) => e.takenAfterMs), never: realData.events.filter((e) => !e.taken).length, hostile: marks.hostile };
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript((d) => (window.SCENE_DATA = d), data);
await page.goto(pathToFileURL("scenes/scenes.html").href);
await page.evaluate(() => document.fonts.ready);
mkdirSync("out/preview", { recursive: true });
const shots = [["problem", 14, [0.6, 4, 9]], ["data", 18, [0.6, 5.5, 12]], ["intro", 9, [0.6, 4.5]], ["how", 19, [0.6, 2.3, 10.3]], ["hostile", 14, [0.6, 2.9, 12]], ["close", 12, [0.6, 8.8]]];
for (const [id, t, cues] of shots) {
  await page.evaluate(([i, tt, c]) => window.renderAt(i, tt, c, 20), [id, t, cues]);
  await page.screenshot({ path: `out/preview/${id}.jpg`, type: "jpeg", quality: 85 });
}
await browser.close();
console.log("previews written");
