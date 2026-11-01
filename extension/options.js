import { getSettings, LANGS, MODEL_HINTS } from "./src/settings.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["provider", "apiKey", "model", "baseUrl", "sourceLang", "targetLang", "genre", "tone", "displayMode", "glossary", "characters", "translateImages", "minImageSize"];

$("targetLang").innerHTML = LANGS.map((l) => `<option>${l}</option>`).join("");
$("sourceLang").innerHTML = `<option value="auto">ตรวจอัตโนมัติ</option>` + LANGS.map((l) => `<option>${l}</option>`).join("");

const s = await getSettings();
for (const f of FIELDS) {
  const el = $(f);
  if (el.type === "checkbox") el.checked = s[f];
  else el.value = s[f];
}

const syncProvider = () => {
  $("baseUrlRow").hidden = $("provider").value !== "openai";
  $("model").placeholder = MODEL_HINTS[$("provider").value];
};
$("provider").addEventListener("change", () => {
  $("model").value = MODEL_HINTS[$("provider").value];
  syncProvider();
});
syncProvider();

$("save").onclick = async () => {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    out[f] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  }
  await chrome.storage.sync.set(out);
  $("msg").textContent = "บันทึกแล้ว ✓";
  setTimeout(() => ($("msg").textContent = ""), 2000);
};
$("clear").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "clearCache" });
  $("msg").textContent = "ล้างแคชแล้ว";
};
