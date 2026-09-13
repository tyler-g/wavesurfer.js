/**
 * Anchored PCM chunk alignment for RecordPlugin.
 *
 * A recording pass captures PCM in worklet-sized chunks, each stamped with the
 * AudioContext-clock time of its first frame. The transport, the playback
 * cursor, and the capture anchor all live on that same clock — there is ONE
 * master clock. Aligning the merged buffer so sample 0 falls exactly on the
 * anchor time makes every simultaneously recorded take start at the identical
 * transport position, regardless of how far apart their recorders were
 * started on the main thread.
 */

export interface TimedPcmChunk {
  /** Interleaved PCM (frame-major when channels > 1). */
  data: Float32Array
  /** AudioContext-clock time (seconds) of the chunk's first frame. Undefined
   *  for legacy untimed chunks — those disable anchoring for the whole pass. */
  time?: number
}

/**
 * Merge an interleaved chunk stream into one Float32Array whose first frame
 * corresponds exactly to `anchorSec` on the AudioContext clock: chunks fully
 * before the anchor are dropped, the straddling chunk is head-trimmed in
 * whole frames, and a late-starting stream is zero-padded up to the anchor.
 * With no anchor (or any untimed chunk) the chunks are concatenated verbatim.
 */
export function mergeChunksToAnchor(
  chunks: TimedPcmChunk[],
  anchorSec: number | null,
  sampleRate: number,
  channels: number,
): Float32Array {
  const anchored = anchorSec !== null && chunks.every((c) => c.time !== undefined)

  const parts: Float32Array[] = []
  let started = !anchored

  for (const chunk of chunks) {
    if (started) {
      parts.push(chunk.data)
      continue
    }
    const frames = Math.floor(chunk.data.length / channels)
    const time = chunk.time as number
    if (time + frames / sampleRate <= (anchorSec as number)) continue // fully before anchor

    const leadFrames = Math.round(((anchorSec as number) - time) * sampleRate)
    if (leadFrames > 0) {
      parts.push(chunk.data.subarray(leadFrames * channels))
    } else {
      if (leadFrames < 0) parts.push(new Float32Array(-leadFrames * channels)) // stream started late — pad silence
      parts.push(chunk.data)
    }
    started = true
  }

  const totalLength = parts.reduce((sum, arr) => sum + arr.length, 0)
  const merged = new Float32Array(totalLength)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}

export interface AccumulatePeaksResult {
  /** Possibly-reallocated window (grown when cells landed beyond its length). */
  dataWindow: Float32Array
  /** Index of the first unconsumed chunk — pass back as fromChunk next call. */
  nextChunk: number
  /** Highest cell written this call, or -1 when nothing landed. */
  maxCellWritten: number
}

/**
 * Frames the committed take drops from its head to compensate round-trip
 * latency: `round(ms · sr)`, capped so at least one frame survives, and 0 for
 * a non-positive `compensationMs` or a take of ≤1 frame. The ONE computation
 * shared by RecordPlugin's finalize trim and the live preview placement, so the
 * preview sits exactly where the committed clip lands (WVY-590).
 */
export function compensationTrimFrames(
  compensationMs: number,
  sampleRate: number,
  availableFrames = Infinity,
): number {
  if (!(compensationMs > 0) || availableFrames <= 1) return 0
  return Math.min(Math.round((compensationMs / 1000) * sampleRate), availableFrames - 1)
}

/**
 * Fold timestamped PCM chunks into a peaks window at the cells their frames
 * will occupy in the COMMITTED take: a frame's committed index is
 * `leadFrames + f − trimFrames`, where `leadFrames = −round((anchor − t) · sr)`
 * negates the exact rounding `mergeChunksToAnchor` applies, and `trimFrames`
 * is the latency head trim (`compensationTrimFrames`). It lands in cell
 * `baseIdx + floor(index · fps / sr)` holding the max absolute amplitude
 * across frames and channels. Frames with a negative index (pre-anchor, or
 * inside the trimmed head) are skipped. Because cell placement and amplitude
 * both derive from the shared chunk stream (not per-recorder analysers or
 * timer phases), every recorder of the same input renders the IDENTICAL
 * waveform, and it does not move when the take is committed.
 */
export function accumulateChunkPeaks(opts: {
  dataWindow: Float32Array
  chunks: TimedPcmChunk[]
  fromChunk: number
  anchorSec: number
  baseIdx: number
  sampleRate: number
  channels: number
  fps: number
  /** Latency head trim in frames (compensationTrimFrames). Default 0. */
  trimFrames?: number
}): AccumulatePeaksResult {
  const { chunks, fromChunk, anchorSec, baseIdx, sampleRate, channels, fps, trimFrames = 0 } = opts
  let { dataWindow } = opts
  let maxCellWritten = -1

  for (let ci = fromChunk; ci < chunks.length; ci++) {
    const { data, time } = chunks[ci]
    if (time === undefined) continue
    const frames = Math.floor(data.length / channels)
    const leadFrames = -Math.round((anchorSec - time) * sampleRate)
    for (let f = 0; f < frames; f++) {
      const offset = leadFrames + f - trimFrames
      if (offset < 0) continue
      const cell = baseIdx + Math.floor((offset * fps) / sampleRate)
      let amp = 0
      for (let c = 0; c < channels; c++) {
        const v = Math.abs(data[f * channels + c])
        if (v > amp) amp = v
      }
      if (cell >= dataWindow.length) {
        const grown = new Float32Array(Math.max(dataWindow.length * 2, cell + 1))
        grown.set(dataWindow, 0)
        dataWindow = grown
      }
      if (amp > dataWindow[cell]) dataWindow[cell] = amp
      if (cell > maxCellWritten) maxCellWritten = cell
    }
  }

  return { dataWindow, nextChunk: chunks.length, maxCellWritten }
}
