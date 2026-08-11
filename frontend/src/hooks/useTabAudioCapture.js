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

import { useState, useRef, useCallback, useEffect } from "react"
import { getMergedSamples, resample, blobToBase64 } from "../utils/audioHelpers"

// Continuous "listen to a browser tab" capture hook. Uses getDisplayMedia so
// the user can pick any tab (e.g. a Meet call) and the audio that tab plays
// is fed into the same Float32 PCM pipeline as the mic recorder.
//
// Voice-activity detection: frames are buffered only while speech is present;
// chunks are flushed every ~1s of continuous speech (maximally fluid live
// transcription) or after ~1.2s of silence, then base64 16 kHz mono (the
// /api/stt payload) goes to the onChunk callback. NOTE: very short chunks
// transcribe without context from the previous chunk — expect cut words and
// slightly more errors than longer chunks.

const SPEECH_THRESHOLD = 0.015 // RMS above this counts as speech
const SILENCE_FLUSH_FRAMES = 14 // ~1.2s of silence at 48 kHz / 4096-frame buffers
const MAX_CHUNK_SECONDS = 1 // live cadence: flush every ~1s of speech

export function useTabAudioCapture() {
  const [isCapturing, setIsCapturing] = useState(false)
  const [error, setError] = useState(null)

  const audioContextRef = useRef(null)
  const sourceRef = useRef(null)
  const analyserRef = useRef(null)
  const scriptProcessorRef = useRef(null)
  const streamRef = useRef(null)

  const onChunkRef = useRef(null)
  const bufferRef = useRef([])
  const speechFramesRef = useRef(0)
  const silenceFramesRef = useRef(0)
  const sampleRateRef = useRef(48000)

  const flushChunk = async (reason) => {
    const samples = bufferRef.current
    bufferRef.current = []
    speechFramesRef.current = 0
    silenceFramesRef.current = 0
    if (samples.length === 0 || !onChunkRef.current) return

    const mergedSamples = getMergedSamples(samples)
    const resampledSamples = resample(mergedSamples, sampleRateRef.current, 16000)
    const rawBlob = new Blob([resampledSamples.buffer], {
      type: "application/octet-stream",
    })
    const base64Data = await blobToBase64(rawBlob)
    // final=true marks the end of an utterance (silence flush); the
    // continuous cadence flushes (duration) carry final=false.
    onChunkRef.current({ base64Data, final: reason === "silence" })
  }

  const startCapture = useCallback(async (onChunk) => {
    setError(null)
    onChunkRef.current = onChunk
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      })
      // Only the audio track is used; the video track is discarded.
      stream.getVideoTracks().forEach((track) => track.stop())
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error("No audio track in the selected source")
      }
      streamRef.current = stream

      const AudioContext = window.AudioContext || window.webkitAudioContext
      const ctx = new AudioContext()
      audioContextRef.current = ctx
      if (ctx.state === "suspended") {
        await ctx.resume()
      }
      sampleRateRef.current = ctx.sampleRate

      const source = ctx.createMediaStreamSource(stream)
      sourceRef.current = source

      // Small FFT — feeds the low-res bar visualizer.
      analyserRef.current = ctx.createAnalyser()
      analyserRef.current.fftSize = 256
      source.connect(analyserRef.current)

      const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1)
      scriptProcessorRef.current = scriptProcessor
      bufferRef.current = []

      scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0)

        let sum = 0
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i]
        }
        const rms = Math.sqrt(sum / inputData.length)

        if (rms > SPEECH_THRESHOLD) {
          silenceFramesRef.current = 0
          bufferRef.current.push(new Float32Array(inputData))
          speechFramesRef.current++
          const seconds = (speechFramesRef.current * 4096) / sampleRateRef.current
          if (seconds >= MAX_CHUNK_SECONDS) {
            flushChunk("duration")
          }
        } else if (speechFramesRef.current > 0) {
          silenceFramesRef.current++
          bufferRef.current.push(new Float32Array(inputData))
          if (silenceFramesRef.current >= SILENCE_FLUSH_FRAMES) {
            flushChunk("silence")
          }
        }
      }

      source.connect(scriptProcessor)
      scriptProcessor.connect(ctx.destination)

      setIsCapturing(true)
      return true
    } catch (err) {
      console.error("Error capturing tab audio:", err)
      const msg = err.message || "Tab audio capture failed (secure context required)"
      setError(msg)
      return false
    }
  }, [])

  const stopCapture = useCallback(() => {
    setIsCapturing(false)
    onChunkRef.current = null
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect()
      scriptProcessorRef.current.onaudioprocess = null
      scriptProcessorRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect()
      analyserRef.current = null
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    bufferRef.current = []
    speechFramesRef.current = 0
    silenceFramesRef.current = 0
  }, [])

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close()
      }
    }
  }, [])

  return {
    isCapturing,
    error,
    startCapture,
    stopCapture,
    analyser: analyserRef.current,
  }
}
