import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import TranslatorApp from "./TranslatorApp"

// Smoke test: rendering the full app catches render-time crashes (TDZ in
// hook dependency arrays, bad declaration order, etc.) that the unit suites
// cannot see. Audio/capture hooks are mocked — this tests the component
// wiring, not the browser APIs.

vi.mock("./hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    isRecording: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    analyser: null,
    micError: null,
    setMicError: vi.fn(),
  }),
}))

vi.mock("./hooks/useTabAudioCapture", () => ({
  useTabAudioCapture: () => ({
    isCapturing: false,
    error: null,
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    analyser: null,
  }),
}))

vi.mock("./utils/floatingWindow", () => ({
  openFloatingWindow: vi.fn(),
}))

vi.mock("./utils/audio-blip", () => ({
  playBlip: vi.fn(),
}))

// The app preloads its language pair and polls readiness on mount; jsdom has
// no fetch, so stub the client rather than let those reject in the console.
vi.mock("./utils/api", () => ({
  transcribeAudio: vi.fn(),
  translateText: vi.fn(),
  translateTextStream: vi.fn(),
  translateFast: vi.fn(),
  buildPlainTranslationPrompt: () => "",
  splitTextIntoSpeechChunks: vi.fn(() => []),
  listSessions: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ id: 1 })),
  getSessionMessages: vi.fn(async () => ({ messages: [] })),
  sttStreamStart: vi.fn(),
  sttStreamAppend: vi.fn(),
  sttStreamStop: vi.fn(),
  warmupPair: vi.fn(async () => ({ warming: true })),
  getReadiness: vi.fn(async () => ({ ready: true, components: {}, busy: [] })),
}))

// jsdom has no 2D canvas context; the visualizer is not under test here.
vi.mock("./components/Visualizer", () => ({
  default: () => <div data-testid="visualizer" />,
}))

const config = {
  endpointUrl: "http://localhost:9379/v1",
  modelName: "gemma4-e2b",
  apiKey: "",
  keyboardMode: "landscape",
  useProxy: true,
  enableTts: true,
  visualizerBars: 16,
  systemPrompt: "Translator mode",
  themeColor: "#ffa500",
}

afterEach(cleanup)

describe("TranslatorApp smoke", () => {
  it("renders the full app without crashing", () => {
    render(<TranslatorApp config={config} onOpenSettings={vi.fn()} />)
    expect(screen.getByText("BAVEL")).toBeTruthy()
    expect(screen.getByText("Traducción")).toBeTruthy()
    expect(screen.getByText("Transcripción")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: /Escuchar pestaña/ }),
    ).toBeTruthy()
  })

  it("starts with English and Spanish lanes", () => {
    render(<TranslatorApp config={config} onOpenSettings={vi.fn()} />)
    const selects = screen.getAllByRole("combobox")
    expect(selects).toHaveLength(2)
    expect(selects[0].value).toBe("en")
    expect(selects[1].value).toBe("es")
  })
})
