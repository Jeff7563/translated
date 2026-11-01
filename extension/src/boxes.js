// Shared by the extension and the mobile reader server.

// How to cut a tall comic image before sending it to the model.
// Qwen2.5-VL answers with pixel coordinates of the image *it* saw, and Ollama
// shrinks anything over ~1 MP (to multiples of 28). Sending slices that are
// already a multiple of 28 and under 1 MP means its pixels are our pixels.
export function sliceGeometry(s) {
  if (s.provider === "ollama" && /qwen2\.?5.?vl/i.test(s.model || "")) {
    return { width: 672, height: 1456, pixels: true, step: 28 };
  }
  return { width: 1000, height: 2400, pixels: false, step: 1 };
}

// Turns a vision model's answer for one image slice into boxes relative to the
// whole image (0..1).
// sl: { y0, y1 } slice position in the image (0..1), { w, h } slice pixels.
export function sliceItems(j, sl, pixels = false) {
  const span = sl.y1 - sl.y0;
  const items = [];
  for (const it of j.items || []) {
    if (!it || typeof it.text !== "string" || !it.text.trim()) continue;
    let ymin, xmin, ymax, xmax;
    let px = pixels;
    if (Array.isArray(it.bbox_2d) && it.bbox_2d.length === 4) {
      // Qwen's native format: [x1, y1, x2, y2] in pixels.
      [xmin, ymin, xmax, ymax] = it.bbox_2d.map(Number);
      px = true;
    } else {
      const b = it.box_2d || it.box;
      if (!Array.isArray(b) || b.length !== 4) continue;
      [ymin, xmin, ymax, xmax] = b.map(Number);
      // Some models answer in pixels even when asked for 0-1000.
      if (Math.max(ymin, xmin, ymax, xmax) > 1000) px = true;
    }
    if (px) {
      ymin = (ymin / sl.h) * 1000;
      ymax = (ymax / sl.h) * 1000;
      xmin = (xmin / sl.w) * 1000;
      xmax = (xmax / sl.w) * 1000;
    }
    if (![ymin, xmin, ymax, xmax].every(Number.isFinite) || !(ymax > ymin && xmax > xmin)) continue;
    // Models often box only the letters: grow the box so it covers the bubble text.
    const padX = (xmax - xmin) * 0.12 + 8;
    const padY = (ymax - ymin) * 0.15 + 8;
    const c = (v) => Math.min(1000, Math.max(0, v));
    [xmin, xmax, ymin, ymax] = [c(xmin - padX), c(xmax + padX), c(ymin - padY), c(ymax + padY)];
    items.push({
      x0: xmin / 1000,
      x1: xmax / 1000,
      y0: sl.y0 + (ymin / 1000) * span,
      y1: sl.y0 + (ymax / 1000) * span,
      source: it.source || "",
      text: it.text.trim()
    });
  }
  return { items, story: items.map((i) => i.source).filter(Boolean).join("\n") };
}
