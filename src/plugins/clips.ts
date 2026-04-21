/**
 * Clips plugin for WaveSurfer.
 * Renders arrangement clips as visual blocks on the waveform timeline.
 * Each clip has a mini-waveform canvas, drag-to-move, and edge resize handles.
 */

import BasePlugin, { type BasePluginEvents } from '../base-plugin.js'
import { makeDraggable } from '../draggable.js'
import EventEmitter from '../event-emitter.js'
import createElement from '../dom.js'

export type ClipsPluginOptions = undefined

export type ClipsPluginEvents = BasePluginEvents & {
  'clip-added': [clip: ClipBlockImpl]
  'clip-removed': [clip: ClipBlockImpl]
  'clip-drag-end': [clip: ClipBlockImpl]
  'clip-resize-end': [clip: ClipBlockImpl, side: 'start' | 'end']
  'clip-clicked': [clip: ClipBlockImpl, e: MouseEvent]
  'clip-dblclick': [clip: ClipBlockImpl, e: MouseEvent]
  'clip-context-menu': [clip: ClipBlockImpl, e: MouseEvent]
  'clip-selected': [clip: ClipBlockImpl]
  'clip-updated': [clip: ClipBlockImpl]
}

export type ClipBlockEvents = {
  remove: []
  update: [side?: 'start' | 'end']
  'update-end': [side?: 'start' | 'end']
  click: [event: MouseEvent]
  dblclick: [event: MouseEvent]
  'context-menu': [event: MouseEvent]
}

/**
 * Custom render function for clip canvas content.
 * Called instead of the default waveform renderer when provided.
 * Receives the canvas context, pixel dimensions, and the clip instance.
 */
export type ClipRenderFn = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  clip: ClipBlockImpl,
) => void

export type ClipParams = {
  id: string
  startTime: number // seconds
  duration: number // seconds
  originalDuration?: number // seconds — the original audio length (for looping/clipping)
  color?: string
  name?: string
  peaks?: number[] | null
  selected?: boolean
  /** Custom render function — replaces waveform rendering when provided */
  renderContent?: ClipRenderFn
  /** Arbitrary data attached to the clip (e.g., MidiNote[] for MIDI clips) */
  data?: any
  /**
   * Raw PCM channels used for Ableton-style high-quality waveform
   * rendering. When present, the plugin computes peaks on demand at the
   * display's pixel width instead of stretching the low-res `peaks` array,
   * and switches to sample-accurate line rendering at extreme zoom.
   * Passed by reference — the host app keeps ownership.
   */
  pcm?: Float32Array[] | null
  /** Sample rate the `pcm` was captured at. Required for sample-rate math
   *  in extreme-zoom line rendering. Ignored when `pcm` is absent. */
  sampleRate?: number
}

class ClipBlockImpl extends EventEmitter<ClipBlockEvents> {
  public element: HTMLElement | null = null
  public canvas: HTMLCanvasElement | null = null
  public id: string
  public startTime: number
  public duration: number
  public originalDuration: number
  public color: string
  public name: string
  public peaks: number[] | null
  public peaksPreLooped: boolean
  private originalPeaks: number[] | null
  public selected: boolean
  public renderContent: ClipRenderFn | undefined
  public data: any
  public subscriptions: (() => void)[] = []
  private totalDuration: number
  private isRemoved = false
  // High-quality rendering state. `pcm` is a live reference to the
  // host app's Float32Array per channel — never mutated here.
  private pcm: Float32Array[] | null
  private sampleRate: number
  private rafHandle: number = 0
  /**
   * Snapshot of the inputs that produced the currently-painted canvas.
   * Used to short-circuit renderWaveform when a redraw/scroll event fires
   * but nothing visible to this clip has actually changed — critical for
   * projects with many clips, since zoom broadcasts a render to every one.
   */
  private lastPaintState: {
    pixelW: number
    pixelH: number
    pcmRef: Float32Array | null
    peaksRef: number[] | null
    peaksPreLooped: boolean
    bins: number
    duration: number
    originalDuration: number
    // Canvas window within the clip element, for viewport virtualization.
    canvasLeftCss: number
    canvasWidthCss: number
    startSample: number
    endSample: number
  } | null = null
  /** Reference to the owning plugin so the clip can read the shared
   *  visible-time range for viewport culling. */
  private ownerPlugin: ClipsPlugin | undefined

