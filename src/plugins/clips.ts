/**
 * Clips plugin for WaveSurfer.
 * Renders arrangement clips as visual blocks on the waveform timeline.
 * Each clip has a mini-waveform canvas, drag-to-move, and edge resize handles.
 */

import BasePlugin, { type BasePluginEvents } from '../base-plugin.js'
import { makeDraggable } from '../draggable.js'
import EventEmitter from '../event-emitter.js'
import createElement from '../dom.js'
import { renderWaveform } from '../render-waveform.js'

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
  public selected: boolean
  public renderContent: ClipRenderFn | undefined
  public data: any
  public subscriptions: (() => void)[] = []
  private totalDuration: number
  private isRemoved = false

  constructor(params: ClipParams, totalDuration: number) {
    super()
    this.id = params.id
    this.startTime = Math.max(0, params.startTime)
    this.duration = Math.max(0, params.duration)
    this.originalDuration = params.originalDuration ?? this.duration
    this.color = params.color ?? 'rgba(56, 178, 172, 0.6)'
    this.name = params.name ?? ''
    this.peaks = params.peaks ?? null
    this.selected = params.selected ?? false
    this.renderContent = params.renderContent
    this.data = params.data
    this.totalDuration = Math.max(totalDuration, 0.001)
    this.element = this.initElement()
    this.renderPosition()
    this.renderWaveform()
    this.initMouseEvents()
  }

  private initElement(): HTMLElement | null {
    if (this.isRemoved) return null

    const element = createElement('div', {
      style: {
        position: 'absolute',
        top: '0',
        height: '100%',
        backgroundColor: this.color,
        borderRadius: '3px',
        boxSizing: 'border-box',
        border: this.selected ? '2px solid #fff' : '1px solid rgba(255,255,255,0.3)',
        cursor: 'grab',
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

    // Drag
    this.subscriptions.push(
      makeDraggable(
        element,
        (dx) => this.onMove(dx),
        () => {
          if (element.style) element.style.cursor = 'grabbing'
        },
        () => {
          if (element.style) element.style.cursor = 'grab'
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

  public renderWaveform() {
    if (!this.canvas) return
    // For custom-rendered clips, peaks are optional
    if (!this.renderContent && (!this.peaks || this.peaks.length === 0)) return

    // Debounce canvas sizing to avoid layout thrashing
    requestAnimationFrame(() => {
      if (!this.canvas) return
      if (!this.renderContent && !this.peaks) return

      const clipEl = this.canvas.parentElement
      const rect = clipEl?.getBoundingClientRect()
      const cssW = rect ? Math.ceil(rect.width) : 200

      // Match the WaveSurfer canvases height so centerlines align.
      // The clips container is a child of .wrapper; .canvases is a sibling.
      // WaveSurfer canvases have explicit pixel height (default 128px) anchored to top:0,
      // so the clip canvas must use the same CSS height (not 100% of the clip element).
      const wrapper = clipEl?.parentElement?.parentElement
      const canvasesDiv = wrapper?.querySelector(':scope > [part="canvases"]') as HTMLElement | null
      const cssH = canvasesDiv ? canvasesDiv.clientHeight : rect ? Math.ceil(rect.height) : 40

      // Update CSS height to match WaveSurfer canvases (not stretch to 100%)
      this.canvas.style.height = `${cssH}px`

      const dpr = Math.max(1, window.devicePixelRatio || 1)
      const pixelW = Math.round(cssW * dpr)
      const pixelH = Math.round(cssH * dpr)

      if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
        this.canvas.width = pixelW
        this.canvas.height = pixelH
      }

      const ctx = this.canvas.getContext('2d')
      if (!ctx) return

      ctx.clearRect(0, 0, pixelW, pixelH)

      // Use custom render function if provided, otherwise render waveform
      if (this.renderContent) {
        this.renderContent(ctx, pixelW, pixelH, this)
      } else if (this.peaks) {
        // Build display peaks with looping/truncation applied
        const displayBins = Math.max(pixelW, this.peaks.length)
        const displayPeaks = this.buildDisplayPeaks(this.peaks, displayBins)

        renderWaveform([displayPeaks], ctx, {
          waveColor: 'rgba(255,255,255,0.4)',
        })
      }
    })
  }

  public setSelected(selected: boolean) {
    this.selected = selected
    if (this.element) {
      this.element.style.border = selected
        ? '2px solid #fff'
        : '1px solid rgba(255,255,255,0.3)'
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

  public setPeaks(peaks: number[] | null) {
    this.peaks = peaks
    this.renderWaveform()
  }

  public setRenderContent(fn: ClipRenderFn | undefined) {
    this.renderContent = fn
    this.renderWaveform()
  }

  public setData(data: any) {
    this.data = data
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
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element)
    }
    this.isRemoved = true
    this.element = null
    this.canvas = null
  }
}

class ClipsPlugin extends BasePlugin<ClipsPluginEvents, ClipsPluginOptions> {
  private clips: ClipBlockImpl[] = []
  private container: HTMLElement | null = null
  private totalDuration = 0

  constructor(options?: ClipsPluginOptions) {
    super(options as ClipsPluginOptions)
  }

  public static create(options?: ClipsPluginOptions) {
    return new ClipsPlugin(options)
  }

  protected onInit() {
    if (!this.wavesurfer) return

    // Create container overlay on the waveform wrapper
    const wrapper = this.wavesurfer.getWrapper()
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
  }

  /**
   * Add a clip to the timeline.
   */
  public addClip(params: ClipParams): ClipBlockImpl {
    const clip = new ClipBlockImpl(params, this.totalDuration)

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
