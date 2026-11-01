// Shared defaults for background, popup and options pages.
export const DEFAULTS = {
  provider: "anthropic", // anthropic | openai | gemini
  apiKey: "",
  model: "claude-sonnet-5-5",
  baseUrl: "https://api.openai.com/v1", // used by "openai" provider (also Ollama, OpenRouter, DeepSeek...)
  targetLang: "Thai",
  sourceLang: "auto",
  genre: "การ์ตูน / มังงะ / เว็บตูน",
  tone: "ภาษาพูดเป็นกันเอง เหมือนคนไทยคุยกันจริง",
  glossary: "", // one per line: source = target
  characters: "", // free notes: who is who, gender, how they speak
  displayMode: "replace", // replace | bilingual
  translateImages: true,
  minImageSize: 250,
  autoSites: [] // hostnames translated automatically on load
};

export const MODEL_HINTS = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5-mini",
  gemini: "gemini-3.8-flash"
};

export const LANGS = [
  "Thai", "English", "Chinese (Simplified)", "Chinese (Traditional)", "Japanese",
  "Korean", "German", "French", "Spanish", "Portuguese", "Italian", "Russian",
  "Vietnamese", "Indonesian", "Malay", "Lao", "Burmese", "Khmer", "Arabic",
  "Hindi", "Turkish", "Dutch", "Polish"
];

export async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}
