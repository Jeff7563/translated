// TranslateT content script: translates page text and comic images in place.
(() => {
  if (window.__translateT) return;
  window.__translateT = true;

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH", "KBD", "SAMP"]);
  const MAX_BATCH_CHARS = 2500;
  const MAX_BATCH_ITEMS = 40;

  let active = false;
  let settings = null;
  const originals = new Map(); // text node -> original text
  const bilingualSpans = new Set();
  let seenNodes = new WeakSet();
  const imageState = new Map(); // img -> { overlay, data }
  let lastContext = "";
  let observer = null;
  const hooked = new WeakSet();
  const watched = new Set(); // images waiting to come near the viewport
  let scanTimer = null;
  const IMG_CONCURRENCY = 3;
  let imgRunning = 0;
  const imgWaiting = [];
  let storySoFar = "";

  const RELOADED = "ส่วนขยายถูกอัปเดต กรุณารีเฟรชหน้า (F5) แล้วแปลใหม่";
  const friendly = (m) => (/context invalidated|Receiving end does not exist/i.test(m) ? RELOADED : m);
  const send = (msg) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(friendly(chrome.runtime.lastError.message)));
          r?.ok ? resolve(r.data) : reject(new Error(r?.error || "error"));
        });
      } catch (e) {
        reject(new Error(friendly(String(e.message || e))));
      }
    });

  // ---------- status badge ----------
  let badge;
  let pending = 0;
  function status(text, isError) {
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "tt-badge";
      badge.title = "คลิกเพื่อคืนต้นฉบับ / แปลใหม่";
      badge.addEventListener("click", toggle);
      document.documentElement.appendChild(badge);
    }
    badge.textContent = text;
    badge.classList.toggle("tt-badge-error", !!isError);
    badge.style.display = text ? "block" : "none";
  }
  function bump(delta) {
    pending += delta;
    if (pending > 0) status(`TranslateT กำลังแปล… (${pending})`);
    else status(active ? "TranslateT ✓" : "");
  }

  // ---------- text ----------
  function acceptNode(node) {
    const text = node.nodeValue;
    if (!text || text.trim().length < 2 || !/\p{L}/u.test(text)) return false;
    let el = node.parentElement;
    if (!el || el.closest(".tt-badge, .tt-overlay, .tt-bi, [contenteditable=''], [contenteditable='true'], [translate='no'], .notranslate")) return false;
    for (; el; el = el.parentElement) if (SKIP_TAGS.has(el.tagName)) return false;
    return true;
  }

  function collect(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (!seenNodes.has(n) && acceptNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    return nodes;
  }

  function batches(nodes) {
    const out = [];
    let cur = [];
    let chars = 0;
    for (const n of nodes) {
      const len = n.nodeValue.length;
      if (cur.length && (chars + len > MAX_BATCH_CHARS || cur.length >= MAX_BATCH_ITEMS)) {
        out.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(n);
      chars += len;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async function translateNodes(nodes) {
    nodes.forEach((n) => seenNodes.add(n));
    for (const batch of batches(nodes)) {
      if (!active) return;
      const segments = batch.map((n) => n.nodeValue.trim());
      bump(1);
      try {
        const result = await send({ type: "translateTexts", title: document.title, context: lastContext, segments });
        if (!active) return;
        batch.forEach((n, i) => apply(n, result[i]));
        lastContext = segments.join("\n").slice(-1200);
      } catch (e) {
        status("TranslateT: " + e.message, true);
        pending--;
        return;
      }
      bump(-1);
    }
  }

  function apply(node, translated) {
    if (!translated || translated === node.nodeValue.trim()) return;
    const raw = node.nodeValue;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    if (settings.displayMode === "bilingual") {
      const span = document.createElement("span");
      span.className = "tt-bi";
      span.textContent = translated;
      node.parentNode?.insertBefore(span, node.nextSibling);
      bilingualSpans.add(span);
    } else {
      originals.set(node, raw);
      node.nodeValue = lead + translated + trail;
      node.parentElement?.setAttribute("data-tt-original", raw.trim().slice(0, 300));
    }
  }

  function restoreText() {
    for (const [node, raw] of originals) {
      node.nodeValue = raw;
      node.parentElement?.removeAttribute("data-tt-original");
    }
    originals.clear();
    bilingualSpans.forEach((s) => s.remove());
    bilingualSpans.clear();
  }

  // ---------- images (comics) ----------
  function bigEnough(img) {
    const min = settings.minImageSize || 250;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return w >= min && h >= min * 0.6 && img.offsetWidth >= 150;
  }

  function watchImages(root) {
    if (!settings.translateImages) return;
    const imgs = root.tagName === "IMG" ? [root] : root.querySelectorAll?.("img") || [];
    imgs.forEach((img) => {
      if (imageState.has(img)) return;
      if (!hooked.has(img)) {
        hooked.add(img);
        // Lazy readers swap a placeholder for the real page later: check again on every load.
        img.addEventListener("load", () => maybeObserve(img));
      }
      if (img.complete) maybeObserve(img);
    });
  }
  function maybeObserve(img) {
    if (active && !imageState.has(img) && bigEnough(img)) {
      watched.add(img);
      scheduleScan();
    }
  }

  // Translate images a few screens ahead of the reader. Uses raw positions
  // instead of IntersectionObserver because many readers scroll inside a div,
  // where IntersectionObserver ignores the look-ahead margin.
  const AHEAD = 4000;
  const BEHIND = 800;
  function scanImages() {
    scanTimer = null;
    if (!active) return;
    const vh = window.innerHeight;
    for (const img of watched) {
      if (!img.isConnected) {
        watched.delete(img);
        continue;
      }
      const r = img.getBoundingClientRect();
      if (r.height && r.top < vh + AHEAD && r.bottom > -BEHIND) {
        watched.delete(img);
        queueImage(img);
      }
    }
  }
  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scanImages, 150);
  }

  function queueImage(img) {
    if (imageState.has(img)) return;
    imageState.set(img, { overlay: null, data: null });
    imgWaiting.push(img);
    pumpImages();
  }

  function pumpImages() {
    while (imgRunning < IMG_CONCURRENCY && imgWaiting.length) {
      // Nearest image to the viewport first.
      imgWaiting.sort((a, b) => Math.abs(a.getBoundingClientRect().top) - Math.abs(b.getBoundingClientRect().top));
      const img = imgWaiting.shift();
      imgRunning++;
      translateImg(img)
        .catch(() => {})
        .finally(() => {
          imgRunning--;
          pumpImages();
        });
    }
  }

  async function translateImg(img) {
    if (!active) return;
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:image/svg")) return;
    bump(1);
    try {
      const data = await send({ type: "translateImage", src, title: document.title, context: storySoFar });
      storySoFar = data.story || storySoFar;
      if (!active) return;
      const st = imageState.get(img);
      if (st) {
        st.data = data;
        drawOverlay(img, st);
      }
    } catch (e) {
      status("TranslateT (รูป): " + e.message, true);
      imageState.delete(img);
      pending--;
      return;
    }
    bump(-1);
  }

  function drawOverlay(img, st) {
    st.overlay?.remove();
    if (!st.data?.items?.length) return;
    const ov = document.createElement("div");
    ov.className = "tt-overlay";
    for (const it of st.data.items) {
      const b = document.createElement("div");
      b.className = "tt-bubble";
      b.textContent = it.text;
      b.title = it.source;
      b.style.left = it.x0 * 100 + "%";
      b.style.top = it.y0 * 100 + "%";
      b.style.width = Math.max(0.04, it.x1 - it.x0) * 100 + "%";
      b.style.minHeight = Math.max(0.015, it.y1 - it.y0) * 100 + "%";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        b.classList.toggle("tt-bubble-hidden");
      });
      ov.appendChild(b);
    }
    img.insertAdjacentElement("afterend", ov);
    st.overlay = ov;
    position(img, st);
  }

  // The overlay is the image's next sibling, so it shares the image's
  // containing block and moves with it no matter which element scrolls.
  function position(img, st) {
    const ov = st.overlay;
    if (!ov) return;
    if (ov.previousElementSibling !== img) img.insertAdjacentElement("afterend", ov);
    const w = img.offsetWidth;
    const h = img.offsetHeight;
    const parent = ov.offsetParent;
    const sameParent = parent && parent === img.offsetParent;
    if (sameParent) {
      ov.style.left = img.offsetLeft + img.clientLeft + "px";
      ov.style.top = img.offsetTop + img.clientTop + "px";
    } else if (parent) {
      const a = img.getBoundingClientRect();
      const b = parent.getBoundingClientRect();
      ov.style.left = a.left - b.left + parent.scrollLeft - parent.clientLeft + "px";
      ov.style.top = a.top - b.top + parent.scrollTop - parent.clientTop + "px";
    }
    ov.style.width = w + "px";
    ov.style.height = h + "px";
    ov.style.display = w && h ? "block" : "none";
    if (ov.dataset.w !== String(w)) {
      ov.dataset.w = String(w);
      for (const b of ov.children) fit(b);
    }
  }

  // Biggest readable font that fits the bubble; the box may grow a little
  // rather than shrink text below 11px.
  function fit(el) {
    const w = el.clientWidth;
    const h = el.parentElement.clientHeight * (parseFloat(el.style.minHeight) / 100);
    if (!w || !h) return;
    const len = Math.max(1, el.textContent.length);
    let size = Math.sqrt((w * h * 0.55) / len);
    size = Math.max(11, Math.min(26, size));
    el.style.fontSize = size + "px";
    while (size > 11 && el.scrollWidth > el.clientWidth + 1) {
      size -= 1;
      el.style.fontSize = size + "px";
    }
  }

  function repositionAll() {
    for (const [img, st] of imageState) position(img, st);
    scheduleScan();
  }

  function translateOneImage(src) {
    if (!settings) return;
    const img = [...document.images].find((i) => (i.currentSrc || i.src) === src);
    if (!img) return;
    active = true;
    imageState.delete(img);
    queueImage(img);
  }

  // ---------- lifecycle ----------
  async function start() {
    if (active) return;
    settings = await send({ type: "getSettings" });
    active = true;
    status("TranslateT กำลังแปล…");
    document.addEventListener("scroll", scheduleScan, { capture: true, passive: true });
    watchImages(document.body);
    observer = new MutationObserver((muts) => {
      const added = [];
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.TEXT_NODE) added.push(n);
          else if (n.nodeType === Node.ELEMENT_NODE && !n.closest?.(".tt-overlay, .tt-badge, .tt-bi")) {
            added.push(...collect(n));
            watchImages(n);
          }
        }
      }
      const fresh = added.filter((n) => !seenNodes.has(n) && acceptNode(n));
      if (fresh.length) debounceTranslate(fresh);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", repositionAll);
    posTimer = setInterval(repositionAll, 1500);
    await translateNodes(collect(document.body));
    bump(0);
  }

  let pendingFresh = [];
  let freshTimer = null;
  let posTimer = null;
  function debounceTranslate(nodes) {
    pendingFresh.push(...nodes);
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => {
      const list = pendingFresh;
      pendingFresh = [];
      translateNodes(list);
    }, 400);
  }

  function stop() {
    active = false;
    observer?.disconnect();
    watched.clear();
    imgWaiting.length = 0;
    document.removeEventListener("scroll", scheduleScan, true);
    clearInterval(posTimer);
    window.removeEventListener("resize", repositionAll);
    restoreText();
    for (const st of imageState.values()) st.overlay?.remove();
    imageState.clear();
    pending = 0;
    seenNodes = new WeakSet(); // allow re-translation next time
    lastContext = "";
    storySoFar = "";
    status("");
  }

  function toggle() {
    if (active) stop();
    else start();
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === "start") start();
    else if (msg.type === "stop") stop();
    else if (msg.type === "toggle") toggle();
    else if (msg.type === "translateOneImage") {
      (settings ? Promise.resolve() : send({ type: "getSettings" }).then((s) => (settings = s))).then(() =>
        translateOneImage(msg.src)
      );
    } else if (msg.type === "status") {
      sendResponse({ active });
      return;
    }
    sendResponse({ ok: true });
  });

  // Auto-translate sites the user opted into.
  send({ type: "getSettings" })
    .then((s) => {
      settings = s;
      if ((s.autoSites || []).includes(location.hostname)) start();
    })
    .catch(() => {});
})();
