// Minimal LLM clients. Each returns the model's text reply.
// image: optional { mime, base64 }

export async function callLLM(s, system, user, image) {
  if (!s.apiKey && s.provider !== "openai") throw new Error("ยังไม่ได้ใส่ API key (ไปที่หน้าตั้งค่า)");
  if (s.provider === "anthropic") return anthropic(s, system, user, image);
  if (s.provider === "gemini") return gemini(s, system, user, image);
  return openai(s, system, user, image);
}

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function anthropic(s, system, user, image) {
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } });
  content.push({ type: "text", text: user });
  const j = await post(
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": s.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    { model: s.model, max_tokens: 8000, system, messages: [{ role: "user", content }] }
  );
  return j.content.filter((c) => c.type === "text").map((c) => c.text).join("");
}

async function openai(s, system, user, image) {
  const content = image
    ? [{ type: "text", text: user }, { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } }]
    : user;
  const base = (s.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const headers = s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};
  const j = await post(`${base}/chat/completions`, headers, {
    model: s.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content }
    ]
  });
  return j.choices[0].message.content;
}

// Google retires model names often. If the saved one is gone, pick the newest
// "flash" model this key can use, remember it, and retry once.
async function newestGeminiFlash(apiKey) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": apiKey }
  });
  if (!res.ok) return null;
  const { models = [] } = await res.json();
  const ver = (n) => (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0";
  const ids = models
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-[\d.]+-flash$/.test(n));
  ids.sort((a, b) => parseFloat(ver(b)) - parseFloat(ver(a)));
  return ids[0] || null;
}

async function gemini(s, system, user, image) {
  try {
    return await geminiOnce(s, system, user, image);
  } catch (e) {
    if (!/^404/.test(e.message)) throw e;
    const next = await newestGeminiFlash(s.apiKey);
    if (!next || next === s.model) throw e;
    await chrome.storage.sync.set({ model: next });
    return geminiOnce({ ...s, model: next }, system, user, image);
  }
}

async function geminiOnce(s, system, user, image) {
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
  parts.push({ text: user });
  const j = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent`,
    { "x-goog-api-key": s.apiKey },
    {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" }
    }
  );
  return j.candidates[0].content.parts.map((p) => p.text || "").join("");
}

// Pull the first JSON object out of a reply that may be wrapped in ```json fences.
export function parseJSON(text) {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("โมเดลไม่ได้ตอบเป็น JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}
