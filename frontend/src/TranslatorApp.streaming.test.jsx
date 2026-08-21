import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import TranslatorApp from "./TranslatorApp"
import {
  translateFast,
  translateTextStream,
  sttStreamStart,
  sttStreamAppend,
  sttStreamStop,
} from "./utils/api"

// Integration tests for the streaming translation path: VAD chunk ->
// coalesced queue -> Moonshine stream -> LocalAgreement -> clause segmenter
// -> translator. The unit suites cover each policy in isolation; what is
// under test here is the WIRING between them.

// Captures the onChunk callback the app hands to the capture hook so the test
// can drive the pipeline as if a tab were speaking.
let onChunk = null

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
    startCapture: vi.fn(async (cb) => {
      onChunk = cb
      return true
    }),
    stopCapture: vi.fn(),
    analyser: null,
  }),
}))

vi.mock("./utils/floatingWindow", () => ({ openFloatingWindow: vi.fn() }))
vi.mock("./utils/audio-blip", () => ({ playBlip: vi.fn() }))
vi.mock("./components/Visualizer", () => ({
  default: () => <div data-testid="visualizer" />,
}))

vi.mock("./utils/api", () => ({
  transcribeAudio: vi.fn(),
  translateText: vi.fn(async () => ({
    translation: "TRADUCIDO",
    duration: "0.1",
    tokens: 1,
  })),
  // Fast NMT path: one call, full text back (61ms in production).
  translateFast: vi.fn(async () => ({ text: "TRADUCIDO", engine: "argos", ms: 61 })),
  // The streaming path emits partial tokens, then resolves with the full text.
  translateTextStream: vi.fn(async (text, cfg, onToken) => {
    onToken?.("TRAD")
    onToken?.("TRADUCIDO")
    return "TRADUCIDO"
  }),
  buildPlainTranslationPrompt: (src, dst) =>
    `Translate the following text from ${src.split(" ")[0]} into ${dst.split(" ")[0]}.`,
  splitTextIntoSpeechChunks: vi.fn(() => []),
  listSessions: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ id: 1 })),
  getSessionMessages: vi.fn(async () => ({ messages: [] })),
  sttStreamStart: vi.fn(async () => ({ stream_id: 7 })),
  sttStreamAppend: vi.fn(async () => ({ text: "" })),
  sttStreamStop: vi.fn(async () => ({ text: "" })),
  // Fired on mount to preload the selected pair; irrelevant to these tests.
  warmupPair: vi.fn(async () => ({ warming: true })),
  getReadiness: vi.fn(async () => ({ ready: true, components: {}, busy: [] })),
}))

const config = {
  endpointUrl: "http://localhost:9379/v1",
  modelName: "gemma4-e2b",
  apiKey: "",
  keyboardMode: "landscape",
  useProxy: true,
  enableTts: false,
  visualizerBars: 16,
  systemPrompt: "Translator mode",
  themeColor: "#ffa500",
}

// One Float32 sample, base64-encoded — the shape the capture hook emits.
function chunk(final = false) {
  return { base64Data: btoa("\x00\x00\x00\x00"), final }
}

async function startListening() {
  render(<TranslatorApp config={config} onOpenSettings={vi.fn()} />)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Escuchar pestaña/ }))
  })
  expect(onChunk).toBeTypeOf("function")
}

beforeEach(() => {
  onChunk = null
  vi.clearAllMocks()
  sttStreamStart.mockResolvedValue({ stream_id: 7 })
  sttStreamStop.mockResolvedValue({ text: "" })
  translateFast.mockResolvedValue({ text: "TRADUCIDO", engine: "argos", ms: 61 })
  translateTextStream.mockImplementation(async (text, cfg, onToken) => {
    onToken?.("TRADUCIDO")
    return "TRADUCIDO"
  })
})
afterEach(cleanup)

