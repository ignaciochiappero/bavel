import { computeFloatView } from "./docView"

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

const FLOAT_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0;
      font-family: "Roboto Mono", "Courier New", monospace; }
  body { background: #ffa500; color: #000; overflow: hidden; }
  .float-root { height: 100vh; display: flex; flex-direction: column;
                padding: 8px 10px; gap: 4px; }
  .float-title { font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
                 text-transform: uppercase; opacity: 0.85; }
  .float-body { flex: 1; overflow-y: auto; }
  .float-label { font-size: 10px; font-weight: 700; text-transform: uppercase;
                 letter-spacing: 0.06em; margin-bottom: 3px; }
  .float-text { font-size: 14px; line-height: 1.4; word-break: break-word;
                white-space: pre-wrap; }
  .live-caret { display: inline-block; width: 7px; height: 12px; margin-left: 3px;
                background: #000; vertical-align: text-bottom;
                animation: caret 1s steps(2, start) infinite; }
  @keyframes caret { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
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
  text.textContent = view.text || "—"
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
