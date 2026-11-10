/**
 * The render controls' styles and a small element builder (GEN-369). Text is
 * always set as text, never as markup: a server's failure reason reaches the
 * screen as it was sent.
 */
export const PANEL_CLASS = 'gev-run-render';
export const PIP_CLASS = 'gev-run-render-pip';
export const VIEWFINDER_CLASS = 'gev-run-render-viewfinder';
export const FULL_CLASS = 'gev-run-render-full';
/** On the run player while the form or the list is open: they take the chart's place (GEN-423). */
export const OPEN_CLASS = 'rr-open';

export const STYLE = `
.gev-run-player.${OPEN_CLASS} :is(.rp-strip, .rp-axis, .rp-lanes, .rp-model) { display: none; }
.${PANEL_CLASS} { box-sizing: border-box; padding: 6px 0 0; border-top: 1px solid rgba(0, 212, 255, 0.2); }
.${PANEL_CLASS}[hidden], .${PIP_CLASS}[hidden], .${VIEWFINDER_CLASS}[hidden], .${FULL_CLASS}[hidden] { display: none; }
.${PANEL_CLASS} .rr-head { display: flex; justify-content: space-between; font-weight: 600; letter-spacing: 0.06em; margin-bottom: 6px; }
.${PANEL_CLASS} .rr-row { display: grid; grid-template-columns: 56px 1fr; gap: 6px; align-items: baseline; margin: 4px 0; }
.${PANEL_CLASS} .rr-label { color: #6fa9b8; }
.${PANEL_CLASS} .rr-options { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.${PANEL_CLASS} label { cursor: pointer; white-space: nowrap; }
.${PANEL_CLASS} input[type=radio] { accent-color: var(--accent, #00d4ff); margin: 0 4px 0 0; vertical-align: -2px; }
.${PANEL_CLASS} select { font: inherit; color: inherit; background: rgba(0, 212, 255, 0.08); border: 1px solid rgba(0, 212, 255, 0.3); border-radius: 4px; }
.${PANEL_CLASS} .rr-hint { color: #6fa9b8; }
.${PANEL_CLASS} .rr-blockers { color: #ffb84d; margin: 6px 0 0; }
.${PANEL_CLASS} .rr-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.gev-run-player .rp-render-line { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.gev-run-player .rp-render-line[hidden] { display: none; }
.gev-run-player .rr-chip { border: 1px solid rgba(0, 212, 255, 0.3); border-radius: 10px; padding: 1px 8px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.gev-run-player .rr-chip.rr-failed { border-color: rgba(255, 184, 77, 0.6); color: #ffb84d; }
.gev-run-player .rr-chip.rr-done { border-color: rgba(120, 220, 140, 0.6); color: #9be8ad; }
.gev-run-player .rr-list { max-height: 132px; overflow: auto; box-sizing: border-box; padding: 4px 0 0;
  border-top: 1px solid rgba(0, 212, 255, 0.2); }
.gev-run-player .rr-list[hidden] { display: none; }
.gev-run-player .rr-list button { display: block; width: 100%; text-align: left; margin: 2px 0; }
.gev-run-player .rr-list .rr-entry { display: flex; gap: 4px; align-items: flex-start; }
.gev-run-player .rr-list .rr-entry > button:first-child { flex: 1 1 auto; min-width: 0; }
.gev-run-player .rr-list .rr-cancel { flex: none; width: auto; }
.gev-run-player .rr-list .rr-reason { color: #ffb84d; font-size: 10px; }
.${PIP_CLASS} {
  position: absolute; top: 16px; right: 16px; width: min(400px, 40%); z-index: 20; box-sizing: border-box;
  padding: 6px; border-radius: 10px; background: rgba(10, 10, 15, 0.86); border: 1px solid rgba(0, 212, 255, 0.3);
  color: #d8f6ff; font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 11px;
}
.${PIP_CLASS} .rr-frame { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #05070a; border-radius: 6px; overflow: hidden; }
.${PIP_CLASS} .rr-frame img, .${PIP_CLASS} .rr-frame canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.${PIP_CLASS} .rr-box { position: absolute; border: 1.5px solid #ff3c3c; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); min-width: 8px; min-height: 8px; transform: translate(-50%, -50%); }
.${PIP_CLASS} .rr-caption { display: flex; justify-content: space-between; gap: 6px; margin-top: 4px; white-space: nowrap; }
.${PIP_CLASS} .rr-caption span { overflow: hidden; text-overflow: ellipsis; }
.${PIP_CLASS} .rr-views { display: flex; gap: 4px; margin-top: 4px; }
.${PIP_CLASS} button, .gev-run-player .rr-list button, .${FULL_CLASS} button, .${FULL_CLASS} a {
  font: inherit; color: inherit; background: rgba(0, 212, 255, 0.08); border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 6px; padding: 2px 8px; cursor: pointer; text-decoration: none;
}
.${PIP_CLASS} button[aria-pressed='true'] { background: rgba(0, 212, 255, 0.3); border-color: var(--accent, #00d4ff); }
.${PIP_CLASS} button:disabled { opacity: 0.4; cursor: default; }
.${PIP_CLASS} .rr-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #6fa9b8; text-align: center; padding: 12px; }
.${VIEWFINDER_CLASS} { position: absolute; z-index: 15; pointer-events: none; box-sizing: border-box;
  border: 1px dashed rgba(0, 212, 255, 0.9); box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.28); }
/* Full size covers the viewer and its HUD, as the attribution lightbox (200) does. Its frame is
   sized from the viewer's own box (container units), not the window's: embedded in a host page
   the viewer is shorter than the window, and the caption and Close fell off the bottom. */
.${FULL_CLASS} { position: absolute; inset: 0; z-index: 200; container-type: size; background: rgba(0, 0, 0, 0.88); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px; color: #d8f6ff; font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 11px; }
.${FULL_CLASS} .rr-frame { position: relative; width: min(96%, calc(86vh * 16 / 9)); width: min(96cqw, calc((100cqh - 96px) * 16 / 9)); aspect-ratio: 16 / 9; }
.${FULL_CLASS} .rr-close { position: absolute; top: 10px; right: 10px; font-size: 18px; line-height: 1; padding: 4px 10px; }
.${FULL_CLASS} .rr-frame img, .${FULL_CLASS} .rr-frame canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.${FULL_CLASS} .rr-box { position: absolute; border: 2px solid #ff3c3c; min-width: 10px; min-height: 10px; transform: translate(-50%, -50%); }
.${FULL_CLASS} .rr-actions { display: flex; gap: 8px; }
`;

/** `el('button', {class: 'x', onclick}, 'text', child)`: attributes, listeners (`on*`), and text or nodes. */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2), value);
    else if (key === 'hidden') node.hidden = Boolean(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : child,
    );
  }
  return node;
}

/** `16:00:55Z` for an instant. */
export function clockText(ms) {
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

/** `0:42`, `1:05`. */
export function elapsedText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
