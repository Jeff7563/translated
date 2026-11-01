import { getSettings, LANGS } from "./src/settings.js";

const $ = (id) => document.getElementById(id);
const s = await getSettings();
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const host = tab?.url ? new URL(tab.url).hostname : "";

$("targetLang").innerHTML = LANGS.map((l) => `<option>${l}</option>`).join("");
$("targetLang").value = s.targetLang;
$("genre").value = s.genre;
$("translateImages").checked = s.translateImages;
$("auto").checked = s.autoSites.includes(host);
$("warn").hidden = !!s.apiKey || s.provider === "openai";

const save = async () => {
  const autoSites = new Set(s.autoSites);
  $("auto").checked ? autoSites.add(host) : autoSites.delete(host);
  await chrome.storage.sync.set({
    targetLang: $("targetLang").value,
    genre: $("genre").value,
    translateImages: $("translateImages").checked,
    autoSites: [...autoSites]
  });
};
["targetLang", "genre", "translateImages", "auto"].forEach((id) => $(id).addEventListener("change", save));

async function sendToTab(msg) {
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // Page was open before the extension was installed: inject now.
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
    await chrome.tabs.sendMessage(tab.id, msg);
  }
}

$("go").onclick = async () => {
  await save();
  await sendToTab({ type: "stop" });
  await sendToTab({ type: "start" });
  window.close();
};
$("stop").onclick = async () => {
  await sendToTab({ type: "stop" });
  window.close();
};
