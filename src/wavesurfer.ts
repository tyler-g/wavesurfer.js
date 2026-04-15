import BasePlugin, { type GenericPlugin } from './base-plugin.js'
import Decoder from './decoder.js'
import * as dom from './dom.js'
import Fetcher from './fetcher.js'
import Player from './player.js'
import Renderer from './renderer.js'
import Timer from './timer.js'
import WebAudioPlayer from './webaudio.js'

export type WaveSurferOptions = {
  /** Required: an HTML element or selector where the waveform will be rendered */
  container: HTMLElement | string
  /** The height of the waveform in pixels, or "auto" to fill the container height */
  height?: number | 'auto'
  /** The width of the waveform in pixels or any CSS value; defaults to 100% */
  width?: number | string
  /** The color of the waveform */
  waveColor?: string | string[] | CanvasGradient
  /** The color of the progress mask */
  progressColor?: string | string[] | CanvasGradient
  /** The color of the playback cursor */
  cursorColor?: string
  /** The cursor width */
  cursorWidth?: number
  /** If set, the waveform will be rendered with bars like this: ▁ ▂ ▇ ▃ ▅ ▂ */
  barWidth?: number
  /** Spacing between bars in pixels */
  barGap?: number
  /** Rounded borders for bars */
  barRadius?: number
  /** A vertical scaling factor for the waveform */
  barHeight?: number
  /** Vertical bar alignment */
  barAlign?: 'top' | 'bottom'
  /** Minimum pixels per second of audio (i.e. the zoom level) */
  minPxPerSec?: number
  /** Stretch the waveform to fill the container, true by default */
  fillParent?: boolean
  /** Audio URL */
  url?: string
  /** Pre-computed audio data, arrays of floats for each channel */
  peaks?: Array<Float32Array | number[]>
  /** Pre-computed audio duration in seconds */
  duration?: number
  /** Use an existing media element instead of creating one */
  media?: HTMLMediaElement
  /** Whether to show default audio element controls */
  mediaControls?: boolean
  /** Play the audio on load */
  autoplay?: boolean
  /** Pass false to disable clicks on the waveform */
  interact?: boolean
  /** Allow to drag the cursor to seek to a new position. If an object with `debounceTime` is provided instead
   * then `dragToSeek` will also be true. If `true` the default is 200ms
   */
  dragToSeek?: boolean | { debounceTime: number }
  /** Hide the scrollbar */
  hideScrollbar?: boolean
  /** Audio rate, i.e. the playback speed */
  audioRate?: number
  /** Automatically scroll the container to keep the current position in viewport */
  autoScroll?: boolean
  /** If autoScroll is enabled, keep the cursor in the center of the waveform during playback */
  autoCenter?: boolean
  /** Decoding sample rate. Doesn't affect the playback. Defaults to 8000 */
  sampleRate?: number
  /** Render each audio channel as a separate waveform */
  splitChannels?: Array<Partial<WaveSurferOptions> & { overlay?: boolean }>
  /** Stretch the waveform to the full height */
  normalize?: boolean
  /** The list of plugins to initialize on start */
  plugins?: GenericPlugin[]
  /** Custom render function */
  renderFunction?: (peaks: Array<Float32Array | number[]>, ctx: CanvasRenderingContext2D) => void
  /** Options to pass to the fetch method */
  fetchParams?: RequestInit
  /** Playback "backend" to use, defaults to MediaElement */
  backend?: 'WebAudio' | 'MediaElement'
  /** Nonce for CSP if necessary */
  cspNonce?: string
  /** Override the Blob MIME type */
  blobMimeType?: string
  /** (if WebAudio backend) AudioContext to use. If none passed a new one is created */
  audioContext?: AudioContext
  /** Unified project duration in seconds. When set, scrollable width is based on
   *  max(audioDuration, projectDuration) so all tracks share the same width. */
  projectDuration?: number
}

const defaultOptions = {
  waveColor: '#999',
  progressColor: '#555',
  cursorWidth: 1,
  minPxPerSec: 0,
  fillParent: true,
  interact: true,
  dragToSeek: false,
  autoScroll: true,
  autoCenter: true,
  sampleRate: 44100,
}

