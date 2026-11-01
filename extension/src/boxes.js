// Turns a vision model's answer for one image slice into boxes relative to the
// whole image (0..1). Shared by the extension and the mobile reader server.
// sl: { y0, y1 } slice position in the image (0..1), { w, h } slice pixels.
export function sliceItems(j, sl) {
  const span = sl.y1 - sl.y0;
  const items = [];
  for (const it of j.items || []) {
    const b = it.box_2d || it.box;
    if (!Array.isArray(b) || b.length !== 4 || !it.text) continue;
    let [ymin, xmin, ymax, xmax] = b.map(Number);
    // Some local models (Qwen2.5-VL) answer in pixels of the image they saw.
    if (Math.max(ymin, xmin, ymax, xmax) > 1000) {
      ymin = (ymin / sl.h) * 1000;
      ymax = (ymax / sl.h) * 1000;
      xmin = (xmin / sl.w) * 1000;
      xmax = (xmax / sl.w) * 1000;
    }
    if (!(ymax > ymin && xmax > xmin)) continue;
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
      text: it.text
    });
  }
  return { items, story: items.map((i) => i.source).filter(Boolean).join("\n") };
}
