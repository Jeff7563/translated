// The heart of the project: prompts that make the output read like it was
// written by a native speaker instead of translated word for word.

const LANG_RULES = {
  Thai: `Thai-specific rules:
- Drop pronouns and subjects whenever Thai speakers naturally would.
- Pick pronouns and sentence-final particles from who is speaking to whom and their mood
  (ผม/ครับ, ฉัน/ค่ะ, เรา, กู/มึง, นาย/ฉัน, พี่/น้อง, แก, ข้า/เจ้า for fantasy/period). Keep each character's choice consistent.
- Use natural particles: นะ, น่ะ, สิ, ล่ะ, เหรอ, หรอก, เลย, ว่ะ, วะ, เนี่ย, จ้ะ, จ๊ะ — but do not overuse them.
- Turn English idioms, slang and jokes into Thai ones with the same feeling; never translate them literally.
- Avoid stiff written forms like "มันเป็น...", "ซึ่ง", "ได้รับการ", "ทำการ", "ในการ" unless the original is formal.
- Shouts, sound effects and exclamations should be Thai ones (เฮ้ย!, อ๊ะ, ว้าว, โอ๊ย, ตูม, ฟึ่บ).
- Keep it short and punchy for speech bubbles.`,
  "Chinese (Simplified)": `Chinese rules: use natural colloquial Mandarin (口语) for dialogue, 网络用语 only if the source is that casual; adapt idioms to 成语/俗语 with the same meaning.`,
  "Chinese (Traditional)": `Chinese rules: use natural Traditional Chinese as spoken in Taiwan; adapt idioms rather than translating literally.`,
  Japanese: `Japanese rules: choose 一人称 and speech level (タメ口/敬語/キャラ語尾) per character; keep it natural for manga.`,
  German: `German rules: use du/Sie based on the relationship; natural word order and modal particles (doch, mal, ja, halt) in dialogue.`,
  English: `English rules: use natural contractions and idiomatic phrasing; dialogue should sound like real speech.`
};

function rulesFor(lang) {
  return LANG_RULES[lang] || `${lang} rules: write the way native ${lang} speakers actually talk and write in this genre.`;
}

export function systemPrompt(s) {
  return `You are an expert literary translator and localizer. Translate into ${s.targetLang}${s.sourceLang && s.sourceLang !== "auto" ? ` from ${s.sourceLang}` : ""}.

Goal: the result must read as if it was originally written in ${s.targetLang} by a native speaker. Translate meaning, intent, tone and emotion, not words.
Content type: ${s.genre || "general web page"}.
Desired voice: ${s.tone || "natural"}.

General rules:
- Never translate word for word. Restructure sentences freely so they flow.
- Use the surrounding context (page title, earlier text, neighbouring lines) to resolve meaning, who is speaking, and register.
- Keep names, terms and numbers consistent. Always follow the glossary.
- Keep the same level of rudeness, politeness, humour and slang as the original.
- Do not add explanations, notes, or quotes. Do not censor.
- If a segment is already in ${s.targetLang}, or is code/URL/a username, return it unchanged.

${rulesFor(s.targetLang)}
${s.glossary?.trim() ? `\nGlossary (source = target, must use):\n${s.glossary.trim()}` : ""}
${s.characters?.trim() ? `\nCharacter notes:\n${s.characters.trim()}` : ""}`;
}

export function textUserPrompt({ title, context, segments }) {
  return `Page title: ${title || "(none)"}
${context ? `Text that came just before (for context only, do not translate):\n"""${context}"""\n` : ""}
Translate every segment below. Segments are consecutive pieces of the same page, so read them together first.
Reply with ONLY a JSON object mapping each id to its translation, e.g. {"0":"...","1":"..."}.

${JSON.stringify(Object.fromEntries(segments.map((t, i) => [String(i), t])))}`;
}

export function imageUserPrompt({ title, context }) {
  return `This is a part of a comic/manga/webtoon page from "${title || "a web page"}".
${context ? `Story so far (previous panels, for context):\n"""${context}"""\n` : ""}
Find every piece of readable text (speech bubbles, captions, narration boxes, signs, and meaningful sound effects).
Give one item per separate bubble or box (never merge two bubbles into one item). For each one give a tight bounding box around the bubble/box that contains the text, and its natural translation following all the rules.
Box format "box_2d": [ymin, xmin, ymax, xmax], integers normalized to 0-1000 of this image's height (y) and width (x).
Reply with ONLY JSON: {"items":[{"box_2d":[ymin,xmin,ymax,xmax],"source":"original text","text":"translation"}]}
If there is no text, reply {"items":[]}.`;
}