export type WaveSurferEvents = {
  /** After wavesurfer is created */
  init: []
  /** When audio starts loading */
  load: [url: string]
  /** During audio loading */
  loading: [percent: number]
  /** When the audio has been decoded */
  decode: [duration: number]
  /** When the audio is both decoded and can play */
  ready: [duration: number]
  /** When visible waveform is drawn */
  redraw: []
  /** When all audio channel chunks of the waveform have drawn */
  redrawcomplete: []
  /** When the audio starts playing */
  play: []
  /** When the audio pauses */
  pause: []
  /** When the audio finishes playing */
  finish: []
  /** On audio position change, fires continuously during playback */
  timeupdate: [currentTime: number]
  /** An alias of timeupdate but only when the audio is playing */
  audioprocess: [currentTime: number]
  /** When the user seeks to a new position */
  seeking: [currentTime: number]
  /** When the user interacts with the waveform (i.g. clicks or drags on it) */
  interaction: [newTime: number]
  /** When the user clicks on the waveform */
  click: [relativeX: number, relativeY: number]
  /** When the user double-clicks on the waveform */
  dblclick: [relativeX: number, relativeY: number]
  /** When the user drags the cursor */
  drag: [relativeX: number]
  /** When the user starts dragging the cursor */
  dragstart: [relativeX: number]
  /** When the user ends dragging the cursor */
  dragend: [relativeX: number]
  /** When the waveform is scrolled (panned) */
  scroll: [visibleStartTime: number, visibleEndTime: number, scrollLeft: number, scrollRight: number]
  /** When the zoom level changes */
  zoom: [minPxPerSec: number]
  /** Just before the waveform is destroyed so you can clean up your events */
  destroy: []
  /** When source file is unable to be fetched, decoded, or an error is thrown by media element */
  error: [error: Error]
}

class WaveSurfer extends Player<WaveSurferEvents> {
  public options: WaveSurferOptions & typeof defaultOptions
  private renderer: Renderer
  private timer: Timer
  private plugins: GenericPlugin[] = []
  private decodedData: AudioBuffer | null = null
  private stopAtPosition: number | null = null
  protected subscriptions: Array<() => void> = []
  protected mediaSubscriptions: Array<() => void> = []
  protected abortController: AbortController | null = null

  public static readonly BasePlugin = BasePlugin
  public static readonly dom = dom

  /** Create a new WaveSurfer instance */
  public static create(options: WaveSurferOptions) {
    return new WaveSurfer(options)
  }

  /** Create a new WaveSurfer instance */
  constructor(options: WaveSurferOptions) {
    const media =
      options.media ||
      (options.backend === 'WebAudio'
        ? (new WebAudioPlayer(options.audioContext) as unknown as HTMLAudioElement)
        : undefined)

    super({
      media,
      mediaControls: options.mediaControls,
      autoplay: options.autoplay,
      playbackRate: options.audioRate,
    })

    this.options = Object.assign({}, defaultOptions, options)
    this.timer = new Timer()

    const audioElement = media ? undefined : this.getMediaElement()
    this.renderer = new Renderer(this.options, audioElement)

    this.initPlayerEvents()
    this.initRendererEvents()
    this.initTimerEvents()
    this.initPlugins()

    // Read the initial URL before load has been called
    const initialUrl = this.options.url || this.getSrc() || ''

    // Init and load async to allow external events to be registered
    Promise.resolve().then(() => {
      this.emit('init')

      // Load audio if URL or an external media with an src is passed,
      // of render w/o audio if pre-decoded peaks and duration are provided
      const { peaks, duration } = this.options
      if (initialUrl || (peaks && duration)) {
        // Swallow async errors because they cannot be caught from a constructor call.
        // Subscribe to the wavesurfer's error event to handle them.
        this.load(initialUrl, peaks, duration).catch(() => null)
      }
    })
  }

  private updateProgress(currentTime = this.getCurrentTime()): number {
    this.renderer.renderProgress(currentTime / this.getEffectiveDuration(), this.isPlaying())
    return currentTime
  }

  private initTimerEvents() {
    // The timer fires every 16ms for a smooth progress animation
    this.subscriptions.push(
      this.timer.on('tick', () => {
        if (!this.isSeeking()) {
          const currentTime = this.updateProgress()
          this.emit('timeupdate', currentTime)
          this.emit('audioprocess', currentTime)

          // Pause audio when it reaches the stopAtPosition
          if (this.stopAtPosition != null && this.isPlaying() && currentTime >= this.stopAtPosition) {
            this.pause()
          }
        }
      }),
    )
  }