describe("streaming translation wiring", () => {
  it("translates a clause once LocalAgreement confirms it", async () => {
    // The same hypothesis twice: LocalAgreement-2 confirms the whole prefix,
    // and the trailing period closes a clause of 5 words.
    sttStreamAppend.mockResolvedValue({ text: "hola cómo estás amigo mío." })
    await startListening()

    await act(async () => {
      await onChunk(chunk())
      await onChunk(chunk())
    })

    expect(translateFast).toHaveBeenCalledTimes(1)
    expect(translateFast.mock.calls[0][0]).toBe("hola cómo estás amigo mío.")
  })

  it("does NOT translate before a clause boundary is reached", async () => {
    // Confirmed, but only two words and no punctuation — below minWords.
    sttStreamAppend.mockResolvedValue({ text: "hola cómo" })
    await startListening()

    await act(async () => {
      await onChunk(chunk())
      await onChunk(chunk())
    })

    expect(translateFast).not.toHaveBeenCalled()
  })

  it("translates the held remainder when the utterance ends", async () => {
    sttStreamAppend.mockResolvedValue({ text: "hola cómo" })
    sttStreamStop.mockResolvedValue({ text: "hola cómo" })
    await startListening()

    await act(async () => {
      await onChunk(chunk())
      await onChunk(chunk())
      await onChunk(chunk(true)) // silence -> end of utterance
    })

    // The segmenter's flush releases what never reached a boundary.
    expect(translateFast).toHaveBeenCalled()
    expect(translateFast.mock.calls[0][0]).toBe("hola cómo")
  })

  it("uses the source and target languages of the active lane", async () => {
    sttStreamAppend.mockResolvedValue({ text: "hola cómo estás amigo mío." })
    await startListening()
    await act(async () => {
      await onChunk(chunk())
      await onChunk(chunk())
    })

    // Lane 1 is English, lane 2 Spanish by default.
    expect(sttStreamStart).toHaveBeenCalledWith("en")
    // Fast engine takes language CODES, not a prompt.
    expect(translateFast.mock.calls[0][1]).toBe("en")
    expect(translateFast.mock.calls[0][2]).toBe("es")
  })
})

describe("queue backpressure", () => {
  it("merges chunks queued while the pipeline is busy into ONE append", async () => {
    // Hold the first append open so the next chunks pile up behind it.
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    sttStreamAppend.mockImplementationOnce(async () => {
      await gate
      return { text: "" }
    })
    sttStreamAppend.mockResolvedValue({ text: "" })

    await startListening()

    await act(async () => {
      const inFlight = onChunk(chunk()) // starts processing, blocks on gate
      await Promise.resolve()
      await onChunk(chunk()) // queued
      await onChunk(chunk()) // queued
      release()
      await inFlight
    })

    // Three chunks in, but only two appends: the first, then the two queued
    // ones merged. Without coalescing this would be three.
    expect(sttStreamAppend).toHaveBeenCalledTimes(2)
  })

  it("opens only one stream for a continuous utterance", async () => {
    sttStreamAppend.mockResolvedValue({ text: "hola" })
    await startListening()

    await act(async () => {
      await onChunk(chunk())
      await onChunk(chunk())
      await onChunk(chunk())
    })

    expect(sttStreamStart).toHaveBeenCalledTimes(1)
  })

  it("closes the stream when silence ends the utterance", async () => {
    sttStreamAppend.mockResolvedValue({ text: "hola" })
    await startListening()

    await act(async () => {
      await onChunk(chunk(true))
    })

    expect(sttStreamStop).toHaveBeenCalledWith(7)
  })
})

describe("translation does not block the audio loop", () => {
  it("keeps feeding Moonshine while a translation is still in flight", async () => {
    // Confirmed clause on every append, so a translation fires early.
    sttStreamAppend.mockResolvedValue({ text: "hola cómo estás amigo mío." })

    // Hold the translator open for the whole test.
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    translateFast.mockImplementation(async () => {
      await gate
      return { text: "TRADUCIDO", engine: "argos", ms: 61 }
    })

    await startListening()

    await act(async () => {
      await onChunk(chunk())
      await onChunk(chunk()) // clause confirmed here -> translation starts
      await onChunk(chunk())
      await onChunk(chunk())
    })

    // The translator is STILL blocked...
    expect(translateFast).toHaveBeenCalled()
    // ...yet every audio chunk was appended. With the old blocking `await`
    // inside the loop this stopped at 2.
    expect(sttStreamAppend).toHaveBeenCalledTimes(4)

    await act(async () => {
      release()
      await gate
    })
  })

  it("translates queued segments in order", async () => {
    const order = []
    translateFast.mockImplementation(async (text) => {
      order.push(text)
      // Make the FIRST call the slowest: if the chain were not sequential,
      // the second segment would land first.
      await new Promise((r) => setTimeout(r, order.length === 1 ? 30 : 0))
      return { text: `T(${text})`, engine: "argos", ms: 61 }
    })
    sttStreamAppend
      .mockResolvedValueOnce({ text: "primera oración de prueba acá." })
      .mockResolvedValueOnce({ text: "primera oración de prueba acá." })
      .mockResolvedValue({
        text: "primera oración de prueba acá. segunda oración de prueba acá.",
      })

    await startListening()
    await act(async () => {
      await onChunk(chunk())
      await onChunk(chunk())
      await onChunk(chunk())
      await onChunk(chunk(true)) // final -> drains the chain
    })

    expect(order.length).toBeGreaterThanOrEqual(2)
    expect(order[0]).toBe("primera oración de prueba acá.")
  })
})
