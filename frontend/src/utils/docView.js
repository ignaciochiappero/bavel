// Shared logic for the bilingual document view: the main panel and the
// floating Picture-in-Picture window render the same projection of the
// conversation (continuous paragraphs per column).
export function computeDocView(conversation) {
  const translationEntries = conversation.filter((m) => m.kind === "translation")
  const lastPair = translationEntries[translationEntries.length - 1]
  const lastEntry = conversation[conversation.length - 1]

  return {
    leftText: conversation
      .map((m) => m.transcript)
      .filter(Boolean)
      .join(" "),
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
    return { label: view.sourceLabel, text: view.leftText, isLive: view.isLive }
  }
  return { label: view.targetLabel, text: view.rightText, isLive: false }
}
