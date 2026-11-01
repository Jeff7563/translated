// TranslateT Reader: a small web app that runs on your PC so you can read
// translated comics on a phone. The phone sends a chapter link; this server
// opens it in a headless browser, finds the comic images, proxies them, and
// translates each image slice with the same prompts as the extension.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../extension/src/settings.js";
import { systemPrompt, imageUserPrompt } from "../extension/src/prompt.js";
import { callLLM, parseJSON } from "../extension/src/providers.js";
import { sliceItems } from "../extension/src/boxes.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, "public");
const CACHE = path.join(DIR, ".cache");
fs.mkdirSync(CACHE, { recursive: true });

// ---------- settings ----------
const readJSON = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return {};
  }
};
const settings = {
  ...DEFAULTS,
  provider: "ollama",
  model: "qwen2.5vl:7b",
  port: 8787,
  ...readJSON(path.join(DIR, "config.json"))
};
const settingsKey = [settings.provider, settings.model, settings.targetLang, settings.genre, settings.tone, settings.glossary, settings.characters].join("|");

// A random key in the link keeps other people on the same network out.
const tokenFile = path.join(DIR, ".token");
let TOKEN = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
if (!TOKEN) {
  TOKEN = crypto.randomBytes(6).toString("hex");
  fs.writeFileSync(tokenFile, TOKEN);
}

// ---------- headless browser ----------
let ctxPromise = null;
async function browserContext() {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      let pw;
      try {
        pw = await import("playwright-core");
      } catch {
        return null; // not installed: fall back to plain fetch
      }
      const dir = path.join(DIR, ".browser");
      const opts = { headless: settings.headless !== false, viewport: { width: 900, height: 1400 } };
      const tries = settings.browserPath
        ? [{ executablePath: settings.browserPath }]
        : [{ channel: "chrome" }, { channel: "msedge" }, {}];
      for (const t of tries) {
        try {
          const ctx = await pw.chromium.launchPersistentContext(dir, { ...opts, ...t });
          ctx.on("close", () => (ctxPromise = null)); // start a new one if it crashes or is closed
          return ctx;
        } catch (e) {
          console.warn("เปิดเบราว์เซอร์ไม่ได้:", t.channel || t.executablePath || "default", String(e.message).split("\n")[0]);
        }
      }
      return null;
    })();
  }
  return ctxPromise;
}

const MIN_W = 300;

// Opens the chapter, scrolls to trigger lazy loading, and lists the big images.
const chapters = new Map(); // url -> { at, data }, so reopening a chapter is instant
const loading = new Map(); // url -> promise, so parallel requests share one page load
async function getChapter(url) {
  const hit = chapters.get(url);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  if (!loading.has(url)) loading.set(url, loadChapter(url).finally(() => loading.delete(url)));
  const data = await loading.get(url);
  if (data.images.length) chapters.set(url, { at: Date.now(), data });
  if (chapters.size > 50) chapters.delete(chapters.keys().next().value);
  return data;
}

// Image bytes the chapter page itself downloaded. Image hosts often refuse a
// second request for the same file, so we keep what the page already loaded.
const images = new Map(); // src -> { type, body }
function keepImage(src, img) {
  images.delete(src);
  images.set(src, img);
  while (images.size > 400) images.delete(images.keys().next().value);
}

async function loadChapter(url) {
  const ctx = await browserContext();
  if (!ctx) return getChapterPlain(url);
  const page = await ctx.newPage();
  const pending = [];
  page.on("response", (r) => {
    if (r.request().resourceType() !== "image" || !r.ok()) return;
    pending.push(
      r
        .body()
        .then((body) => body.length > 5000 && keepImage(r.url(), { type: r.headers()["content-type"] || "image/jpeg", body }))
        .catch(() => {})
    );
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);
    // Make lazy images load even when we scroll past them quickly.
    await page.evaluate(() => document.querySelectorAll("img[loading=lazy]").forEach((i) => (i.loading = "eager")));
    let last = -1;
    for (let i = 0; i < 80; i++) {
      const n = await page.evaluate(() => {
        // Scroll the window and any inner scroll box (some readers scroll a div).
        const boxes = [document.scrollingElement, ...document.querySelectorAll("*")].filter(
          (el) => el && el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY + (el === document.scrollingElement ? "auto" : ""))
        );
        for (const b of boxes) b.scrollTop += b.clientHeight;
        return document.images.length + ":" + boxes.map((b) => Math.round(b.scrollTop)).join(",");
      });
      await page.waitForTimeout(250);
      if (n === last) break;
      last = n;
    }
    // Wait (up to 20 s) for the big images to finish downloading.
    await page
      .waitForFunction(
        (minW) => [...document.images].filter((i) => i.getBoundingClientRect().width >= minW).every((i) => i.complete),
        MIN_W,
        { timeout: 20000, polling: 500 }
      )
      .catch(() => {});
    const data = await page.evaluate((minW) => {
      const seen = new Set();
      const images = [];
      for (const img of document.images) {
        const src =
          img.currentSrc || img.src || img.dataset.src || img.dataset.lazySrc || img.dataset.original || "";
        if (!src || src.startsWith("data:") || seen.has(src)) continue;
        const w = img.naturalWidth || img.width;
        const shown = img.getBoundingClientRect().width;
        if (w < minW && shown < minW) continue;
        seen.add(src);
        images.push({ src, w: img.naturalWidth, h: img.naturalHeight });
      }
      const isNext = (el) => {
        const t = ((el.getAttribute("aria-label") || "") + " " + el.textContent).trim();
        return /^(next\b|next chapter|ตอนต่อไป|ถัดไป)|›|»|→/i.test(t) && !/prev/i.test(t);
      };
      const a = document.querySelector("a[rel~=next]") || [...document.querySelectorAll("a[href]")].find((x) => isNext(x) && x.href !== location.href);
      if (a) return { title: document.title, url: location.href, images, next: a.href };
      // Some readers use a button instead of a link: mark it so we can click it.
      const b = [...document.querySelectorAll("button, [role=button]")].find(isNext);
      if (b) b.setAttribute("data-tt-next", "1");
      return { title: document.title, url: location.href, images, next: null, nextButton: !!b };
    }, MIN_W);
    await Promise.all(pending);
    if (data.nextButton) {
      try {
        const before = page.url();
        // A plain DOM click: a mouse click can be swallowed by an overlay (comix.to).
        const moved = page.waitForURL((u) => u.href !== before, { timeout: 10000 });
        await page.evaluate(() => document.querySelector("[data-tt-next]").click());
        await moved;
        data.next = page.url();
      } catch {}
    }
    delete data.nextButton;
    return data;
  } finally {
    await page.close().catch(() => {});
  }
}

