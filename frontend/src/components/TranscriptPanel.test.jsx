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

  const openMenu = () =>
    fireEvent.click(screen.getByRole("button", { name: "Acciones" }))

  it("disables the save button with no messages", () => {
    render(<TranscriptPanel {...baseProps} />)
    openMenu()
    expect(screen.getByRole("button", { name: "Guardar" }).disabled).toBe(true)
  })

  it("keeps the actions unreachable while the menu is collapsed", () => {
    render(<TranscriptPanel {...baseProps} />)
    // Only the trigger is exposed; the rest are hidden behind it.
    expect(screen.queryByRole("button", { name: "Historial" })).toBeNull()
    expect(screen.getByRole("button", { name: "Acciones" })).toBeTruthy()
  })

  it("shows the saving state", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        saveState="saving"
        conversation={[{ key: 1, kind: "transcription", transcript: "x" }]}
      />,
    )
    openMenu()
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
    openMenu()
    expect(screen.getByRole("button", { name: /Guardado/ })).toBeTruthy()
  })

  it("fires the header actions", () => {
    render(
      <TranscriptPanel
        {...baseProps}
        conversation={[{ key: 1, kind: "transcription", transcript: "x" }]}
      />,
    )
    // The menu closes after each pick, so it is reopened between actions.
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: "Historial" }))
    expect(baseProps.onOpenHistory).toHaveBeenCalled()
    openMenu()
    fireEvent.click(screen.getByRole("button", { name: "Nueva charla" }))
    expect(baseProps.onNewCall).toHaveBeenCalled()
    openMenu()
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

describe("TranscriptPanel — floating window toggle", () => {
  it("lives outside the menu, reachable without opening it", () => {
    render(<TranscriptPanel {...baseProps} />)
    // No click on the trigger first: it must be there straight away.
    expect(screen.getByRole("button", { name: "Ventana flotante" })).toBeTruthy()
  })

  it("fires its handler", () => {
    const onToggleFloat = vi.fn()
    render(<TranscriptPanel {...baseProps} onToggleFloat={onToggleFloat} />)
    fireEvent.click(screen.getByRole("button", { name: "Ventana flotante" }))
    expect(onToggleFloat).toHaveBeenCalled()
  })

  it("reports its on/off state, which is why it is not buried in the menu", () => {
    const { rerender } = render(<TranscriptPanel {...baseProps} floatOpen={false} />)
    const btn = () => screen.getByRole("button", { name: "Ventana flotante" })
    expect(btn().getAttribute("aria-pressed")).toBe("false")
    expect(btn().className).not.toContain("active")

    rerender(<TranscriptPanel {...baseProps} floatOpen={true} />)
    expect(btn().getAttribute("aria-pressed")).toBe("true")
    expect(btn().className).toContain("active")
  })

  it("is no longer among the menu actions", () => {
    render(<TranscriptPanel {...baseProps} />)
    fireEvent.click(screen.getByRole("button", { name: "Acciones" }))
    const menuLabels = ["Configuración", "Historial", "Nueva charla", "Guardar"]
    menuLabels.forEach((l) =>
      expect(screen.getByRole("button", { name: l })).toBeTruthy(),
    )
    // Exactly one control carries this label — the standalone one.
    expect(screen.getAllByRole("button", { name: "Ventana flotante" })).toHaveLength(1)
  })
})