  constructor(params: ClipParams, totalDuration: number, ownerPlugin?: ClipsPlugin) {
    super()
    this.ownerPlugin = ownerPlugin
    this.id = params.id
    this.startTime = Math.max(0, params.startTime)
    this.duration = Math.max(0, params.duration)
    this.originalDuration = params.originalDuration ?? this.duration
    this.color = params.color ?? 'rgba(56, 178, 172, 0.6)'
    this.name = params.name ?? ''
    this.peaks = params.peaks ?? null
    this.peaksPreLooped = false
    this.originalPeaks = this.peaks ? [...this.peaks] : null
    this.selected = params.selected ?? false
    this.renderContent = params.renderContent
    this.data = params.data
    this.pcm = params.pcm ?? null
    this.sampleRate = params.sampleRate ?? 44100
    this.totalDuration = Math.max(totalDuration, 0.001)
    this.element = this.initElement()
    this.renderPosition()
    this.renderWaveform()
    this.initMouseEvents()
  }

  private initElement(): HTMLElement | null {
    if (this.isRemoved) return null

    const element = createElement('div', {
      class: 'ws-clip',
      style: {
        position: 'absolute',
        top: '0',
        height: '100%',
        backgroundColor: this.color,
        borderRadius: '3px',
        // Use outline (not border) so the frame has zero layout impact — no
        // content-box inset, so the clip's waveform centerline stays on the
        // track centerline, and toggling selection doesn't shift anything.
        outline: this.selected ? '2px solid #fff' : '2px solid rgba(255,255,255,0.18)',
        outlineOffset: '-2px',
        pointerEvents: 'all',
        overflow: 'hidden',
        zIndex: '2',
      },
    })

    // Name label
    const label = createElement('div', {
      style: {
        position: 'absolute',
        top: '1px',
        left: '4px',
        fontSize: '10px',
        color: '#fff',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 'calc(100% - 8px)',
        pointerEvents: 'auto',
        userSelect: 'none',
        zIndex: '3',
        textShadow: '0 1px 2px rgba(0,0,0,0.5)',
        fontFamily: 'system-ui, sans-serif',
        lineHeight: '14px',
        cursor: 'default',
      },
      textContent: this.name,
    })
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.emit('dblclick', e)
    })
    element.appendChild(label)

    // Canvas for waveform
    const canvas = document.createElement('canvas')
    canvas.style.position = 'absolute'
    canvas.style.top = '0'
    canvas.style.left = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.pointerEvents = 'none'
    this.canvas = canvas
    element.appendChild(canvas)

    // Resize handles
    this.addResizeHandles(element)

    return element
  }

  private addResizeHandles(element: HTMLElement) {
    const handleStyle: Partial<CSSStyleDeclaration> = {
      position: 'absolute',
      zIndex: '4',
      width: '6px',
      height: '100%',
      top: '0',
      cursor: 'ew-resize',
    }

    const leftHandle = createElement('div', {
      style: {
        ...handleStyle,
        left: '0',
        borderLeft: '2px solid rgba(255,255,255,0.5)',
        borderRadius: '3px 0 0 3px',
      } as any,
    })

    const rightHandle = createElement('div', {
      style: {
        ...handleStyle,
        right: '0',
        borderRight: '2px solid rgba(255,255,255,0.5)',
        borderRadius: '0 3px 3px 0',
      } as any,
    })

    element.appendChild(leftHandle)
    element.appendChild(rightHandle)

    const resizeThreshold = 1
    this.subscriptions.push(
      makeDraggable(
        leftHandle,
        (dx) => this.onResize(dx, 'start'),
        () => null,
        () => this.onEndResizing('start'),
        resizeThreshold,
      ),
      makeDraggable(
        rightHandle,
        (dx) => this.onResize(dx, 'end'),
        () => null,
        () => this.onEndResizing('end'),
        resizeThreshold,
      ),
    )
  }

  private initMouseEvents() {
    const { element } = this
    if (!element) return

    element.addEventListener('click', (e) => {
      e.stopPropagation()
      this.emit('click', e)
    })

    element.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.emit('context-menu', e)
    })

    // Track mouse position for cut-line indicator
    element.addEventListener('mousemove', (e) => {
      const rect = element.getBoundingClientRect()
      element.style.setProperty('--cut-x', `${e.clientX - rect.left}px`)
    })

    // Drag
    this.subscriptions.push(
      makeDraggable(
        element,
        (dx) => this.onMove(dx),
        () => {
          element.classList.add('ws-clip--dragging')
        },
        () => {
          element.classList.remove('ws-clip--dragging')
          this.emit('update-end')
        },
      ),
    )
  }

  private onMove(dx: number) {
    if (!this.element?.parentElement) return
    const { width } = this.element.parentElement.getBoundingClientRect()
    const deltaSeconds = (dx / width) * this.totalDuration
    const newStart = this.startTime + deltaSeconds

    if (newStart >= 0) {
      this.startTime = newStart
      this.renderPosition()
      this.emit('update')
    }
  }

  private onResize(dx: number, side: 'start' | 'end') {
    if (!this.element?.parentElement) return
    const { width } = this.element.parentElement.getBoundingClientRect()
    const deltaSeconds = (dx / width) * this.totalDuration

    // During drag, revert to original (un-looped) peaks so buildDisplayPeaks
    // can tile them correctly for the in-progress duration. The store will
    // send final pre-looped peaks via setPeaks() on drag end.
    if (this.peaksPreLooped && this.originalPeaks) {
      this.peaks = this.originalPeaks
      this.peaksPreLooped = false
    }

    if (side === 'start') {
      const newStart = this.startTime + deltaSeconds
      const newDuration = this.duration - deltaSeconds
      if (newStart >= 0 && newDuration > 0.01) {
        this.startTime = newStart
        this.duration = newDuration
        this.renderPosition()
        this.renderWaveform()
        this.emit('update', 'start')
      }
    } else {
      const newDuration = this.duration + deltaSeconds
      if (newDuration > 0.01) {
        this.duration = newDuration
        this.renderPosition()
        this.renderWaveform()
        this.emit('update', 'end')
      }
    }
  }

  private onEndResizing(side: 'start' | 'end') {
    this.emit('update-end', side)
  }

  public renderPosition() {
    if (!this.element) return
    const startPct = (this.startTime / this.totalDuration) * 100
    const widthPct = (this.duration / this.totalDuration) * 100
    this.element.style.left = `${startPct}%`
    this.element.style.width = `${widthPct}%`
  }

  /**
   * Build display peaks that correctly represent looped or truncated audio.
   * When duration > originalDuration, tiles the peaks. When smaller, truncates.
   */
  private buildDisplayPeaks(peaks: number[], numBins: number): number[] {
    const origDur = this.originalDuration
    const curDur = this.duration

    // If peaks are already looped (from store resize), skip re-looping
    if (this.peaksPreLooped) {
      return peaks
    }

    // If durations match (or no original duration info), use peaks as-is
    if (!origDur || origDur <= 0 || Math.abs(curDur - origDur) < 0.001) {
      return peaks
    }

    const result: number[] = new Array(numBins)
    for (let i = 0; i < numBins; i++) {
      // Map this bin's time position, wrapping around for looping
      const timeInNew = ((i + 0.5) / numBins) * curDur
      const timeInOriginal = timeInNew % origDur
      const posInOriginal = timeInOriginal / origDur
      const origIndex = Math.min(
        Math.floor(posInOriginal * peaks.length),
        peaks.length - 1
      )
      result[i] = peaks[origIndex]
    }
    return result
  }

  /** Bin-count ladder for the on-demand peak cache. A target pixel width
   *  is snapped up to the nearest tier so small zoom changes hit the
   *  cache instead of triggering a fresh PCM scan on every frame. Sizes
   *  chosen to bracket typical clip widths on modern displays. */
  private static readonly PEAK_TIERS: readonly number[] = [
    256, 512, 1024, 2048, 4096, 8192, 16384,
  ]

  private tierForBins(target: number): number {
    for (let i = 0; i < ClipBlockImpl.PEAK_TIERS.length; i++) {
      if (ClipBlockImpl.PEAK_TIERS[i] >= target) return ClipBlockImpl.PEAK_TIERS[i]
    }
    // Extreme zoom past the largest tier — fall back to exact count so
    // quality stays pixel-for-pixel. Sample-line rendering takes over
    // past another threshold anyway, so this branch is rarely hit.
    return target
  }

  /** True if any part of this clip overlaps [start, end]. Used by the
   *  plugin's scroll handler to decide which clips need a repaint. */
  public isInTimeRange(start: number, end: number): boolean {
    return this.startTime + this.duration > start && this.startTime < end
  }

  /** True if the clip is inside the wavesurfer's current visible range.
   *  Off-screen clips skip painting; their canvas stays as-is until
   *  they scroll back in (or until an input change marks the paint
   *  state dirty and forces a fresh render). */
  private isInViewport(): boolean {
    if (!this.ownerPlugin) return true
    return this.isInTimeRange(
      this.ownerPlugin.visibleStartTime,
      this.ownerPlugin.visibleEndTime,
    )
  }

  /**
   * Compute peaks from a specific sample range. Used when the clip
   * canvas is a viewport window into a larger clip — we only need the
   * samples that map to the canvas's x-range, not the whole PCM.
   * No caching: scroll moves the range on every frame, cache hit rate
   * would be near zero. The scan is inherently cheap since `end-start`
   * is bounded by viewport width × samples-per-pixel.
   */
  private computePeaksFromPcmRange(
    startSample: number,
    endSample: number,
    bins: number,
    channelIdx: number = 0,
  ): Float32Array | null {
    if (!this.pcm) return null
    const channel = this.pcm[channelIdx] ?? this.pcm[0]
    if (!channel) return null
    const start = Math.max(0, Math.floor(startSample))
    const end = Math.min(channel.length, Math.ceil(endSample))
    const span = end - start
    if (span <= 0 || bins <= 0) return new Float32Array(bins)

    const result = new Float32Array(bins)
    const samplesPerBin = span / bins
    let binIdx = 0
    let nextBoundary = samplesPerBin
    let maxAbs = 0
    for (let i = 0; i < span; i++) {
      const v = channel[start + i]
      const abs = v < 0 ? -v : v
      if (abs > maxAbs) maxAbs = abs
      if (i + 1 >= nextBoundary) {
        result[binIdx++] = maxAbs
        maxAbs = 0
        nextBoundary = (binIdx + 1) * samplesPerBin
      }
    }
    while (binIdx < bins) result[binIdx++] = maxAbs
    return result
  }

  /**
   * Draw one channel's peak envelope, filled and mirrored around a
   * given y-center. Used by both mono (full canvas, centered at
   * pixelH/2) and stereo split (two halves, each centered in its half
   * with its own centerline — Ableton's layout).
   */
  private drawChannelPeaks(
    ctx: CanvasRenderingContext2D,
    peaks: Float32Array | number[],
    pixelW: number,
    yCenter: number,
    yHalfHeight: number,
    color: string,
  ) {
    const n = peaks.length
    if (n === 0) return
    ctx.fillStyle = color
    ctx.beginPath()
    // Top half of the envelope — trace peaks upward from yCenter.
    ctx.moveTo(0, yCenter)
    const scale = pixelW / n
    for (let i = 0; i < n; i++) {
      const mag = peaks[i]
      const absMag = mag < 0 ? -mag : mag
      const h = absMag * yHalfHeight
      ctx.lineTo(i * scale, yCenter - h)
    }
    ctx.lineTo(pixelW, yCenter)
    // Mirror: trace back right-to-left below yCenter to close the fill.
    for (let i = n - 1; i >= 0; i--) {
      const mag = peaks[i]
      const absMag = mag < 0 ? -mag : mag
      const h = absMag * yHalfHeight
      ctx.lineTo(i * scale, yCenter + h)
    }
    ctx.closePath()
    ctx.fill()
  }

  /**
   * Draw a single channel's sample-line view within a vertical region
   * of the canvas. Called once for mono (full canvas) or twice for
   * stereo (top + bottom halves, each with own centerline).
   */
  private drawChannelSampleLine(
    ctx: CanvasRenderingContext2D,
    channel: Float32Array,
    startSample: number,
    endSample: number,
    pixelW: number,
    yCenter: number,
    yHalfHeight: number,
  ) {
    const start = Math.max(0, Math.floor(startSample))
    const end = Math.min(channel.length, Math.ceil(endSample))
    const span = end - start
    if (span <= 1) return

    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = Math.max(1, Math.round(pixelW / span) * 0.5)
    ctx.lineJoin = 'round'
    ctx.beginPath()

    const xScale = pixelW / (span - 1)
    for (let i = 0; i < span; i++) {
      const s = channel[start + i]
      const x = i * xScale
      const y = yCenter - s * yHalfHeight
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // Dots at individual sample positions at extreme zoom.
    const pxPerSample = pixelW / span
    if (pxPerSample >= 8) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      const dotR = Math.max(1.5, Math.min(3, pxPerSample * 0.18))
      for (let i = 0; i < span; i++) {
        const s = channel[start + i]
        const x = i * xScale
        const y = yCenter - s * yHalfHeight
        ctx.beginPath()
        ctx.arc(x, y, dotR, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  /**
   * Extreme-zoom sample-line render. Dispatches mono vs stereo layout.
   * Mono: full-canvas polyline centered at pixelH/2. Stereo: two
   * stacked polylines, each centered in its own half — Ableton style.
   */
  private renderSampleLine(
    ctx: CanvasRenderingContext2D,
    pixelW: number,
    pixelH: number,
    startSample: number,
    endSample: number,
  ) {
    if (!this.pcm || !this.pcm[0]) return

    if (this.pcm.length >= 2 && this.pcm[1]) {
      // Stereo split: each channel gets a full waveform in its half
      // with its own centerline.
      const quarterH = pixelH / 4
      this.drawChannelSampleLine(
        ctx, this.pcm[0], startSample, endSample, pixelW, quarterH, quarterH,
      )
      this.drawChannelSampleLine(
        ctx, this.pcm[1], startSample, endSample, pixelW, 3 * quarterH, quarterH,
      )
    } else {
      // Mono: full canvas, centered.
      const halfH = pixelH / 2
      this.drawChannelSampleLine(
        ctx, this.pcm[0], startSample, endSample, pixelW, halfH, halfH,
      )
    }
  }

  public renderWaveform() {
    if (!this.canvas) return
    // Nothing to draw yet (and no custom renderer either) — skip.
    if (!this.renderContent && !this.pcm && (!this.peaks || this.peaks.length === 0)) return

    // Coalesce rapid re-renders (e.g. during zoom/scroll) into one frame.
    if (this.rafHandle) return
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0
      if (!this.canvas) return
      if (!this.renderContent && !this.pcm && !this.peaks) return

      // Viewport culling: off-screen clips keep their last-painted canvas
      // and skip the work. They'll repaint when they scroll back into
      // view (the plugin's scroll handler calls renderWaveform for them)
      // or when an input change dirties the paint state. Custom
      // renderers (MIDI) opt out since their render is cheap and the
      // miss cost is hard to reason about.
      if (!this.renderContent && !this.isInViewport()) return

      const clipEl = this.element
      if (!clipEl) return
      const clipRect = clipEl.getBoundingClientRect()
      const clipWidthCss = Math.max(1, clipRect.width)

      // Match the WaveSurfer canvases height so centerlines align.
      // The clips container is a child of .wrapper; .canvases is a sibling.
      // WaveSurfer canvases have explicit pixel height (default 128px) anchored to top:0,
      // so the clip canvas must use the same CSS height (not 100% of the clip element).
      const wrapper = clipEl.parentElement?.parentElement
      const canvasesDiv = wrapper?.querySelector(':scope > [part="canvases"]') as HTMLElement | null
      const cssH = canvasesDiv ? canvasesDiv.clientHeight : Math.ceil(clipRect.height)

      // Viewport windowing. At high zoom, clip CSS width can reach
      // hundreds of thousands of pixels — way past the browser's ~16K
      // canvas limit. Instead of sizing canvas to the full clip, we
      // only size/position it to cover the scroll-visible portion (plus
      // a scroll-margin so small scrolls don't force a repaint).
      //
      // Canvas position "sticks" as long as the current visible range
      // still fits inside it — then scroll events just move the clip
      // element through the viewport with the canvas along for the
      // ride, no repaints. Repositioning only happens when the viewport
      // edge approaches or exits the canvas coverage.
      const scrollEl = this.ownerPlugin?.getScrollEl() ?? null
      const SCROLL_MARGIN_CSS = 600
      let canvasLeftCss: number
      let canvasWidthCss: number
      if (scrollEl) {
        const scrollRect = scrollEl.getBoundingClientRect()
        const visibleLeftInClip = Math.max(0, scrollRect.left - clipRect.left)
        const visibleRightInClip = Math.min(
          clipWidthCss,
          scrollRect.right - clipRect.left,
        )

        // If last canvas still covers the visible range (including a
        // small safety gap), reuse it. Otherwise re-center on visible
        // area with the full scroll margin.
        const last = this.lastPaintState
        const sameZoomAndData =
          last &&
          last.duration === this.duration &&
          last.originalDuration === this.originalDuration &&
          last.pcmRef === (this.pcm?.[0] ?? null) &&
          last.peaksRef === this.peaks &&
          last.peaksPreLooped === this.peaksPreLooped
        const REBUILD_GAP_CSS = 100
        if (
          sameZoomAndData &&
          last.canvasLeftCss <= visibleLeftInClip - REBUILD_GAP_CSS &&
          last.canvasLeftCss + last.canvasWidthCss >=
            visibleRightInClip + REBUILD_GAP_CSS
        ) {
          canvasLeftCss = last.canvasLeftCss
          canvasWidthCss = last.canvasWidthCss
        } else {
          canvasLeftCss = Math.max(0, visibleLeftInClip - SCROLL_MARGIN_CSS)
          const canvasRightCss = Math.min(
            clipWidthCss,
            visibleRightInClip + SCROLL_MARGIN_CSS,
          )
          canvasWidthCss = Math.max(0, canvasRightCss - canvasLeftCss)
        }
      } else {
        // Fallback for headless / no scroll ancestor — full clip width.
        canvasLeftCss = 0
        canvasWidthCss = clipWidthCss
      }

      if (canvasWidthCss <= 0) return

      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const pixelW = Math.max(1, Math.round(canvasWidthCss * dpr))
      const pixelH = Math.max(1, Math.round(cssH * dpr))

      // Sample range that maps to this canvas window within the clip.
      // Derived from the clip's CSS width, so it's independent of any
      // internal sample-rate / duration fields drifting from reality.
      const totalSamples = this.pcm?.[0]?.length ?? 0
      const samplesPerCssPx = totalSamples > 0 ? totalSamples / clipWidthCss : 0
      const startSample = Math.floor(canvasLeftCss * samplesPerCssPx)
      const endSample = Math.ceil((canvasLeftCss + canvasWidthCss) * samplesPerCssPx)

      // Short-circuit when nothing material changed since the last paint.
      // Canvas position + sample range are part of the key so a scroll
      // or zoom that shifts the window forces a repaint.
      const pcmRef = this.pcm?.[0] ?? null
      const tierBins = this.pcm && !this.peaksPreLooped ? this.tierForBins(pixelW) : 0
      if (
        !this.renderContent &&
        this.lastPaintState &&
        this.lastPaintState.pixelW === pixelW &&
        this.lastPaintState.pixelH === pixelH &&
        this.lastPaintState.pcmRef === pcmRef &&
        this.lastPaintState.peaksRef === this.peaks &&
        this.lastPaintState.peaksPreLooped === this.peaksPreLooped &&
        this.lastPaintState.bins === tierBins &&
        this.lastPaintState.duration === this.duration &&
        this.lastPaintState.originalDuration === this.originalDuration &&
        this.lastPaintState.canvasLeftCss === canvasLeftCss &&
        this.lastPaintState.canvasWidthCss === canvasWidthCss &&
        this.lastPaintState.startSample === startSample &&
        this.lastPaintState.endSample === endSample &&
        this.canvas.width === pixelW &&
        this.canvas.height === pixelH
      ) {
        return
      }

      // Position + size the canvas within the clip element. Overrides
      // the 100% width baked into initElement so the canvas can be a
      // moving viewport window at high zoom.
      this.canvas.style.left = `${canvasLeftCss}px`
      this.canvas.style.width = `${canvasWidthCss}px`
      this.canvas.style.height = `${cssH}px`

      if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
        this.canvas.width = pixelW
        this.canvas.height = pixelH
      }

      const ctx = this.canvas.getContext('2d')
      if (!ctx) return

      ctx.clearRect(0, 0, pixelW, pixelH)

      const persistPaintState = () => {
        this.lastPaintState = {
          pixelW, pixelH, pcmRef, peaksRef: this.peaks,
          peaksPreLooped: this.peaksPreLooped, bins: tierBins,
          duration: this.duration, originalDuration: this.originalDuration,
          canvasLeftCss, canvasWidthCss, startSample, endSample,
        }
      }

      // Custom renderer (MIDI clips) takes precedence. These get the
      // full-clip canvas (not windowed) because MIDI note positions
      // are computed against clip coordinates — windowing would require
      // a protocol update for the render callback.
      if (this.renderContent) {
        // Restore full-width for custom renderers.
        this.canvas.style.left = '0'
        this.canvas.style.width = '100%'
        const fullPixelW = Math.max(1, Math.round(clipWidthCss * dpr))
        if (this.canvas.width !== fullPixelW) this.canvas.width = fullPixelW
        ctx.clearRect(0, 0, fullPixelW, pixelH)
        this.renderContent(ctx, fullPixelW, pixelH, this)
        return
      }

      // PCM-based rendering. Only kicks in when the clip hasn't been
      // resized past its original length (peaksPreLooped is the tile
      // case — we reuse the precomputed looped peaks there because
      // tiling samples at render time is extra work for a path that
      // rarely sees extreme zoom anyway).
      if (this.pcm && this.pcm[0] && this.pcm[0].length > 0 && !this.peaksPreLooped) {
        const samplesInWindow = endSample - startSample
        const samplesPerPixel = samplesInWindow / pixelW

        // Sample-accurate line when we have roughly one sample per pixel
        // or better — Ableton's extreme-zoom view.
        if (samplesPerPixel < 1.5) {
          this.renderSampleLine(ctx, pixelW, pixelH, startSample, endSample)
          persistPaintState()
          return
        }

        // Otherwise compute peaks for just the samples that fall in the
        // canvas window, at the canvas's actual pixel width. For stereo
        // clips, render each channel in its own vertical half with its
        // own centerline (Ableton layout).
        const waveColor = 'rgba(255,255,255,0.4)'
        if (this.pcm.length >= 2 && this.pcm[1]) {
          const peaksL = this.computePeaksFromPcmRange(
            startSample, endSample, pixelW, 0,
          )
          const peaksR = this.computePeaksFromPcmRange(
            startSample, endSample, pixelW, 1,
          )
          if (peaksL && peaksR) {
            const quarterH = pixelH / 4
            this.drawChannelPeaks(ctx, peaksL, pixelW, quarterH, quarterH, waveColor)
            this.drawChannelPeaks(ctx, peaksR, pixelW, 3 * quarterH, quarterH, waveColor)
            persistPaintState()
            return
          }
        } else {
          const rangePeaks = this.computePeaksFromPcmRange(
            startSample, endSample, pixelW, 0,
          )
          if (rangePeaks) {
            this.drawChannelPeaks(
              ctx, rangePeaks, pixelW, pixelH / 2, pixelH / 2, waveColor,
            )
            persistPaintState()
            return
          }
        }
      }

      // Fallback: precomputed peak bars (tiled clips, or PCM not yet
      // loaded — e.g. during P2P audio sync). buildDisplayPeaks runs
      // against the full clip peaks; we slice the result to the canvas
      // window so positions still line up. Always mono — the precomputed
      // peaks path only has one channel of data.
      if (this.peaks) {
        const fullBins = Math.max(
          Math.round(clipWidthCss * dpr),
          this.peaks.length,
        )
        const fullPeaks = this.buildDisplayPeaks(this.peaks, fullBins)
        const sliceStart = Math.floor((canvasLeftCss / clipWidthCss) * fullBins)
        const sliceEnd = Math.ceil(
          ((canvasLeftCss + canvasWidthCss) / clipWidthCss) * fullBins,
        )
        const slicedPeaks = fullPeaks.slice(sliceStart, sliceEnd)
        this.drawChannelPeaks(
          ctx,
          slicedPeaks,
          pixelW,
          pixelH / 2,
          pixelH / 2,
          'rgba(255,255,255,0.4)',
        )
        persistPaintState()
      }
    })
  }

  public setSelected(selected: boolean) {
    this.selected = selected
    if (this.element) {
      this.element.style.outline = selected
        ? '2px solid #fff'
        : '2px solid rgba(255,255,255,0.18)'
    }
  }

  public setColor(color: string) {
    this.color = color
    if (this.element) {
      this.element.style.backgroundColor = color
    }
  }

  public setName(name: string) {
    this.name = name
    if (this.element) {
      const label = this.element.querySelector('div') as HTMLElement
      if (label) label.textContent = name
    }
  }

  public getLabelElement(): HTMLElement | null {
    if (!this.element) return null
    return this.element.querySelector('div') as HTMLElement | null
  }

  public setPeaks(peaks: number[] | null, preLooped = false) {
    this.peaks = peaks
    this.peaksPreLooped = preLooped
    if (!preLooped && peaks) {
      // Save the original un-looped peaks for use during resize drags
      this.originalPeaks = [...peaks]
    }
    // Invalidate the paint-state snapshot so the short-circuit doesn't
    // skip this update.
    this.lastPaintState = null
    this.renderWaveform()
  }

  /**
   * Swap in new PCM (e.g. after a non-destructive edit recomputed
   * effective audio). Invalidates the per-bin peak cache so the next
   * render reflects the new samples. Pass null to clear and fall back
   * to the precomputed peaks path.
   */
  public setPcm(pcm: Float32Array[] | null, sampleRate?: number) {
    // Skip the cascade when nothing actually changed — avoids useless
    // repaints on every AudioTrack sync tick for clips whose PCM ref
    // hasn't been swapped.
    const nextRef = pcm?.[0] ?? null
    const prevRef = this.pcm?.[0] ?? null
    const sampleRateChanged = sampleRate != null && sampleRate !== this.sampleRate
    if (nextRef === prevRef && !sampleRateChanged) return
    this.pcm = pcm
    if (sampleRate != null) this.sampleRate = sampleRate
    this.lastPaintState = null
    this.renderWaveform()
  }

  public setRenderContent(fn: ClipRenderFn | undefined) {
    this.renderContent = fn
    // Transitioning between custom-render and default-render paths
    // changes what the short-circuit would consider equal — invalidate.
    this.lastPaintState = null
    this.renderWaveform()
  }

  public setData(data: any) {
    this.data = data
    // Custom renderers read from `data`; bypass short-circuit for them.
    this.lastPaintState = null
    this.renderWaveform()
  }

  public setOriginalDuration(dur: number) {
    this.originalDuration = dur
  }

  public updateTotalDuration(totalDuration: number) {
    this.totalDuration = Math.max(totalDuration, 0.001)
    this.renderPosition()
  }

  public remove() {
    this.emit('remove')
    this.subscriptions.forEach((unsub) => unsub())
    this.subscriptions = []
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = 0
    }
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element)
    }
    this.isRemoved = true
    this.element = null
    this.canvas = null
    this.pcm = null
    this.lastPaintState = null
  }
}

