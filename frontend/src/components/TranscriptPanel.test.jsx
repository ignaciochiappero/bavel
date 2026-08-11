import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import TranscriptPanel from "./TranscriptPanel"

afterEach(cleanup)

const baseProps = {
  conversation: [],
  saveState: "idle",
  onSave: vi.fn(),
  onNewCall: vi.fn(),
  onOpenHistory: vi.fn(),
  onOpenSettings: vi.fn(),
}

describe("TranscriptPanel", () => {
  it("shows the placeholder when the conversation is empty", () => {
    render(<TranscriptPanel {...baseProps} />)
    expect(screen.getByText("Select languages, push to talk")).toBeTruthy()
  })

  it("renders a translation pair as a two-column document", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        conversation={[
          {
            key: 1,
            kind: "translation",
            sourceName: "English",
            targetName: "Spanish",
            transcript: "Hello",
            translation: "Hola",
            ts: "2026-08-11T12:00:00Z",
          },
        ]}
      />,
    )
    expect(screen.getByText("Hello")).toBeTruthy()
    expect(screen.getByText("Hola")).toBeTruthy()
    expect(screen.getByText("English")).toBeTruthy()
    expect(screen.getByText("Spanish")).toBeTruthy()
  })

  it("joins multiple utterances into one continuous paragraph per column", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        conversation={[
          {
            key: 1,
            kind: "translation",
            sourceName: "English",
            targetName: "Spanish",
            transcript: "Hello",
            translation: "Hola",
          },
          {
            key: 2,
            kind: "translation",
            sourceName: "English",
            targetName: "Spanish",
            transcript: "How are you",
            translation: "Cómo estás",
          },
          {
            key: 3,
            kind: "transcription",
            sourceName: "English",
            transcript: "Fine thanks",
          },
        ]}
      />,
    )
    expect(screen.getByText("Hello How are you Fine thanks")).toBeTruthy()
    expect(screen.getByText("Hola Cómo estás")).toBeTruthy()
  })

  it("renders a transcription entry in the source column", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        conversation={[
          {
            key: 1,
            kind: "transcription",
            sourceName: "English",
            transcript: "Live text",
            ts: "2026-08-11T12:00:00Z",
          },
        ]}
      />,
    )
    expect(screen.getByText("Live text")).toBeTruthy()
    expect(screen.queryByText("Spanish")).toBeNull()
  })

  it("shows a blinking caret on live entries", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        conversation={[
          {
            key: 1,
            kind: "transcription",
            live: true,
            sourceName: "English",
            transcript: "Partial",
          },
        ]}
      />,
    )
    expect(screen.getByText("Partial").querySelector(".live-caret")).toBeTruthy()
  })

  it("disables the save button with no messages", () => {
    render(<TranscriptPanel {...baseProps} />)
    expect(screen.getByRole("button", { name: "Guardar" }).disabled).toBe(true)
  })

  it("shows the saving state", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        saveState="saving"
        conversation={[{ key: 1, kind: "transcription", transcript: "x" }]}
      />,
    )
    expect(screen.getByRole("button", { name: /Guardando/ }).disabled).toBe(true)
  })

  it("shows saved confirmation", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        saveState="saved"
        conversation={[{ key: 1, kind: "transcription", transcript: "x" }]}
      />,
    )
    expect(screen.getByRole("button", { name: /Guardado/ })).toBeTruthy()
  })

  it("fires the header actions", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        conversation={[{ key: 1, kind: "transcription", transcript: "x" }]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Historial" }))
    expect(baseProps.onOpenHistory).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Nueva charla" }))
    expect(baseProps.onNewCall).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }))
    expect(baseProps.onSave).toHaveBeenCalled()
  })
})
