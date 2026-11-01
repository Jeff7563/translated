import { getSettings } from "./settings.js";
import { systemPrompt, textUserPrompt, imageUserPrompt } from "./prompt.js";
import { callLLM, parseJSON } from "./providers.js";

// ---------- cache ----------
async function hash(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function settingsKey(s) {
  return [s.provider, s.model, s.targetLang, s.genre, s.tone, s.glossary, s.characters].join("|");
}
async function cacheGet(key) {
  const r = await chrome.storage.local.get(key);
  return r[key];
}
async function cacheSet(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch {
    await chrome.storage.local.clear(); // quota hit: start fresh
  }
}

// ---------- text ----------
async function translateTexts({ title, context, segments }) {
  const s = await getSettings();
  const sk = settingsKey(s);
  const keys = await Promise.all(segments.map((t) => hash(sk + "\u0000" + t).then((h) => "t:" + h)));
  const cached = await chrome.storage.local.get(keys);
  const out = segments.map((_, i) => cached[keys[i]]);
  const missing = segments.map((t, i) => (out[i] === undefined ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {
    const reply = await callLLM(
      s,
      systemPrompt(s),
      textUserPrompt({ title, context, segments: missing.map((i) => segments[i]) })
    );
    const map = parseJSON(reply);
    const toStore = {};
    missing.forEach((idx, j) => {
      const t = map[String(j)];
      if (typeof t === "string") {
        out[idx] = t;
        toStore[keys[idx]] = t;
      }
    });
    await chrome.storage.local.set(toStore).catch(() => chrome.storage.local.clear());
  }
  return out.map((t, i) => (t === undefined ? segments[i] : t));
}

// ---------- images ----------
// Tall webtoon strips are sliced so the model can still read the small text.
async function loadSlices(src) {
  const res = await fetch(src, { credentials: "include" });
  if (!res.ok) throw new Error(`โหลดรูปไม่ได้ (${res.status})`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;
  const maxW = Math.min(width, 1200);
  const scale = maxW / width;
  const sliceH = Math.round(width * 1.6); // in source pixels
  const slices = [];
  for (let y = 0; y < height; y += sliceH) {
    const h = Math.min(sliceH, height - y);
    if (h < 40) break;
    const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(h * scale));
    canvas.getContext("2d").drawImage(bmp, 0, y, width, h, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const base64 = await blobToBase64(out);
    slices.push({ y0: y / height, y1: (y + h) / height, image: { mime: "image/jpeg", base64 } });
  }
  return slices;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function translateImage({ src, title, context }) {
  const s = await getSettings();
  const key = "i:" + (await hash(settingsKey(s) + "\u0000" + src));
  const hit = await cacheGet(key);
  if (hit) return hit;
  const slices = await loadSlices(src);
  const items = [];
  let story = context || "";
  for (const sl of slices) {
    const reply = await callLLM(s, systemPrompt(s), imageUserPrompt({ title, context: story.slice(-1500) }), sl.image);
    const j = parseJSON(reply);
    for (const it of j.items || []) {
      if (!Array.isArray(it.box) || it.box.length !== 4 || !it.text) continue;
      const [x0, y0, x1, y1] = it.box.map(Number);
      const span = sl.y1 - sl.y0;
      items.push({
        x0: x0 / 1000,
        x1: x1 / 1000,
        y0: sl.y0 + (y0 / 1000) * span,
        y1: sl.y0 + (y1 / 1000) * span,
        source: it.source || "",
        text: it.text
      });
      if (it.source) story += "\n" + it.source;
    }
  }
  const result = { items, story: story.slice(-1500) };
  await cacheSet(key, result);
  return result;
}

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    if (msg.type === "translateTexts") return { ok: true, data: await translateTexts(msg) };
    if (msg.type === "translateImage") return { ok: true, data: await translateImage(msg) };
    if (msg.type === "getSettings") return { ok: true, data: await getSettings() };
    if (msg.type === "clearCache") {
      await chrome.storage.local.clear();
      return { ok: true };
    }
    return { ok: false, error: "unknown message" };
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});

// ---------- menus & shortcut ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "tt-page", title: "แปลหน้านี้ (TranslateT)", contexts: ["page", "selection"] });
  chrome.contextMenus.create({ id: "tt-image", title: "แปลรูปนี้ (TranslateT)", contexts: ["image"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "tt-page") chrome.tabs.sendMessage(tab.id, { type: "start" });
  if (info.menuItemId === "tt-image") chrome.tabs.sendMessage(tab.id, { type: "translateOneImage", src: info.srcUrl });
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "toggle" });
});
