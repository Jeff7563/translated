// Minimal LLM clients. Each returns the model's text reply.
// image: optional { mime, base64 }

export async function callLLM(s, system, user, image) {
  if (s.provider === "ollama") return ollama(s, system, user, image);
  if (!s.apiKey && s.provider !== "openai") throw new Error("ยังไม่ได้ใส่ API key (ไปที่หน้าตั้งค่า)");
  if (s.provider === "anthropic") return anthropic(s, system, user, image);
  if (s.provider === "gemini") return gemini(s, system, user, image);
  return openai(s, system, user, image);
}

export const DAILY_QUOTA = "DAILY_QUOTA";

// Free tiers allow only a few requests per minute: wait and retry on 429/503,
// telling the page why it is waiting. A per-day limit is not worth waiting for.
async function post(url, headers, body, notify, timeoutMs = 90000) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status === 429 && /per ?day|PerDay|daily/i.test(text)) {
      const e = new Error(`429: ${text.slice(0, 300)}`);
      e.code = DAILY_QUOTA;
      throw e;
    }
    if ((res.status === 429 || res.status === 503 || res.status === 529) && attempt < 4) {
      const ra = Number(res.headers.get("retry-after"));
      const hinted = Number((text.match(/retry in ([\d.]+)s/i) || [])[1]);
      const wait = Math.min((ra || hinted || 2 ** attempt * 4) * 1000, 60000);
      notify?.(`ชนโควต้าต่อนาทีของ AI รอ ${Math.round(wait / 1000)} วินาทีแล้วลองใหม่…`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
  }
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
    { model: s.model, max_tokens: 8000, system, messages: [{ role: "user", content }] },
    s._notify
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
  }, s._notify);
  return j.choices[0].message.content;
}

// Local models through Ollama: free, no quota, runs on the user's GPU.
async function ollama(s, system, user, image) {
  const base = (s.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
  const msg = { role: "user", content: user };
  if (image) msg.images = [image.base64];
  let j;
  try {
    j = await post(
      `${base}/api/chat`,
      {},
      {
        model: s.model,
        stream: false,
        format: "json",
        keep_alive: "30m",
        options: { temperature: 0.3, num_ctx: 8192 },
        messages: [{ role: "system", content: system }, msg]
      },
      s._notify,
      300000
    );
  } catch (e) {
    if (/^403/.test(e.message)) {
      throw new Error("Ollama ปฏิเสธการเชื่อมต่อ ให้ตั้งตัวแปร OLLAMA_ORIGINS=chrome-extension://* แล้วเปิด Ollama ใหม่");
    }
    if (/^404/.test(e.message)) throw new Error(`ไม่พบโมเดล ${s.model} ใน Ollama (ลอง: ollama pull ${s.model})`);
    if (/Failed to fetch|NetworkError/i.test(e.message)) throw new Error("ต่อ Ollama ไม่ได้ เปิดโปรแกรม Ollama อยู่หรือเปล่า?");
    throw e;
  }
  return j.message?.content || "";
}

export async function listOllamaModels(url) {
  const base = (url || "http://localhost:11434").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) throw new Error(`${res.status}`);
  const j = await res.json();
  return (j.models || []).map((m) => m.name);
}

// Google retires model names often, and free "flash" models allow only ~20
// requests a day. Pick the newest model of a family this key can use.
async function newestGemini(apiKey, family) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": apiKey }
  });
  if (!res.ok) return null;
  const { models = [] } = await res.json();
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
  const re = new RegExp(`^gemini-[\\d.]+-${family}$`);
  const ids = models
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => re.test(n));
  ids.sort((a, b) => ver(b) - ver(a));
  return ids[0] || null;
}

async function switchModel(s, family) {
  const next = (await newestGemini(s.apiKey, family)) || (family === "flash-lite" ? "gemini-3.5-flash-lite" : null);
  if (!next || next === s.model) return null;
  await chrome.storage.sync.set({ model: next });
  s._notify?.(`เปลี่ยนไปใช้โมเดล ${next}`);
  return next;
}

async function gemini(s, system, user, image) {
  try {
    return await geminiOnce(s, system, user, image);
  } catch (e) {
    if (/^400/.test(e.message) && /thinking/i.test(e.message) && !s.noThinkingConfig) {
      return gemini({ ...s, noThinkingConfig: true }, system, user, image);
    }
    if (e.code === DAILY_QUOTA) {
      const next = !/lite/.test(s.model) && (await switchModel(s, "flash-lite"));
      if (next) return gemini({ ...s, model: next }, system, user, image);
      throw new Error("โควต้าฟรีของ Gemini วันนี้หมดแล้ว ลองพรุ่งนี้ หรือเปิดบิลใน Google AI Studio / ใช้ AI เจ้าอื่น");
    }
    if (!/^404/.test(e.message)) throw e;
    const next = await switchModel(s, /lite/.test(s.model) ? "flash-lite" : "flash");
    if (!next) throw e;
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
      generationConfig: {
        responseMimeType: "application/json",
        // Translation needs little reasoning; low thinking is much faster.
        ...(s.noThinkingConfig ? {} : { thinkingConfig: { thinkingLevel: "low" } })
      }
    },
    s._notify
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
