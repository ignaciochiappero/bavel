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

// Full conversation transcript: all spoken text accumulates as one
// continuous paragraph per column (source | translation), with save-to-
// session controls.
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
          <DocView conversation={conversation} />
        )}
      </div>
    </div>
  )
}

// Bilingual continuous document: everything spoken flows as one paragraph
// on the left column, every translation flows on the right column.
function DocView({ conversation }) {
  const translationEntries = conversation.filter((m) => m.kind === "translation")
  const lastPair = translationEntries[translationEntries.length - 1]
  const lastEntry = conversation[conversation.length - 1]
  const isLive = Boolean(lastEntry && lastEntry.live)

  const leftText = conversation
    .map((m) => m.transcript)
    .filter(Boolean)
    .join(" ")
  const rightText = translationEntries
    .map((m) => m.translation)
    .filter(Boolean)
    .join(" ")

  return (
    <div className="doc-columns">
      <div className="doc-column">
        <div className="doc-label">
          {lastEntry ? lastEntry.sourceName : "Transcripción"}
        </div>
        <div className="doc-text">
          {leftText || "—"}
          {isLive && <span className="live-caret" />}
        </div>
      </div>
      <div className="doc-column doc-column-target">
        <div className="doc-label">
          {lastPair ? lastPair.targetName : "Traducción"}
        </div>
        <div className="doc-text">{rightText || "—"}</div>
      </div>
    </div>
  )
}