class ClipsPlugin extends BasePlugin<ClipsPluginEvents, ClipsPluginOptions> {
  private clips: ClipBlockImpl[] = []
  private container: HTMLElement | null = null
  private totalDuration = 0
  /**
   * Current horizontal viewport in seconds. Clips outside this range
   * short-circuit their render call so many-clip projects don't pay
   * the canvas-paint cost for every off-screen clip on each zoom/redraw.
   * Defaults cover everything until wavesurfer emits its first scroll
   * event (ensures initial render shows all clips).
   */
  public visibleStartTime = -Infinity
  public visibleEndTime = Infinity
  // Cached references to wavesurfer's wrapper (holds the clip container)
  // and its scrolling parent. Clips use these to compute viewport-sized
  // canvas positions instead of canvases that grow with zoom level.
  private wrapperEl: HTMLElement | null = null
  private scrollEl: HTMLElement | null = null

  constructor(options?: ClipsPluginOptions) {
    super(options as ClipsPluginOptions)
  }

  public getWrapperEl(): HTMLElement | null {
    return this.wrapperEl
  }

  public getScrollEl(): HTMLElement | null {
    return this.scrollEl
  }

  public static create(options?: ClipsPluginOptions) {
    return new ClipsPlugin(options)
  }

  protected onInit() {
    if (!this.wavesurfer) return

    // Create container overlay on the waveform wrapper
    const wrapper = this.wavesurfer.getWrapper()
    this.wrapperEl = wrapper
    this.scrollEl = wrapper.parentElement
    this.container = createElement('div', {
      style: {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '3',
        overflow: 'hidden',
      },
    })
    wrapper.appendChild(this.container)
    wrapper.style.position = 'relative'

    // Track duration changes
    this.totalDuration = this.wavesurfer.getDuration() || 1
    this.subscriptions.push(
      this.wavesurfer.on('decode', () => {
        this.totalDuration = this.wavesurfer?.getDuration() || 1
        this.updateAllClipPositions()
      }),
    )
    this.subscriptions.push(
      this.wavesurfer.on('zoom', () => {
        // Re-render waveforms on zoom since canvas dimensions change
        this.clips.forEach((clip) => clip.renderWaveform())
      }),
    )
    this.subscriptions.push(
      this.wavesurfer.on('redraw', () => {
        // Re-render waveforms when track height changes
        this.clips.forEach((clip) => clip.renderWaveform())
      }),
    )
    this.subscriptions.push(
      this.wavesurfer.on('scroll', (startTime: number, endTime: number) => {
        // Record the visible time range so clips can cull themselves.
        // Off-screen clips keep their last-painted canvas content; when
        // scrolled back into view, the renderWaveform call short-circuits
        // if paint state hasn't changed, or repaints if it has (e.g.
        // canvas dims changed due to a zoom while the clip was hidden).
        this.visibleStartTime = startTime
        this.visibleEndTime = endTime
        for (const clip of this.clips) {
          if (clip.isInTimeRange(startTime, endTime)) {
            clip.renderWaveform()
          }
        }
      }),
    )
  }