async function getChapterPlain(url) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([^<]*)/i) || [])[1] || url;
  const images = [];
  const seen = new Set();
  for (const m of html.matchAll(/<img\b[^>]*?\s(?:data-src|data-lazy-src|src)=["']([^"']+)["']/gi)) {
    const src = new URL(m[1].replace(/&amp;/g, "&"), url).href;
    if (!seen.has(src) && !/logo|icon|avatar|banner/i.test(src)) {
      seen.add(src);
      images.push({ src });
    }
  }
  return { title, url, images, next: null };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

// Image bytes, fetched with the site's cookies and referer (many image hosts check it).
async function getImage(src, ref) {
  if (images.has(src)) return images.get(src);
  const ctx = await browserContext();
  const headers = { referer: ref || src, "user-agent": UA };
  if (ctx && ref) {
    // Not kept (server restarted or evicted): open the chapter again.
    chapters.delete(ref);
    await getChapter(ref);
    if (images.has(src)) return images.get(src);
  }
  if (ctx) {
    const r = await ctx.request.get(src, { headers, timeout: 45000 });
    if (!r.ok()) throw new Error(`โหลดรูปไม่ได้ (${r.status()})`);
    return { type: r.headers()["content-type"] || "image/jpeg", body: await r.body() };
  }
  const r = await fetch(src, { headers });
  if (!r.ok) throw new Error(`โหลดรูปไม่ได้ (${r.status})`);
  return { type: r.headers.get("content-type") || "image/jpeg", body: Buffer.from(await r.arrayBuffer()) };
}

// ---------- translation ----------
// A local GPU handles one image at a time; cloud APIs can take two.
let running = 0;
const waiting = [];
const limit = settings.provider === "ollama" ? 1 : 2;
async function slot(fn) {
  if (running >= limit) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const cacheFile = (key) =>
  path.join(CACHE, crypto.createHash("sha256").update(settingsKey + "\u0000" + key).digest("hex").slice(0, 24) + ".json");

async function translate({ key, image, slice, title, context }) {
  const file = cacheFile(key);
  const hit = readJSON(file);
  if (hit.items) return hit;
  if (!image) return { miss: true };
  const reply = await slot(() =>
    callLLM(settings, systemPrompt(settings), imageUserPrompt({ title, context: (context || "").slice(-1500) }), image)
  );
  const result = sliceItems(parseJSON(reply), slice);
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}

// ---------- http ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname.startsWith("/api/")) {
        if ((req.headers["x-key"] || u.searchParams.get("k")) !== TOKEN) return send(res, 401, { error: "ลิงก์ไม่ถูกต้อง เปิดจากลิงก์ที่หน้าจอคอมแสดง" });
        if (u.pathname === "/api/chapter") return send(res, 200, await getChapter(u.searchParams.get("url")));
        if (u.pathname === "/api/img") {
          const img = await getImage(u.searchParams.get("src"), u.searchParams.get("ref"));
          res.writeHead(200, { "content-type": img.type, "cache-control": "private, max-age=86400" });
          return res.end(img.body);
        }
        if (u.pathname === "/api/translate" && req.method === "POST") return send(res, 200, await translate(await readBody(req)));
        if (u.pathname === "/api/info") return send(res, 200, { provider: settings.provider, model: settings.model, targetLang: settings.targetLang });
        return send(res, 404, { error: "not found" });
      }
      const file = path.join(PUBLIC, u.pathname === "/" ? "index.html" : path.normalize(u.pathname).replace(/^([/\\])+/, ""));
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
      send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
    } catch (e) {
      console.error(u.pathname, e.message);
      send(res, 500, { error: String(e.message || e) });
    }
  })
  .listen(settings.port, "0.0.0.0", () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
    console.log(`\nTranslateT Reader พร้อมแล้ว  (AI: ${settings.provider} / ${settings.model})`);
    console.log("เปิดลิงก์นี้บนมือถือ (ต้องต่อ Wi-Fi เดียวกัน หรือ Tailscale):");
    for (const ip of ips) console.log(`  http://${ip}:${settings.port}/?k=${TOKEN}`);
    console.log(`บนคอมนี้: http://localhost:${settings.port}/?k=${TOKEN}\n`);
  });
