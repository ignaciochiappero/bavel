// Shared logic for the bilingual document view: the main panel and the
// floating Picture-in-Picture window render the same projection of the
// conversation (continuous paragraphs per column).
//
// A live streaming entry is split in two by the LocalAgreement policy:
// `transcript` holds the confirmed prefix (stable, never rewritten) and
// `pending` the tentative tail the recognizer may still revise. They are
// exposed separately so the UI can render the unstable part dimmed.
export function computeDocView(conversation) {
  const translationEntries = conversation.filter((m) => m.kind === "translation")
  const lastPair = translationEntries[translationEntries.length - 1]
  const lastEntry = conversation[conversation.length - 1]

  return {
    leftText: conversation
      .map((m) => m.transcript)
      .filter(Boolean)
      .join(" "),
    // Only a live entry can have unconfirmed text.
    leftPending:
      lastEntry && lastEntry.live && lastEntry.pending ? lastEntry.pending : "",
    rightText: translationEntries
      .map((m) => m.translation)
      .filter(Boolean)
      .join(" "),
    sourceLabel: lastEntry ? lastEntry.sourceName : "Transcripción",
    targetLabel: lastPair ? lastPair.targetName : "Traducción",
    isLive: Boolean(lastEntry && lastEntry.live),
  }
}

// Projection for the floating window, which is mode-aware:
// - translation mode: only the resulting translation
// - transcription mode: only the source text (with live caret)
export function computeFloatView(conversation, transcribeMode) {
  const view = computeDocView(conversation)
  if (transcribeMode === "transcription") {
    return {
      label: view.sourceLabel,
      text: view.leftText,
      pending: view.leftPending,
      isLive: view.isLive,
    }
  }
  return {
    label: view.targetLabel,
    text: view.rightText,
    pending: "",
    isLive: false,
  }
}
