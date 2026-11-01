// Phone side of TranslateT Reader: shows the chapter images (through the PC),
// slices each image like the extension does, asks the PC to translate the
// slices nearest the screen first, and draws Thai bubbles over the art.
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const K = qs.get("k") || localStorage.getItem("tt-k") || "";
if (K) localStorage.setItem("tt-k", K);

const api = async (p, body) => {
  const r = await fetch(p, {
    method: body ? "POST" : "GET",
    headers: { "x-key": K, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

// How the PC wants images cut (depends on the model). Loaded once.
let geo = { width: 1000, height: 2400, pixels: false, step: 1 };
const infoReady = api("/api/info")
  .then((i) => i.slice && (geo = i.slice))
  .catch(() => {});

// ---------- status ----------
let statusTimer;
function status(text, sticky) {
  $("status").textContent = text;
  $("status").hidden = !text;
  clearTimeout(statusTimer);
  if (text && !sticky) statusTimer = setTimeout(() => ($("status").hidden = true), 4000);
}

// ---------- recent ----------
const recent = () => JSON.parse(localStorage.getItem("tt-recent") || "[]");
function remember(url, title) {
  const list = [{ url, title }, ...recent().filter((r) => r.url !== url)].slice(0, 20);
  localStorage.setItem("tt-recent", JSON.stringify(list));
}
function showHome() {
  $("home").hidden = false;
  $("reader").hidden = true;
  const list = recent();
  $("recentTitle").hidden = !list.length;
  $("recent").innerHTML = "";
  for (const r of list) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = link(r.url);
    a.textContent = r.title || r.url;
    a.onclick = (e) => {
      e.preventDefault();
      open(r.url);
    };
    li.append(a);
    $("recent").append(li);
  }
}
const link = (u) => `?k=${encodeURIComponent(K)}&u=${encodeURIComponent(u)}`;

// ---------- reader ----------
let gen = 0; // bumps on every new chapter so old work is dropped
let jobs = [];
let running = 0;
let done = new Map(); // "page:slice" -> story text, for context
let total = 0;
let finished = 0;
let chapter = null;

const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      lazy.unobserve(img);
      img.src = img.dataset.src;
    }
  },
  { rootMargin: "5000px 0px" }
);

async function open(url, push = true) {
  url = url.trim();
  if (!url) return;
  const my = ++gen;
  jobs = [];
  done = new Map();
  total = finished = 0;
  $("url").value = url;
  if (push) history.pushState(null, "", link(url));
  $("home").hidden = true;
  $("reader").hidden = false;
  $("pages").innerHTML = "";
  $("next").hidden = true;
  $("chapterTitle").textContent = "กำลังเปิดตอน…";
  status("คอมกำลังเปิดหน้าการ์ตูน อาจใช้เวลาสักครู่…", true);
  window.scrollTo(0, 0);
  try {
    chapter = await api(`/api/chapter?url=${encodeURIComponent(url)}`);
  } catch (e) {
    if (my !== gen) return;
    $("chapterTitle").textContent = "เปิดไม่ได้: " + e.message;
    status("");
    return;
  }
  if (my !== gen) return;
  remember(url, chapter.title);
  document.title = chapter.title;
  $("chapterTitle").textContent = chapter.title;
  if (!chapter.images.length) {
    $("chapterTitle").textContent += " — ไม่พบรูปการ์ตูนในหน้านี้ (เว็บอาจกันบอท หรือต้องล็อกอิน)";
    status("");
    return;
  }
  status(`พบ ${chapter.images.length} รูป เริ่มแปล…`);
  chapter.images.forEach((im, i) => addPage(im, i, my));
  if (chapter.next) {
    $("next").hidden = false;
    $("next").href = link(chapter.next);
    $("next").onclick = (e) => {
      e.preventDefault();
      open(chapter.next);
    };
  }
}

