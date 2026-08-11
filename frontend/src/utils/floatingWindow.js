import { computeDocView } from "./docView"

// Floating translations window: a Document Picture-in-Picture window that
// stays on top of everything (e.g. over a Meet call in another tab).
//
// Per the Document PiP spec, the opener executes the scripts that affect the
// pip window's content — the pip document is same-origin and the opener keeps
// a live reference to it, so we render DIRECTLY into pipWin.document on every
// snapshot. No postMessage, no BroadcastChannel, no injected scripts.

const FLOAT_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0;
      font-family: "Roboto Mono", "Courier New", monospace; }
  body { background: #ffa500; color: #000; overflow: hidden; }
  .float-root { height: 100vh; display: flex; flex-direction: column;
                padding: 8px 10px; gap: 4px; }
  .float-title { font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
                 text-transform: uppercase; opacity: 0.85; }
  .float-columns { flex: 1; display: grid; grid-template-columns: 1fr 1fr;
                   gap: 12px; overflow: auto; }
  .float-column-target { border-left: 1px solid #000; padding-left: 12px; }
  .float-label { font-size: 10px; font-weight: 700; text-transform: uppercase;
                 letter-spacing: 0.06em; margin-bottom: 3px; }
  .float-text { font-size: 14px; line-height: 1.4; word-break: break-word;
                white-space: pre-wrap; }
  .live-caret { display: inline-block; width: 7px; height: 12px; margin-left: 3px;
                background: #000; vertical-align: text-bottom;
                animation: caret 1s steps(2, start) infinite; }
  @keyframes caret { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
`

// Renders the bilingual document into `root` using `doc` as the document
// factory — every element must be created in the pip document.
function renderFloat(root, conversation, doc) {
  const view = computeDocView(conversation)

  const columns = doc.createElement("div")
  columns.className = "float-columns"

  const source = doc.createElement("div")
  const sourceLabel = doc.createElement("div")
  sourceLabel.className = "float-label"
  sourceLabel.textContent = view.sourceLabel
  const sourceText = doc.createElement("div")
  sourceText.className = "float-text"
  sourceText.textContent = view.leftText || "—"
  if (view.isLive) {
    const caret = doc.createElement("span")
    caret.className = "live-caret"
    sourceText.appendChild(caret)
  }
  source.append(sourceLabel, sourceText)

  const target = doc.createElement("div")
  target.className = "float-column float-column-target"
  const targetLabel = doc.createElement("div")
  targetLabel.className = "float-label"
  targetLabel.textContent = view.targetLabel
  const targetText = doc.createElement("div")
  targetText.className = "float-text"
  targetText.textContent = view.rightText || "—"
  target.append(targetLabel, targetText)

  columns.append(source, target)

  // Rebuild only the columns; keep the title bar.
  const existing = root.querySelector(".float-columns")
  if (existing) existing.remove()
  root.appendChild(columns)
}

// Opens the floating window and returns handles to close it and to push
// conversation snapshots (rendered directly into the pip document).
export async function openFloatingWindow({ conversation = [], onClose } = {}) {
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

  const render = (nextConversation) => renderFloat(root, nextConversation, doc)
  render(conversation)

  const close = () => pipWin.close()

  pipWin.addEventListener("pagehide", () => {
    if (onClose) onClose()
  })

  return {
    close,
    post: render,
  }
}
