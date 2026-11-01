import { getSettings, LANGS, MODEL_HINTS } from "./src/settings.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["provider", "apiKey", "model", "baseUrl", "ollamaUrl", "sourceLang", "targetLang", "genre", "tone", "displayMode", "glossary", "characters", "translateImages", "minImageSize"];

$("targetLang").innerHTML = LANGS.map((l) => `<option>${l}</option>`).join("");
$("sourceLang").innerHTML = `<option value="auto">ตรวจอัตโนมัติ</option>` + LANGS.map((l) => `<option>${l}</option>`).join("");

const s = await getSettings();
for (const f of FIELDS) {
  const el = $(f);
  if (el.type === "checkbox") el.checked = s[f];
  else el.value = s[f];
}

const syncProvider = () => {
  const p = $("provider").value;
  $("baseUrlRow").hidden = p !== "openai";
  $("ollamaRow").hidden = $("ollamaTools").hidden = p !== "ollama";
  $("apiKeyRow").hidden = p === "ollama";
  $("model").placeholder = MODEL_HINTS[$("provider").value];
};
$("provider").addEventListener("change", () => {
  $("model").value = MODEL_HINTS[$("provider").value];
  syncProvider();
});
syncProvider();

$("loadModels").onclick = async () => {
  $("ollamaMsg").textContent = "กำลังดึง…";
  const r = await chrome.runtime.sendMessage({ type: "ollamaModels", url: $("ollamaUrl").value });
  if (!r?.ok) {
    $("ollamaMsg").textContent = "ต่อ Ollama ไม่ได้: " + (r?.error || "") + " (เปิดโปรแกรม Ollama อยู่ไหม?)";
    return;
  }
  $("modelList").innerHTML = r.data.map((m) => `<option value="${m}">`).join("");
  $("ollamaMsg").textContent = r.data.length ? "พบ: " + r.data.join(", ") : "ยังไม่มีโมเดล ลอง ollama pull qwen2.5vl:7b";
};

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
