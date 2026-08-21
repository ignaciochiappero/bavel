import { describe, it, expect } from "vitest"
import { computeDocView, computeFloatView } from "./docView"

describe("computeDocView", () => {
  it("joins all transcripts into one continuous left paragraph", () => {
    const view = computeDocView([
      { kind: "translation", transcript: "Hello", translation: "Hola" },
      { kind: "translation", transcript: "How are you", translation: "Cómo estás" },
      { kind: "transcription", transcript: "Fine thanks" },
    ])
    expect(view.leftText).toBe("Hello How are you Fine thanks")
  })

  it("joins only translations into the right paragraph", () => {
    const view = computeDocView([
      { kind: "translation", transcript: "Hello", translation: "Hola" },
      { kind: "transcription", transcript: "Fine thanks" },
      { kind: "translation", transcript: "Bye", translation: "Chau" },
    ])
    expect(view.rightText).toBe("Hola Chau")
  })

  it("uses the latest message languages as column labels", () => {
    const view = computeDocView([
      { kind: "translation", sourceName: "English", targetName: "Spanish" },
      { kind: "transcription", sourceName: "Japanese" },
    ])
    expect(view.sourceLabel).toBe("Japanese")
    expect(view.targetLabel).toBe("Spanish")
  })

  it("falls back to default labels with no messages", () => {
    const view = computeDocView([])
    expect(view.leftText).toBe("")
    expect(view.rightText).toBe("")
    expect(view.sourceLabel).toBe("Transcripción")
    expect(view.targetLabel).toBe("Traducción")
    expect(view.isLive).toBe(false)
  })

  it("exposes the unconfirmed tail of a live entry separately", () => {
    const view = computeDocView([
      { kind: "transcription", transcript: "hola cómo", pending: "estás", live: true },
    ])
    expect(view.leftText).toBe("hola cómo")
    expect(view.leftPending).toBe("estás")
  })

  it("ignores pending text once the entry is no longer live", () => {
    const view = computeDocView([
      { kind: "transcription", transcript: "hola cómo", pending: "estás", live: false },
    ])
    expect(view.leftPending).toBe("")
  })

  it("has no pending text when nothing is streaming", () => {
    const view = computeDocView([
      { kind: "translation", transcript: "Hello", translation: "Hola" },
    ])
    expect(view.leftPending).toBe("")
  })

  it("flags the conversation as live when the last entry is live", () => {
    expect(
      computeDocView([{ kind: "transcription", live: true, transcript: "x" }])
        .isLive,
    ).toBe(true)
    expect(
      computeDocView([{ kind: "transcription", live: false, transcript: "x" }])
        .isLive,
    ).toBe(false)
  })

  it("skips empty transcripts and translations", () => {
    const view = computeDocView([
      { kind: "translation", transcript: "", translation: "" },
      { kind: "translation", transcript: "Hi", translation: "Hola" },
    ])
    expect(view.leftText).toBe("Hi")
    expect(view.rightText).toBe("Hola")
  })
})

describe("computeFloatView", () => {
  const conversation = [
    { kind: "translation", sourceName: "English", targetName: "Spanish", transcript: "Hello", translation: "Hola" },
    { kind: "transcription", sourceName: "English", transcript: "Live", live: true },
  ]

  it("shows only the translation in translation mode", () => {
    const view = computeFloatView(conversation, "translation")
    expect(view.label).toBe("Spanish")
    expect(view.text).toBe("Hola")
    expect(view.isLive).toBe(false)
  })

  it("shows only the source text in transcription mode", () => {
    const view = computeFloatView(conversation, "transcription")
    expect(view.label).toBe("English")
    expect(view.text).toBe("Hello Live")
    expect(view.isLive).toBe(true)
  })

  it("forwards the unconfirmed tail in transcription mode", () => {
    const view = computeFloatView(
      [{ kind: "transcription", sourceName: "English", transcript: "hola", pending: "cómo", live: true }],
      "transcription",
    )
    expect(view.text).toBe("hola")
    expect(view.pending).toBe("cómo")
  })

  it("never shows pending text in translation mode", () => {
    const view = computeFloatView(
      [{ kind: "transcription", sourceName: "English", transcript: "hola", pending: "cómo", live: true }],
      "translation",
    )
    expect(view.pending).toBe("")
  })
})
