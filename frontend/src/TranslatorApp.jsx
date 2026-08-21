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

import React, { useState, useEffect, useRef, useCallback } from "react"
import {
  X,
  Play,
  Square,
  Volume2,
  VolumeX,
  Languages,
  Captions,
} from "lucide-react"
import LanguageLane from "./components/LanguageLane"
import TranscriptPanel from "./components/TranscriptPanel"
import Visualizer from "./components/Visualizer"
import { useAudioRecorder } from "./hooks/useAudioRecorder"
import { useTabAudioCapture } from "./hooks/useTabAudioCapture"
import { useReadiness } from "./hooks/useReadiness"
import { openFloatingWindow } from "./utils/floatingWindow"
import { createLocalAgreement } from "./utils/localAgreement"
import { createTranslationSegmenter } from "./utils/translationSegmenter"
import { drainQueue } from "./utils/audioQueue"
import {
  transcribeAudio,
  translateText,
  translateTextStream,
  translateFast,
  buildPlainTranslationPrompt,
  splitTextIntoSpeechChunks,
  listSessions,
  createSession,
  getSessionMessages,
  sttStreamStart,
  sttStreamAppend,
  sttStreamStop,
  warmupPair,
} from "./utils/api"
import { playBlip } from "./utils/audio-blip"

// Core orchestrator for the two-person kiosk translator.
// Flow: hold a key → record mic (useAudioRecorder) → POST /api/stt (Moonshine)
// → LLM translation via /proxy (Gemma, strict-JSON prompt) → /api/tts playback.

// Languages offered on each lane's revolver; ttsLang selects the backend voice.
const AVAILABLE_LANGUAGES = [
  { code: "ar", name: "Arabic", voice: "tts", ttsLang: "ar" },
  { code: "en", name: "English", voice: "tts", ttsLang: "en" },
  { code: "es", name: "Spanish", voice: "tts", ttsLang: "es" },
  { code: "ja", name: "Japanese", voice: "tts", ttsLang: "ja" },
  { code: "zh", name: "Chinese", voice: "tts", ttsLang: "zh" },
  { code: "ko", name: "Korean", voice: "tts", ttsLang: "ko" },
]

// Strict-JSON translation prompt, shared by the one-shot (push-to-talk) path
// and the streaming segment path so both produce identical wording.
function buildTranslationPrompt(srcName, dstName) {
  const from = srcName.split(" ")[0]
  const to = dstName.split(" ")[0]
  return `You are a high-performance translator. Your task is to translate text from ${from} into ${to}.\nYou MUST format your response as a valid JSON object matching this structure:\n{\n  "translation": "High-quality, natural translation into ${to}"\n}\nDo NOT return anything else except this JSON object. No Markdown block wraps (no \`\`\`json), no introductory text, no conversational text. Start directly with "{" and end directly with "}".`
}

// Emission policy for streaming translation: hold confirmed words until they
// form a clause worth sending to the LLM.
//
// minWords is THE latency knob, measured on the real stack with a 17s
// monologue: at 5 the first clause was released after 3.23s (it had to wait
// for "...joining the call today."), at 3 after 1.37s ("Good morning,
// everyone." — already a translatable clause). Time to first visible token
// went 3.68s -> 1.82s for the cost of one extra segment. Below 3 there was no
// further gain, since the first sentence boundary sits at word three.
const SEGMENTER_OPTIONS = { minWords: 3, maxWords: 24 }

// Human-readable summary of which models are still loading, so the warm-up
// banner says what is happening rather than just spinning.
const WARMUP_LABELS = { stt: "transcripción", tts: "voz", translation: "traducción" }

function formatWarmupDetail(components = {}, busy = []) {
  // An in-flight lazy load is the specific thing worth naming — that is the
  // one that takes tens of seconds.
  if (busy.length > 0) {
    return `(${busy.map((b) => b.detail || WARMUP_LABELS[b.kind] || b.kind).join(", ")})`
  }
  const pending = Object.entries(components)
    .filter(([, state]) => state !== "ready" && state !== "error")
    .map(([name]) => WARMUP_LABELS[name] || name)
  return pending.length > 0 ? `(${pending.join(", ")})` : ""
}

// Backpressure ceiling for the tab-listening queue: 30 s of 16 kHz mono audio.
// Queued chunks are merged rather than dropped, so this only bites when the
// pipeline has fallen catastrophically behind.
const MAX_QUEUED_SAMPLES = 16000 * 30

