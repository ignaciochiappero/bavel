import { describe, it, expect } from "vitest"
import { computeDocView } from "./docView"

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