  private initPlayerEvents() {
    if (this.isPlaying()) {
      this.emit('play')
      this.timer.start()
    }

    this.mediaSubscriptions.push(
      this.onMediaEvent('timeupdate', () => {
        const currentTime = this.updateProgress()
        this.emit('timeupdate', currentTime)
      }),

      this.onMediaEvent('play', () => {
        this.emit('play')
        this.timer.start()
      }),

      this.onMediaEvent('pause', () => {
        this.emit('pause')
        this.timer.stop()
        this.stopAtPosition = null
      }),

      this.onMediaEvent('emptied', () => {
        this.timer.stop()
        this.stopAtPosition = null
      }),

      this.onMediaEvent('ended', () => {
        this.emit('timeupdate', this.getDuration())
        this.emit('finish')
        this.stopAtPosition = null
      }),

      this.onMediaEvent('seeking', () => {
        this.emit('seeking', this.getCurrentTime())
      }),

      this.onMediaEvent('error', () => {
        this.emit('error', (this.getMediaElement().error ?? new Error('Media error')) as Error)
        this.stopAtPosition = null
      }),
    )
  }

  private initRendererEvents() {
    this.subscriptions.push(
      // Seek on click
      this.renderer.on('click', (relativeX, relativeY) => {
        if (this.options.interact) {
          this.seekTo(relativeX)
          this.emit('interaction', relativeX * this.getEffectiveDuration())
          this.emit('click', relativeX, relativeY)
        }
      }),

      // Double click
      this.renderer.on('dblclick', (relativeX, relativeY) => {
        this.emit('dblclick', relativeX, relativeY)
      }),

      // Scroll
      this.renderer.on('scroll', (startX, endX, scrollLeft, scrollRight) => {
        const duration = this.getEffectiveDuration()
        this.emit('scroll', startX * duration, endX * duration, scrollLeft, scrollRight)
      }),

      // Redraw
      this.renderer.on('render', () => {
        this.emit('redraw')
      }),

      // RedrawComplete
      this.renderer.on('rendered', () => {
        this.emit('redrawcomplete')
      }),

      // DragStart
      this.renderer.on('dragstart', (relativeX) => {
        this.emit('dragstart', relativeX)
      }),

      // DragEnd
      this.renderer.on('dragend', (relativeX) => {
        this.emit('dragend', relativeX)
      }),
    )

    // Drag
    {
      let debounce: ReturnType<typeof setTimeout>
      this.subscriptions.push(
        this.renderer.on('drag', (relativeX) => {
          if (!this.options.interact) return

          // Update the visual position
          this.renderer.renderProgress(relativeX)

          // Set the audio position with a debounce
          clearTimeout(debounce)
          let debounceTime

          if (this.isPlaying()) {
            debounceTime = 0
          } else if (this.options.dragToSeek === true) {
            debounceTime = 200
          } else if (typeof this.options.dragToSeek === 'object' && this.options.dragToSeek !== undefined) {
            debounceTime = this.options.dragToSeek['debounceTime']
          }

          debounce = setTimeout(() => {
            this.seekTo(relativeX)
          }, debounceTime)

          this.emit('interaction', relativeX * this.getEffectiveDuration())
          this.emit('drag', relativeX)
        }),
      )
    }
  }

  private initPlugins() {
    if (!this.options.plugins?.length) return

    this.options.plugins.forEach((plugin) => {
      this.registerPlugin(plugin)
    })
  }

  private unsubscribePlayerEvents() {
    this.mediaSubscriptions.forEach((unsubscribe) => unsubscribe())
    this.mediaSubscriptions = []
  }

  /** Set new wavesurfer options and re-render it */
  public setOptions(options: Partial<WaveSurferOptions>) {
    this.options = Object.assign({}, this.options, options)
    if (options.duration && !options.peaks) {
      this.decodedData = Decoder.createBuffer(this.exportPeaks(), options.duration)
    }
    if (options.peaks && options.duration) {
      // Create new decoded data buffer from peaks and duration
      this.decodedData = Decoder.createBuffer(options.peaks, options.duration)
    }
    this.renderer.setOptions(this.options)

    if (options.audioRate) {
      this.setPlaybackRate(options.audioRate)
    }
    if (options.mediaControls != null) {
      this.getMediaElement().controls = options.mediaControls
    }
  }