function TranslatorApp({ config, onOpenSettings }) {
  // UI State
  const [activePerson, setActivePerson] = useState(1)

  // Conversation state: every completed utterance stays on screen.
  const [conversation, setConversation] = useState([])
  const [saveState, setSaveState] = useState("idle") // idle | saving | saved | error
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sessions, setSessions] = useState([])
  const messageKeyRef = useRef(0)

  // Processing mode: "translation" (STT + translate + optional TTS) or
  // "transcription" (STT only, live text stream).
  const [transcribeMode, setTranscribeMode] = useState("translation")
  const [voiceOn, setVoiceOn] = useState(config.enableTts)
  // Refs so the tab-chunk closure always reads the LATEST mode without
  // re-subscribing the capture handler.
  const transcribeModeRef = useRef("translation")
  const voiceOnRef = useRef(config.enableTts)
  const isTabCapturingRef = useRef(false)
  useEffect(() => {
    transcribeModeRef.current = transcribeMode
  }, [transcribeMode])
  useEffect(() => {
    voiceOnRef.current = voiceOn
  }, [voiceOn])

  // Active Moonshine streaming session, or null:
  //   { id, liveKey, src, dst, agreement, segmenter }
  //
  // `agreement` is the LocalAgreement-2 policy: Moonshine may revise its
  // hypothesis on every append, so only the prefix two consecutive hypotheses
  // agree on is committed. The rest renders as tentative text instead of
  // making the whole paragraph flicker.
  //
  // `segmenter` exists only in translation mode. It holds confirmed words
  // until they form a clause, then releases them to the translator — so the
  // translation column fills in while the person is still speaking, without
  // one LLM request per word.
  const sttStreamRef = useRef(null)

  // Floating Picture-in-Picture window (translations over other tabs).
  const [floatOpen, setFloatOpen] = useState(false)
  const floatWindowRef = useRef(null)

  // Push conversation snapshots to the floating window whenever they change
  // (the window's content depends on the active mode too).
  useEffect(() => {
    if (floatWindowRef.current) {
      floatWindowRef.current.post({ conversation, transcribeMode })
    }
  }, [conversation, transcribeMode])

  // Translation State
  const [transcriptionData, setTranscriptionData] = useState({
    source: "",
    text: "— listening —",
  })
  const [translationData, setTranslationData] = useState({
    target: "",
    text: "— waiting —",
  })
  const [metaText, setMetaText] = useState("")

  // Currently-playing TTS audio element (chunked playback chain)
  const onlineAudioPlayerRef = useRef(null)

  // Language Lanes State — default: English (lane 1) → Spanish (lane 2)
  const [lang1Index, setLang1Index] = useState(1)
  const [lang2Index, setLang2Index] = useState(2)
  const [activeLaneRecording, setActiveLaneRecording] = useState(null)

  // Live-refs for lane languages (streaming closure needs them).
  const lang1IndexRef = useRef(lang1Index)
  const lang2IndexRef = useRef(lang2Index)
  useEffect(() => {
    lang1IndexRef.current = lang1Index
  }, [lang1Index])
  useEffect(() => {
    lang2IndexRef.current = lang2Index
  }, [lang2Index]) // 1 or 2

  const { isRecording, startRecording, stopRecording, analyser, micError } =
    useAudioRecorder()

  const {
    isCapturing: isTabCapturing,
    error: tabError,
    startCapture: startTabCapture,
    stopCapture: stopTabCapture,
    analyser: tabAnalyser,
  } = useTabAudioCapture()

  // Model warm-up state. The heavy models load in the background at boot;
  // surfacing that is the difference between "preparing" and "this is slow".
  const readiness = useReadiness()

  // Preload whatever pair the lanes currently point at. Only en->es is
  // prewarmed at boot, and first use of another pair costs seconds (26.66s
  // measured for es->en), so pay it while the user is still setting up rather
  // than in the middle of a sentence.
  useEffect(() => {
    const src = AVAILABLE_LANGUAGES[lang1Index]
    const dst = AVAILABLE_LANGUAGES[lang2Index]
    if (!src || !dst) return
    // Both directions: either lane can be the speaker.
    warmupPair(src.code, dst.code).catch(() => {})
    warmupPair(dst.code, src.code).catch(() => {})
  }, [lang1Index, lang2Index])

  // Synced AFTER the hook: reading isTabCapturing in a deps array before its
  // declaration would throw a temporal-dead-zone error at render.
  useEffect(() => {
    isTabCapturingRef.current = isTabCapturing
  }, [isTabCapturing])

  // Live ref to the active lane so the tab-listening loop always uses the
  // latest selection without re-subscribing the chunk handler.
  const activePersonRef = useRef(activePerson)
  useEffect(() => {
    activePersonRef.current = activePerson
  }, [activePerson])

  // Sequential chunk queue: one STT + translation at a time.
  const tabQueueRef = useRef([])
  const tabProcessingRef = useRef(false)

  // Finalize any open stream on unmount (fire-and-forget).
  useEffect(() => {
    return () => {
      if (sttStreamRef.current) {
        const stream = sttStreamRef.current
        sttStreamRef.current = null
        sttStreamStop(stream.id).catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    if (micError) {
      setTranscriptionData({ source: "Microphone", text: "Access Failed" })
      setTranslationData({
        target: "Error",
        text: `${micError} (HTTPS is required when accessing from remote devices)`,
      })
    }
  }, [micError])

  const stopSpeaking = useCallback(() => {
    if (onlineAudioPlayerRef.current) {
      onlineAudioPlayerRef.current.pause()
      onlineAudioPlayerRef.current = null
    }
  }, [])

  // Speak text via /api/tts, splitting into ~180-char chunks and chaining
  // playback so long translations don't overflow a single TTS request.
  const playTTS = useCallback(
    (text, targetLang) => {
      if (!text) return
      stopSpeaking()

      const chunks = splitTextIntoSpeechChunks(text)
      if (chunks.length === 0) return

      let chunkIndex = 0

      const playNextChunk = () => {
        if (chunkIndex >= chunks.length) {
          stopSpeaking()
          return
        }
        const ttsUrl = `/api/tts?text=${encodeURIComponent(chunks[chunkIndex])}&lang=${encodeURIComponent(targetLang)}`
        const player = new Audio(ttsUrl)
        player.volume = 1.0
        onlineAudioPlayerRef.current = player

        player.onended = () => {
          chunkIndex++
          playNextChunk()
        }
        player.onerror = () => {
          stopSpeaking()
          alert("TTS playback failed. Backend server may be offline.")
        }
        player.play().catch((e) => {
          // AbortError = playback was intentionally interrupted by a newer
          // chunk or stopSpeaking() — expected, not a real failure.
          if (e && e.name === "AbortError") return
          console.error("Audio play error:", e)
          stopSpeaking()
        })
      }

      playNextChunk()
    },
    [stopSpeaking],
  )

  // Rotate a lane's language, skipping the slot held by the other lane
  // (the two lanes may never show the same language).
  const handleRotateLanguage = useCallback(
    (lane, direction) => {
      if (isRecording) return
      const N = AVAILABLE_LANGUAGES.length

      playBlip("language")

      if (lane === 1) {
        let ni = (lang1Index + direction + N) % N
        if (ni === lang2Index) ni = (ni + direction + N) % N
        setLang1Index(ni)
      } else {
        let ni = (lang2Index + direction + N) % N
        if (ni === lang1Index) ni = (ni + direction + N) % N
        setLang2Index(ni)
      }
    },
    [lang1Index, lang2Index, isRecording],
  )

  // Translation Pipeline
  const processTranslation = useCallback(
    async (lane, base64Data) => {
      const src =
        lane === 1
          ? AVAILABLE_LANGUAGES[lang1Index]
          : AVAILABLE_LANGUAGES[lang2Index]
      const dst =
        lane === 1
          ? AVAILABLE_LANGUAGES[lang2Index]
          : AVAILABLE_LANGUAGES[lang1Index]

      setTranscriptionData({
        source: `${src.name} (Source)`,
        text: "Analyzing voice input...",
      })
      setTranslationData({
        target: `${dst.name} (Translation)`,
        text: "Translating...",
      })
      setMetaText("")

      try {
        // 1. Transcription
        setTranscriptionData((prev) => ({ ...prev, text: "Listening..." }))
        const transcribedText = await transcribeAudio(base64Data, src.code)
        setTranscriptionData((prev) => ({ ...prev, text: transcribedText }))

        if (!transcribedText.trim()) {
          setTranslationData((prev) => ({
            ...prev,
            text: "(No speech detected)",
          }))
          return
        }

        const key = ++messageKeyRef.current
        const ts = new Date().toISOString()

        // Transcription-only mode: append the live chunk and keep going.
        if (transcribeModeRef.current === "transcription") {
          setConversation((prev) => [
            ...prev,
            {
              key,
              kind: "transcription",
              sourceName: src.name,
              sourceCode: src.code,
              transcript: transcribedText,
              ts,
            },
          ])
          setSaveState((s) => (s === "saved" ? "dirty" : s))
          return
        }

        // 2. Translation
        // Push-to-talk uses the same fast NMT engine as tab listening; the
        // LLM stays as a fallback for pairs Argos cannot serve. This path used
        // to be the slow one (JSON prompt, no streaming) — measured 1.76s per
        // sentence against Argos's 61ms.
        let result
        try {
          const fast = await translateFast(transcribedText, src.code, dst.code)
          result = { translation: fast.text, duration: (fast.ms / 1000).toFixed(2), tokens: 0 }
        } catch (fastErr) {
          console.warn("Fast translation unavailable, falling back to the LLM:", fastErr)
          result = await translateText(transcribedText, {
            ...config,
            modelName: config.modelName,
            systemPrompt: buildTranslationPrompt(src.name, dst.name),
          })
        }

        setTranslationData((prev) => ({ ...prev, text: result.translation }))
        setMetaText(`Duration: ${result.duration}s | Tokens: ${result.tokens}`)

        // Append to the on-screen conversation (kept until "Nueva charla").
        setConversation((prev) => [
          ...prev,
          {
            key,
            kind: "translation",
            sourceName: src.name,
            targetName: dst.name,
            sourceCode: src.code,
            targetCode: dst.code,
            transcript: transcribedText,
            translation: result.translation,
            ts,
          },
        ])
        setSaveState((s) => (s === "saved" ? "dirty" : s))

        if (config.enableTts && voiceOnRef.current && !isTabCapturingRef.current) {
          playTTS(result.translation, dst.ttsLang)
        }
      } catch (err) {
        console.error(err)
        setTranscriptionData((prev) => ({
          ...prev,
          text: prev.text === "Listening..." ? "(Transcription failed)" : prev.text,
        }))
        setTranslationData((prev) => ({ ...prev, text: `Error: ${err.message}` }))
      }
    },
    [config, lang1Index, lang2Index, playTTS, isTabCapturing],
  )

  // Translation runs OFF the audio loop.
  //
  // Measured on the real stack: STT 14.89s + LLM 10.48s summed to exactly the
  // 25.37s pipeline, i.e. zero overlap — awaiting the translator inside the
  // append loop stalled transcription. Segments are now chained on their own
  // promise so they still translate IN ORDER, while the audio loop keeps
  // feeding Moonshine.
  const translationChainRef = useRef(Promise.resolve())
  // Translated text committed so far for the live entry, so a streaming
  // segment can append to it without re-reading React state.
  const translatedSoFarRef = useRef("")

  // Translates one confirmed segment into the live entry's translation column.
  //
  // Argos (dedicated NMT) answers in ~61ms, so the segment simply appears —
  // no token streaming needed. The LLM path stays as a fallback for language
  // pairs Argos has no package for.
  const translateSegment = useCallback(
    async (segment, src, dst, liveKey) => {
      const base = translatedSoFarRef.current
      const withBase = (piece) => (base ? `${base} ${piece}` : piece)
      const paint = (piece) => {
        setConversation((prev) =>
          prev.map((m) =>
            m.key === liveKey ? { ...m, translation: withBase(piece) } : m,
          ),
        )
        setTranslationData((prev) => ({ ...prev, text: withBase(piece) }))
      }

      let piece = ""
      try {
        const fast = await translateFast(segment, src.code, dst.code)
        piece = (fast.text || "").trim()
      } catch (err) {
        console.warn("Fast translation unavailable, falling back to the LLM:", err)
        try {
          const slow = await translateTextStream(
            segment,
            {
              ...config,
              modelName: config.modelName,
              systemPrompt: buildPlainTranslationPrompt(src.name, dst.name),
            },
            (partial) => paint(partial),
          )
          piece = (slow || "").trim()
        } catch (err2) {
          // One failed segment must not abort the utterance.
          console.error("Segment translation failed:", err2)
          return
        }
      }

      if (!piece) return
      translatedSoFarRef.current = withBase(piece)
      paint(piece)
    },
    [config],
  )

  // Queues a segment behind the ones already translating. Returns immediately
  // so the caller (the audio loop) is never blocked.
  const enqueueTranslation = useCallback(
    (segment, src, dst, liveKey) => {
      translationChainRef.current = translationChainRef.current.then(() =>
        translateSegment(segment, src, dst, liveKey),
      )
      return translationChainRef.current
    },
    [translateSegment],
  )

  // Commit the active streaming transcript (silence detected, capture
  // stopped, mode switched, or session cleared).
  const finalizeLiveStream = useCallback(async () => {
    const stream = sttStreamRef.current
    if (!stream) return
    sttStreamRef.current = null

    // Commit whatever is still tentative. On success the backend's final
    // transcript wins; on failure we keep the text LocalAgreement had already
    // accumulated. Either way the entry stops being live, so the caret and
    // the dimmed tail never linger.
    const settle = async (finalText) => {
      const { committed, newlyCommitted } = stream.agreement.flush(finalText)
      setConversation((prev) =>
        prev.map((m) =>
          m.key === stream.liveKey
            ? { ...m, transcript: committed || m.transcript, pending: "", live: false }
            : m,
        ),
      )

      // Translation mode: the segmenter may still hold words that never
      // reached a clause boundary. End of utterance releases them.
      if (stream.segmenter) {
        const tail = [
          ...stream.segmenter.push(newlyCommitted),
          ...stream.segmenter.flush(),
        ]
        for (const segment of tail) {
          enqueueTranslation(segment, stream.src, stream.dst, stream.liveKey)
        }
      }
      // The transcript is settled, so the caret is already gone. Segments
      // queued earlier may still be translating, though: wait for the chain
      // so callers (stop capture, mode switch, new call) do not race ahead of
      // translations that are still painting into this entry.
      await translationChainRef.current
    }

    try {
      const res = await sttStreamStop(stream.id)
      await settle(res.text || undefined)
    } catch (err) {
      console.error("Stream finalize failed:", err)
      await settle()
    }
  }, [enqueueTranslation])

  // Save the whole conversation as a session (SQLite via the backend).
  const handleSave = useCallback(async () => {
    if (conversation.length === 0) return
    setSaveState("saving")
    try {
      const d = new Date()
      const title = `Llamada ${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
      await createSession({
        title,
        messages: conversation.map((m) => ({
          source_lang: m.sourceCode,
          target_lang: m.targetCode,
          transcript: m.transcript,
          translation: m.translation || "",
        })),
      })
      setSaveState("saved")
    } catch (err) {
      console.error("Session save failed:", err)
      setSaveState("error")
    }
  }, [conversation])

  const handleNewCall = useCallback(() => {
    if (sttStreamRef.current) finalizeLiveStream()
    setConversation([])
    setSaveState("idle")
    setMetaText("")
    setTranscriptionData({ source: "", text: "— listening —" })
    setTranslationData({ target: "", text: "— waiting —" })
  }, [finalizeLiveStream])

  const handleOpenHistory = useCallback(async () => {
    try {
      setSessions(await listSessions())
      setHistoryOpen(true)
    } catch (err) {
      console.error("Failed to load sessions:", err)
    }
  }, [])

  const handleLoadSession = useCallback(
    async (sessionId) => {
      if (sttStreamRef.current) finalizeLiveStream()
      try {
      const data = await getSessionMessages(sessionId)
      const entries = data.messages.map((m, i) => {
        const src =
          AVAILABLE_LANGUAGES.find((l) => l.code === m.source_lang) || {
            code: m.source_lang,
            name: m.source_lang,
          }
        const dst =
          AVAILABLE_LANGUAGES.find((l) => l.code === m.target_lang) || {
            code: m.target_lang,
            name: m.target_lang,
          }
        return {
          key: i + 1,
          kind: m.target_lang ? "translation" : "transcription",
          sourceName: src.name,
          targetName: dst.name,
          sourceCode: src.code,
          targetCode: dst.code,
          transcript: m.transcript,
          translation: m.translation,
          ts: m.created_at,
        }
      })
      messageKeyRef.current = entries.length
      setConversation(entries)
      setSaveState("saved")
      setHistoryOpen(false)
    } catch (err) {
      console.error("Failed to load session:", err)
    }
  }, [finalizeLiveStream])

  // One streaming cycle: open the Moonshine stream on the first chunk of an
  // utterance, append audio (which returns a revised FULL hypothesis), run it
  // through LocalAgreement, and — in translation mode — release confirmed
  // clauses to the translator as they close, so the translation column grows
  // while the person is still talking.
  const processStreamChunk = useCallback(
    async ({ base64Data, final }) => {
      const translating = transcribeModeRef.current !== "transcription"

      if (!sttStreamRef.current) {
        const lane = activePersonRef.current
        const srcIndex = lane === 1 ? lang1IndexRef.current : lang2IndexRef.current
        const dstIndex = lane === 1 ? lang2IndexRef.current : lang1IndexRef.current
        const src = AVAILABLE_LANGUAGES[srcIndex]
        const dst = AVAILABLE_LANGUAGES[dstIndex]
        try {
          const { stream_id } = await sttStreamStart(src.code)
          const key = ++messageKeyRef.current
          setConversation((prev) => [
            ...prev,
            {
              key,
              kind: translating ? "translation" : "transcription",
              live: true,
              sourceName: src.name,
              sourceCode: src.code,
              targetName: translating ? dst.name : undefined,
              targetCode: translating ? dst.code : undefined,
              transcript: "",
              pending: "",
              translation: "",
              ts: new Date().toISOString(),
            },
          ])
          setSaveState((s) => (s === "saved" ? "dirty" : s))
          translatedSoFarRef.current = ""
          sttStreamRef.current = {
            id: stream_id,
            liveKey: key,
            src,
            dst,
            agreement: createLocalAgreement({ n: 2 }),
            // Only translation mode needs an emission policy.
            segmenter: translating
              ? createTranslationSegmenter(SEGMENTER_OPTIONS)
              : null,
          }
        } catch (err) {
          console.error("Stream start failed, falling back to one-shot:", err)
          await processTranslation(activePersonRef.current, base64Data)
          return
        }
      }

      const stream = sttStreamRef.current
      if (!stream) return

      try {
        const res = await sttStreamAppend(stream.id, base64Data)
        // Raw hypothesis -> stable prefix + tentative tail.
        const { committed, pending, newlyCommitted } = stream.agreement.update(
          res.text,
        )
        // Capture the live key BEFORE the updater runs: React defers state
        // updaters to the next render, and finalizeLiveStream may have
        // nulled sttStreamRef by then (reading it here would crash).
        const liveKey = stream.liveKey
        setConversation((prev) =>
          prev.map((m) =>
            m.key === liveKey ? { ...m, transcript: committed, pending } : m,
          ),
        )

        // Translation mode: newly confirmed words go to the segmenter, which
        // releases them only once they form a clause worth translating.
        if (stream.segmenter && newlyCommitted) {
          for (const segment of stream.segmenter.push(newlyCommitted)) {
            // Fire-and-forget on purpose: the chain keeps them ordered while
            // this loop goes straight back to feeding audio.
            enqueueTranslation(segment, stream.src, stream.dst, liveKey)
          }
        }
      } catch (err) {
        console.error("Stream append failed:", err)
        await finalizeLiveStream()
        await processTranslation(activePersonRef.current, base64Data)
        return
      }

      if (final) {
        await finalizeLiveStream()
      }
    },
    [finalizeLiveStream, processTranslation, enqueueTranslation],
  )

  // Continuous listening loop for tab capture. Both modes now feed the same
  // Moonshine STREAM; the mode only decides whether confirmed text also gets
  // translated (see processStreamChunk).
  //
  // Backpressure: the VAD produces a chunk per second, but a full STT +
  // translation round trip takes longer. Draining the queue one chunk at a
  // time made the backlog — and therefore the delay behind the speaker — grow
  // without bound. Every queued chunk is now MERGED into a single append, so
  // no audio is lost and the recognizer runs once per cycle instead of once
  // per chunk.
  const handleTabChunk = useCallback(
    async ({ base64Data, final }) => {
      tabQueueRef.current.push({ base64Data, final })
      if (tabProcessingRef.current) return
      tabProcessingRef.current = true
      try {
        while (tabQueueRef.current.length > 0) {
          const merged = drainQueue(tabQueueRef.current, {
            maxSamples: MAX_QUEUED_SAMPLES,
          })
          if (!merged) break
          if (merged.droppedSamples > 0) {
            console.warn(
              `[tab] pipeline is ${Math.round(merged.droppedSamples / 16000)}s behind — dropped the oldest audio`,
            )
          }
          try {
            await processStreamChunk(merged)
          } catch (err) {
            console.error("Tab chunk processing failed:", err)
          }
        }
      } finally {
        // Always release the lock: an unhandled throw here would freeze tab
        // listening until the page is reloaded.
        tabProcessingRef.current = false
      }
    },
    [processStreamChunk],
  )

  // Mouse-driven language pick: the two lanes may never share a language.
  const handleSelectLanguage = useCallback(
    (lane, index) => {
      if (isRecording) return
      const otherIndex = lane === 1 ? lang2Index : lang1Index
      if (index === otherIndex) return
      playBlip("language")
      if (lane === 1) setLang1Index(index)
      else setLang2Index(index)
    },
    [isRecording, lang1Index, lang2Index],
  )

  // Open/close the floating translations window (Document PiP).
  const handleToggleFloat = useCallback(async () => {
    if (floatWindowRef.current) {
      floatWindowRef.current.close()
      floatWindowRef.current = null
      setFloatOpen(false)
      return
    }
    try {
      const { close, post } = await openFloatingWindow({
        payload: { conversation, transcribeMode },
        onClose: () => {
          floatWindowRef.current = null
          setFloatOpen(false)
        },
      })
      floatWindowRef.current = { close, post }
      setFloatOpen(true)
    } catch (err) {
      console.error("Floating window failed:", err)
      alert(err.message)
    }
  }, [conversation, transcribeMode])

  // Recording triggers
  const handleRecordStart = useCallback(
    async (lane) => {
      if (isRecording || isTabCapturing) return
      stopSpeaking()

      setActivePerson((prev) => {
        if (prev !== lane) playBlip("speaker")
        return lane
      })
      setActiveLaneRecording(lane)
      playBlip("ping")

      const ok = await startRecording()
      if (!ok) {
        setActiveLaneRecording(null)
      }
    },
    [isRecording, isTabCapturing, stopSpeaking, startRecording],
  )

  const handleRecordStop = useCallback(async () => {
    if (!isRecording) return

    const recordedLane = activeLaneRecording
    setActiveLaneRecording(null)
    const audioData = await stopRecording()

    if (audioData) {
      processTranslation(recordedLane, audioData.base64Data)
    }
  }, [isRecording, activeLaneRecording, stopRecording, processTranslation])

  const toggleTabListening = useCallback(async () => {
    if (isTabCapturing) {
      await finalizeLiveStream()
      stopTabCapture()
      return
    }
    stopSpeaking()
    if (isRecording) await handleRecordStop()
    const ok = await startTabCapture(handleTabChunk)
    if (ok) {
      setTranscriptionData({
        source: "Tab audio",
        text: "Listening to the selected tab...",
      })
      setTranslationData({
        target: "Auto-translate",
        text: "— waiting —",
      })
    }
  }, [
    isTabCapturing,
    isRecording,
    stopTabCapture,
    startTabCapture,
    handleTabChunk,
    handleRecordStop,
    stopSpeaking,
    finalizeLiveStream,
  ])

  // Switching away from transcription commits the partial transcript.
  const handleSetTranscribeMode = useCallback(
    (mode) => {
      if (mode !== "transcription" && sttStreamRef.current) {
        finalizeLiveStream()
      }
      setTranscribeMode(mode)
    },
    [finalizeLiveStream],
  )

  // Push-to-talk keyboard control (two modes, see README):
  // landscape = one "active person" driven by Space/Z/arrows;
  // vertical   = independent per-lane keys (Z/X for record, arrows and -/+).
  // keydown starts recording, keyup stops — e.repeat guards auto-repeat.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return
      const key = e.key.toLowerCase()

      if (config.keyboardMode === "landscape") {
        if (key === " " || e.key === "Spacebar") {
          e.preventDefault()
          if (!isRecording && !isTabCapturing) {
            playBlip("speaker")
            setActivePerson((p) => (p === 1 ? 2 : 1))
          }
        } else if (key === "z") {
          e.preventDefault()
          if (!e.repeat && !isRecording && !isTabCapturing)
            handleRecordStart(activePerson)
        } else if (key === "t") {
          e.preventDefault()
          if (!e.repeat) toggleTabListening()
        } else if (e.key === "ArrowLeft") {
          e.preventDefault()
          handleRotateLanguage(activePerson, -1)
        } else if (e.key === "ArrowRight") {
          e.preventDefault()
          handleRotateLanguage(activePerson, 1)
        }
      } else {
        if (key === "z") {
          e.preventDefault()
          if (!e.repeat && !isRecording && !isTabCapturing) handleRecordStart(1)
        } else if (key === "x") {
          e.preventDefault()
          if (!e.repeat && !isRecording && !isTabCapturing) handleRecordStart(2)
        } else if (key === "t") {
          e.preventDefault()
          if (!e.repeat) toggleTabListening()
        } else if (e.key === "ArrowLeft") {
          e.preventDefault()
          handleRotateLanguage(1, -1)
        } else if (e.key === "ArrowRight") {
          e.preventDefault()
          handleRotateLanguage(1, 1)
        } else if (key === "-" || key === "_") {
          e.preventDefault()
          handleRotateLanguage(2, -1)
        } else if (key === "+" || key === "=") {
          e.preventDefault()
          handleRotateLanguage(2, 1)
        }
      }
    }

    const handleKeyUp = (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return
      const key = e.key.toLowerCase()

      if (config.keyboardMode === "landscape") {
        if (key === "z" && isRecording) handleRecordStop()
      } else {
        if (key === "z" && activeLaneRecording === 1) handleRecordStop()
        if (key === "x" && activeLaneRecording === 2) handleRecordStop()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [
    config.keyboardMode,
    isRecording,
    isTabCapturing,
    activePerson,
    activeLaneRecording,
    handleRecordStart,
    handleRecordStop,
    handleRotateLanguage,
    toggleTabListening,
  ])

  return (
    <div className="translator-envelope">
      <TranscriptPanel
        conversation={conversation}
        saveState={saveState}
        floatOpen={floatOpen}
        onSave={handleSave}
        onNewCall={handleNewCall}
        onOpenHistory={handleOpenHistory}
        onOpenSettings={onOpenSettings}
        onToggleFloat={handleToggleFloat}
        placeholderText="Select languages, push to talk"
      />

      {historyOpen && (
        <div className="history-overlay">
          <header className="overlay-header">
            <h2>Historial de sesiones</h2>
            <button
              className="overlay-close-btn"
              onClick={() => setHistoryOpen(false)}
              aria-label="Cerrar"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </header>
          <div className="history-list">
            {sessions.length === 0 ? (
              <div className="initial-placeholder">Sin sesiones guardadas</div>
            ) : (
              sessions.map((s) => (
                <button
                  key={s.id}
                  className="history-item"
                  onClick={() => handleLoadSession(s.id)}
                >
                  <span className="history-item-title">{s.title}</span>
                  <span className="history-item-meta">
                    {s.message_count} msgs · {s.created_at.replace("T", " ").slice(0, 16)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      <main className="translator-workspace">
        <div className="capture-mode-bar">
          <button
            className={`capture-mode-btn ${isTabCapturing ? "active" : ""}`}
            onClick={toggleTabListening}
          >
            {isTabCapturing ? (
              <>
                <Square size={13} strokeWidth={2} fill="currentColor" />
                <span>Detener</span>
              </>
            ) : (
              <>
                <Play size={13} strokeWidth={2} fill="currentColor" />
                <span>Escuchar pestaña</span>
              </>
            )}
          </button>
          <div
            className="segmented"
            data-mode={transcribeMode}
          >
            {/* Liquid indicator: two stacked blobs under the #gooey filter.
                The trailing one lags behind, so during the slide they stretch
                into a single droplet and then snap back together. Labels live
                OUTSIDE this layer so the text stays sharp. */}
            <span className="seg-liquid" aria-hidden="true">
              <span className="seg-blob" />
              <span className="seg-blob seg-blob-trail" />
            </span>
            <button
              className={`seg-btn ${transcribeMode === "translation" ? "active" : ""}`}
              onClick={() => handleSetTranscribeMode("translation")}
            >
              <Languages size={13} strokeWidth={1.75} />
              <span>Traducción</span>
            </button>
            <button
              className={`seg-btn ${transcribeMode === "transcription" ? "active" : ""}`}
              onClick={() => handleSetTranscribeMode("transcription")}
            >
              <Captions size={13} strokeWidth={1.75} />
              <span>Transcripción</span>
            </button>
          </div>
          <button
            className={`voice-btn ${voiceOn ? "" : "muted"}`}
            onClick={() => setVoiceOn((v) => !v)}
            title="Voz"
          >
            {voiceOn ? (
              <Volume2 size={15} strokeWidth={1.75} />
            ) : (
              <VolumeX size={15} strokeWidth={1.75} />
            )}
          </button>
          {readiness.known && !readiness.ready && (
            <span className="warmup-indicator" role="status" aria-live="polite">
              <span className="warmup-dot" />
              Preparando modelos… {formatWarmupDetail(readiness.components, readiness.busy)}
            </span>
          )}
          <span className="capture-mode-hint">
            {isTabCapturing
              ? transcribeMode === "transcription"
                ? `Transcribiendo ${AVAILABLE_LANGUAGES[activePerson === 1 ? lang1Index : lang2Index].name} en vivo…`
                : `Auto: ${AVAILABLE_LANGUAGES[activePerson === 1 ? lang1Index : lang2Index].name} → ${
                    AVAILABLE_LANGUAGES[activePerson === 1 ? lang2Index : lang1Index].name
                  } · T detener`
              : "Mic: Z · Pestaña: T"}
          </span>
          {tabError && <span className="capture-mode-error">{tabError}</span>}
        </div>

        <div className="languages-container">
          <LanguageLane
            laneId={1}
            laneLabel="1"
            languages={AVAILABLE_LANGUAGES}
            currentIndex={lang1Index}
            otherLaneCode={AVAILABLE_LANGUAGES[lang2Index].code}
            isRecording={activeLaneRecording === 1}
            isActivePerson={
              config.keyboardMode === "landscape" && activePerson === 1
            }
            onRotate={(dir) => handleRotateLanguage(1, dir)}
            onSelect={(index) => handleSelectLanguage(1, index)}
          />
          <LanguageLane
            laneId={2}
            laneLabel="2"
            languages={AVAILABLE_LANGUAGES}
            currentIndex={lang2Index}
            otherLaneCode={AVAILABLE_LANGUAGES[lang1Index].code}
            isRecording={activeLaneRecording === 2}
            isActivePerson={
              config.keyboardMode === "landscape" && activePerson === 2
            }
            onRotate={(dir) => handleRotateLanguage(2, dir)}
            onSelect={(index) => handleSelectLanguage(2, index)}
          />
        </div>

        <Visualizer
          activePerson={activePerson}
          isRecording={isRecording || isTabCapturing}
          analyser={isTabCapturing ? tabAnalyser : analyser}
          barsCount={parseInt(config.visualizerBars, 10)}
        />
      </main>
    </div>
  )
}

export default TranslatorApp
