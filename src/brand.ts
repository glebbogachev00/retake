/** Retake's own look, for pages that leave the window: the share pages.
    The same stylesheet the window uses (src/ui/brand.css), put inline so a
    shared page stands on its own, with nothing loaded from anywhere. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The window's stylesheet: paper and ink, amber, REC red, labels, frames. */
export function brandCss(): string {
  return fs.readFileSync(path.join(HERE, "ui", "brand.css"), "utf8");
}

/** The Retake mark, as SVG shapes in a 64 × 64 box. */
export const MARK_SHAPES = `<rect width="64" height="64" rx="14" fill="#1a1c1e"/><g fill="#eceee9"><rect x="16" y="12" width="12" height="6" rx="3" opacity=".55"/><rect x="16" y="21" width="20" height="6" rx="3" opacity=".8"/><rect x="16" y="39" width="20" height="6" rx="3" opacity=".8"/><rect x="16" y="48" width="12" height="6" rx="3" opacity=".55"/></g><rect x="16" y="30" width="36" height="6" rx="3" fill="#e8b04b"/>`;

/** The mark as an inline SVG, at a size. */
export const markSvg = (size: number) => `<svg class="rt-mark" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" focusable="false">${MARK_SHAPES}</svg>`;

/** A favicon link for a page with no server behind its assets. */
export const markFavicon = () => `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${MARK_SHAPES}</svg>`)}">`;
