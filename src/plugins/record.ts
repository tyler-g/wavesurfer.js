/**
 * Record audio from the microphone with a real-time waveform preview
 */

import BasePlugin, { type BasePluginEvents } from '../base-plugin.js'
import Timer from '../timer.js'
import type { WaveSurferOptions } from '../wavesurfer.js'

export type RecordPluginOptions = {
  /** The MIME type to use when recording audio */
  mimeType?: MediaRecorderOptions['mimeType']
  /** The audio bitrate to use when recording audio, defaults to 128000 to avoid a VBR encoding. */
  audioBitsPerSecond?: MediaRecorderOptions['audioBitsPerSecond']
  /** Whether to render the recorded audio at the end, true by default */
  renderRecordedAudio?: boolean
  /** Whether to render the scrolling waveform, false by default */
  scrollingWaveform?: boolean
  /** The duration of the scrolling waveform window, defaults to 5 seconds */
  scrollingWaveformWindow?: number
  /** Accumulate and render the waveform data as the audio is being recorded, false by default */
  continuousWaveform?: boolean
  /** The duration of the continuous waveform, in seconds */
  continuousWaveformDuration?: number
  /** The timeslice to use for the media recorder */
  mediaRecorderTimeslice?: number
  /** The AudioContext to use. If none passed , a new one is generated */
  audioContext?: AudioContext
  /** The Worker reference to use for listening to raw audio data. This can be used in combination with MediaRecorder (which does not support lossless)*/
  workerContext?: Worker
}

export type RecordPluginDeviceOptions = MediaTrackConstraints

export type RecordPluginEvents = BasePluginEvents & {
  /** Fires when the recording starts */
  'record-start': []
  /** Fires when the recording is paused */
  'record-pause': [blob: Blob]
  /** Fires when the recording is resumed */
  'record-resume': []
  /* When the recording stops, either by calling stopRecording or when the media recorder stops */
  'record-end': [blob: Blob]
  /** Fires continuously while recording */
  'record-progress': [duration: number]
  /** On every new recorded chunk */
  'record-data-available': [blob: Blob]
  /** Fires when audio effect processing begins (recomputeAndReload starts) */
  'processing-start': []
  /** Fires when audio effect processing completes (recomputeAndReload finishes) */
  'processing-end': []
}

type MicStream = {
  onDestroy: () => void
  onEnd: () => void
  source: MediaStreamAudioSourceNode
}

type AudioEdit = {
  id: string
  type: string
  startSample: number
  endSample: number
  startTime?: number
  endTime?: number
  gain?: number
  // Limiter params
  threshold?: number
  makeupTarget?: number
  kneeWidth?: number
  lookaheadMs?: number
  releaseMs?: number
  // Compressor params
  ratio?: number
  makeupGainDb?: number
  attackMs?: number
  // Change Pitch params
  semitones?: number
  highQuality?: boolean
  // Fade In / Fade Out params
  curve?: 'linear' | 'exponential'
  // Normalize params
  targetDb?: number
}

type SampleRange = {
  startSample: number
  endSample: number
}

const DEFAULT_BITS_PER_SECOND = 128000
const DEFAULT_SCROLLING_WAVEFORM_WINDOW = 5
const FPS = 100

const MIME_TYPES = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/mp3']
const findSupportedMimeType = () => MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType))

class RecordPlugin extends BasePlugin<RecordPluginEvents, RecordPluginOptions> {
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private mediaRecorder: MediaRecorder | null = null
  private dataWindow: Float32Array | null = null
  private isWaveformPaused = false
  private originalOptions?: Partial<WaveSurferOptions>
  private timer: Timer
  private lastStartTime = 0
  private lastDuration = 0
  private duration = 0
  private micStream: MicStream | null = null
  private unsubscribeDestroy?: () => void

  // Non-destructive editing state
  private originalPcm: Float32Array[] | null = null
  private pcmSampleRate: number = 44100
  private edits: AudioEdit[] = []
  /** True while recomputeAndReload is restoring zoom/cursor after a loadBlob.
   *  AudioTrack event listeners should check this to avoid creating spurious
   *  history entries (which would truncate the undo/redo stack). */
  public isReloading: boolean = false
  /** Snapshot of wavesurfer's decodedData captured before recording starts.
   *  Used by undo to restore the track to its pre-recording visual+audio state. */
  private preRecordingData: { channelData: Float32Array[]; sampleRate: number } | null = null

  // Punch-in recording state
  private punchInSample: number | null = null
  private punchInTimeSec: number = 0
  private existingAudioForPunchIn: Float32Array[] | null = null

  // Channel count for PCM data (set before recording for stereo tracks)
  private recordingChannels: number = 1

  // PCM chunks accumulated during recording (pushed from external PCM pipeline)
  private recordedChunksPCM: Float32Array[] = []
  // Generation counter to detect stale onstop handlers from previous recordings
  private recordingGeneration: number = 0

  /** Create an instance of the Record plugin */
  constructor(options: RecordPluginOptions) {
    super({
      ...options,
      audioBitsPerSecond: options.audioBitsPerSecond ?? DEFAULT_BITS_PER_SECOND,
      scrollingWaveform: options.scrollingWaveform ?? false,
      scrollingWaveformWindow: options.scrollingWaveformWindow ?? DEFAULT_SCROLLING_WAVEFORM_WINDOW,
      continuousWaveform: options.continuousWaveform ?? false,
      renderRecordedAudio: options.renderRecordedAudio ?? true,
      mediaRecorderTimeslice: options.mediaRecorderTimeslice ?? undefined,
      audioContext: options.audioContext ?? new AudioContext(),
      workerContext: options.workerContext ?? undefined,
    })

    this.timer = new Timer()

    this.subscriptions.push(
      this.timer.on('tick', () => {
        const currentTime = performance.now() - this.lastStartTime
        this.duration = this.isPaused() ? this.duration : this.lastDuration + currentTime
        this.emit('record-progress', this.duration)
      }),
    )
  }

  /** Create an instance of the Record plugin */
  public static create(options?: RecordPluginOptions) {
    return new RecordPlugin(options || {})
  }

  public getSource(): MediaStreamAudioSourceNode | null {
    return this.source
  }

  /** Set the number of channels for the PCM recording pipeline (default 1 = mono) */
  public setRecordingChannels(channels: number) {
    this.recordingChannels = channels
  }

  /** Push a PCM chunk from the external audio pipeline (called by MasterSlice). */
  public pushPcmChunk(chunk: Float32Array) {
    this.recordedChunksPCM.push(chunk)
  }

