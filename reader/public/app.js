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
  img.onload = () => {
    if (my !== gen) return;
    page.classList.add("ready");
    page.style.aspectRatio = "";
    const sliceH = Math.round(img.naturalWidth * 2.4);
    for (let y = 0, s = 0; y < img.naturalHeight; y += sliceH, s++) {
      const h = Math.min(sliceH, img.naturalHeight - y);
      if (h < 40) break;
      jobs.push({ my, page, img, i, s, y, h, y0: y / img.naturalHeight, y1: (y + h) / img.naturalHeight });
      total++;
    }
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
  const key = `${job.img.dataset.src.replace(/k=[^&]*&/, "")}#${job.s}`;
  status(`กำลังแปล ${finished + 1}/${total}…`, true);
  try {
    let r = await api("/api/translate", { key });
    if (r.miss) {
      const maxW = Math.min(job.img.naturalWidth, 1000);
      const scale = maxW / job.img.naturalWidth;
      const c = document.createElement("canvas");
      c.width = Math.round(job.img.naturalWidth * scale);
      c.height = Math.round(job.h * scale);
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
    for (const it of r.items) draw(job.page, it);
  } catch (e) {
    if (job.my !== gen) return;
    status("แปลไม่สำเร็จ: " + e.message);
  }
  finished++;
  if (job.my === gen) status(finished >= total && !jobs.length ? `แปลครบแล้ว ${total} ส่วน` : `แปลแล้ว ${finished}/${total}`, finished < total);
}

function draw(page, it) {
  const b = document.createElement("div");
  b.className = "bubble";
  b.style.left = it.x0 * 100 + "%";
  b.style.top = it.y0 * 100 + "%";
  b.style.width = (it.x1 - it.x0) * 100 + "%";
  b.style.height = (it.y1 - it.y0) * 100 + "%";
  b.textContent = it.text;
  b.title = it.source;
  b.onclick = () => b.classList.toggle("src");
  page.append(b);
  fit(b);
}

function fit(el) {
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return;
  const len = Math.max(1, el.textContent.length);
  let size = Math.max(9, Math.min(24, Math.sqrt((w * h * 0.5) / len)));
  el.style.fontSize = size + "px";
  while (size > 9 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
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
