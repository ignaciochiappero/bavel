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
    const { container } = render(
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
    const cols = container.querySelectorAll(".doc-text")
    expect(cols[0].textContent).toBe("Hello How are you Fine thanks")
    expect(cols[1].textContent).toBe("Hola Cómo estás")
  })

  it("renders a transcription entry in the source column", () => {
    const { container } = render(
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
    expect(container.querySelectorAll(".doc-text")[0].textContent).toBe(
      "Live text",
    )
    expect(screen.queryByText("Spanish")).toBeNull()
  })

  it("shows a blinking caret on live entries", () => {
    const { container } = render(
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
    const col = container.querySelectorAll(".doc-text")[0]
    expect(col.textContent).toBe("Partial")
    expect(col.querySelector(".live-caret")).toBeTruthy()
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

describe("TranscriptPanel — LocalAgreement pending tail", () => {
  const liveEntry = {
    key: 1,
    kind: "transcription",
    sourceName: "English",
    transcript: "hola cómo",
    pending: "estás",
    live: true,
    ts: "2026-08-19T12:00:00Z",
  }

  it("renders the unconfirmed tail dimmed and separate from committed text", () => {
    const { container } = render(
      <TranscriptPanel {...baseProps} conversation={[liveEntry]} />,
    )
    const pending = container.querySelector(".doc-text-pending")
    expect(pending).toBeTruthy()
    expect(pending.textContent.trim()).toBe("estás")
    // The committed prefix is NOT inside the dimmed span.
    expect(pending.textContent).not.toContain("hola")
  })

  it("keeps a space between the committed prefix and the pending tail", () => {
    const { container } = render(
      <TranscriptPanel {...baseProps} conversation={[liveEntry]} />,
    )
    expect(container.querySelector(".doc-text").textContent).toBe(
      "hola cómo estás",
    )
  })

  it("renders no dimmed span once the entry is committed", () => {
    const { container } = render(
      <TranscriptPanel
        {...baseProps}
        conversation={[{ ...liveEntry, transcript: "hola cómo estás", pending: "", live: false }]}
      />,
    )
    expect(container.querySelector(".doc-text-pending")).toBeNull()
    expect(container.querySelector(".live-caret")).toBeNull()
  })

  it("does not show the em-dash placeholder while only pending text exists", () => {
    const { container } = render(
      <TranscriptPanel
        {...baseProps}
        conversation={[{ ...liveEntry, transcript: "", pending: "hola" }]}
      />,
    )
    expect(container.querySelector(".doc-text").textContent.trim()).toBe("hola")
  })
})