  public renderMicStream(stream: MediaStream): MicStream {
    const audioContext = this.options.audioContext || new AudioContext()
    let source = audioContext.createMediaStreamSource(stream)
    let analyser = audioContext.createAnalyser()
    source.connect(analyser)

    if (this.options.continuousWaveform) {
      analyser.fftSize = 32
    }
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Float32Array(bufferLength)

    let sampleIdx = 0
    let hasInitialRender = false

    if (this.wavesurfer) {
      this.originalOptions ??= {
        ...this.wavesurfer.options,
      }

      // Snapshot the current audio before the live waveform overwrites decodedData
      if (!this.preRecordingData) {
        const decoded = this.wavesurfer.getDecodedData()
        if (decoded) {
          const sampleRate = this.options.audioContext?.sampleRate || 44100
          const channels: Float32Array[] = []
          for (let i = 0; i < decoded.numberOfChannels; i++) {
            channels.push(new Float32Array(decoded.getChannelData(i)))
          }
          this.preRecordingData = { channelData: channels, sampleRate }
        }
      }

      this.wavesurfer.options.interact = false
      if (this.options.scrollingWaveform) {
        this.wavesurfer.options.cursorWidth = 0
      }
    }

    const drawWaveform = () => {
      if (this.isWaveformPaused) return

      analyser.getFloatTimeDomainData(dataArray)

      if (this.options.scrollingWaveform) {
        // Scrolling waveform
        const windowSize = Math.floor((this.options.scrollingWaveformWindow || 0) * audioContext.sampleRate)
        const newLength = Math.min(windowSize, this.dataWindow ? this.dataWindow.length + bufferLength : bufferLength)
        const tempArray = new Float32Array(windowSize) // Always make it the size of the window, filling with zeros by default

        if (this.dataWindow) {
          const startIdx = Math.max(0, windowSize - this.dataWindow.length)
          tempArray.set(this.dataWindow.slice(-newLength + bufferLength), startIdx)
        }

        tempArray.set(dataArray, windowSize - bufferLength)
        this.dataWindow = tempArray
      } else if (this.options.continuousWaveform) {
        // Continuous waveform
        if (!this.dataWindow) {
          const size = this.options.continuousWaveformDuration
            ? Math.round(this.options.continuousWaveformDuration * FPS)
            : (this.wavesurfer?.getWidth() ?? 0) * window.devicePixelRatio
          this.dataWindow = new Float32Array(size)

          // Punch-in: pre-fill with existing audio peaks so the waveform
          // shows the original audio, then overwrite from the punch-in point
          if (this.punchInSample !== null && this.existingAudioForPunchIn) {
            const existingSampleRate = this.options.audioContext?.sampleRate || this.pcmSampleRate
            const samplesPerPeak = Math.floor(existingSampleRate / FPS)
            const channel = this.existingAudioForPunchIn[0]
            const numPeaks = Math.min(Math.ceil(channel.length / samplesPerPeak), size)

            for (let i = 0; i < numPeaks; i++) {
              let peak = 0
              const start = i * samplesPerPeak
              const end = Math.min(start + samplesPerPeak, channel.length)
              for (let j = start; j < end; j++) {
                const v = Math.abs(channel[j])
                if (v > peak) peak = v
              }
              this.dataWindow[i] = peak
            }

            // Start writing live data from the punch-in position
            sampleIdx = Math.round(this.punchInSample / samplesPerPeak)
          }
        }

        let maxValue = 0
        for (let i = 0; i < bufferLength; i++) {
          const value = Math.abs(dataArray[i])
          if (value > maxValue) {
            maxValue = value
          }
        }

        if (sampleIdx + 1 > this.dataWindow.length) {
          const tempArray = new Float32Array(this.dataWindow.length * 2)
          tempArray.set(this.dataWindow, 0)
          this.dataWindow = tempArray
        }

        this.dataWindow[sampleIdx] = maxValue
        sampleIdx++
      } else {
        this.dataWindow = dataArray
      }

      // Render the waveform
      if (this.wavesurfer) {
        const totalDuration = (this.dataWindow?.length ?? 0) / FPS
        const duration = this.options.scrollingWaveform ? this.options.scrollingWaveformWindow : totalDuration

        if (!hasInitialRender) {
          // First frame: full load to set up DOM structure, events, media
          this.wavesurfer
            .load('', [this.dataWindow], duration)
            .then(() => {
              if (this.wavesurfer && this.options.continuousWaveform) {
                this.wavesurfer.setTime(this.punchInTimeSec + this.getDuration() / 1000)

                if (!this.wavesurfer.options.minPxPerSec) {
                  this.wavesurfer.setOptions({
                    minPxPerSec: this.wavesurfer.getWidth() / this.wavesurfer.getDuration(),
                  })
                }
              }
              hasInitialRender = true
            })
            .catch((err) => {
              console.error('Error rendering real-time recording data:', err)
            })
        } else {
          // Subsequent frames: lightweight update — reuses canvas DOM, no events, no layout thrashing
          const currentTime = this.options.continuousWaveform
            ? this.punchInTimeSec + this.getDuration() / 1000
            : undefined
          this.wavesurfer.updatePeaks([this.dataWindow!], duration || 0, currentTime)
        }
      }
    }

    const intervalId = setInterval(drawWaveform, 1000 / FPS)

    const cleanup = () => {
      clearInterval(intervalId)

      try { source?.disconnect() } catch (_) { /* already disconnected */ }
      try { analyser?.disconnect() } catch (_) { /* already disconnected */ }

      // if the audio context was passed, don't close it
      if (!this.options.audioContext) {
        audioContext?.close()
      }
    }

    return {
      onDestroy: cleanup,
      onEnd: () => {
        this.isWaveformPaused = true
        this.stopMic()
      },
      source
    }
  }