  /**
   * Add a clip to the timeline.
   */
  public addClip(params: ClipParams): ClipBlockImpl {
    const clip = new ClipBlockImpl(params, this.totalDuration, this)

    if (clip.element && this.container) {
      this.container.appendChild(clip.element)
    }

    // Forward clip events to plugin events
    clip.on('click', (e) => this.emit('clip-clicked', clip, e))
    clip.on('dblclick', (e) => this.emit('clip-dblclick', clip, e))
    clip.on('context-menu', (e) => this.emit('clip-context-menu', clip, e))
    clip.on('update-end', (side) => {
      if (side === 'start' || side === 'end') {
        this.emit('clip-resize-end', clip, side)
      } else {
        this.emit('clip-drag-end', clip)
      }
    })

    this.clips.push(clip)
    this.emit('clip-added', clip)
    return clip
  }

  /**
   * Remove a clip by ID.
   */
  public removeClip(id: string) {
    const idx = this.clips.findIndex((c) => c.id === id)
    if (idx === -1) return

    const clip = this.clips[idx]
    this.clips.splice(idx, 1)
    clip.remove()
    this.emit('clip-removed', clip)
  }

  /**
   * Get a clip by ID.
   */
  public getClip(id: string): ClipBlockImpl | undefined {
    return this.clips.find((c) => c.id === id)
  }

  /**
   * Get all clips.
   */
  public getClips(): ClipBlockImpl[] {
    return this.clips
  }

  /**
   * Clear all clips.
   */
  public clearClips() {
    for (const clip of [...this.clips]) {
      clip.remove()
    }
    this.clips = []
  }

  /**
   * Update the total timeline duration and reposition all clips.
   */
  public setTotalDuration(duration: number) {
    this.totalDuration = Math.max(duration, 0.001)
    this.updateAllClipPositions()
  }

  private updateAllClipPositions() {
    for (const clip of this.clips) {
      clip.updateTotalDuration(this.totalDuration)
    }
  }

  public destroy() {
    this.clearClips()
    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container)
    }
    this.container = null
    super.destroy()
  }
}

export default ClipsPlugin
export type ClipBlock = ClipBlockImpl