  /** Register a wavesurfer.js plugin */
  public registerPlugin<T extends GenericPlugin>(plugin: T): T {
    // Check if the plugin is already registered
    if (this.plugins.includes(plugin)) {
      return plugin
    }

    plugin._init(this)
    this.plugins.push(plugin)

    // Unregister plugin on destroy
    const unsubscribe = plugin.once('destroy', () => {
      this.plugins = this.plugins.filter((p) => p !== plugin)
      this.subscriptions = this.subscriptions.filter((fn) => fn !== unsubscribe)
    })
    this.subscriptions.push(unsubscribe)

    return plugin
  }

  /** Unregister a wavesurfer.js plugin */
  public unregisterPlugin(plugin: GenericPlugin): void {
    this.plugins = this.plugins.filter((p) => p !== plugin)
    plugin.destroy()
  }

  /** For plugins only: get the waveform wrapper div */
  public getWrapper(): HTMLElement {
    return this.renderer.getWrapper()
  }

  /** For plugins only: get the scroll container client width */
  public getWidth(): number {
    return this.renderer.getWidth()
  }

  /** Get the current scroll position in pixels */
  public getScroll(): number {
    return this.renderer.getScroll()
  }

  /** Set the current scroll position in pixels */
  public setScroll(pixels: number) {
    return this.renderer.setScroll(pixels)
  }

  /** Move the start of the viewing window to a specific time in the audio (in seconds) */
  public setScrollTime(time: number) {
    const percentage = time / this.getEffectiveDuration()
    this.renderer.setScrollPercentage(percentage)
  }

  /** Get all registered plugins */
  public getActivePlugins() {
    return this.plugins
  }

  private padAudioBufferToDuration(buffer: AudioBuffer, targetDuration: number): AudioBuffer {
    const sampleRate = buffer.sampleRate
    const targetLength = Math.floor(targetDuration * sampleRate)
    const numChannels = buffer.numberOfChannels

    // Create a new buffer with the target duration
    const paddedBuffer = new AudioBuffer({
      length: targetLength,
      numberOfChannels: numChannels,
      sampleRate: sampleRate,
    })

    // Copy the original data to the new buffer
    for (let channel = 0; channel < numChannels; channel++) {
      const originalData = buffer.getChannelData(channel)
      const paddedData = paddedBuffer.getChannelData(channel)
      paddedData.set(originalData)
      // The rest of the buffer will be filled with zeros by default
    }

    return paddedBuffer
  }

  private async loadAudio(url: string, blob?: Blob, channelData?: WaveSurferOptions['peaks'], duration?: number) {
    // Abort any in-flight load so the new one always wins
    this.abortController?.abort()
    this.abortController = null

    this.emit('load', url)
    // Don't pause during recording — the RecordPlugin calls load() on the first
    // frame to set up DOM structure while playback is active
    if (!this.options.media && this.isPlaying() && !channelData) this.pause()

    this.decodedData = null
    this.stopAtPosition = null

    // Fetch the entire audio as a blob if pre-decoded data is not provided
    if (!blob && !channelData) {
      const fetchParams = this.options.fetchParams || {}
      if (window.AbortController && !fetchParams.signal) {
        this.abortController = new AbortController()
        fetchParams.signal = this.abortController?.signal
      }
      const onProgress = (percentage: number) => this.emit('loading', percentage)
      blob = await Fetcher.fetchBlob(url, onProgress, fetchParams)
      const overridenMimeType = this.options.blobMimeType
      if (overridenMimeType) {
        blob = new Blob([blob], { type: overridenMimeType })
      }
    }

    // Set the mediaelement source
    this.setSrc(url, blob)

    // Wait for the audio duration
    const audioDuration = await new Promise<number>((resolve) => {
      const staticDuration = duration || this.getDuration()
      if (staticDuration) {
        resolve(staticDuration)
      } else {
        this.mediaSubscriptions.push(
          this.onMediaEvent('loadedmetadata', () => resolve(this.getDuration()), { once: true }),
        )
      }
    })

    // Set the duration if the player is a WebAudioPlayer without a URL
    if (!url && !blob) {
      const media = this.getMediaElement()
      if (media instanceof WebAudioPlayer) {
        media.duration = audioDuration
      }
    }

    // Decode the audio data or use user-provided peaks
    if (channelData) {
      this.decodedData = Decoder.createBuffer(channelData, audioDuration || 0)
    } else if (blob) {
      const arrayBuffer = await blob.arrayBuffer()
      this.decodedData = await Decoder.decode(arrayBuffer, this.options.sampleRate)
    }

    if (this.decodedData) {
      // Pad the buffer to 60 seconds if it's shorter
      if (this.decodedData.duration < 60) {
        // console.log('loadAudio | padding audio buffer to 60 seconds');
        //this.decodedData = this.padAudioBufferToDuration(this.decodedData, 60)
      }
      this.emit('decode', this.getDuration())
      // Preserve scroll position across render to prevent jitter
      const savedScroll = this.getScroll()
      this.renderer.render(this.decodedData)
      this.setScroll(savedScroll)
      requestAnimationFrame(() => this.setScroll(savedScroll))
    }

    this.emit('ready', this.getDuration())
  }

