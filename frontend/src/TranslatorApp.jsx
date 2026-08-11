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
import LanguageLane from "./components/LanguageLane"
import TranscriptPanel from "./components/TranscriptPanel"
import Visualizer from "./components/Visualizer"
import { useAudioRecorder } from "./hooks/useAudioRecorder"
import { useTabAudioCapture } from "./hooks/useTabAudioCapture"
import {
  transcribeAudio,
  translateText,
  splitTextIntoSpeechChunks,
  listSessions,
  createSession,
  getSessionMessages,
  sttStreamStart,
  sttStreamAppend,
  sttStreamStop,
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
  useEffect(() => {
    transcribeModeRef.current = transcribeMode
  }, [transcribeMode])
  useEffect(() => {
    voiceOnRef.current = voiceOn
  }, [voiceOn])

  // Active Moonshine streaming session: { id, liveKey } or null.
  const sttStreamRef = useRef(null)

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

  // Language Lanes State
  const [lang1Index, setLang1Index] = useState(0)
  const [lang2Index, setLang2Index] = useState(1)
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
        const result = await translateText(transcribedText, {
          ...config,
          modelName: config.modelName,
          systemPrompt: `You are a high-performance translator. Your task is to translate text from ${src.name.split(" ")[0]} into ${dst.name.split(" ")[0]}.\nYou MUST format your response as a valid JSON object matching this structure:\n{\n  "translation": "High-quality, natural translation into ${dst.name.split(" ")[0]}"\n}\nDo NOT return anything else except this JSON object. No Markdown block wraps (no \`\`\`json), no introductory text, no conversational text. Start directly with "{" and end directly with "}".`,
        })

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

        if (config.enableTts && voiceOnRef.current && !isTabCapturing) {
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

  // Commit the active streaming transcript (silence detected, capture
  // stopped, mode switched, or session cleared).
  const finalizeLiveStream = useCallback(async () => {
    const stream = sttStreamRef.current
    if (!stream) return
    sttStreamRef.current = null
    try {
      const res = await sttStreamStop(stream.id)
      setConversation((prev) =>
        prev.map((m) =>
          m.key === stream.liveKey
            ? { ...m, transcript: res.text || m.transcript, live: false }
            : m,
        ),
      )
    } catch (err) {
      console.error("Stream finalize failed:", err)
    }
  }, [])

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

  // Continuous auto-translate loop for tab listening mode. In transcription
  // mode each chunk feeds a Moonshine STREAM (incremental partial text);
  // otherwise chunks go through the one-shot STT + translation pipeline.
  const handleTabChunk = useCallback(
    async ({ base64Data, final }) => {
      tabQueueRef.current.push({ base64Data, final })
      if (tabProcessingRef.current) return
      tabProcessingRef.current = true
      while (tabQueueRef.current.length > 0) {
        const chunk = tabQueueRef.current.shift()
        try {
          if (transcribeModeRef.current === "transcription") {
            await processStreamChunk(chunk)
          } else {
            await processTranslation(activePersonRef.current, chunk.base64Data)
          }
        } catch (err) {
          console.error("Tab chunk processing failed:", err)
        }
      }
      tabProcessingRef.current = false
    },
    [processTranslation],
  )

  // One streaming chunk: start the stream on the first piece of an
  // utterance, append audio (gets partial text back), stop on silence.
  const processStreamChunk = useCallback(
    async ({ base64Data, final }) => {
      if (!sttStreamRef.current) {
        const srcIndex =
          activePersonRef.current === 1
            ? lang1IndexRef.current
            : lang2IndexRef.current
        const srcLang = AVAILABLE_LANGUAGES[srcIndex]
        try {
          const { stream_id } = await sttStreamStart(srcLang.code)
          const key = ++messageKeyRef.current
          setConversation((prev) => [
            ...prev,
            {
              key,
              kind: "transcription",
              live: true,
              sourceName: srcLang.name,
              sourceCode: srcLang.code,
              transcript: "",
              ts: new Date().toISOString(),
            },
          ])
          setSaveState((s) => (s === "saved" ? "dirty" : s))
          sttStreamRef.current = { id: stream_id, liveKey: key }
        } catch (err) {
          console.error("Stream start failed, falling back to one-shot:", err)
          await processTranslation(activePersonRef.current, base64Data)
          return
        }
      }

      try {
        const res = await sttStreamAppend(sttStreamRef.current.id, base64Data)
        setConversation((prev) =>
          prev.map((m) =>
            m.key === sttStreamRef.current.liveKey
              ? { ...m, transcript: res.text }
              : m,
          ),
        )
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
    [finalizeLiveStream, processTranslation],
  )

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
        onSave={handleSave}
        onNewCall={handleNewCall}
        onOpenHistory={handleOpenHistory}
        onOpenSettings={onOpenSettings}
        placeholderText="Select languages, push to talk"
      />

      {historyOpen && (
        <div className="history-overlay">
          <header className="overlay-header">
            <h2>Historial de sesiones</h2>
            <button
              className="overlay-close-btn"
              onClick={() => setHistoryOpen(false)}
            >
              ✕
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
            {isTabCapturing ? "■ Detener" : "▶ Escuchar pestaña"}
          </button>
          <div className="segmented">
            <button
              className={`seg-btn ${transcribeMode === "translation" ? "active" : ""}`}
              onClick={() => handleSetTranscribeMode("translation")}
            >
              Traducción
            </button>
            <button
              className={`seg-btn ${transcribeMode === "transcription" ? "active" : ""}`}
              onClick={() => handleSetTranscribeMode("transcription")}
            >
              Transcripción
            </button>
          </div>
          <button
            className={`voice-btn ${voiceOn ? "" : "muted"}`}
            onClick={() => setVoiceOn((v) => !v)}
            title="Voz"
          >
            {voiceOn ? "🔊" : "🔇"}
          </button>
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
            isRecording={activeLaneRecording === 1}
            isActivePerson={
              config.keyboardMode === "landscape" && activePerson === 1
            }
            onRotate={(dir) => handleRotateLanguage(1, dir)}
          />
          <LanguageLane
            laneId={2}
            laneLabel="2"
            languages={AVAILABLE_LANGUAGES}
            currentIndex={lang2Index}
            isRecording={activeLaneRecording === 2}
            isActivePerson={
              config.keyboardMode === "landscape" && activePerson === 2
            }
            onRotate={(dir) => handleRotateLanguage(2, dir)}
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