function addPage(im, i, my) {
  const page = document.createElement("div");
  page.className = "page";
  if (im.w && im.h) page.style.aspectRatio = `${im.w} / ${im.h}`;
  const img = document.createElement("img");
  img.alt = "";
  img.dataset.src = `/api/img?k=${encodeURIComponent(K)}&src=${encodeURIComponent(im.src)}&ref=${encodeURIComponent(chapter.url)}`;
  img.onload = async () => {
    await infoReady;
    if (my !== gen) return;
    page.classList.add("ready");
    page.style.aspectRatio = "";
    // Cut into slices that overlap a little, so a bubble cut at one edge is
    // whole in the next slice. Each slice keeps only bubbles centred in its
    // own part, so nothing is drawn twice.
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const sliceH = Math.round((W * geo.height) / geo.width);
    const overlap = Math.round(sliceH * 0.15);
    const starts = [0];
    while (starts.at(-1) + sliceH < H) starts.push(starts.at(-1) + sliceH - overlap);
    starts.forEach((y, s) => {
      const h = Math.min(sliceH, H - y);
      if (h < 40 && s > 0) return;
      const own0 = s === 0 ? 0 : (y + overlap / 2) / H;
      const own1 = s === starts.length - 1 ? 1 : (y + sliceH - overlap / 2) / H;
      jobs.push({ my, page, img, i, s, y, h, y0: y / H, y1: (y + h) / H, own0, own1 });
      total++;
    });
    pump();
  };
  img.onerror = () => {
    page.innerHTML = `<div class="err">โหลดรูปที่ ${i + 1} ไม่ได้</div>`;
  };
  page.append(img);
  $("pages").append(page);
  lazy.observe(img);
}

// Slices near the screen go first; slices ahead of you beat ones you passed.
function distance(job) {
  const r = job.page.getBoundingClientRect();
  const top = r.top + job.y0 * r.height;
  const bottom = r.top + job.y1 * r.height;
  if (bottom < 0) return -bottom * 3;
  if (top > innerHeight) return top - innerHeight;
  return 0;
}

function pump() {
  while (running < 2 && jobs.length) {
    jobs.sort((a, b) => distance(a) - distance(b));
    const job = jobs.shift();
    running++;
    run(job).finally(() => {
      running--;
      pump();
    });
  }
}

