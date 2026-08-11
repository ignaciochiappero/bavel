import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  getNormalizedBaseUrl,
  transcribeAudio,
  translateText,
  splitTextIntoSpeechChunks,
  listSessions,
  createSession,
  getSessionMessages,
  sttStreamStart,
  sttStreamAppend,
  sttStreamStop,
} from "./api"

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

describe("getNormalizedBaseUrl", () => {
  it("defaults to local litert-lm", () => {
    expect(getNormalizedBaseUrl("")).toBe("http://localhost:9379/v1")
  })

  it("appends /v1 when missing", () => {
    expect(getNormalizedBaseUrl("http://localhost:9379")).toBe(
      "http://localhost:9379/v1",
    )
  })

  it("keeps an existing /v1", () => {
    expect(getNormalizedBaseUrl("http://localhost:9379/v1/")).toBe(
      "http://localhost:9379/v1",
    )
  })
})

describe("transcribeAudio", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ text: "hola" }))
  })
  afterEach(() => vi.restoreAllMocks())

  it("posts base64 audio with the language", async () => {
    await transcribeAudio("QUJD", "es")
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/stt",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ audio_base64: "QUJD", language: "es" }),
      }),
    )
  })

  it("returns the transcript text", async () => {
    expect(await transcribeAudio("QUJD", "en")).toBe("hola")
  })

  it("returns empty text when the field is missing", async () => {
    global.fetch.mockResolvedValue(jsonResponse({}))
    expect(await transcribeAudio("QUJD", "en")).toBe("")
  })
})

describe("translateText", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"translation":"Hola"}' } }],
        usage: { total_tokens: 42 },
      }),
    )
  })
  afterEach(() => vi.restoreAllMocks())

  const config = {
    endpointUrl: "http://localhost:9379/v1",
    useProxy: true,
    apiKey: "",
    modelName: "gemma4-e2b",
    systemPrompt: "translate",
  }

  it("parses the translation JSON", async () => {
    const res = await translateText("Hello", config)
    expect(res.translation).toBe("Hola")
    expect(res.tokens).toBe(42)
  })

  it("tolerates fenced JSON", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({
        choices: [
          { message: { content: '```json\n{"translation":"Hola"}\n```' } },
        ],
      }),
    )
    const res = await translateText("Hello", config)
    expect(res.translation).toBe("Hola")
  })

  it("falls back to the raw reply when parsing fails", async () => {
    global.fetch.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "Hola, chicos" } }],
      }),
    )
    const res = await translateText("Hello", config)
    expect(res.translation).toBe("Hola, chicos")
  })

  it("routes through /proxy when useProxy is on", async () => {
    await translateText("Hello", config)
    const url = global.fetch.mock.calls[0][0]
    expect(url.startsWith("/proxy?url=")).toBe(true)
    expect(decodeURIComponent(url)).toContain(
      "http://localhost:9379/v1/chat/completions",
    )
  })
})

describe("splitTextIntoSpeechChunks", () => {
  it("keeps chunks under the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")
    const chunks = splitTextIntoSpeechChunks(text, 30)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30)
    expect(chunks.join(" ")).toBe(text)
  })
})

describe("sessions API", () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it("lists sessions", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ sessions: [{ id: 1 }] }))
    expect(await listSessions()).toEqual([{ id: 1 }])
    expect(global.fetch).toHaveBeenCalledWith("/api/sessions")
  })

  it("creates a session with messages", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ id: 7 }))
    const res = await createSession({ title: "T", messages: [{}] })
    expect(res.id).toBe(7)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe("/api/sessions")
    expect(opts.method).toBe("POST")
    expect(JSON.parse(opts.body).title).toBe("T")
  })

  it("loads session messages", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ messages: [] }))
    await getSessionMessages(3)
    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/3/messages")
  })
})

describe("streaming STT API", () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it("starts a stream", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ stream_id: 1 }))
    expect((await sttStreamStart("es")).stream_id).toBe(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe("/api/stt/stream/start")
    expect(JSON.parse(opts.body).language).toBe("es")
  })

  it("appends audio", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ text: "hola", done: false }))
    const res = await sttStreamAppend(1, "QUJD")
    expect(res.text).toBe("hola")
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe("/api/stt/stream/append")
    expect(JSON.parse(opts.body).stream_id).toBe(1)
    expect(JSON.parse(opts.body).audio_base64).toBe("QUJD")
  })

  it("stops a stream", async () => {
    global.fetch.mockResolvedValue(jsonResponse({ text: "hola mundo", done: true }))
    const res = await sttStreamStop(1)
    expect(res.done).toBe(true)
    expect(global.fetch.mock.calls[0][0]).toBe("/api/stt/stream/stop")
  })
})