  /** Load an audio file by URL, with optional pre-decoded audio data */
  public async load(url: string, channelData?: WaveSurferOptions['peaks'], duration?: number) {
    try {
      return await this.loadAudio(url, undefined, channelData, duration)
    } catch (err) {
      this.emit('error', err as Error)
      throw err
    }
  }

  /** Lightweight peaks update — reuses existing canvas DOM elements instead of full load().
   *  Used during recording to avoid the performance cliff from destroying/recreating DOM at 60fps.
   *  Updates the waveform data, cursor position, and scroll in a single efficient call. */
  public updatePeaks(channelData: WaveSurferOptions['peaks'], duration: number, currentTime?: number) {
    if (!channelData) return
    this.decodedData = Decoder.createBuffer(channelData, duration)

    // Update media duration for WebAudioPlayer
    const media = this.getMediaElement()
    if (media instanceof WebAudioPlayer) {
      media.duration = duration
    }

    // Update cursor/progress position BEFORE rendering so renderUpdate
    // can draw canvases around the correct viewport.
    // Use the raw audio duration (not effectiveDuration) for cursor/scroll so the
    // cursor tracks the actual recording position, not the project-wide width.
    if (currentTime !== undefined && duration > 0) {
      const effectiveDuration = Math.max(duration, this.options.projectDuration || 0)
      const progress = Math.min(1, currentTime / effectiveDuration)

      // Scroll only when cursor reaches the right edge (matches playback behavior)
      const minPxPerSec = this.options.minPxPerSec || 0
      const scrollWidth = Math.ceil(effectiveDuration * minPxPerSec)
      const clientWidth = this.getWidth()
      if (scrollWidth > clientWidth) {
        const cursorPosition = currentTime * minPxPerSec
        const currentScroll = this.getScroll()
        const rightEdge = currentScroll + clientWidth
        if (cursorPosition > rightEdge - 50) {
          const targetScroll = cursorPosition - 50
          this.setScroll(Math.max(0, Math.min(targetScroll, scrollWidth - clientWidth)))
        }
      }

      // Render the waveform canvases (uses current scrollLeft to determine visible canvases)
      if (this.decodedData) {
        this.renderer.renderUpdate(this.decodedData)
      }

      // Update cursor/progress visual (skipScroll — we already scrolled above)
      this.renderer.renderProgress(progress, false, true)
    } else if (this.decodedData) {
      this.renderer.renderUpdate(this.decodedData)
    }
  }

  /** Load an audio blob */
  public async loadBlob(blob: Blob, channelData?: WaveSurferOptions['peaks'], duration?: number) {
    try {
      return await this.loadAudio('', blob, channelData, duration)
    } catch (err) {
      this.emit('error', err as Error)
      throw err
    }
  }

