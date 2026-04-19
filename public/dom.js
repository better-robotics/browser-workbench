export const $ = (id) => document.getElementById(id);

// Unique-query cache bust. `cache: "no-cache"` on fetch triggers a
// revalidation, not a forced refetch — GH Pages CDN's "still fresh" reply
// keeps the cached bytes. A novel query string is the only reliable bypass.
// Rule: any fetch targeting `firmware/*` (OTA bundles, binaries, prep assets)
// must go through this.
export const freshUrl = (path) =>
  `${path}${path.includes("?") ? "&" : "?"}v=${Date.now()}`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Backdrop-click dismiss for quick-view <dialog>s (label, settings, pinout).
// Do NOT wire this on dialogs that carry session state or multi-step work
// (recovery terminal, SD-prep) — accidental clicks outside wreck user work.
// Menus and popovers have their own dismiss logic; don't use this helper.
export function wireDialogOutsideClick(dialog) {
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}
