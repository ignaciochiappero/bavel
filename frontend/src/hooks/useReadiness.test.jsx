import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor, cleanup } from "@testing-library/react"
import { useReadiness } from "./useReadiness"
import { getReadiness } from "../utils/api"

vi.mock("../utils/api", () => ({ getReadiness: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const PENDING = {
  ready: false,
  components: { stt: "loading", tts: "pending", translation: "pending" },
  elapsed_ms: 1200,
  warmup_ms: null,
}
const READY = {
  ready: true,
  components: { stt: "ready", tts: "ready", translation: "ready" },
  elapsed_ms: 8400,
  warmup_ms: 8400,
}

describe("useReadiness", () => {
  it("starts unknown so the UI does not flash a warning", () => {
    getReadiness.mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useReadiness())
    expect(result.current.known).toBe(false)
    expect(result.current.ready).toBe(false)
  })

  it("reports which components are still loading", async () => {
    getReadiness.mockResolvedValue(PENDING)
    const { result } = renderHook(() => useReadiness({ intervalMs: 5 }))
    await waitFor(() => expect(result.current.known).toBe(true))
    expect(result.current.ready).toBe(false)
    expect(result.current.components.stt).toBe("loading")
    expect(result.current.elapsedMs).toBe(1200)
  })

  it("flips to ready and reports the total warm-up time", async () => {
    getReadiness.mockResolvedValue(READY)
    const { result } = renderHook(() => useReadiness({ intervalMs: 5 }))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.warmupMs).toBe(8400)
  })

  it("keeps watching after ready, but backs off to the idle interval", async () => {
    // It must NOT stop: only en->es is prewarmed, so switching pairs triggers
    // a lazy load later in the session that the UI still has to announce.
    getReadiness.mockResolvedValue(READY)
    const { result } = renderHook(() =>
      useReadiness({ intervalMs: 5, idleIntervalMs: 15 }),
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    const callsWhenReady = getReadiness.mock.calls.length
    await waitFor(() =>
      expect(getReadiness.mock.calls.length).toBeGreaterThan(callsWhenReady),
    )
  })

  it("polls FASTER while something is still loading than when idle", async () => {
    getReadiness.mockResolvedValue(PENDING)
    renderHook(() => useReadiness({ intervalMs: 5, idleIntervalMs: 500 }))
    // With the busy interval it should get several calls in well under one
    // idle interval; if it used the idle interval this would time out.
    await waitFor(() => expect(getReadiness.mock.calls.length).toBeGreaterThan(3), {
      timeout: 400,
    })
  })

  it("surfaces in-flight lazy loads so the banner can name them", async () => {
    getReadiness.mockResolvedValue({
      ready: false,
      components: { stt: "ready", tts: "ready", translation: "ready" },
      busy: [{ kind: "translation", detail: "es→en", elapsed_ms: 8200 }],
      elapsed_ms: 60000,
      warmup_ms: 4500,
    })
    const { result } = renderHook(() => useReadiness({ intervalMs: 5 }))
    await waitFor(() => expect(result.current.known).toBe(true))
    // Every component is "ready" yet the system is NOT ready — a pair is
    // still downloading. This is the case the first version got wrong.
    expect(result.current.ready).toBe(false)
    expect(result.current.busy[0].detail).toBe("es→en")
  })

  it("keeps polling while the backend is still starting up", async () => {
    getReadiness.mockRejectedValue(new Error("connection refused"))
    renderHook(() => useReadiness({ intervalMs: 5 }))
    await waitFor(() => expect(getReadiness.mock.calls.length).toBeGreaterThan(1))
  })

  it("stops polling after unmount", async () => {
    getReadiness.mockResolvedValue(PENDING)
    const { unmount } = renderHook(() => useReadiness({ intervalMs: 5 }))
    await waitFor(() => expect(getReadiness.mock.calls.length).toBeGreaterThan(0))
    unmount()
    const after = getReadiness.mock.calls.length
    await new Promise((r) => setTimeout(r, 40))
    expect(getReadiness.mock.calls.length).toBeLessThanOrEqual(after + 1)
  })
})
