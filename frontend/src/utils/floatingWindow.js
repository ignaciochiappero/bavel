import { computeFloatView } from "./docView"
// Vite rewrites these to fingerprinted URLs. The pip document is same-origin
// but does NOT inherit the opener's @font-face rules, so they are redeclared
// below against these exact URLs.
import blenderBook from "../assets/fonts/BlenderPro-Book.woff"
import blenderMedium from "../assets/fonts/BlenderPro-Medium.woff"

// Floating translations window: a Document Picture-in-Picture window that
// stays on top of everything (e.g. over a Meet call in another tab).
//
// Per the Document PiP spec, the opener executes the scripts that affect the
// pip window's content — the pip document is same-origin and the opener keeps
// a live reference to it, so we render DIRECTLY into pipWin.document on every
// snapshot. No postMessage, no BroadcastChannel, no injected scripts.
//
// Content is mode-aware: translation mode shows only the resulting
// translation; transcription mode shows only the source text. The text body
// auto-scrolls to the bottom on every update.

// Glass styling for the pip window.
//
// NOTE ON REAL TRANSPARENCY: a Document Picture-in-Picture window cannot be
// see-through to the desktop — the browser paints its own opaque background
// and no CSS can punch through it. So the glass here is *simulated*: a dark
// ground, a blurred colour wash drifting underneath, a translucent pane with a
// bright top edge, and a specular sheen. It reads as frosted glass sitting on
// top of other windows, which is the effect asked for, without pretending to a
// capability the platform does not expose.
const FLOAT_CSS = `
  @font-face {
    font-family: "Blender Pro"; src: url("${blenderBook}") format("woff");
    font-weight: 400; font-style: normal; font-display: block;
  }
  @font-face {
    font-family: "Blender Pro"; src: url("${blenderMedium}") format("woff");
    font-weight: 500; font-style: normal; font-display: block;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
  :root {
    --accent: #6c8cff;
    --ink: rgba(255,255,255,0.96);
    --ink-dim: rgba(255,255,255,0.42);
    --font-ui: "Blender Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, system-ui, sans-serif;
    --font-mono: "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  body {
    background: #07080d;
    color: var(--ink);
    overflow: hidden;
    font-family: var(--font-ui);
    height: 100vh;
  }
  /* Colour wash drifting behind the pane — this is what the blur refracts. */
  body::before, body::after {
    content: ""; position: fixed; border-radius: 50%;
    filter: blur(56px); opacity: 0.55; pointer-events: none;
    will-change: transform;
  }
  body::before {
    width: 90vw; height: 90vw; top: -46vw; left: -26vw;
    background: radial-gradient(circle, var(--accent), transparent 68%);
    animation: fdrift-a 26s cubic-bezier(0.22,1,0.36,1) infinite alternate;
  }
  body::after {
    width: 78vw; height: 78vw; right: -34vw; bottom: -40vw;
    background: radial-gradient(circle, #ff7ac6, transparent 66%);
    animation: fdrift-b 31s cubic-bezier(0.22,1,0.36,1) infinite alternate;
  }
  @keyframes fdrift-a { to { transform: translate3d(14vw, 10vh, 0) scale(1.2); } }
  @keyframes fdrift-b { to { transform: translate3d(-12vw, -8vh, 0) scale(1.14); } }

  .float-root {
    position: relative; height: 100vh; display: flex; flex-direction: column;
    gap: 8px; padding: 12px 14px 14px;
    background: rgba(255,255,255,0.07);
    backdrop-filter: blur(30px) saturate(160%);
    -webkit-backdrop-filter: blur(30px) saturate(160%);
    border-top: 1px solid rgba(255,255,255,0.22);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.12);
  }
  /* Specular sheen across the top — the tell that sells "glass". */
  .float-root::before {
    content: ""; position: absolute; inset: 0 0 auto 0; height: 45%;
    background: linear-gradient(to bottom, rgba(255,255,255,0.09), transparent);
    pointer-events: none;
  }
  .float-title {
    position: relative; font-size: 9px; font-weight: 600;
    letter-spacing: 0.26em; text-transform: uppercase;
    color: rgba(255,255,255,0.5);
  }
  .float-body {
    position: relative; flex: 1; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.16) transparent;
  }
  .float-body::-webkit-scrollbar { width: 5px; }
  .float-body::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.16); border-radius: 999px;
  }
  .float-label {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.2em; color: rgba(255,255,255,0.38); margin-bottom: 6px;
  }
  .float-text {
    font-family: var(--font-mono);
    font-size: 14px; line-height: 1.62; word-break: break-word;
    white-space: pre-wrap; color: var(--ink);
  }
  .float-pending { color: var(--ink-dim); font-style: italic; }
  .live-caret {
    display: inline-block; width: 2px; height: 1em; margin-left: 4px;
    border-radius: 2px; vertical-align: text-bottom;
    background: var(--accent); box-shadow: 0 0 10px var(--accent);
    animation: caret 1.15s cubic-bezier(0.22,1,0.36,1) infinite;
  }
  @keyframes caret { 0%,100% { opacity: 1; } 50% { opacity: 0.12; } }

  @media (prefers-reduced-motion: reduce) {
    body::before, body::after, .live-caret { animation: none; }
  }
`

// Renders the mode-aware single-column document into `root`, creating every
// element with `doc` (the pip document). Rebuilds the scrollable body and
// pins the scroll position to the bottom.
function renderFloat(root, payload, doc) {
  const view = computeFloatView(payload.conversation, payload.transcribeMode)

  const body = doc.createElement("div")
  body.className = "float-body"

  const label = doc.createElement("div")
  label.className = "float-label"
  label.textContent = view.label
  const text = doc.createElement("div")
  text.className = "float-text"
  text.textContent = view.text || (view.pending ? "" : "—")
  // Tentative tail (not yet confirmed by LocalAgreement) — dimmed.
  if (view.pending) {
    const pending = doc.createElement("span")
    pending.className = "float-pending"
    pending.textContent = `${view.text ? " " : ""}${view.pending}`
    text.appendChild(pending)
  }
  if (view.isLive) {
    const caret = doc.createElement("span")
    caret.className = "live-caret"
    text.appendChild(caret)
  }
  body.append(label, text)

  const existing = root.querySelector(".float-body")
  if (existing) existing.remove()
  root.appendChild(body)
  // Auto-scroll to the newest text.
  body.scrollTop = body.scrollHeight
}

// Opens the floating window and returns handles to close it and to push
// snapshots (rendered directly into the pip document).
export async function openFloatingWindow({ payload, onClose } = {}) {
  if (!("documentPictureInPicture" in window)) {
    throw new Error(
      "La ventana flotante requiere Chrome 116+ (Document Picture-in-Picture)",
    )
  }

  const pipWin = await documentPictureInPicture.requestWindow({
    width: 440,
    height: 260,
  })
  const doc = pipWin.document
  doc.title = "Bavel — traducciones"

  const style = doc.createElement("style")
  style.textContent = FLOAT_CSS
  doc.head.appendChild(style)

  const root = doc.createElement("div")
  root.className = "float-root"
  const title = doc.createElement("div")
  title.className = "float-title"
  title.textContent = "BAVEL · traducción en vivo"
  root.appendChild(title)
  doc.body.appendChild(root)

  const render = (nextPayload) => renderFloat(root, nextPayload, doc)
  render(payload)

  const close = () => pipWin.close()

  pipWin.addEventListener("pagehide", () => {
    if (onClose) onClose()
  })

  return {
    close,
    post: render,
  }
}
