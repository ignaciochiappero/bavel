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

import React, { useEffect, useRef } from "react"

// Full conversation transcript: every utterance stays on screen as a
// source/translation bubble pair, with save-to-session controls.
function formatTime(ts) {
  if (!ts) return ""
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return ""
  }
}

export default function TranscriptPanel({
  conversation,
  saveState,
  onSave,
  onNewCall,
  onOpenHistory,
  onOpenSettings,
  placeholderText,
}) {
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [conversation])

  return (
    <div className="response-drawer">
      <header className="app-title">
        <span className="app-title-name">BAVEL</span>
        <div className="header-actions">
          <button className="header-btn" onClick={onOpenSettings} title="Configuración">
            ⚙️
          </button>
          <button className="header-btn" onClick={onOpenHistory}>
            Historial
          </button>
          <button className="header-btn" onClick={onNewCall}>
            Nueva charla
          </button>
          <button
            className={`header-btn header-btn-save ${
              saveState === "saved" ? "saved" : ""
            }`}
            onClick={onSave}
            disabled={conversation.length === 0 || saveState === "saving"}
          >
            {saveState === "saving"
              ? "Guardando…"
              : saveState === "saved"
                ? "✓ Guardado"
                : saveState === "error"
                  ? "Reintentar"
                  : "Guardar"}
          </button>
        </div>
      </header>
      <div className="chat-panel" ref={scrollRef}>
        {conversation.length === 0 ? (
          <div className="initial-placeholder">
            {placeholderText || "Select languages, push to talk"}
          </div>
        ) : (
          conversation.map((m) =>
            m.kind === "transcription" ? (
              <div className="chat-message" key={m.key}>
                <div className="chat-row chat-row-left">
                  <div
                    className={`chat-bubble bubble-left bubble-transcription ${
                      m.live ? "bubble-live" : ""
                    }`}
                  >
                    <div className="bubble-label">
                      {m.sourceName}
                      {m.ts ? ` · ${formatTime(m.ts)}` : ""}
                    </div>
                    <div className="bubble-text">
                      {m.transcript || "escuchando…"}
                      {m.live && <span className="live-caret" />}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="chat-message" key={m.key}>
                <div className="chat-row chat-row-left">
                  <div className="chat-bubble bubble-left">
                    <div className="bubble-label">
                      {m.sourceName}
                      {m.ts ? ` · ${formatTime(m.ts)}` : ""}
                    </div>
                    <div className="bubble-text">{m.transcript || "—"}</div>
                  </div>
                </div>
                <div className="chat-row chat-row-right">
                  <div className="chat-bubble bubble-right">
                    <div className="bubble-label">{m.targetName}</div>
                    <div className="bubble-text">
                      {m.translation === null
                        ? "traduciendo…"
                        : m.translation || "—"}
                    </div>
                  </div>
                </div>
              </div>
            ),
          )
        )}
      </div>
    </div>
  )
}
