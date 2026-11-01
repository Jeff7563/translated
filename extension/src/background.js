import { getSettings } from "./settings.js";
import { systemPrompt, textUserPrompt, imageUserPrompt } from "./prompt.js";
import { callLLM, parseJSON, listOllamaModels } from "./providers.js";
import { sliceItems } from "./boxes.js";

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
async function translateTexts({ title, context, segments }, tabId) {
  const s = await getSettings();
  s._notify = (text) => tabId && chrome.tabs.sendMessage(tabId, { type: "notice", text }).catch(() => {});
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
  const maxW = Math.min(width, 1000);
  const scale = maxW / width;
  const sliceH = Math.round(width * 2.4); // in source pixels
  const slices = [];
  for (let y = 0; y < height; y += sliceH) {
    const h = Math.min(sliceH, height - y);
    if (h < 40) break;
    const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(h * scale));
    canvas.getContext("2d").drawImage(bmp, 0, y, width, h, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const base64 = await blobToBase64(out);
    slices.push({ y0: y / height, y1: (y + h) / height, w: canvas.width, h: canvas.height, image: { mime: "image/jpeg", base64 } });
  }
  return slices;
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Slices of recently used images, kept in memory so each slice request does
// not download and cut the image again.
const sliceCache = new Map();
function getSlices(src) {
  if (!sliceCache.has(src)) {
    const p = loadSlices(src);
    p.catch(() => sliceCache.delete(src));
    sliceCache.set(src, p);
    while (sliceCache.size > 12) sliceCache.delete(sliceCache.keys().next().value);
  }
  return sliceCache.get(src);
}

async function imageSlices({ src }) {
  const slices = await getSlices(src);
  return slices.map(({ y0, y1 }) => ({ y0, y1 }));
}

async function translateSlice({ src, index, title, context }, tabId) {
  const s = await getSettings();
  s._notify = (text) => tabId && chrome.tabs.sendMessage(tabId, { type: "notice", text }).catch(() => {});
  const key = "s:" + (await hash(settingsKey(s) + "\u0000" + src + "\u0000" + index));
  const hit = await cacheGet(key);
  if (hit) return hit;
  const sl = (await getSlices(src))[index];
  if (!sl) return { items: [], story: "" };
  const reply = await callLLM(s, systemPrompt(s), imageUserPrompt({ title, context: (context || "").slice(-1500) }), sl.image);
  const result = sliceItems(parseJSON(reply), sl);
  await cacheSet(key, result);
  return result;
}

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const run = async () => {
    if (msg.type === "translateTexts") return { ok: true, data: await translateTexts(msg, tabId) };
    if (msg.type === "imageSlices") return { ok: true, data: await imageSlices(msg) };
    if (msg.type === "translateSlice") return { ok: true, data: await translateSlice(msg, tabId) };
    if (msg.type === "getSettings") return { ok: true, data: await getSettings() };
    if (msg.type === "ollamaModels") return { ok: true, data: await listOllamaModels(msg.url) };
    if (msg.type === "clearCache") {
      await chrome.storage.local.clear();
      return { ok: true };
    }
    return { ok: false, error: "unknown message" };
  };
  run().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});

// ---------- local Ollama ----------
// Ollama refuses browser-extension origins unless OLLAMA_ORIGINS is set.
// Requests from this extension to localhost don't need an Origin header, so drop it.
async function installOllamaRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
          condition: {
            regexFilter: "^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?/api/",
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    });
  } catch (e) {
    console.warn("TranslateT: could not install Ollama header rule", e);
  }
}
chrome.runtime.onInstalled.addListener(installOllamaRule);
chrome.runtime.onStartup.addListener(installOllamaRule);

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