function contextBefore(job) {
  const out = [];
  for (const [k, story] of done) {
    const [pi, si] = k.split(":").map(Number);
    if (pi < job.i || (pi === job.i && si < job.s)) out.push([pi, si, story]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.map((x) => x[2]).join("\n").slice(-1500);
}

async function run(job) {
  if (job.my !== gen) return;
  const key = `${job.img.dataset.src.replace(/k=[^&]*&/, "")}#${geo.width}x${geo.height}@${job.y}`;
  status(`กำลังแปล ${finished + 1}/${total}…`, true);
  try {
    let r = await api("/api/translate", { key });
    if (r.miss) {
      const outW = geo.pixels ? geo.width : Math.min(job.img.naturalWidth, geo.width);
      const scale = outW / job.img.naturalWidth;
      const snap = (v) => Math.max(geo.step * 2, Math.round(v / geo.step) * geo.step);
      const c = document.createElement("canvas");
      c.width = snap(job.img.naturalWidth * scale);
      c.height = snap(job.h * scale);
      c.getContext("2d").drawImage(job.img, 0, job.y, job.img.naturalWidth, job.h, 0, 0, c.width, c.height);
      const base64 = c.toDataURL("image/jpeg", 0.85).split(",")[1];
      r = await api("/api/translate", {
        key,
        image: { mime: "image/jpeg", base64 },
        slice: { y0: job.y0, y1: job.y1, w: c.width, h: c.height },
        title: chapter.title,
        context: contextBefore(job)
      });
    }
    if (job.my !== gen) return;
    done.set(`${job.i}:${job.s}`, r.story || "");
    for (const it of r.items) {
      const cy = (it.y0 + it.y1) / 2;
      if (cy >= job.own0 && cy <= job.own1) draw(job.page, it);
    }
  } catch (e) {
    if (job.my !== gen) return;
    status("แปลไม่สำเร็จ: " + e.message);
  }
  finished++;
  if (job.my === gen) status(finished >= total && !jobs.length ? `แปลครบแล้ว ${total} ส่วน` : `แปลแล้ว ${finished}/${total}`, finished < total);
}

const clamp = (v) => Math.min(1, Math.max(0, v));

// Share of two boxes' overlap in the smaller one (0..1).
function overlapShare(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return (w * h) / small;
}

function draw(page, raw) {
  const pageW = page.clientWidth || innerWidth;
  const pageH = page.clientHeight || pageW;
  const it = { ...raw, x0: clamp(raw.x0), x1: clamp(raw.x1), y0: clamp(raw.y0), y1: clamp(raw.y1) };
  // Thin boxes (vertical text, or the model boxed one word) can't hold a Thai
  // line: widen them around their centre to at least ~6 Thai letters.
  page.boxes = page.boxes || [];
  const minW = Math.min(0.9, Math.max(0.24, 90 / pageW));
  if (it.x1 - it.x0 < minW) {
    // Grow to the side that covers the fewest bubbles already drawn.
    const cx = (it.x0 + it.x1) / 2;
    const tries = [cx - minW / 2, it.x0, it.x1 - minW].map((x0) => {
      x0 = Math.max(0, Math.min(x0, 1 - minW));
      const c = { ...it, x0, x1: x0 + minW };
      return [page.boxes.reduce((n, b) => n + overlapShare(b, c), 0), x0];
    });
    tries.sort((a, b) => a[0] - b[0]);
    it.x0 = tries[0][1];
    it.x1 = it.x0 + minW;
  }
  const minH = 34 / pageH;
  if (it.y1 - it.y0 < minH) {
    const cy = (it.y0 + it.y1) / 2;
    it.y0 = clamp(cy - minH / 2);
    it.y1 = clamp(it.y0 + minH);
  }
  // The same bubble read twice: keep the first one.
  if (page.boxes.some((b) => overlapShare(b, it) > 0.5)) return;
  page.boxes.push(it);

  const b = document.createElement("div");
  b.className = "bubble";
  b.style.left = it.x0 * 100 + "%";
  b.style.top = it.y0 * 100 + "%";
  b.style.width = (it.x1 - it.x0) * 100 + "%";
  b.style.minHeight = (it.y1 - it.y0) * 100 + "%";
  b.dataset.h = it.y1 - it.y0;
  b.textContent = it.text;
  b.title = it.source;
  b.onclick = () => b.classList.toggle("src");
  page.append(b);
  fit(b);
}

// Biggest font (9-22 px) at which the text fits the box without growing it.
function fit(el) {
  const w = el.clientWidth;
  const h = parseFloat(el.dataset.h) * el.parentElement.clientHeight;
  if (!w || !h) return;
  let size = 22;
  el.style.fontSize = size + "px";
  while (size > 9 && (el.scrollHeight > h + 1 || el.scrollWidth > w + 1)) {
    size -= 1;
    el.style.fontSize = size + "px";
  }
}

// ---------- ui ----------
$("go").onsubmit = (e) => {
  e.preventDefault();
  $("url").blur();
  open($("url").value);
};
$("paste").onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (/^https?:\/\//.test(t)) open(t);
    else status("ในคลิปบอร์ดไม่มีลิงก์");
  } catch {
    status("เบราว์เซอร์ไม่ให้อ่านคลิปบอร์ด กดค้างที่ช่องแล้วเลือกวางแทน");
  }
};
$("toggle").onclick = () => {
  const off = document.body.classList.toggle("original");
  $("toggle").classList.toggle("off", off);
};
let lastY = 0;
let scrollTimer;
addEventListener(
  "scroll",
  () => {
    const y = scrollY;
    $("bar").classList.toggle("hide", y > lastY && y > 80);
    lastY = y;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(pump, 150);
  },
  { passive: true }
);
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.querySelectorAll(".bubble").forEach(fit), 200);
});
addEventListener("popstate", () => {
  const u = new URLSearchParams(location.search).get("u");
  u ? open(u, false) : (gen++, showHome());
});

if (!K) status("เปิดจากลิงก์ที่หน้าจอคอมแสดง (มี ?k=...) ไม่งั้นจะใช้ไม่ได้", true);
const start = qs.get("u");
start ? open(start, false) : showHome();
