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

// API client for the Python backend (backend/server.py). LLM calls are
// routed through the backend's /proxy by default so the kiosk stays
// same-origin (no CORS) and works fully offline.

// Normalize a user-entered endpoint into an OpenAI-compatible ".../v1" base.
export function getNormalizedBaseUrl(endpointUrl) {
  let url = endpointUrl.trim()
  if (!url) return "http://localhost:9379/v1"
  url = url.replace(/\/+$/, "")
  if (!url.endsWith("/v1")) {
    url += "/v1"
  }
  return url
}

// Cheap connectivity probe: GET {base}/v1/models.
export async function testConnectionAPI(endpointUrl, useProxy, apiKey) {
  const baseUrl = getNormalizedBaseUrl(endpointUrl)
  const targetUrl = `${baseUrl}/models`

  const headers = {}
  if (apiKey && apiKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`
  }

  const fetchUrl = useProxy
    ? `/proxy?url=${encodeURIComponent(targetUrl)}`
    : targetUrl

  const response = await fetch(fetchUrl, { method: "GET", headers })
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`)
  }
  return true
}

// POST base64 Float32 PCM (16 kHz mono) to the local Moonshine STT.
export async function transcribeAudio(base64Data, sourceLangCode) {
  const response = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_base64: base64Data,
      language: sourceLangCode,
    }),
  })

  if (!response.ok) {
    throw new Error(`STT failed: ${response.status}`)
  }

  const sttData = await response.json()
  return sttData.text || ""
}

function generatePayloadJSON(transcribedText, model, systemPrompt) {
  const messages = []
  if (systemPrompt && systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt.trim() })
  }
  messages.push({
    role: "user",
    content: transcribedText,
  })

  return JSON.stringify({ model: model || "gemma4-e2b", messages })
}

// Chat-completions request. The system prompt demands a bare
// {"translation": ...} JSON object; we still tolerate ``` fences and fall
// back to the raw reply text if parsing fails.
export async function translateText(transcribedText, config) {
  const { endpointUrl, useProxy, apiKey, modelName, systemPrompt } = config
  const baseUrl = getNormalizedBaseUrl(endpointUrl)
  const targetUrl = `${baseUrl}/chat/completions`
  const payload = generatePayloadJSON(transcribedText, modelName, systemPrompt)

  const headers = { "Content-Type": "application/json" }
  if (apiKey && apiKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`
  }

  const fetchUrl = useProxy
    ? `/proxy?url=${encodeURIComponent(targetUrl)}`
    : targetUrl
  const startRequestTime = Date.now()

  const response = await fetch(fetchUrl, {
    method: "POST",
    headers,
    body: payload,
  })
  const requestDuration = ((Date.now() - startRequestTime) / 1000).toFixed(2)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `API ${response.status}: ${errorText || response.statusText}`,
    )
  }

  const data = await response.json()
  let modelResponse = ""
  if (data.choices && data.choices[0] && data.choices[0].message) {
    modelResponse = data.choices[0].message.content || ""
  } else {
    modelResponse = JSON.stringify(data, null, 2)
  }

  let translationVal = ""
  try {
    let cleanJson = modelResponse.trim()
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.slice(7)
    }
    if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.slice(3)
    }
    if (cleanJson.endsWith("```")) {
      cleanJson = cleanJson.slice(0, -3)
    }
    cleanJson = cleanJson.trim()

    const parsed = JSON.parse(cleanJson)
    translationVal = parsed.translation || ""
  } catch (e) {
    translationVal = modelResponse
  }

  return {
    translation: translationVal,
    duration: requestDuration,
    tokens: data.usage?.total_tokens || 0,
  }
}

// Warm-up status of the heavy models (STT, TTS, translation). The backend
// loads them in the background at boot; until they are in memory the first
// request of each kind pays seconds of load time, which reads as "the app is
// slow" unless the UI says otherwise.
//
// Resolves to { ready, components, elapsed_ms, warmup_ms }.
export async function getReadiness() {
  const response = await fetch("/api/ready")
  if (!response.ok) throw new Error(`Ready check failed: ${response.status}`)
  return response.json()
}

// Asks the backend to preload a language pair. Fire-and-forget: it returns as
// soon as the work is queued, and progress appears in getReadiness().busy.
//
// Worth calling as soon as the user picks languages, because the first use of
// an unloaded pair is expensive — measured 26.66s for es->en (package download
// plus model load) against 0.05s once resident.
export async function warmupPair(sourceCode, targetCode) {
  const response = await fetch("/api/warmup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: sourceCode, target: targetCode }),
  })
  if (!response.ok) throw new Error(`Warmup failed: ${response.status}`)
  return response.json()
}