  /** Load audio directly from PCM Float32Arrays, bypassing the WAV blob pipeline.
   *  Creates a real AudioBuffer via audioContext.createBuffer() — single copy, no transient blobs. */
  public async loadPcm(channelData: Float32Array[], sampleRate: number): Promise<void> {
    this.abortController?.abort()
    this.abortController = null

    if (!this.options.media && this.isPlaying()) this.pause()

    this.decodedData = null
    this.stopAtPosition = null

    const numChannels = channelData.length
    const length = channelData[0]?.length || 0
    if (numChannels === 0 || length === 0) return

    const media = this.getMediaElement()
    if (!(media instanceof WebAudioPlayer)) {
      throw new Error('loadPcm requires WebAudio backend')
    }

    const audioContext = (media as unknown as WebAudioPlayer).getAudioContext()
    const audioBuffer = audioContext.createBuffer(numChannels, length, sampleRate)
    for (let ch = 0; ch < numChannels; ch++) {
      audioBuffer.copyToChannel(channelData[ch], ch)
    }

    ;(media as unknown as WebAudioPlayer).setAudioBuffer(audioBuffer)

    // Preserve scroll position across render to prevent jitter when
    // recording stops while playback continues
    const savedScroll = this.getScroll()
    this.decodedData = audioBuffer
    this.renderer.render(this.decodedData)
    // Restore scroll immediately and again after layout to prevent browser clamping
    this.setScroll(savedScroll)
    requestAnimationFrame(() => this.setScroll(savedScroll))

    this.emit('decode', this.getDuration())
    this.emit('ready', this.getDuration())
  }

  /** Zoom the waveform by a given pixels-per-second factor */
  public zoom(minPxPerSec: number) {
    if (!this.decodedData) {
      return
    }
    this.renderer.zoom(minPxPerSec)
    this.emit('zoom', minPxPerSec)
  }

  /** Zoom and set scroll position atomically (pointer-anchored zoom). */
  public zoomAndScroll(minPxPerSec: number, scrollLeft: number) {
    if (!this.decodedData) {
      return
    }
    this.renderer.zoomAndScroll(minPxPerSec, scrollLeft)
    this.emit('zoom', minPxPerSec)
  }

  /** Get the decoded audio data */
  public getDecodedData(): AudioBuffer | null {
    return this.decodedData
  }

  /** Get decoded peaks */
  public exportPeaks({ channels = 2, maxLength = 44100, precision = 10_000 } = {}): Array<number[]> {
    if (!this.decodedData) {
      throw new Error('The audio has not been decoded yet')
    }
    const maxChannels = Math.min(channels, this.decodedData.numberOfChannels)
    const peaks = []
    for (let i = 0; i < maxChannels; i++) {
      const channel = this.decodedData.getChannelData(i)
      const data = []
      const sampleSize = channel.length / maxLength
      for (let i = 0; i < maxLength; i++) {
        const sample = channel.slice(Math.floor(i * sampleSize), Math.ceil((i + 1) * sampleSize))
        let max = 0
        for (let x = 0; x < sample.length; x++) {
          const n = sample[x]
          if (Math.abs(n) > Math.abs(max)) max = n
        }
        data.push(Math.round(max * precision) / precision)
      }
      peaks.push(data)
    }
    return peaks
  }

  /** Get the duration of the audio in seconds */
  public getDuration(): number {
    let duration = super.getDuration() || 0
    // Fall back to the decoded data duration if the media duration is incorrect
    if ((duration === 0 || duration === Infinity) && this.decodedData) {
      duration = this.decodedData.duration
    }
    return duration
  }

  /** Get the effective duration (max of audio duration and projectDuration option).
   *  Used for scroll width, cursor positioning, and seek calculations. */
  public getEffectiveDuration(): number {
    return Math.max(this.getDuration(), this.options.projectDuration || 0)
  }

  /** Toggle if the waveform should react to clicks */
  public toggleInteraction(isInteractive: boolean) {
    this.options.interact = isInteractive
  }

  /** Jump to a specific time in the audio (in seconds) */
  public setTime(time: number) {
    this.stopAtPosition = null
    super.setTime(time)
    this.updateProgress(time)
    this.emit('timeupdate', time)
  }

  /** Update visual progress without changing audio position. Used for master timeline sync. */
  public setProgress(time: number, skipScroll?: boolean) {
    const duration = this.getEffectiveDuration()
    if (duration > 0) {
      this.renderer.renderProgress(time / duration, this.isPlaying(), skipScroll)
    }
  }

