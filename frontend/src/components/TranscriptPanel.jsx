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
import {
  PictureInPicture2,
  Settings,
  History,
  MessageSquarePlus,
  Save,
  Check,
  Loader2,
  RotateCcw,
} from "lucide-react"
import { computeDocView } from "../utils/docView"
import StreamingText from "./StreamingText"
import LiquidMenu from "./LiquidMenu"
import Tooltip, { useTooltipTilt } from "./Tooltip"

// Full conversation transcript: all spoken text accumulates as one
// continuous paragraph per column (source | translation), with save-to-
// session controls.
export default function TranscriptPanel({
  conversation,
  saveState,
  floatOpen,
  onSave,
  onNewCall,
  onOpenHistory,
  onOpenSettings,
  onToggleFloat,
  placeholderText,
}) {
  const scrollRef = useRef(null)
  const { tilt: floatTilt, tiltHandlers: floatTiltHandlers } = useTooltipTilt()

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
          <button
            className={`header-icon-btn ${floatOpen ? "active" : ""}`}
            onClick={onToggleFloat}
            aria-label="Ventana flotante"
            aria-pressed={floatOpen}
            {...floatTiltHandlers}
          >
            <PictureInPicture2 size={17} strokeWidth={1.75} />
            <Tooltip
              label="Ventana flotante"
              tilt={floatTilt}
              placement="bottom"
            />
          </button>
          <LiquidMenu
            items={[
              {
                key: "settings",
                label: "Configuración",
                icon: <Settings size={16} strokeWidth={1.75} />,
                onClick: onOpenSettings,
              },
              {
                key: "history",
                label: "Historial",
                icon: <History size={16} strokeWidth={1.75} />,
                onClick: onOpenHistory,
              },
              {
                key: "new",
                label: "Nueva charla",
                icon: <MessageSquarePlus size={16} strokeWidth={1.75} />,
                onClick: onNewCall,
              },
              {
                key: "save",
                label:
                  saveState === "saving"
                    ? "Guardando…"
                    : saveState === "saved"
                      ? "Guardado"
                      : saveState === "error"
                        ? "Reintentar guardado"
                        : "Guardar",
                icon:
                  saveState === "saving" ? (
                    <Loader2 size={16} strokeWidth={1.75} className="spin" />
                  ) : saveState === "saved" ? (
                    <Check size={16} strokeWidth={2} />
                  ) : saveState === "error" ? (
                    <RotateCcw size={16} strokeWidth={1.75} />
                  ) : (
                    <Save size={16} strokeWidth={1.75} />
                  ),
                onClick: onSave,
                disabled: conversation.length === 0 || saveState === "saving",
                active: saveState === "saved",
              },
            ]}
          />
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
  const view = computeDocView(conversation)

  return (
    <div className="doc-columns">
      <div className="doc-column">
        <div className="doc-label">{view.sourceLabel}</div>
        <div className="doc-text">
          {/* The pending tail is the part LocalAgreement has not confirmed:
              it renders dimmed because it may still be rewritten. */}
          <StreamingText
            text={view.leftText}
            pending={view.leftPending}
            isLive={view.isLive}
          />
        </div>
      </div>
      <div className="doc-column doc-column-target">
        <div className="doc-label">{view.targetLabel}</div>
        <div className="doc-text">
          <StreamingText text={view.rightText} />
        </div>
      </div>
    </div>
  )
}
