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

  // Punch-in recording state
  private punchInSample: number | null = null
  private punchInTimeSec: number = 0
  private existingAudioForPunchIn: Float32Array[] | null = null

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

    if (this.wavesurfer) {
      this.originalOptions ??= {
        ...this.wavesurfer.options,
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
        this.wavesurfer
          .load(
            '',
            [this.dataWindow],
            this.options.scrollingWaveform ? this.options.scrollingWaveformWindow : totalDuration,
          )
          .then(() => {
            if (this.wavesurfer && this.options.continuousWaveform) {
              this.wavesurfer.setTime(this.punchInTimeSec + this.getDuration() / 1000)

              if (!this.wavesurfer.options.minPxPerSec) {
                this.wavesurfer.setOptions({
                  minPxPerSec: this.wavesurfer.getWidth() / this.wavesurfer.getDuration(),
                })
              }
            }
          })
          .catch((err) => {
            console.error('Error rendering real-time recording data:', err)
          })
      }
    }

    const intervalId = setInterval(drawWaveform, 1000 / FPS)

    const cleanup = () => {
      clearInterval(intervalId)

      source?.disconnect()
      analyser?.disconnect()

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
    const recordedChunksPCM: Float32Array[] = [] // this is the raw PCM data (UNCOMPRESSED) Only available with workerContext and pcm passthrough


    mediaRecorder.ondataavailable = (event) => {
      //console.log('mediaRecorder.ondataavailable', event.data);
      if (event.data.size > 0) {
        recordedChunks.push(event.data)
      }
      this.emit('record-data-available', event.data)
    }

    if (this.options.workerContext) {
      this.options.workerContext.onmessage = async (e) => {
        if (!e.data) return
        // received a raw audio chunk from the stream
        if (e.data.cmd === 'passthrough') {
          // console.log('record plugin received pcm', e.data.pcm)
          recordedChunksPCM.push(e.data.pcm)
          return
        }
        if (e.data.cmd === 'passthrough-uint8') {
          //console.log('record plugin received pcm as uint8', e.data.pcm)
          return
        }
        if (e.data.cmd === 'pcm-data') {
          console.log('record plugin | received pcm data', e.data.pcm)

          let finalPcm: Float32Array[] = e.data.pcm

          // Capture timing info before punch-in state is reset
          const startTime = this.punchInTimeSec
          const sampleRate = this.options.audioContext?.sampleRate || 44100

          // If punch-in was set, stitch the new recording with existing audio
          if (this.punchInSample !== null) {
            finalPcm = this.stitchPunchIn(e.data.pcm)
            this.punchInSample = null
            this.punchInTimeSec = 0
            this.existingAudioForPunchIn = null
          }

          // Store the original PCM internally for non-destructive editing
          this.originalPcm = finalPcm
          this.pcmSampleRate = sampleRate
          this.edits = []

          const endTime = startTime + (finalPcm[0].length / sampleRate)
          this.emit('record-pcm-data' as any, { pcm: finalPcm, startTime, endTime })

          const paddedWavBlob = this.padPCMToDuration(finalPcm, 60)
          this.wavesurfer?.load(URL.createObjectURL(paddedWavBlob), undefined, 60)
          return
        }
      }
    }
    const emitWithBlob = (ev: 'record-pause' | 'record-end') => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType })
      //this.forceDownload(blob, 'pcmFromMediaRecorder.wav')
      this.emit(ev, blob)
      if (this.options.renderRecordedAudio) {
        this.applyOriginalOptionsIfNeeded()
        //console.log('tester recordedChunks', recordedChunks)
        this.options.workerContext?.postMessage({
          cmd: 'merge-pcm',
          buf: recordedChunksPCM,
        })
        //this.wavesurfer?.load(URL.createObjectURL(blob), undefined, 60)
        //this.wavesurfer?.load(URL.createObjectURL(blob))
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
    const edit: AudioEdit = { id, type: 'delete', startSample: startOriginal, endSample: endOriginal }
    this.edits.push(edit)
    this.recomputeAndReload()

    return {
      id,
      startSample: startOriginal,
      endSample: endOriginal,
      startTime: startOriginal / this.pcmSampleRate,
      endTime: endOriginal / this.pcmSampleRate,
    }
  }

  /** Delete a region by original PCM sample coordinates (from peer). */
  public deleteRegionByOriginalSamples(startSample: number, endSample: number, editId?: string) {
    const id = editId || crypto.randomUUID()
    const edit: AudioEdit = { id, type: 'delete', startSample, endSample }
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

  private recomputeAndReload() {
    if (!this.originalPcm || !this.wavesurfer) return

    const effectivePcm = this.computeEffectiveAudio()
    if (effectivePcm[0].length > 0) {
      const wavBlob = this.convertPCMToWAV(effectivePcm)
      this.wavesurfer.loadBlob(wavBlob)
    } else {
      this.wavesurfer.empty()
    }
  }

  private editedToOriginal(editedSample: number): number {
    const ranges = this.mergeOverlappingRanges()
    let offset = 0

    for (const range of ranges) {
      const editedCutPoint = range.startSample - offset
      if (editedSample < editedCutPoint) break
      offset += range.endSample - range.startSample
    }

    return editedSample + offset
  }

  private computeEffectiveAudio(): Float32Array[] {
    if (!this.originalPcm) return []
    const ranges = this.mergeOverlappingRanges()
    if (ranges.length === 0) {
      return this.originalPcm.map((ch) => new Float32Array(ch))
    }

    const originalLength = this.originalPcm[0].length

    let totalDeleted = 0
    for (const range of ranges) {
      const start = Math.max(0, Math.min(range.startSample, originalLength))
      const end = Math.max(0, Math.min(range.endSample, originalLength))
      totalDeleted += end - start
    }

    const newLength = originalLength - totalDeleted
    if (newLength <= 0) {
      return this.originalPcm.map(() => new Float32Array(0))
    }

    return this.originalPcm.map((channel) => {
      const result = new Float32Array(newLength)
      let writePos = 0
      let readPos = 0

      for (const range of ranges) {
        const start = Math.max(0, Math.min(range.startSample, originalLength))
        const end = Math.max(0, Math.min(range.endSample, originalLength))

        if (readPos < start) {
          result.set(channel.subarray(readPos, start), writePos)
          writePos += start - readPos
        }
        readPos = end
      }

      if (readPos < originalLength) {
        result.set(channel.subarray(readPos), writePos)
      }

      return result
    })
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