  /** Seek to a ratio of audio as [0..1] (0 = beginning, 1 = end) */
  public seekTo(progress: number) {
    const time = this.getEffectiveDuration() * progress
    this.setTime(time)
  }

  /** Start playing the audio */
  public async play(start?: number, end?: number): Promise<void> {
    if (start != null) {
      this.setTime(start)
    }

    const playResult = await super.play()
    if (end != null) {
      if (this.media instanceof WebAudioPlayer) {
        this.media.stopAt(end)
      } else {
        this.stopAtPosition = end
      }
    }

    return playResult
  }

  /** Start playback synchronized to a shared AudioContext time snapshot.
   *  Timer is started by the 'play' event handler in initPlayerEvents. */
  public playAt(when: number): void {
    if (this.media instanceof WebAudioPlayer) {
      ;(this.media as unknown as WebAudioPlayer).playAt(when)
    }
  }

  /** Pause playback synchronized to a shared AudioContext time snapshot.
   *  Timer is stopped by the 'pause' event handler in initPlayerEvents. */
  public pauseAt(when: number): void {
    if (this.media instanceof WebAudioPlayer) {
      ;(this.media as unknown as WebAudioPlayer).pauseAt(when)
    }
  }

  /** Play or pause the audio */
  public async playPause(): Promise<void> {
    return this.isPlaying() ? this.pause() : this.play()
  }

  /** Stop the audio and go to the beginning */
  public stop() {
    this.pause()
    this.setTime(0)
  }

  /** Skip N or -N seconds from the current position */
  public skip(seconds: number) {
    this.setTime(this.getCurrentTime() + seconds)
  }

  /** Empty the waveform by loading a minimal silent buffer */
  public empty() {
    this.load('', [[0]], 0.001)
  }

  /** Clear the waveform completely — no audio, no visual artifacts.
   *  Unlike empty(), this does not load a fake silent buffer. */
  public clear() {
    this.decodedData = null
    const media = this.getMediaElement()
    if (media && 'duration' in media && typeof (media as any).duration === 'number') {
      ;(media as any).duration = 0
    }
    // Clear all canvas elements in the renderer wrapper
    const wrapper = this.renderer.getWrapper()
    const canvases = wrapper.querySelectorAll('canvas')
    canvases.forEach((c) => {
      const ctx = c.getContext('2d')
      if (ctx) ctx.clearRect(0, 0, c.width, c.height)
    })
  }

  /** force rerender of the waveform */
  public reRender() {
    this.renderer.reRender()
  }

  /** Set HTML media element */
  public setMediaElement(element: HTMLMediaElement) {
    this.unsubscribePlayerEvents()
    super.setMediaElement(element)
    this.initPlayerEvents()
  }

  /** Insert a custom output node between the gain node and destination (WebAudio backend only) */
  public setOutputNode(node: AudioNode) {
    if (this.media instanceof WebAudioPlayer) {
      ;(this.media as unknown as WebAudioPlayer).setOutputNode(node)
    }
  }

  /**
   * Export the waveform image as a data-URI or a blob.
   *
   * @param format The format of the exported image, can be `image/png`, `image/jpeg`, `image/webp` or any other format supported by the browser.
   * @param quality The quality of the exported image, for `image/jpeg` or `image/webp`. Must be between 0 and 1.
   * @param type The type of the exported image, can be `dataURL` (default) or `blob`.
   * @returns A promise that resolves with an array of data-URLs or blobs, one for each canvas element.
   */
  public async exportImage(format: string, quality: number, type: 'dataURL'): Promise<string[]>
  public async exportImage(format: string, quality: number, type: 'blob'): Promise<Blob[]>
  public async exportImage(
    format = 'image/png',
    quality = 1,
    type: 'dataURL' | 'blob' = 'dataURL',
  ): Promise<string[] | Blob[]> {
    return this.renderer.exportImage(format, quality, type)
  }

  /** Unmount wavesurfer */
  public destroy() {
    this.emit('destroy')
    this.abortController?.abort()
    this.plugins.forEach((plugin) => plugin.destroy())
    this.subscriptions.forEach((unsubscribe) => unsubscribe())
    this.unsubscribePlayerEvents()
    this.timer.destroy()
    this.renderer.destroy()
    super.destroy()
  }
}

export default WaveSurfer
