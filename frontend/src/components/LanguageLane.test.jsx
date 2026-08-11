import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import LanguageLane from "./LanguageLane"

afterEach(cleanup)

const languages = [
  { code: "ar", name: "Arabic", voice: "tts", ttsLang: "ar" },
  { code: "en", name: "English", voice: "tts", ttsLang: "en" },
  { code: "es", name: "Spanish", voice: "tts", ttsLang: "es" },
]

const baseProps = {
  laneId: 1,
  laneLabel: "1",
  languages,
  currentIndex: 1,
  otherLaneCode: "es",
  isRecording: false,
  isActivePerson: true,
  onRotate: vi.fn(),
  onSelect: vi.fn(),
}

describe("LanguageLane", () => {
  it("shows the current language in the dropdown", () => {
    render(<LanguageLane {...baseProps} />)
    expect(screen.getByRole("combobox").value).toBe("en")
  })

  it("disables the option held by the other lane", () => {
    render(<LanguageLane {...baseProps} />)
    const select = screen.getByRole("combobox")
    const disabledOption = select.querySelector('option[value="es"]')
    expect(disabledOption.disabled).toBe(true)
  })

  it("fires onSelect with the picked language index", () => {
    render(<LanguageLane {...baseProps} />)
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "ar" },
    })
    expect(baseProps.onSelect).toHaveBeenCalledWith(0)
  })

  it("is disabled while recording", () => {
    render(<LanguageLane {...baseProps} isRecording={true} />)
    expect(screen.getByRole("combobox").disabled).toBe(true)
  })

  it("rotates languages with the arrows", () => {
    render(<LanguageLane {...baseProps} />)
    fireEvent.click(screen.getAllByRole("button")[0])
    expect(baseProps.onRotate).toHaveBeenCalledWith(-1)
    fireEvent.click(screen.getAllByRole("button")[1])
    expect(baseProps.onRotate).toHaveBeenCalledWith(1)
  })
})