  /** Request access to the microphone and start monitoring incoming audio */
  public async startMic(options?: RecordPluginDeviceOptions): Promise<MediaStream> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: options ?? true,
      })
    } catch (err) {
      throw new Error('Error accessing the microphone: ' + (err as Error).message)
    }

    const micStream = this.renderMicStream(stream)
    this.micStream = micStream
    this.unsubscribeDestroy = this.once('destroy', micStream.onDestroy)
    this.stream = stream
    this.source = micStream.source

    return stream
  }

  /** Activate the microphone without rendering a waveform. Used to pre-warm the mic on arm. */
  public async prewarmMic(options?: RecordPluginDeviceOptions): Promise<MediaStream> {
    if (this.stream) return this.stream

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: options ?? true,
      })
    } catch (err) {
      throw new Error('Error accessing the microphone: ' + (err as Error).message)
    }

    this.stream = stream
    return stream
  }

  /** Stop monitoring incoming audio */
  public stopMic() {
    this.micStream?.onDestroy()
    this.unsubscribeDestroy?.()
    this.micStream = null
    this.unsubscribeDestroy = undefined
    if (!this.stream) return
    this.stream.getTracks().forEach((track) => track.stop())
    this.stream = null
    this.source = null
    this.mediaRecorder = null
  }

  private padPCMToDuration(pcmData: Float32Array[], targetDuration: number): Blob {
    // Get the sample rate from the audio context
    const sampleRate = this.options.audioContext?.sampleRate || 44100
    const numChannels = pcmData.length

    // Calculate the target length in samples
    const targetLength = Math.floor(targetDuration * sampleRate)

    // Create padded PCM arrays
    const paddedPCM = pcmData.map((channel) => {
      const padded = new Float32Array(targetLength)
      padded.set(channel)
      return padded
    })

    // Convert to WAV
    const format = 1 // PCM
    const bitDepth = 16
    const bytesPerSample = bitDepth / 8
    const blockAlign = numChannels * bytesPerSample
    const byteRate = sampleRate * blockAlign
    const dataSize = targetLength * blockAlign
    const headerSize = 44
    const totalSize = headerSize + dataSize

    const wavArrayBuffer = new ArrayBuffer(totalSize)
    const view = new DataView(wavArrayBuffer)

    // RIFF identifier
    this.writeString(view, 0, 'RIFF')
    // RIFF chunk length
    view.setUint32(4, totalSize - 8, true)
    // RIFF type
    this.writeString(view, 8, 'WAVE')
    // format chunk identifier
    this.writeString(view, 12, 'fmt ')
    // format chunk length
    view.setUint32(16, 16, true)
    // sample format (raw)
    view.setUint16(20, format, true)
    // channel count
    view.setUint16(22, numChannels, true)
    // sample rate
    view.setUint32(24, sampleRate, true)
    // byte rate (sample rate * block align)
    view.setUint32(28, byteRate, true)
    // block align (channel count * bytes per sample)
    view.setUint16(32, blockAlign, true)
    // bits per sample
    view.setUint16(34, bitDepth, true)
    // data chunk identifier
    this.writeString(view, 36, 'data')
    // data chunk length
    view.setUint32(40, dataSize, true)

    // Write the PCM samples
    const offset = 44
    let pos = 0
    for (let i = 0; i < targetLength; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, paddedPCM[channel][i]))
        const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        view.setInt16(offset + pos, value, true)
        pos += 2
      }
    }

    return new Blob([wavArrayBuffer], { type: 'audio/wav' })
  }

  private convertPCMToWAV(pcmData: Float32Array[]): Blob {
    // Get the sample rate from the audio context
    const sampleRate = this.options.audioContext?.sampleRate || 44100
    const numChannels = pcmData.length

    // Use the actual length of the first channel (assuming all channels have same length)
    const actualLength = pcmData[0]?.length || 0

    // Convert to WAV
    const format = 1 // PCM
    const bitDepth = 16
    const bytesPerSample = bitDepth / 8
    const blockAlign = numChannels * bytesPerSample
    const byteRate = sampleRate * blockAlign
    const dataSize = actualLength * blockAlign
    const headerSize = 44
    const totalSize = headerSize + dataSize

    const wavArrayBuffer = new ArrayBuffer(totalSize)
    const view = new DataView(wavArrayBuffer)

    // RIFF identifier
    this.writeString(view, 0, 'RIFF')
    // RIFF chunk length
    view.setUint32(4, totalSize - 8, true)
    // RIFF type
    this.writeString(view, 8, 'WAVE')
    // format chunk identifier
    this.writeString(view, 12, 'fmt ')
    // format chunk length
    view.setUint32(16, 16, true)
    // sample format (raw)
    view.setUint16(20, format, true)
    // channel count
    view.setUint16(22, numChannels, true)
    // sample rate
    view.setUint32(24, sampleRate, true)
    // byte rate (sample rate * block align)
    view.setUint32(28, byteRate, true)
    // block align (channel count * bytes per sample)
    view.setUint16(32, blockAlign, true)
    // bits per sample
    view.setUint16(34, bitDepth, true)
    // data chunk identifier
    this.writeString(view, 36, 'data')
    // data chunk length
    view.setUint32(40, dataSize, true)

    // Write the PCM samples
    const offset = 44
    let pos = 0
    for (let i = 0; i < actualLength; i++) {
      for (let channel = 0; channel < numChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, pcmData[channel][i]))
        const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        view.setInt16(offset + pos, value, true)
        pos += 2
      }
    }

    return new Blob([wavArrayBuffer], { type: 'audio/wav' })
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i))
    }
  }

  private getDownloadLink(blob: Blob, filename: string, omitLinkLabel = false) {
    const name = filename || 'output.wav';
    const url = (window.URL || window.webkitURL).createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = name;
    if (!omitLinkLabel) {
      link.textContent = name;
    }
    return link;
  };

  private forceDownload(blob: Blob, filename: string) {
    const link = this.getDownloadLink(blob, filename, true);
    //NOTE: FireFox requires a MouseEvent (in Chrome a simple Event would do the trick)
    const click = document.createEvent('MouseEvent');
    click.initMouseEvent(
      'click',
      true,
      true,
      window,
      0,
      0,
      0,
      0,
      0,
      false,
      false,
      false,
      false,
      0,
      null
    );
    link.dispatchEvent(click);
  };

  /** Start recording audio from the microphone */
  public async startRecording(options?: RecordPluginDeviceOptions) {
    const stream = this.stream || (await this.startMic(options))

    // Clean up old micStream rendering (interval, source, analyser) but keep the stream alive
    if (this.micStream) {
      this.micStream.onDestroy()
      this.unsubscribeDestroy?.()
      this.micStream = null
      this.unsubscribeDestroy = undefined
    }

    // Create fresh rendering for this recording (new source, analyser, sampleIdx closure)
    const micStream = this.renderMicStream(stream)
    this.micStream = micStream
    this.unsubscribeDestroy = this.once('destroy', micStream.onDestroy)
    this.source = micStream.source

    // Reset PCM chunks for the new recording
    this.recordedChunksPCM = []
    const generation = ++this.recordingGeneration

    this.dataWindow = null
    const mediaRecorder =
      this.mediaRecorder ||
      new MediaRecorder(stream, {
        mimeType: this.options.mimeType || findSupportedMimeType(),
        audioBitsPerSecond: this.options.audioBitsPerSecond,
      })
    this.mediaRecorder = mediaRecorder
    this.stopRecording()

    const recordedChunks: BlobPart[] = [] // this is the mediaRecorder data (COMPRESSED)

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data)
      }
      this.emit('record-data-available', event.data)
    }

    const emitWithBlob = (ev: 'record-pause' | 'record-end') => {
      // Skip if a new recording has started (stale onstop from previous recording)
      if (generation !== this.recordingGeneration) return

      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType })
      this.emit(ev, blob)
      if (this.options.renderRecordedAudio) {
        this.applyOriginalOptionsIfNeeded()
        this.processPcmData()
      }
    }

    mediaRecorder.onpause = () => emitWithBlob('record-pause')

    mediaRecorder.onstop = () => emitWithBlob('record-end')

    mediaRecorder.start(this.options.mediaRecorderTimeslice)
    this.lastStartTime = performance.now()
    this.lastDuration = 0
    this.duration = 0
    this.isWaveformPaused = false
    this.timer.start()

    this.emit('record-start')
  }

  /** Get the duration of the recording */
  public getDuration(): number {
    return this.duration
  }

  /** Check if the audio is being recorded */
  public isRecording(): boolean {
    return this.mediaRecorder?.state === 'recording'
  }

  public isPaused(): boolean {
    return this.mediaRecorder?.state === 'paused'
  }

  public isActive(): boolean {
    return this.mediaRecorder?.state !== 'inactive'
  }

  /** Stop the recording */
  public stopRecording() {
    if (this.isActive()) {
      this.isWaveformPaused = true
      this.mediaRecorder?.stop()
      this.timer.stop()
    }
  }

  /** Pause the recording */
  public pauseRecording() {
    if (this.isRecording()) {
      this.isWaveformPaused = true
      this.mediaRecorder?.requestData()
      this.mediaRecorder?.pause()
      this.timer.stop()
      this.lastDuration = this.duration
    }
  }

  /** Resume the recording */
  public resumeRecording() {
    if (this.isPaused()) {
      this.isWaveformPaused = false
      this.mediaRecorder?.resume()
      this.timer.start()
      this.lastStartTime = performance.now()
      this.emit('record-resume')
    }
  }

  // ── Punch-in recording API ──────────────────────────────────────

  public setPunchInPosition(cursorTimeSec: number) {
    const sampleRate = this.options.audioContext?.sampleRate || this.pcmSampleRate
    this.punchInSample = Math.round(cursorTimeSec * sampleRate)
    this.punchInTimeSec = cursorTimeSec
    if (this.hasOriginalPcm()) {
      // Use the original PCM with edits applied
      this.existingAudioForPunchIn = this.computeEffectiveAudio()
    } else if (this.wavesurfer) {
      // No originalPcm (audio loaded from file, not from a recording) —
      // grab whatever is currently in the WaveSurfer decoded buffer
      const decodedData = this.wavesurfer.getDecodedData()
      if (decodedData) {
        const channels: Float32Array[] = []
        for (let i = 0; i < decodedData.numberOfChannels; i++) {
          channels.push(new Float32Array(decodedData.getChannelData(i)))
        }
        this.existingAudioForPunchIn = channels
      } else {
        this.existingAudioForPunchIn = null
      }
    } else {
      this.existingAudioForPunchIn = null
    }
  }

  /** Merge accumulated PCM chunks into per-channel Float32Arrays, de-interleaving stereo if needed. */
  private mergePcmChunks(): Float32Array[] {
    const totalLength = this.recordedChunksPCM.reduce((sum, arr) => sum + arr.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const chunk of this.recordedChunksPCM) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    const channels = this.recordingChannels
    if (channels > 1) {
      const frameCount = Math.floor(merged.length / channels)
      const result: Float32Array[] = []
      for (let ch = 0; ch < channels; ch++) {
        result.push(new Float32Array(frameCount))
      }
      for (let i = 0; i < frameCount; i++) {
        for (let ch = 0; ch < channels; ch++) {
          result[ch][i] = merged[i * channels + ch]
        }
      }
      return result
    }

    return [merged]
  }

  /** Process accumulated PCM data after recording stops: merge, stitch punch-in, store, and reload waveform. */
  private processPcmData() {
    if (this.recordedChunksPCM.length === 0) return

    const rawRecordedPcm = this.mergePcmChunks()
    this.recordedChunksPCM = []

    const hadEdits = this.edits.length > 0
    const wasFirstRecording = !this.originalPcm && !this.existingAudioForPunchIn
    const punchInSample = this.punchInSample ?? 0

    // Extract overwritten segment (what the recording replaces)
    let overwrittenPcm: Float32Array[] | null = null
    if (this.existingAudioForPunchIn) {
      const recLen = rawRecordedPcm[0].length
      overwrittenPcm = this.existingAudioForPunchIn.map((ch) => {
        const start = Math.min(punchInSample, ch.length)
        const end = Math.min(punchInSample + recLen, ch.length)
        return end > start ? ch.slice(start, end) : new Float32Array(0)
      })
    }
    const overwrittenLength = overwrittenPcm?.[0]?.length ?? 0

    const startTime = this.punchInTimeSec
    const sampleRate = this.options.audioContext?.sampleRate || 44100

    let finalPcm: Float32Array[]
    if (this.punchInSample !== null) {
      finalPcm = this.stitchPunchIn(rawRecordedPcm)
      this.punchInSample = null
      this.punchInTimeSec = 0
      this.existingAudioForPunchIn = null
    } else {
      finalPcm = rawRecordedPcm
    }

    this.originalPcm = finalPcm
    this.pcmSampleRate = sampleRate
    this.edits = []

    const endTime = startTime + (finalPcm[0].length / sampleRate)
    this.emit('record-pcm-data' as any, {
      pcm: finalPcm, startTime, endTime,
      recordedPcm: rawRecordedPcm, punchInSample,
      overwrittenPcm, overwrittenLength,
      wasFirstRecording, hadEdits,
    })

    this.wavesurfer?.loadPcm(finalPcm, sampleRate)
  }

  /** Undo a recording by unsplicing the recorded delta from originalPcm. */
  public undoRecording(opts: {
    recordedPcm: Float32Array[]
    punchInSample: number
    overwrittenPcm: Float32Array[] | null
    overwrittenLength: number
    wasFirstRecording: boolean
  }) {
    if (opts.wasFirstRecording) {
      this.originalPcm = null
      this.pcmSampleRate = 0
      this.edits = []
      if (this.wavesurfer) {
        this.wavesurfer.clear()
      }
      return
    }

    if (!this.originalPcm) return

    const { recordedPcm, punchInSample, overwrittenPcm, overwrittenLength } = opts
    const recLen = recordedPcm[0].length

    // Unsplice: remove the recorded segment and re-insert overwritten data
    this.originalPcm = this.originalPcm.map((channel, ch) => {
      const overwrittenCh = overwrittenPcm?.[ch] ?? null
      const overLen = overwrittenCh?.length ?? 0
      // Before the punch-in: keep as-is
      const pre = channel.subarray(0, punchInSample)
      // After the recorded segment: everything past punchIn + recLen
      const postStart = punchInSample + recLen
      const post = postStart < channel.length ? channel.subarray(postStart) : new Float32Array(0)
      // Build new buffer: pre + overwritten + post
      const newLen = punchInSample + overLen + post.length
      const result = new Float32Array(newLen)
      result.set(pre, 0)
      if (overwrittenCh && overLen > 0) {
        result.set(overwrittenCh, punchInSample)
      }
      result.set(post, punchInSample + overLen)
      return result
    })

    this.edits = []
    this.recomputeAndReload()
  }

  /** Redo a recording by re-splicing the recorded delta into originalPcm. */
  public redoRecording(opts: {
    recordedPcm: Float32Array[]
    punchInSample: number
    overwrittenLength: number
    wasFirstRecording: boolean
  }) {
    const { recordedPcm, punchInSample, overwrittenLength, wasFirstRecording } = opts
    const sampleRate = this.pcmSampleRate || this.options.audioContext?.sampleRate || 44100

    if (wasFirstRecording) {
      this.originalPcm = recordedPcm.map((ch) => new Float32Array(ch))
      this.pcmSampleRate = sampleRate
      this.edits = []
      // Use loadPcm directly instead of recomputeAndReload — no edits to apply,
      // and the wavesurfer may not be fully rendered yet (e.g. track just re-created
      // via addTrack redo), which causes recomputeAndReload's zoom() to throw.
      this.wavesurfer?.loadPcm(this.originalPcm, sampleRate)
      return
    }

    if (!this.originalPcm) return

    const recLen = recordedPcm[0].length

    // Splice: replace overwrittenLength samples at punchInSample with recordedPcm
    this.originalPcm = this.originalPcm.map((channel, ch) => {
      const recCh = ch < recordedPcm.length ? recordedPcm[ch] : recordedPcm[0]
      const pre = channel.subarray(0, punchInSample)
      const postStart = punchInSample + overwrittenLength
      const post = postStart < channel.length ? channel.subarray(postStart) : new Float32Array(0)
      const newLen = punchInSample + recLen + post.length
      const result = new Float32Array(newLen)
      result.set(pre, 0)
      result.set(recCh, punchInSample)
      result.set(post, punchInSample + recLen)
      return result
    })

    this.edits = []
    // Use loadPcm directly — edits are cleared so computeEffectiveAudio is a no-op copy,
    // and the wavesurfer may not support zoom() yet if the track was just re-created.
    this.wavesurfer?.loadPcm(this.originalPcm, sampleRate)
  }

  private stitchPunchIn(newPcm: Float32Array[]): Float32Array[] {
    if (this.punchInSample === null) return newPcm

    const punchIn = this.punchInSample
    const existing = this.existingAudioForPunchIn

    return newPcm.map((newChannel, ch) => {
      const existingChannel = existing?.[ch] || null
      const existingLen = existingChannel?.length || 0
      const newLen = newChannel.length

      // post = existing audio after the punch-out point
      const postStart = punchIn + newLen
      const postLen = existingLen > postStart ? existingLen - postStart : 0

      const totalLen = punchIn + newLen + postLen
      const result = new Float32Array(totalLen)

      // Copy pre segment from existing (or leave as silence zeros)
      if (existingChannel) {
        const preLen = Math.min(punchIn, existingLen)
        if (preLen > 0) {
          result.set(existingChannel.subarray(0, preLen), 0)
        }
      }

      // Copy new recorded audio at punch-in position
      result.set(newChannel, punchIn)

      // Copy post segment from existing
      if (postLen > 0 && existingChannel) {
        result.set(existingChannel.subarray(postStart), punchIn + newLen)
      }

      return result
    })
  }

  // ── Non-destructive editing API ──────────────────────────────────

  public hasOriginalPcm(): boolean {
    return this.originalPcm !== null
  }

  public getOriginalPcm(): Float32Array[] | null {
    return this.originalPcm
  }

  /** Get the pre-recording audio snapshot (captured before live waveform overwrites it). */
  public getPreRecordingData(): { channelData: Float32Array[]; sampleRate: number } | null {
    return this.preRecordingData
  }

  /** Clear the pre-recording snapshot (called after history entry is created). */
  public clearPreRecordingData(): void {
    this.preRecordingData = null
  }

  public getSampleRate(): number {
    return this.pcmSampleRate
  }

  public getEdits(): AudioEdit[] {
    return this.edits
  }

  public importOriginalPcm(pcm: Float32Array[], sampleRate: number) {
    this.originalPcm = pcm
    this.pcmSampleRate = sampleRate
    this.edits = []
  }

  /** Clear originalPcm and edits (e.g. when undoing the first recording on a track). */
  public clearOriginalPcm() {
    this.originalPcm = null
    this.pcmSampleRate = 0
    this.edits = []
  }

  public importEdits(edits: AudioEdit[]) {
    this.edits = edits
    this.recomputeAndReload()
  }

  /** Set edits without triggering recomputeAndReload. Used when wavesurfer
   *  already has the correct rendered audio (e.g. loaded via P2P sync). */
  public setEdits(edits: AudioEdit[]) {
    this.edits = edits
  }

  /** Delete a region by edited-time coordinates (local user). Returns edit data for history. */
  public deleteRegion(startTime: number, endTime: number): { id: string; startSample: number; endSample: number; startTime: number; endTime: number } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = { id, type: 'delete', startSample: startOriginal, endSample: endOriginal, startTime, endTime }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime }
  }

  /** Delete a region by original PCM sample coordinates (from peer). */
  public deleteRegionByOriginalSamples(startSample: number, endSample: number, editId?: string, startTime?: number, endTime?: number) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = { id, type: 'delete', startSample, endSample, startTime: st, endTime: et }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Amplify a region by edited-time coordinates (local user). Returns edit data for history. */
  public amplifyRegion(startTime: number, endTime: number, gainDb: number): { id: string; startSample: number; endSample: number; startTime: number; endTime: number; gain: number } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = { id, type: 'amplify', startSample: startOriginal, endSample: endOriginal, startTime, endTime, gain: gainDb }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime, gain: gainDb }
  }

  /** Amplify a region by original PCM sample coordinates (from peer). */
  public amplifyRegionByOriginalSamples(startSample: number, endSample: number, gainDb: number, editId?: string, startTime?: number, endTime?: number) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = { id, type: 'amplify', startSample, endSample, startTime: st, endTime: et, gain: gainDb }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Apply limiter to a region (local path — times in edited space). */
  public limiterRegion(
    startTime: number,
    endTime: number,
    params: { threshold: number; makeupTarget: number; kneeWidth: number; lookaheadMs: number; releaseMs: number },
  ): { id: string; startSample: number; endSample: number; startTime: number; endTime: number; threshold: number; makeupTarget: number; kneeWidth: number; lookaheadMs: number; releaseMs: number } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = {
      id,
      type: 'limiter',
      startSample: startOriginal,
      endSample: endOriginal,
      startTime,
      endTime,
      threshold: params.threshold,
      makeupTarget: params.makeupTarget,
      kneeWidth: params.kneeWidth,
      lookaheadMs: params.lookaheadMs,
      releaseMs: params.releaseMs,
    }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime, ...params }
  }

  /** Apply limiter to a region by original PCM sample coordinates (from peer). */
  public limiterRegionByOriginalSamples(
    startSample: number,
    endSample: number,
    params: { threshold: number; makeupTarget: number; kneeWidth: number; lookaheadMs: number; releaseMs: number },
    editId?: string,
    startTime?: number,
    endTime?: number,
  ) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = {
      id,
      type: 'limiter',
      startSample,
      endSample,
      startTime: st,
      endTime: et,
      threshold: params.threshold,
      makeupTarget: params.makeupTarget,
      kneeWidth: params.kneeWidth,
      lookaheadMs: params.lookaheadMs,
      releaseMs: params.releaseMs,
    }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Apply compressor to a region (local path — times in edited space). */
  public compressorRegion(
    startTime: number,
    endTime: number,
    params: { threshold: number; ratio: number; makeupGainDb: number; kneeWidth: number; lookaheadMs: number; attackMs: number; releaseMs: number },
  ): { id: string; startSample: number; endSample: number; startTime: number; endTime: number; threshold: number; ratio: number; makeupGainDb: number; kneeWidth: number; lookaheadMs: number; attackMs: number; releaseMs: number } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = {
      id,
      type: 'compressor',
      startSample: startOriginal,
      endSample: endOriginal,
      startTime,
      endTime,
      threshold: params.threshold,
      ratio: params.ratio,
      makeupGainDb: params.makeupGainDb,
      kneeWidth: params.kneeWidth,
      lookaheadMs: params.lookaheadMs,
      attackMs: params.attackMs,
      releaseMs: params.releaseMs,
    }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime, ...params }
  }

  /** Apply compressor to a region by original PCM sample coordinates (from peer). */
  public compressorRegionByOriginalSamples(
    startSample: number,
    endSample: number,
    params: { threshold: number; ratio: number; makeupGainDb: number; kneeWidth: number; lookaheadMs: number; attackMs: number; releaseMs: number },
    editId?: string,
    startTime?: number,
    endTime?: number,
  ) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = {
      id,
      type: 'compressor',
      startSample,
      endSample,
      startTime: st,
      endTime: et,
      threshold: params.threshold,
      ratio: params.ratio,
      makeupGainDb: params.makeupGainDb,
      kneeWidth: params.kneeWidth,
      lookaheadMs: params.lookaheadMs,
      attackMs: params.attackMs,
      releaseMs: params.releaseMs,
    }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Change pitch of a region (local path — times in edited space). */
  public changePitchRegion(
    startTime: number,
    endTime: number,
    semitones: number,
    highQuality?: boolean,
  ): { id: string; startSample: number; endSample: number; startTime: number; endTime: number; semitones: number; highQuality: boolean } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const hq = highQuality ?? false
    const edit: AudioEdit = {
      id,
      type: 'changePitch',
      startSample: startOriginal,
      endSample: endOriginal,
      startTime,
      endTime,
      semitones,
      highQuality: hq,
    }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime, semitones, highQuality: hq }
  }

  /** Change pitch of a region by original PCM sample coordinates (from peer). */
  public changePitchRegionByOriginalSamples(
    startSample: number,
    endSample: number,
    semitones: number,
    highQuality?: boolean,
    editId?: string,
    startTime?: number,
    endTime?: number,
  ) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const hq = highQuality ?? false
    const edit: AudioEdit = {
      id,
      type: 'changePitch',
      startSample,
      endSample,
      startTime: st,
      endTime: et,
      semitones,
      highQuality: hq,
    }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Reverse a region (local path — times in edited space). */
  public reverseRegion(
    startTime: number,
    endTime: number,
  ): { id: string; startSample: number; endSample: number; startTime: number; endTime: number } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = { id, type: 'reverse', startSample: startOriginal, endSample: endOriginal, startTime, endTime }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime }
  }

  /** Reverse a region by original PCM sample coordinates (from peer). */
  public reverseRegionByOriginalSamples(startSample: number, endSample: number, editId?: string, startTime?: number, endTime?: number) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = { id, type: 'reverse', startSample, endSample, startTime: st, endTime: et }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Apply fade-in to a region (local path — times in edited space). */
  public fadeInRegion(
    startTime: number,
    endTime: number,
    curve: 'linear' | 'exponential' = 'linear',
  ): { id: string; startSample: number; endSample: number; startTime: number; endTime: number; curve: string } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = { id, type: 'fadeIn', startSample: startOriginal, endSample: endOriginal, startTime, endTime, curve }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime, curve }
  }

  /** Apply fade-in to a region by original PCM sample coordinates (from peer). */
  public fadeInRegionByOriginalSamples(startSample: number, endSample: number, curve: 'linear' | 'exponential', editId?: string, startTime?: number, endTime?: number) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = { id, type: 'fadeIn', startSample, endSample, startTime: st, endTime: et, curve }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Apply fade-out to a region (local path — times in edited space). */
  public fadeOutRegion(
    startTime: number,
    endTime: number,
    curve: 'linear' | 'exponential' = 'linear',
  ): { id: string; startSample: number; endSample: number; startTime: number; endTime: number; curve: string } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = { id, type: 'fadeOut', startSample: startOriginal, endSample: endOriginal, startTime, endTime, curve }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime, curve }
  }

  /** Apply fade-out to a region by original PCM sample coordinates (from peer). */
  public fadeOutRegionByOriginalSamples(startSample: number, endSample: number, curve: 'linear' | 'exponential', editId?: string, startTime?: number, endTime?: number) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = { id, type: 'fadeOut', startSample, endSample, startTime: st, endTime: et, curve }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Normalize a region (local path — times in edited space). */
  public normalizeRegion(
    startTime: number,
    endTime: number,
    targetDb: number = -0.1,
  ): { id: string; startSample: number; endSample: number; startTime: number; endTime: number; targetDb: number } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)

    const id = crypto.randomUUID()
    const edit: AudioEdit = { id, type: 'normalize', startSample: startOriginal, endSample: endOriginal, startTime, endTime, targetDb }
    this.edits.push(edit)
    this.recomputeAndReload()

    return { id, startSample: startOriginal, endSample: endOriginal, startTime, endTime, targetDb }
  }

  /** Normalize a region by original PCM sample coordinates (from peer). */
  public normalizeRegionByOriginalSamples(startSample: number, endSample: number, targetDb: number, editId?: string, startTime?: number, endTime?: number) {
    const id = editId || crypto.randomUUID()
    const st = startTime ?? startSample / this.pcmSampleRate
    const et = endTime ?? endSample / this.pcmSampleRate
    const edit: AudioEdit = { id, type: 'normalize', startSample, endSample, startTime: st, endTime: et, targetDb }
    this.edits.push(edit)
    this.recomputeAndReload()
  }

  /** Restore (undo) an edit by its ID. Returns the removed edit data or null. */
  public restoreEdit(editId: string): AudioEdit | null {
    const idx = this.edits.findIndex((e) => e.id === editId)
    if (idx === -1) return null
    const [removed] = this.edits.splice(idx, 1)
    this.recomputeAndReload()
    return removed
  }

  /** Restore multiple edits at once (single recompute). Returns removed edits. */
  public restoreEdits(editIds: string[]): AudioEdit[] {
    const removed: AudioEdit[] = []
    for (const editId of editIds) {
      const idx = this.edits.findIndex((e) => e.id === editId)
      if (idx !== -1) {
        removed.push(...this.edits.splice(idx, 1))
      }
    }
    if (removed.length > 0) {
      this.recomputeAndReload()
    }
    return removed
  }

  /** Trim: keep only the selected region, delete everything before and after (local path). */
  public trimRegion(startTime: number, endTime: number): {
    editIds: string[]
    startSample: number
    endSample: number
    startTime: number
    endTime: number
    deleteEdits: { id: string; startSample: number; endSample: number; startTime: number; endTime: number }[]
  } | null {
    if (!this.originalPcm) return null

    const startEdited = Math.floor(startTime * this.pcmSampleRate)
    const endEdited = Math.ceil(endTime * this.pcmSampleRate)
    const startOriginal = this.editedToOriginal(startEdited)
    const endOriginal = this.editedToOriginal(endEdited)
    const totalLength = this.originalPcm[0].length

    const deleteEdits: { id: string; startSample: number; endSample: number; startTime: number; endTime: number }[] = []
    const editIds: string[] = []

    // Delete everything before the selection
    if (startOriginal > 0) {
      const id = crypto.randomUUID()
      const edit: AudioEdit = { id, type: 'delete', startSample: 0, endSample: startOriginal, startTime: 0, endTime: startTime }
      this.edits.push(edit)
      editIds.push(id)
      deleteEdits.push({ id, startSample: 0, endSample: startOriginal, startTime: 0, endTime: startTime })
    }

    // Delete everything after the selection
    if (endOriginal < totalLength) {
      const id = crypto.randomUUID()
      const edit: AudioEdit = { id, type: 'delete', startSample: endOriginal, endSample: totalLength, startTime: endTime, endTime: totalLength / this.pcmSampleRate }
      this.edits.push(edit)
      editIds.push(id)
      deleteEdits.push({ id, startSample: endOriginal, endSample: totalLength, startTime: endTime, endTime: totalLength / this.pcmSampleRate })
    }

    if (editIds.length === 0) return null // selection already covers everything

    this.recomputeAndReload()

    return { editIds, startSample: startOriginal, endSample: endOriginal, startTime, endTime, deleteEdits }
  }

  /** Trim by original PCM sample coordinates (from peer). */
  public trimRegionByOriginalSamples(
    deleteEdits: { id: string; startSample: number; endSample: number; startTime: number; endTime: number }[],
  ) {
    for (const de of deleteEdits) {
      const edit: AudioEdit = { id: de.id, type: 'delete', startSample: de.startSample, endSample: de.endSample, startTime: de.startTime, endTime: de.endTime }
      this.edits.push(edit)
    }
    this.recomputeAndReload()
  }

  /**
   * Insert PCM data into originalPcm at a given sample position (original-space).
   * Shifts all existing edits whose startSample >= insertSample by the inserted length.
   * Returns metadata for history.
   */
  public insertIntoOriginalPcm(
    insertSample: number,
    pcm: Float32Array[],
  ): { id: string; insertSample: number; length: number } | null {
    if (!this.originalPcm) return null

    const id = crypto.randomUUID()
    const insertLength = pcm[0].length
    const origChannels = this.originalPcm.length
    const insertChannels = pcm.length

    // Build new originalPcm with inserted data
    this.originalPcm = this.originalPcm.map((channel, ch) => {
      // Handle channel count mismatch: duplicate mono to stereo, or take first channel
      let insertData: Float32Array
      if (ch < insertChannels) {
        insertData = pcm[ch]
      } else {
        insertData = pcm[0] // duplicate first channel
      }

      const newBuf = new Float32Array(channel.length + insertLength)
      // Clamp insertSample to valid range
      const clampedInsert = Math.min(insertSample, channel.length)
      newBuf.set(channel.subarray(0, clampedInsert), 0)
      newBuf.set(insertData, clampedInsert)
      newBuf.set(channel.subarray(clampedInsert), clampedInsert + insertLength)
      return newBuf
    })

    // Shift existing edits past the insert point
    for (const edit of this.edits) {
      if (edit.startSample >= insertSample) {
        edit.startSample += insertLength
        edit.endSample += insertLength
        edit.startTime = edit.startSample / this.pcmSampleRate
        edit.endTime = edit.endSample / this.pcmSampleRate
      } else if (edit.endSample > insertSample) {
        // Edit spans the insert point — extend its end
        edit.endSample += insertLength
        edit.endTime = edit.endSample / this.pcmSampleRate
      }
    }

    this.recomputeAndReload()
    return { id, insertSample, length: insertLength }
  }

  /**
   * Remove samples from originalPcm (inverse of insertIntoOriginalPcm for undo).
   * Un-shifts existing edits that were shifted during insert.
   */
  public removeFromOriginalPcm(startSample: number, length: number) {
    if (!this.originalPcm) return

    this.originalPcm = this.originalPcm.map((channel) => {
      const clampedStart = Math.min(startSample, channel.length)
      const clampedEnd = Math.min(clampedStart + length, channel.length)
      const newBuf = new Float32Array(channel.length - (clampedEnd - clampedStart))
      newBuf.set(channel.subarray(0, clampedStart), 0)
      newBuf.set(channel.subarray(clampedEnd), clampedStart)
      return newBuf
    })

    // Un-shift existing edits
    for (const edit of this.edits) {
      if (edit.startSample >= startSample + length) {
        edit.startSample -= length
        edit.endSample -= length
        edit.startTime = edit.startSample / this.pcmSampleRate
        edit.endTime = edit.endSample / this.pcmSampleRate
      } else if (edit.startSample >= startSample) {
        // Edit was inside the removed range — this shouldn't normally happen
        // during undo, but handle gracefully
        edit.startSample = startSample
        edit.endSample = Math.max(startSample, edit.endSample - length)
        edit.startTime = edit.startSample / this.pcmSampleRate
        edit.endTime = edit.endSample / this.pcmSampleRate
      } else if (edit.endSample > startSample) {
        // Edit spans the removal point — shrink its end
        edit.endSample = Math.max(edit.startSample, edit.endSample - length)
        edit.endTime = edit.endSample / this.pcmSampleRate
      }
    }

    this.recomputeAndReload()
  }

  public recomputeAndReload() {
    if (!this.originalPcm || !this.wavesurfer) return

    this.emit('processing-start' as any)

    const effectivePcm = this.computeEffectiveAudio()
    if (effectivePcm[0].length > 0) {
      // Preserve cursor position, zoom, and scroll across reload
      const currentTime = this.wavesurfer.getCurrentTime()
      const scrollLeft = this.wavesurfer.getScroll()
      const minPxPerSec = this.wavesurfer.options.minPxPerSec || 0

      const sampleRate = this.pcmSampleRate || this.options.audioContext?.sampleRate || 44100
      this.isReloading = true
      this.wavesurfer.loadPcm(effectivePcm, sampleRate).then(() => {
        if (!this.wavesurfer) {
          this.isReloading = false
          this.emit('processing-end' as any)
          return
        }
        if (minPxPerSec) {
          this.wavesurfer.zoom(minPxPerSec)
        }
        this.wavesurfer.setTime(currentTime)
        this.wavesurfer.setScroll(scrollLeft)
        this.isReloading = false
        this.emit('processing-end' as any)
      })
    } else {
      this.wavesurfer.empty()
      this.emit('processing-end' as any)
    }
  }

  public editedToOriginal(editedSample: number): number {
    const ranges = this.mergeOverlappingRanges()
    let offset = 0

    for (const range of ranges) {
      const editedCutPoint = range.startSample - offset
      if (editedSample < editedCutPoint) break
      offset += range.endSample - range.startSample
    }

    return editedSample + offset
  }

  /** Map an original-space sample index to effective-space (after deletes). Returns -1 if inside a deleted range. */
  private originalToEffective(originalSample: number, deleteRanges: SampleRange[], originalLength: number): number {
    let offset = 0
    for (const range of deleteRanges) {
      const start = Math.max(0, Math.min(range.startSample, originalLength))
      const end = Math.max(0, Math.min(range.endSample, originalLength))
      if (originalSample < start) break
      if (originalSample < end) return -1 // inside a deleted range
      offset += end - start
    }
    return originalSample - offset
  }

  private computeEffectiveAudio(): Float32Array[] {
    if (!this.originalPcm) return []
    const deleteRanges = this.mergeOverlappingRanges()
    const amplifyEdits = this.edits.filter((e) => e.type === 'amplify' && e.gain !== undefined)
    const originalLength = this.originalPcm[0].length

    // Apply deletes
    let result: Float32Array[]
    if (deleteRanges.length === 0) {
      result = this.originalPcm.map((ch) => new Float32Array(ch))
    } else {
      let totalDeleted = 0
      for (const range of deleteRanges) {
        const start = Math.max(0, Math.min(range.startSample, originalLength))
        const end = Math.max(0, Math.min(range.endSample, originalLength))
        totalDeleted += end - start
      }

      const newLength = originalLength - totalDeleted
      if (newLength <= 0) {
        return this.originalPcm.map(() => new Float32Array(0))
      }

      result = this.originalPcm.map((channel) => {
        const buf = new Float32Array(newLength)
        let writePos = 0
        let readPos = 0

        for (const range of deleteRanges) {
          const start = Math.max(0, Math.min(range.startSample, originalLength))
          const end = Math.max(0, Math.min(range.endSample, originalLength))

          if (readPos < start) {
            buf.set(channel.subarray(readPos, start), writePos)
            writePos += start - readPos
          }
          readPos = end
        }

        if (readPos < originalLength) {
          buf.set(channel.subarray(readPos), writePos)
        }

        return buf
      })
    }

    // Apply amplify edits
    if (amplifyEdits.length > 0) {
      for (const edit of amplifyEdits) {
        const factor = Math.pow(10, (edit.gain ?? 0) / 20)
        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))
        for (let ch = 0; ch < result.length; ch++) {
          for (let i = start; i < end; i++) {
            result[ch][i] *= factor
          }
        }
      }
    }

    // Apply limiter edits
    const limiterEdits = this.edits.filter((e) => e.type === 'limiter')
    if (limiterEdits.length > 0) {
      for (const edit of limiterEdits) {
        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))

        const threshold = edit.threshold ?? -5
        const makeupTarget = edit.makeupTarget ?? -1
        const kneeWidth = edit.kneeWidth ?? 2
        const lookaheadMs = edit.lookaheadMs ?? 1
        const releaseMs = edit.releaseMs ?? 20
        const halfKnee = kneeWidth / 2
        const lookaheadSamples = Math.max(0, Math.round((lookaheadMs / 1000) * this.pcmSampleRate))
        const releaseCoeff = releaseMs > 0 ? Math.exp(-1 / ((releaseMs / 1000) * this.pcmSampleRate)) : 0
        const makeupGainLinear = Math.pow(10, (makeupTarget - threshold) / 20)

        for (let ch = 0; ch < result.length; ch++) {
          const data = result[ch]
          const regionLen = end - start
          const gainReductionDb = new Float32Array(regionLen)

          // Pass 1: compute per-sample gain reduction
          for (let i = 0; i < regionLen; i++) {
            const sample = Math.abs(data[start + i])
            const inputDb = sample > 0 ? 20 * Math.log10(sample) : -120
            let outputDb: number
            if (inputDb <= threshold - halfKnee) {
              outputDb = inputDb
            } else if (inputDb >= threshold + halfKnee) {
              outputDb = threshold
            } else {
              const x = inputDb - threshold + halfKnee
              outputDb = inputDb - (x * x) / (2 * kneeWidth)
            }
            gainReductionDb[i] = outputDb - inputDb
          }

          // Pass 2: lookahead
          if (lookaheadSamples > 0) {
            const smoothed = new Float32Array(regionLen)
            for (let i = 0; i < regionLen; i++) {
              let minGr = gainReductionDb[i]
              const lookEnd = Math.min(regionLen, i + lookaheadSamples)
              for (let j = i + 1; j < lookEnd; j++) {
                if (gainReductionDb[j] < minGr) minGr = gainReductionDb[j]
              }
              smoothed[i] = minGr
            }
            gainReductionDb.set(smoothed)
          }

          // Pass 3: release envelope
          let envelopeDb = 0
          for (let i = 0; i < regionLen; i++) {
            const target = gainReductionDb[i]
            if (target < envelopeDb) {
              envelopeDb = target
            } else {
              envelopeDb = target + releaseCoeff * (envelopeDb - target)
            }
            gainReductionDb[i] = envelopeDb
          }

          // Pass 4: apply
          for (let i = 0; i < regionLen; i++) {
            const grLinear = Math.pow(10, gainReductionDb[i] / 20)
            data[start + i] *= grLinear * makeupGainLinear
          }
        }
      }
    }

    // Apply compressor edits
    const compressorEdits = this.edits.filter((e) => e.type === 'compressor')
    if (compressorEdits.length > 0) {
      for (const edit of compressorEdits) {
        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))

        const threshold = edit.threshold ?? -10
        const ratio = edit.ratio ?? 4
        const makeupGainDb = edit.makeupGainDb ?? 0
        const kneeWidth = edit.kneeWidth ?? 5
        const lookaheadMs = edit.lookaheadMs ?? 1
        const attackMs = edit.attackMs ?? 30
        const releaseMs = edit.releaseMs ?? 150
        const halfKnee = kneeWidth / 2
        const lookaheadSamples = Math.max(0, Math.round((lookaheadMs / 1000) * this.pcmSampleRate))
        const attackCoeff = attackMs > 0 ? Math.exp(-1 / ((attackMs / 1000) * this.pcmSampleRate)) : 0
        const releaseCoeff = releaseMs > 0 ? Math.exp(-1 / ((releaseMs / 1000) * this.pcmSampleRate)) : 0
        const makeupGainLinear = Math.pow(10, makeupGainDb / 20)

        for (let ch = 0; ch < result.length; ch++) {
          const data = result[ch]
          const regionLen = end - start
          const gainReductionDb = new Float32Array(regionLen)

          // Pass 1: compute per-sample gain reduction with ratio
          for (let i = 0; i < regionLen; i++) {
            const sample = Math.abs(data[start + i])
            const inputDb = sample > 0 ? 20 * Math.log10(sample) : -120
            let outputDb: number
            if (inputDb <= threshold - halfKnee) {
              // Below knee — no compression
              outputDb = inputDb
            } else if (inputDb >= threshold + halfKnee) {
              // Above knee — compressed by ratio
              outputDb = threshold + (inputDb - threshold) / ratio
            } else {
              // In the knee — smooth interpolation
              const x = inputDb - threshold + halfKnee
              const compressionAmount = (1 - 1 / ratio) * (x * x) / (2 * kneeWidth)
              outputDb = inputDb - compressionAmount
            }
            gainReductionDb[i] = outputDb - inputDb
          }

          // Pass 2: lookahead
          if (lookaheadSamples > 0) {
            const smoothed = new Float32Array(regionLen)
            for (let i = 0; i < regionLen; i++) {
              let minGr = gainReductionDb[i]
              const lookEnd = Math.min(regionLen, i + lookaheadSamples)
              for (let j = i + 1; j < lookEnd; j++) {
                if (gainReductionDb[j] < minGr) minGr = gainReductionDb[j]
              }
              smoothed[i] = minGr
            }
            gainReductionDb.set(smoothed)
          }

          // Pass 3: attack/release envelope
          let envelopeDb = 0
          for (let i = 0; i < regionLen; i++) {
            const target = gainReductionDb[i]
            if (target < envelopeDb) {
              // Attack: smoothly increase gain reduction
              envelopeDb = target + attackCoeff * (envelopeDb - target)
            } else {
              // Release: smoothly decrease gain reduction
              envelopeDb = target + releaseCoeff * (envelopeDb - target)
            }
            gainReductionDb[i] = envelopeDb
          }

          // Pass 4: apply gain reduction + make-up gain
          for (let i = 0; i < regionLen; i++) {
            const grLinear = Math.pow(10, gainReductionDb[i] / 20)
            data[start + i] *= grLinear * makeupGainLinear
          }
        }
      }
    }

    // Apply changePitch edits — resample then WSOLA time-stretch
    const changePitchEdits = this.edits.filter((e) => e.type === 'changePitch')
    if (changePitchEdits.length > 0) {
      for (const edit of changePitchEdits) {
        const semitones = edit.semitones ?? 0
        if (semitones === 0) continue

        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))
        const regionLen = end - start
        if (regionLen <= 0) continue

        const ratio = Math.pow(2, semitones / 12)
        const highQuality = edit.highQuality ?? false

        // WSOLA parameters (based on SoundTouch defaults, scaled to sample rate)
        const sr = this.pcmSampleRate
        const seqLenSamples = Math.round((highQuality ? 0.082 : 0.060) * sr)  // sequence length
        const seekWindowSamples = Math.round((highQuality ? 0.028 : 0.015) * sr) // seek tolerance
        const overlapSamples = Math.round((highQuality ? 0.012 : 0.008) * sr) // crossfade length

        for (let ch = 0; ch < result.length; ch++) {
          const data = result[ch]
          // Copy the region (we need an independent copy since we'll overwrite data)
          const region = new Float32Array(regionLen)
          region.set(data.subarray(start, end))

          // Step 1: Resample by 1/ratio — shifts pitch AND changes duration
          // Pitch UP (ratio>1): read faster → shorter. Pitch DOWN (ratio<1): read slower → longer
          const resampledLen = Math.max(1, Math.round(regionLen / ratio))
          const resampled = new Float32Array(resampledLen)
          for (let i = 0; i < resampledLen; i++) {
            const srcPos = i * ratio
            const srcIdx = Math.floor(srcPos)
            const frac = srcPos - srcIdx
            const s0 = srcIdx < regionLen ? region[srcIdx] : 0
            const s1 = srcIdx + 1 < regionLen ? region[srcIdx + 1] : 0
            resampled[i] = s0 + frac * (s1 - s0)
          }

          // Step 2: WSOLA time-stretch resampled back to regionLen
          // stretchFactor > 1 means stretching (pitch up), < 1 means compressing (pitch down)
          const stretchFactor = regionLen / resampledLen  // = ratio

          // Clamp parameters for very short regions
          const seqLen = Math.min(seqLenSamples, Math.floor(resampledLen / 2), Math.floor(regionLen / 2))
          if (seqLen < 4) {
            // Region too short for WSOLA — fall back to direct copy/truncate
            for (let i = 0; i < regionLen; i++) {
              data[start + i] = i < resampledLen ? resampled[i] : 0
            }
            continue
          }
          const seekWin = Math.min(seekWindowSamples, Math.floor(seqLen / 2))
          const overlap = Math.min(overlapSamples, Math.floor(seqLen / 2))

          // Synthesis hop (fixed, determines output spacing)
          const Hs = seqLen - overlap
          // Analysis hop (nominal, determines input spacing)
          const Ha = Math.max(1, Math.round(Hs / stretchFactor))

          const output = new Float32Array(regionLen)

          // Normalized cross-correlation over the overlap region
          // Returns the best offset in [-seekWin, +seekWin]
          const findBestOffset = (nominalPos: number, prevTail: Float32Array): number => {
            let bestCorr = -Infinity
            let bestDelta = 0

            for (let delta = -seekWin; delta <= seekWin; delta++) {
              const candidatePos = nominalPos + delta
              if (candidatePos < 0 || candidatePos + overlap > resampledLen) continue

              let cross = 0
              let energy = 0
              for (let i = 0; i < overlap; i++) {
                cross += prevTail[i] * resampled[candidatePos + i]
                energy += resampled[candidatePos + i] * resampled[candidatePos + i]
              }

              // Normalized correlation with mid-range bias (SoundTouch heuristic)
              const norm = energy > 1e-10 ? cross / Math.sqrt(energy) : 0
              // Bias toward center of search window to avoid large jumps
              const dist = delta / (seekWin || 1)
              const biased = norm * (1.0 - 0.25 * dist * dist)

              if (biased > bestCorr) {
                bestCorr = biased
                bestDelta = delta
              }
            }
            return bestDelta
          }

          // Linear crossfade: blend prevTail and new segment head
          const crossfade = (
            dst: Float32Array, dstOffset: number,
            fadeOut: Float32Array, fadeIn: Float32Array,
            len: number
          ) => {
            for (let i = 0; i < len; i++) {
              const w = i / len
              const idx = dstOffset + i
              if (idx >= 0 && idx < regionLen) {
                dst[idx] = fadeOut[i] * (1 - w) + fadeIn[i] * w
              }
            }
          }

          let inPos = 0       // current position in resampled buffer
          let outPos = 0       // current position in output buffer
          let prevDelta = 0    // offset applied to previous frame

          // Process first frame (no crossfade needed)
          const firstLen = Math.min(seqLen, resampledLen, regionLen)
          for (let i = 0; i < firstLen; i++) {
            output[i] = resampled[i]
          }
          outPos = Hs
          inPos = Ha

          // Save tail of first frame for next crossfade
          let prevTail = new Float32Array(overlap)
          const firstTailStart = Math.max(0, firstLen - overlap)
          for (let i = 0; i < overlap; i++) {
            prevTail[i] = firstTailStart + i < firstLen ? resampled[firstTailStart + i] : 0
          }

          // Main WSOLA loop
          while (outPos < regionLen && inPos < resampledLen) {
            // Nominal analysis position, adjusted by previous delta
            const nominalPos = inPos

            // Find best-aligned position via cross-correlation
            const delta = findBestOffset(nominalPos, prevTail)
            const actualPos = Math.max(0, Math.min(resampledLen - seqLen, nominalPos + delta))

            // Crossfade: blend prevTail with head of new segment
            const fadeIn = new Float32Array(overlap)
            for (let i = 0; i < overlap; i++) {
              fadeIn[i] = actualPos + i < resampledLen ? resampled[actualPos + i] : 0
            }
            crossfade(output, outPos, prevTail, fadeIn, overlap)

            // Copy the non-overlapping body of the segment
            const bodyStart = outPos + overlap
            const bodyLen = Math.min(seqLen - overlap, regionLen - bodyStart)
            for (let i = 0; i < bodyLen; i++) {
              const srcIdx = actualPos + overlap + i
              const dstIdx = bodyStart + i
              if (dstIdx < regionLen) {
                output[dstIdx] = srcIdx < resampledLen ? resampled[srcIdx] : 0
              }
            }

            // Save tail for next iteration's crossfade
            const tailStart = actualPos + seqLen - overlap
            prevTail = new Float32Array(overlap)
            for (let i = 0; i < overlap; i++) {
              prevTail[i] = tailStart + i < resampledLen ? resampled[tailStart + i] : 0
            }

            prevDelta = delta
            outPos += Hs
            inPos += Ha
          }

          // Replace the region in the result buffer
          data.set(output, start)
        }
      }
    }

    // Apply reverse edits
    const reverseEdits = this.edits.filter((e) => e.type === 'reverse')
    if (reverseEdits.length > 0) {
      for (const edit of reverseEdits) {
        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))
        for (let ch = 0; ch < result.length; ch++) {
          const region = result[ch].subarray(start, end)
          region.reverse()
        }
      }
    }

    // Apply fade-in edits
    const fadeInEdits = this.edits.filter((e) => e.type === 'fadeIn')
    if (fadeInEdits.length > 0) {
      for (const edit of fadeInEdits) {
        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))
        const regionLen = end - start
        if (regionLen <= 0) continue
        const isExponential = edit.curve === 'exponential'

        for (let ch = 0; ch < result.length; ch++) {
          for (let i = 0; i < regionLen; i++) {
            const t = i / regionLen
            const gain = isExponential ? t * t : t
            result[ch][start + i] *= gain
          }
        }
      }
    }

    // Apply fade-out edits
    const fadeOutEdits = this.edits.filter((e) => e.type === 'fadeOut')
    if (fadeOutEdits.length > 0) {
      for (const edit of fadeOutEdits) {
        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))
        const regionLen = end - start
        if (regionLen <= 0) continue
        const isExponential = edit.curve === 'exponential'

        for (let ch = 0; ch < result.length; ch++) {
          for (let i = 0; i < regionLen; i++) {
            const t = 1 - i / regionLen
            const gain = isExponential ? t * t : t
            result[ch][start + i] *= gain
          }
        }
      }
    }

    // Apply normalize edits
    const normalizeEdits = this.edits.filter((e) => e.type === 'normalize')
    if (normalizeEdits.length > 0) {
      for (const edit of normalizeEdits) {
        const effStart = this.originalToEffective(edit.startSample, deleteRanges, originalLength)
        const effEnd = this.originalToEffective(edit.endSample, deleteRanges, originalLength)
        if (effStart < 0 || effEnd < 0) continue
        const start = Math.max(0, Math.min(effStart, result[0].length))
        const end = Math.max(0, Math.min(effEnd, result[0].length))

        const targetDb = edit.targetDb ?? -0.1

        // Find peak amplitude across all channels in the region
        let peak = 0
        for (let ch = 0; ch < result.length; ch++) {
          for (let i = start; i < end; i++) {
            const abs = Math.abs(result[ch][i])
            if (abs > peak) peak = abs
          }
        }

        if (peak > 0) {
          const targetLinear = Math.pow(10, targetDb / 20)
          const factor = targetLinear / peak
          for (let ch = 0; ch < result.length; ch++) {
            for (let i = start; i < end; i++) {
              result[ch][i] *= factor
            }
          }
        }
      }
    }

    return result
  }

  private mergeOverlappingRanges(): SampleRange[] {
    const deletes = this.edits
      .filter((e) => e.type === 'delete')
      .map((e) => ({ startSample: e.startSample, endSample: e.endSample }))
      .sort((a, b) => a.startSample - b.startSample)

    if (deletes.length === 0) return []

    const merged: SampleRange[] = [deletes[0]]
    for (let i = 1; i < deletes.length; i++) {
      const last = merged[merged.length - 1]
      const curr = deletes[i]
      if (curr.startSample <= last.endSample) {
        last.endSample = Math.max(last.endSample, curr.endSample)
      } else {
        merged.push({ ...curr })
      }
    }
    return merged
  }

  /** Get a list of available audio devices
   * You can use this to get the device ID of the microphone to use with the startMic and startRecording methods
   * Will return an empty array if the browser doesn't support the MediaDevices API or if the user has not granted access to the microphone
   * You can ask for permission to the microphone by calling startMic
   */
  public static async getAvailableAudioDevices() {
    return navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => devices.filter((device) => device.kind === 'audioinput'))
  }

  /** Destroy the plugin */
  public destroy() {
    this.applyOriginalOptionsIfNeeded()
    super.destroy()
    this.stopRecording()
    this.stopMic()
  }

  private applyOriginalOptionsIfNeeded() {
    if (this.wavesurfer && this.originalOptions) {
      this.wavesurfer.setOptions(this.originalOptions)
      delete this.originalOptions
    }
  }
}

export default RecordPlugin