// Fast translation via the backend's dedicated NMT engine (Argos/CTranslate2).
// Measured on the real stack: 61ms average versus 1.76s for Gemma 4B on the
// same sentences — 29x faster, with equivalent quality. At this latency the
// whole translation arrives sooner than the LLM's first token, so there is
// nothing to stream.
//
// Resolves to { text, engine, ms }. Throws on transport errors and on 503,
// which the backend returns when no package exists for the pair — callers can
// fall back to the LLM path.
export async function translateFast(text, sourceCode, targetCode) {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source: sourceCode, target: targetCode }),
  })
  if (!response.ok) {
    throw new Error(`Translate ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

// Streaming translation. Measured against litert-lm on the real stack:
// time-to-first-token is 0.33-0.51s versus 0.73-2.08s for the full response,
// so the reader sees text roughly a second earlier per segment.
//
// Uses a PLAIN-TEXT prompt rather than the strict-JSON one: JSON costs ~30%
// more time per call (it has to emit the scaffolding) and, more importantly,
// nothing can be displayed until the closing brace arrives — which defeats
// streaming entirely.
export function buildPlainTranslationPrompt(srcName, dstName) {
  const from = srcName.split(" ")[0]
  const to = dstName.split(" ")[0]
  return (
    `Translate the following text from ${from} into ${to}. ` +
    `Produce only the ${to} translation, with no labels, quotes, ` +
    `explanations or commentary.`
  )
}

// Strips the wrappers a plain-prompt model sometimes adds anyway:
// "Here is the translation:", a "**Spanish:**" label line, or outer quotes.
export function sanitizeTranslation(input) {
  if (!input) return ""
  let text = String(input).replace(/<\|[^>]*\|>/g, "").trim()
  text = text
    .replace(
      /^(here(?:'s| is) (?:the )?translation:|translated text:|translation:)\s*/i,
      "",
    )
    .trim()
  const lines = text.split(/\r?\n/)
  if (lines.length > 0) {
    const label = lines[0].match(/^\s*(\*\*|__)?\s*[A-Za-zÀ-ÿ ]{2,20}\s*[:：]\s*(\*\*|__)?\s*/)
    if (label) {
      lines[0] = lines[0].slice(label[0].length).trim()
      if (!lines[0]) lines.shift()
      text = lines.join("\n").trim()
    }
  }
  if (text.length >= 2) {
    const a = text[0]
    const b = text[text.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
      text = text.slice(1, -1).trim()
    }
  }
  return text
}

// Streams a translation, calling onToken(partialText) as tokens arrive.
// Resolves with the sanitized full translation.
export async function translateTextStream(
  text,
  { endpointUrl, useProxy, apiKey, modelName, systemPrompt },
  onToken,
) {
  const baseUrl = getNormalizedBaseUrl(endpointUrl)
  const targetUrl = `${baseUrl}/chat/completions`
  const fetchUrl = useProxy
    ? `/proxy?url=${encodeURIComponent(targetUrl)}`
    : targetUrl

  const headers = { "Content-Type": "application/json" }
  if (apiKey && apiKey.trim() !== "") {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`
  }

  const response = await fetch(fetchUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName || "gemma4-e2b",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await response.text()}`)
  }
  if (!response.body) throw new Error("Streaming not supported by this browser")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let full = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    // The last element may be a partial line — keep it for the next read.
    buffer = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === "[DONE]") continue
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content || ""
        if (delta) {
          full += delta
          onToken?.(sanitizeTranslation(full))
        }
      } catch {
        // Incomplete JSON in this frame — the next read completes it.
      }
    }
  }

  return sanitizeTranslation(full)
}

// Word-safe chunking so each /api/tts request stays under ~`limit` chars.
export function splitTextIntoSpeechChunks(text, limit = 180) {
  const words = text.split(/\s+/)
  const chunks = []
  let currentChunk = ""
  for (const word of words) {
    if ((currentChunk + " " + word).trim().length <= limit) {
      currentChunk = (currentChunk + " " + word).trim()
    } else {
      if (currentChunk) chunks.push(currentChunk)
      currentChunk = word
    }
  }
  if (currentChunk) chunks.push(currentChunk)
  return chunks
}

// Saved conversation sessions (SQLite via the backend).
export async function listSessions() {
  const response = await fetch("/api/sessions")
  if (!response.ok) {
    throw new Error(`Sessions failed: ${response.status}`)
  }
  const data = await response.json()
  return data.sessions || []
}

export async function createSession({ title, messages }) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, messages }),
  })
  if (!response.ok) {
    throw new Error(`Session create failed: ${response.status}`)
  }
  return response.json()
}

export async function getSessionMessages(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/messages`)
  if (!response.ok) {
    throw new Error(`Session messages failed: ${response.status}`)
  }
  return response.json()
}

// Streaming STT (live transcription): one stream per utterance, partial
// transcripts returned on every append.
export async function sttStreamStart(language) {
  const response = await fetch("/api/stt/stream/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language }),
  })
  if (!response.ok) {
    throw new Error(`Stream start failed: ${response.status}`)
  }
  return response.json()
}

export async function sttStreamAppend(streamId, base64Data) {
  const response = await fetch("/api/stt/stream/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream_id: streamId, audio_base64: base64Data }),
  })
  if (!response.ok) {
    throw new Error(`Stream append failed: ${response.status}`)
  }
  return response.json()
}

export async function sttStreamStop(streamId) {
  const response = await fetch("/api/stt/stream/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stream_id: streamId }),
  })
  if (!response.ok) {
    throw new Error(`Stream stop failed: ${response.status}`)
  }
  return response.json()
}

