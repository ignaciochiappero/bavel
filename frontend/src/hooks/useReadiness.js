/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useState, useEffect, useRef } from "react"
import { getReadiness } from "../utils/api"

// Polls /api/ready and keeps watching for the whole session.
//
// It does NOT stop once the boot prewarm finishes: the expensive loads are the
// LAZY ones. Only en->es is prewarmed, so switching to any other pair
// downloads and loads it on first use — measured at 26.66s for es->en against
// 0.05s warm. During that window the backend reports busy activity, and the UI
// has to say so. Polling backs off to `idleIntervalMs` while nothing is
// loading so the watch is cheap.
export function useReadiness({ intervalMs = 1000, idleIntervalMs = 4000 } = {}) {
  const [status, setStatus] = useState({
    ready: false,
    components: { stt: "pending", tts: "pending", translation: "pending" },
    busy: [],
    elapsedMs: 0,
    warmupMs: null,
    // Until the first successful poll we do not know anything; the UI uses
    // this to avoid flashing a warning when the backend is merely slow to
    // answer the very first request.
    known: false,
  })
  const timerRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const data = await getReadiness()
        if (cancelled) return
        const ready = Boolean(data.ready)
        setStatus({
          ready,
          components: data.components || {},
          busy: data.busy || [],
          elapsedMs: data.elapsed_ms || 0,
          warmupMs: data.warmup_ms ?? null,
          known: true,
        })
        if (!cancelled) {
          timerRef.current = setTimeout(poll, ready ? idleIntervalMs : intervalMs)
        }
        return
      } catch {
        // Backend not up yet — keep trying, the UI stays in "preparing".
      }
      if (!cancelled) timerRef.current = setTimeout(poll, intervalMs)
    }

    poll()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [intervalMs, idleIntervalMs])

  return status
}
