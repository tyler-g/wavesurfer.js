/**
 * Clips plugin for WaveSurfer.
 * Renders arrangement clips as visual blocks on the waveform timeline.
 * Each clip has a mini-waveform canvas, drag-to-move, and edge resize handles.
 */

import BasePlugin, { type BasePluginEvents } from '../base-plugin.js'
import { makeDraggable } from '../draggable.js'
import EventEmitter from '../event-emitter.js'
import createElement from '../dom.js'
import {
  computeClipSampleWindow,
  computeContentPixelWidth,
  computeLoopSeamTimes,
  snapToGridPoint,
  wrapTileTime,
} from '../clip-render-math.js'

export type ClipsPluginOptions =
  | {
      /**
       * Draw a thin horizontal line through the vertical center of each
       * clip channel in silent regions. Defaults to `false` — silent
       * audio collapses to empty space (Ableton-style). Set to `true` to
       * restore a visible midline even when amplitude is zero.
       */
      showCenterLine?: boolean
    }
  | undefined

export type ClipsPluginEvents = BasePluginEvents & {
  'clip-added': [clip: ClipBlockImpl]
  'clip-removed': [clip: ClipBlockImpl]
  /** Continuous during a body drag (one per pointer move) — lets the host
   *  live-preview group moves of a multi-selection. Resize does NOT emit
   *  this; it fires 'update' with a side. */
  'clip-drag': [clip: ClipBlockImpl]
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
 * `width` is the clip's content width in device pixels and may be
 * FRACTIONAL — it is the exact (unrounded) time→pixel scale basis, kept
 * stable across resize-drag repaints; the backing bitmap is the rounded
 * width, so content near the last partial pixel is cropped.
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
  /** Whether the clip's audio loops a sub-region of the source PCM. When
   *  true with a positive-length region, the waveform render tiles that
   *  region across `duration` so the visual matches what's played. */
  loopEnabled?: boolean
  /** Start of the loop region in source-PCM seconds. */
  loopStartSec?: number
  /** End of the loop region in source-PCM seconds. */
  loopEndSec?: number
  /** Phase offset (source-PCM seconds) folded into the tile time before
   *  wrapping into the loop region. Lets a growing/mid-capture clip's
   *  tile origin track the live source position instead of always
   *  starting the tile at `loopStartSec`. Defaults to 0, which reduces
   *  every phase-aware expression to today's phase-less behavior. */
  loopPhaseSec?: number
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
  // Loop region — when active, render tiles [loopStartSec, loopEndSec) of
  // the source PCM across this.duration. Mirrors the audio engine's
  // `sourceNode.loop` / `loopStart` / `loopEnd` semantics.
  public loopEnabled: boolean = false
  public loopStartSec: number = 0
  public loopEndSec: number = 0
  public loopPhaseSec: number = 0
  /** Cumulative left-edge movement (seconds; positive = extended left) of
   *  the CURRENT resize drag. Read by paintPhaseSec (and by custom content
   *  renderers via the block reference) to keep painted content anchored to
   *  the timeline mid-drag. Reset in onEndResizing. */
  public resizeStartDeltaSec = 0
  /** Duration when the current resize drag began (null = no drag). */
  private dragStartDuration: number | null = null
  /** Source-domain extent bound for trim-mode clamps, captured per drag. */
  private dragStartExtent = 0
  /** Which edge the in-progress resize drag is on (null = no drag). */
  private activeResizeSide: 'start' | 'end' | null = null
  /**
   * UNSNAPPED virtual edge positions for the current resize drag. Loop-
   * seam snapping applies to these, not to the applied values — snapping
   * the applied position directly would trap the edge at the seam (every
   * subsequent small delta re-snaps). Null outside drags.
   */
  private dragVirtualStart: number | null = null
  private dragVirtualDuration: number | null = null
  /** Timeline position of a tile-grid origin, captured at drag start —
   *  the (drag-stable) left-edge snap targets are this + k·loopLen. */
  private dragSeamGridOrigin = 0
  /**
   * Lead-in painted LEFT of the clip start (seconds), custom-content
   * clips only. During a left-edge drag the bitmap is painted once
   * covering [clipStart − lead, clipEnd] and the canvas then SLIDES
   * inside the element instead of repainting — repainting every frame
   * rasterizes the counter-compensated content independently of the
   * moving element position, and the two sub-pixel roundings disagree
   * frame to frame (residual note jitter + seam re-shuffle flicker).
   * Read by renderContent callbacks via the block reference.
   */
  public paintLeadInSec = 0
  /** resizeStartDeltaSec at the time the current bitmap was painted. */
  private paintAnchorDeltaSec = 0
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
    // Clip element width at paint time — the zoom level. Window reuse
    // must break when zoom changes: a stale window can hang past the
    // right edge of a shrinking clip, and the out-of-range tail makes
    // the repaint stretch (jitter during zoom-out).
    clipWidthCss: number
    // Canvas window within the clip element, for viewport virtualization.
    canvasLeftCss: number
    canvasWidthCss: number
    startSample: number
    endSample: number
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    loopPhaseSec: number
  } | null = null
  /** Reference to the owning plugin so the clip can read the shared
   *  visible-time range for viewport culling. */
  private ownerPlugin: ClipsPlugin | undefined

  /**
   * Ableton-style body-drag ghost. During a move the clip element itself
   * STAYS at its committed position; a translucent clone (canvas bitmaps
   * blitted once at drag start — no waveform recompute) tracks the pointer,
   * snapped to the grid when the host's snapConfig is enabled. The clip
   * commits to the ghost position on release. Hosts can also drive a ghost
   * directly via showDragGhost()/hideDragGhost() to preview group moves of
   * clips that aren't the one being dragged.
   */
  private dragGhostEl: HTMLElement | null = null
  /** Unsnapped pointer-follow position of the in-progress body drag. */
  private dragVirtualTime: number | null = null
  /** Where the ghost currently sits — the position a release would commit.
   *  Null when no body drag / host preview is active. */
  public dragTargetTime: number | null = null

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
    this.loopEnabled = params.loopEnabled ?? false
    this.loopStartSec = params.loopStartSec ?? 0
    this.loopEndSec = params.loopEndSec ?? 0
    this.loopPhaseSec = params.loopPhaseSec ?? 0
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

    // Dblclick anywhere on the clip body emits the same event. The label's
    // listener stopPropagation()s so this only fires for dblclicks NOT on the
    // label, letting consumers disambiguate label vs body by event target.
    element.addEventListener('dblclick', (e) => {
      this.emit('dblclick', e)
    })

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

    // Track mouse position for cut-line indicator. When the host app has
    // snap-to-grid enabled, the indicator jumps to the nearest grid line so
    // the cut cursor reflects where the split will actually land. With snap
    // off (or no grid), it follows the pointer freely.
    element.addEventListener('mousemove', (e) => {
      const rect = element.getBoundingClientRect()
      let offsetPx = e.clientX - rect.left
      const snap = this.ownerPlugin?.snapConfig
      if (snap?.enabled && snap.gridSeconds > 0 && rect.width > 0 && this.duration > 0) {
        // px → absolute time → snapped absolute time → px
        const absTime = this.startTime + (offsetPx / rect.width) * this.duration
        const snappedAbs = Math.round(absTime / snap.gridSeconds) * snap.gridSeconds
        const snappedPx = ((snappedAbs - this.startTime) / this.duration) * rect.width
        // Keep the indicator within the clip when the nearest grid line lies
        // outside it (clip narrower than one grid division).
        offsetPx = Math.max(0, Math.min(rect.width, snappedPx))
      }
      element.style.setProperty('--cut-x', `${offsetPx}px`)
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
          // Commit the ghost position, then clean up before emitting so the
          // host's update-end handler sees the final startTime on the block.
          if (this.dragTargetTime != null) {
            this.startTime = this.dragTargetTime
            this.renderPosition()
          }
          this.hideDragGhost()
          this.emit('update-end')
        },
      ),
    )
  }

  private onMove(dx: number) {
    if (!this.element?.parentElement) return
    const { width } = this.element.parentElement.getBoundingClientRect()
    const deltaSeconds = (dx / width) * this.totalDuration

    // Ableton-style move: the clip element stays at its committed position;
    // a translucent ghost tracks the pointer — snapped to the nearest grid
    // line when the host's snap config is enabled, free otherwise — and the
    // release commits wherever the ghost sits.
    const base = this.dragVirtualTime ?? this.startTime
    const virtual = Math.max(0, base + deltaSeconds)
    this.dragVirtualTime = virtual

    const snap = this.ownerPlugin?.snapConfig
    let target = virtual
    if (snap?.enabled && snap.gridSeconds > 0) {
      target = Math.round(virtual / snap.gridSeconds) * snap.gridSeconds
    }
    this.showDragGhost(Math.max(0, target))
    this.emit('update')
  }

  /**
   * Build the ghost: a deep clone of the clip element. cloneNode leaves
   * canvas bitmaps blank, so each canvas is blitted from its source once —
   * after that a drag only updates style.left.
   */
  private buildDragGhost(): HTMLElement | null {
    if (!this.element?.parentElement) return null
    const ghost = this.element.cloneNode(true) as HTMLElement
    const srcCanvases = this.element.querySelectorAll('canvas')
    const dstCanvases = ghost.querySelectorAll('canvas')
    srcCanvases.forEach((src, i) => {
      const dst = dstCanvases[i] as HTMLCanvasElement | undefined
      const srcCanvas = src as HTMLCanvasElement
      if (!dst || srcCanvas.width === 0 || srcCanvas.height === 0) return
      dst.width = srcCanvas.width
      dst.height = srcCanvas.height
      dst.getContext('2d')?.drawImage(srcCanvas, 0, 0)
    })
    ghost.classList.add('ws-clip-ghost')
    ghost.classList.remove('ws-clip--dragging')
    ghost.style.opacity = '0.45'
    ghost.style.pointerEvents = 'none'
    this.element.parentElement.appendChild(ghost)
    return ghost
  }

  /** Show (creating on first call) the drag ghost at `startTime`. */
  public showDragGhost(startTime: number) {
    if (!this.dragGhostEl) this.dragGhostEl = this.buildDragGhost()
    if (!this.dragGhostEl) return
    this.dragTargetTime = Math.max(0, startTime)
    const leftPct = (this.dragTargetTime / this.totalDuration) * 100
    this.dragGhostEl.style.left = `${leftPct}%`
  }

  /** Remove the drag ghost and clear drag-preview state. */
  public hideDragGhost() {
    this.dragGhostEl?.remove()
    this.dragGhostEl = null
    this.dragTargetTime = null
    this.dragVirtualTime = null
  }

  private onResize(dx: number, side: 'start' | 'end') {
    if (!this.element?.parentElement) return
    const { width } = this.element.parentElement.getBoundingClientRect()
    let deltaSeconds = (dx / width) * this.totalDuration

    // Capture per-drag anchors on the first move. dragStartExtent is the
    // source-domain bound for trim-mode clamps: normally the source content
    // length, but never less than the clip's current window so legacy
    // over-stretched clips can shrink without a jarring snap (they just
    // can't grow further).
    if (this.dragStartDuration === null) {
      this.dragStartDuration = this.duration
      this.dragStartExtent = Math.max(
        this.originalDuration || 0,
        (this.loopPhaseSec ?? 0) + this.duration,
      )
      this.dragVirtualStart = this.startTime
      this.dragVirtualDuration = this.duration
      // Timeline position of a tile-grid origin (left edge minus its
      // in-loop phase). Drag-stable: the left-edge seam-snap targets are
      // this + k·loopLen for any integer k.
      const seamLoopLen = this.loopEndSec - this.loopStartSec
      this.dragSeamGridOrigin =
        this.loopEnabled && seamLoopLen > 0.0001
          ? this.startTime - this.paintPhaseSec(seamLoopLen)
          : 0
    }
    this.activeResizeSide = side

    // Trim mode (no loop tiling): edges are bounded by the source content —
    // the left edge stops when the source-start offset reaches 0, the right
    // edge when offset + duration reaches the source extent. Loop-enabled
    // clips extend freely (tiling). Session-bounced clips are loop-enabled;
    // directly-recorded clips are not — this is what makes them trim-only.
    // A degenerate loop region (loopEndSec <= loopStartSec) must NOT count
    // as "loop tiling" — matches the engine's loopIsActive predicate
    // (arrangement-engine.ts) so the fork and engine agree on which clips
    // are trim-mode.
    const trimMode =
      !(this.loopEnabled && this.loopEndSec - this.loopStartSec > 0.0001) &&
      (this.originalDuration || 0) > 0.0001

    // During drag, revert to original (un-looped) peaks so buildDisplayPeaks
    // can tile them correctly for the in-progress duration. The store will
    // send final pre-looped peaks via setPeaks() on drag end.
    if (this.peaksPreLooped && this.originalPeaks) {
      this.peaks = this.originalPeaks
      this.peaksPreLooped = false
    }

    // Loop-seam magnet: loop-tiled clips snap a dragged edge onto the
    // nearest tile boundary when within reach — independent of the host's
    // snap-to-grid setting (a bounced clip landing exactly on its loop
    // point is almost always what the user wants). Snapping is computed
    // against the VIRTUAL (unsnapped) edge so the magnet can be escaped.
    const snapThresholdSec = trimMode ? 0 : this.loopSnapThresholdSec(width)
    const snapLoopLen = this.loopEndSec - this.loopStartSec

    if (side === 'start') {
      this.dragVirtualStart =
        (this.dragVirtualStart ?? this.startTime) + deltaSeconds
      let targetStart = this.dragVirtualStart
      if (snapThresholdSec > 0) {
        const snapped = snapToGridPoint(
          targetStart,
          snapLoopLen,
          this.dragSeamGridOrigin,
          snapThresholdSec,
        )
        if (snapped != null && snapped >= 0) targetStart = snapped
      }
      let stepDelta = targetStart - this.startTime
      let newStart = this.startTime + stepDelta
      let newDuration = this.duration - stepDelta
      if (trimMode) {
        // Left edge cannot reveal earlier than the source start (offset 0).
        const nextAccum = this.resizeStartDeltaSec - stepDelta
        const newOffset = (this.loopPhaseSec ?? 0) - nextAccum
        if (newOffset < 0) {
          const excess = -newOffset
          newStart += excess
          newDuration -= excess
          stepDelta += excess
        }
      }
      if (stepDelta !== 0 && newStart >= 0 && newDuration > 0.01) {
        this.startTime = newStart
        this.duration = newDuration
        // Track cumulative left-edge movement (positive = extended left) so
        // painting can keep content timeline-anchored mid-drag.
        this.resizeStartDeltaSec -= stepDelta
        this.renderPosition()
        this.repaintForResizeDrag('start')
        this.emit('update', 'start')
      }
    } else {
      this.dragVirtualDuration =
        (this.dragVirtualDuration ?? this.duration) + deltaSeconds
      let newDuration = this.dragVirtualDuration
      if (snapThresholdSec > 0) {
        // Right-edge seam grid on the duration axis: k·loopLen − φ.
        const snapped = snapToGridPoint(
          newDuration,
          snapLoopLen,
          -this.paintPhaseSec(snapLoopLen),
          snapThresholdSec,
        )
        if (snapped != null && snapped > 0.01) newDuration = snapped
      }
      if (trimMode) {
        const offset = (this.loopPhaseSec ?? 0) - this.resizeStartDeltaSec
        const maxDur = this.dragStartExtent - offset
        if (newDuration > maxDur) newDuration = maxDur
      }
      if (newDuration > 0.01 && newDuration !== this.duration) {
        this.duration = newDuration
        this.renderPosition()
        this.repaintForResizeDrag('end')
        this.emit('update', 'end')
      }
    }
  }

  /**
   * Magnetic capture radius (seconds) for loop-seam snapping during
   * resize drags: 8 CSS px, but zero when the clip isn't loop-tiled or
   * its tiles are so narrow that seam-snapping would make the whole drag
   * feel sticky.
   */
  private loopSnapThresholdSec(parentWidthCss: number): number {
    const loopLen = this.loopEndSec - this.loopStartSec
    if (!(this.loopEnabled && loopLen > 0.0001)) return 0
    const pxPerSec =
      this.totalDuration > 0 ? parentWidthCss / this.totalDuration : 0
    if (pxPerSec <= 0) return 0
    if (loopLen * pxPerSec < 16) return 0
    return 8 / pxPerSec
  }

  /**
   * Repaint policy for in-progress resize drags. While the duration stays
   * within what the canvas was last painted with, the painted bitmap is
   * already pixel-correct at the current zoom — the clip element's
   * overflow:hidden crops it at the drag edge, so skipping the repaint
   * keeps the waveform perfectly still. Repainting every mousemove
   * instead re-derives rounded bitmap/sample geometry from fractional
   * CSS rects, and the roundings land differently each frame — a visible
   * sub-pixel tremble. Only a drag past the painted duration (tiling /
   * stretch content that isn't on the canvas yet) needs live repaints.
   */
  private repaintForResizeDrag(side: 'start' | 'end') {
    // Left-edge drags move the element origin: the painted bitmap rides the
    // edge, so content must repaint (with drag phase compensation via
    // paintPhaseSec) to stay timeline-anchored. Right-edge shrink keeps the
    // origin — the frozen bitmap crops correctly at the drag edge.
    if (side === 'end') {
      const painted = this.lastPaintState
      if (painted && this.duration <= painted.duration) return
    }
    // Custom-content clips slide instead: the bitmap (painted once with a
    // paintLeadInSec margin) stays timeline-anchored by moving the canvas
    // inside the element — the element's shift and the canvas offset
    // cancel in the same compositor coordinate space, so the painting is
    // perfectly still on screen. Only a drag past the painted lead-in
    // needs a fresh paint (which re-anchors with a new margin).
    if (side === 'start' && this.renderContent && this.lastPaintState) {
      const slid = this.resizeStartDeltaSec - this.paintAnchorDeltaSec
      if (slid <= this.paintLeadInSec + 1e-9) {
        const pxPerSecCss = this.stablePxPerSecCss()
        if (pxPerSecCss > 0 && this.canvas) {
          this.canvas.style.left = `${(slid - this.paintLeadInSec) * pxPerSecCss}px`
          return
        }
      }
    }
    this.renderWaveform()
  }

  /** CSS px per second from the parent timeline width (drag-stable). */
  private stablePxPerSecCss(): number {
    const parentW =
      this.element?.parentElement?.getBoundingClientRect().width ?? 0
    return this.totalDuration > 0 && parentW > 0
      ? parentW / this.totalDuration
      : 0
  }

  /**
   * Lead-in (seconds) to pre-paint left of the clip start when a
   * left-edge drag begins on a custom-content clip. Generous enough that
   * a normal drag never needs a mid-gesture repaint, clamped by: the
   * timeline origin, the source start for trim-mode clips (offset 0 —
   * there is no earlier content to reveal), and the canvas width ceiling.
   */
  private chooseLeadInSec(pxPerSecCss: number): number {
    if (pxPerSecCss <= 0) return 0
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    let lead = 2000 / pxPerSecCss
    lead = Math.min(lead, Math.max(0, this.startTime))
    const trimMode =
      !(this.loopEnabled && this.loopEndSec - this.loopStartSec > 0.0001) &&
      (this.originalDuration || 0) > 0.0001
    if (trimMode) {
      lead = Math.min(
        lead,
        Math.max(0, (this.loopPhaseSec ?? 0) - this.resizeStartDeltaSec),
      )
    }
    const MAX_BITMAP_W = 16000
    const maxLeadCss = Math.max(
      0,
      MAX_BITMAP_W / dpr - this.duration * pxPerSecCss,
    )
    return Math.max(0, Math.min(lead, maxLeadCss / pxPerSecCss))
  }

  private onEndResizing(side: 'start' | 'end') {
    // Clear drag-transient state BEFORE emitting: the host commits the
    // authoritative startTime/duration/phase in response, and its sync
    // repaint must not be double-compensated.
    const hadLeadIn = this.paintLeadInSec > 0
    this.resizeStartDeltaSec = 0
    this.dragStartDuration = null
    this.dragStartExtent = 0
    this.activeResizeSide = null
    this.dragVirtualStart = null
    this.dragVirtualDuration = null
    this.dragSeamGridOrigin = 0
    this.paintLeadInSec = 0
    this.paintAnchorDeltaSec = 0
    // A slid canvas must be restored to normal geometry even if the host
    // commit turns out to be a no-op (below-threshold drag) and never
    // triggers its own repaint.
    if (hadLeadIn) this.renderWaveform()
    this.emit('update-end', side)
  }

  /**
   * Effective loop phase for PAINTING: the committed loopPhaseSec minus the
   * cumulative left-edge movement of an in-progress resize drag, so tiled
   * content stays anchored to the timeline while the edge moves. Forward-clip
   * rule only — the plugin doesn't know `reversed`; reversed clips settle to
   * the exact committed phase on release.
   */
  private paintPhaseSec(loopLen: number): number {
    if (!(loopLen > 0)) return 0
    const raw = (this.loopPhaseSec ?? 0) - this.resizeStartDeltaSec
    return ((raw % loopLen) + loopLen) % loopLen
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
   *
   * NOTE: phase-less fallback — has no loop-region model; the store's
   * pre-looped peaks (which honor loopPhaseSec) replace this within a
   * frame. Mid-drag retiles briefly render phase-0.
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

  /**
   * Seconds of clip time per CSS px. Derived from the parent (timeline)
   * width — constant while a resize drag is in progress — instead of
   * duration / clipWidthCss: the clip's own measured width is quantized
   * by layout (1/64 px in Chromium) while duration is a smooth float,
   * so their ratio wobbles frame to frame and makes live tiled repaints
   * tremble. Mathematically the two are identical (clip width is
   * duration/totalDuration of the parent).
   */
  private secPerCssPx(clipWidthCss: number): number {
    const parentW = this.element?.parentElement?.getBoundingClientRect().width
    if (parentW && parentW > 0 && this.totalDuration > 0) {
      return this.totalDuration / parentW
    }
    return this.duration / Math.max(1e-9, clipWidthCss)
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
   * Shared mono/stereo dispatcher for the PCM render branch. `drawSampleLine`
   * is called at extreme zoom (samplesPerPixel < 1.5); otherwise `computePeaksCh`
   * is invoked once per channel and drawn via `drawChannelPeaks`. Returns
   * true when the canvas was painted, false when nothing was rendered (e.g.
   * empty PCM channel) so the caller can fall through to the fallback path.
   */
  private renderPcmBranch(
    ctx: CanvasRenderingContext2D,
    pixelW: number,
    pixelH: number,
    samplesPerPixel: number,
    drawSampleLine: () => void,
    computePeaksCh: (channelIdx: number) => Float32Array | null,
  ): boolean {
    if (!this.pcm || !this.pcm[0]) return false

    if (samplesPerPixel < 1.5) {
      drawSampleLine()
      return true
    }

    const waveColor = 'rgba(255,255,255,0.4)'
    if (this.pcm.length >= 2 && this.pcm[1]) {
      const peaksL = computePeaksCh(0)
      const peaksR = computePeaksCh(1)
      if (peaksL && peaksR) {
        const quarterH = pixelH / 4
        this.drawChannelPeaks(ctx, peaksL, pixelW, quarterH, quarterH, waveColor)
        this.drawChannelPeaks(ctx, peaksR, pixelW, 3 * quarterH, quarterH, waveColor)
        return true
      }
      return false
    }
    const rangePeaks = computePeaksCh(0)
    if (rangePeaks) {
      this.drawChannelPeaks(
        ctx, rangePeaks, pixelW, pixelH / 2, pixelH / 2, waveColor,
      )
      return true
    }
    return false
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

  /**
   * Tile-aware variant of {@link renderSampleLine} for clips with an active
   * loop region. Maps each canvas pixel x → clip time → wrapped src time
   * (`loopStartSec + ((clipTime) mod loopLen)`) → source sample, and draws
   * a polyline through those samples. At loop wrap points the polyline
   * starts a new subpath so the visual jump matches the audio engine's
   * discontinuity rather than smearing samples across the boundary.
   */
  private renderSampleLineTiled(
    ctx: CanvasRenderingContext2D,
    pixelW: number,
    pixelH: number,
    canvasLeftCss: number,
    canvasWidthCss: number,
    clipWidthCss: number,
    loopStartSec: number,
    loopEndSec: number,
    loopPhaseSec: number,
  ) {
    if (!this.pcm || !this.pcm[0]) return
    if (this.pcm.length >= 2 && this.pcm[1]) {
      const quarterH = pixelH / 4
      this.drawChannelTiledSampleLine(
        ctx, this.pcm[0], pixelW, quarterH, quarterH,
        canvasLeftCss, canvasWidthCss, clipWidthCss,
        loopStartSec, loopEndSec, loopPhaseSec,
      )
      this.drawChannelTiledSampleLine(
        ctx, this.pcm[1], pixelW, 3 * quarterH, quarterH,
        canvasLeftCss, canvasWidthCss, clipWidthCss,
        loopStartSec, loopEndSec, loopPhaseSec,
      )
    } else {
      const halfH = pixelH / 2
      this.drawChannelTiledSampleLine(
        ctx, this.pcm[0], pixelW, halfH, halfH,
        canvasLeftCss, canvasWidthCss, clipWidthCss,
        loopStartSec, loopEndSec, loopPhaseSec,
      )
    }
  }

  private drawChannelTiledSampleLine(
    ctx: CanvasRenderingContext2D,
    channel: Float32Array,
    pixelW: number,
    yCenter: number,
    yHalfHeight: number,
    canvasLeftCss: number,
    canvasWidthCss: number,
    clipWidthCss: number,
    loopStartSec: number,
    loopEndSec: number,
    loopPhaseSec: number,
  ) {
    const loopLen = loopEndSec - loopStartSec
    if (loopLen <= 0 || this.sampleRate <= 0) return
    const sr = this.sampleRate
    const loopStartSample = Math.max(0, Math.floor(loopStartSec * sr))
    const loopEndSample = Math.min(channel.length, Math.ceil(loopEndSec * sr))
    if (loopEndSample - loopStartSample < 2) return

    const cssPerPixel = canvasWidthCss / Math.max(1, pixelW)
    const secPerCssPx = this.secPerCssPx(clipWidthCss)

    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1
    ctx.lineJoin = 'round'
    ctx.beginPath()

    let prevSrcSample = -1
    let inSubpath = false
    for (let x = 0; x < pixelW; x++) {
      const cssPx = canvasLeftCss + (x + 0.5) * cssPerPixel
      const clipT = cssPx * secPerCssPx
      // Fold the loop phase into the tile time before wrapping — at
      // phase 0 this reduces to the original expression exactly.
      // Positive-modulo with the FP loopLen-edge snap (wrapTileTime):
      // shifted can be negative (phase offset, negative drag window).
      const shifted = clipT + loopPhaseSec
      const tileT = wrapTileTime(shifted, loopLen)
      const srcSample = loopStartSample + Math.floor(tileT * sr)
      if (srcSample < 0 || srcSample >= channel.length) {
        inSubpath = false
        continue
      }
      const s = channel[srcSample]
      const y = yCenter - s * yHalfHeight
      // Detect loop wrap (srcSample jumped backward by more than a couple
      // samples). Start a new subpath so the polyline doesn't draw a
      // horizontal line across the discontinuity.
      const wrapped =
        inSubpath && prevSrcSample >= 0 && srcSample < prevSrcSample - 2
      if (!inSubpath || wrapped) {
        ctx.moveTo(x, y)
        inSubpath = true
      } else {
        ctx.lineTo(x, y)
      }
      prevSrcSample = srcSample
    }
    ctx.stroke()

    // Dots at individual sample positions at extreme zoom.
    const samplesPerPixel = secPerCssPx * cssPerPixel * sr
    const pxPerSample = samplesPerPixel > 0 ? 1 / samplesPerPixel : 0
    if (pxPerSample >= 8) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      const dotR = Math.max(1.5, Math.min(3, pxPerSample * 0.18))
      for (let x = 0; x < pixelW; x++) {
        const cssPx = canvasLeftCss + (x + 0.5) * cssPerPixel
        const clipT = cssPx * secPerCssPx
        const shifted = clipT + loopPhaseSec
        const tileT = wrapTileTime(shifted, loopLen)
        const srcSample = loopStartSample + Math.floor(tileT * sr)
        if (srcSample < 0 || srcSample >= channel.length) continue
        const s = channel[srcSample]
        const y = yCenter - s * yHalfHeight
        ctx.beginPath()
        ctx.arc(x, y, dotR, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  /**
   * Tile-aware peak scan for clips with an active loop region. For each
   * canvas pixel, walks the loop sub-region of the source PCM that the
   * pixel covers (potentially crossing one or more loop boundaries) and
   * records max |sample|. Bounded by the same total-samples-in-window
   * cost as the non-tiled scan — pixels just span shorter src ranges
   * across more iterations near boundaries.
   */
  private computePeaksFromPcmRangeTiled(
    pixelW: number,
    canvasLeftCss: number,
    canvasWidthCss: number,
    clipWidthCss: number,
    channelIdx: number,
    loopStartSec: number,
    loopEndSec: number,
    loopPhaseSec: number,
  ): Float32Array | null {
    if (!this.pcm) return null
    const channel = this.pcm[channelIdx] ?? this.pcm[0]
    if (!channel) return null
    const loopLen = loopEndSec - loopStartSec
    if (loopLen <= 0 || this.sampleRate <= 0 || pixelW <= 0) return null
    const sr = this.sampleRate
    const loopStartSample = Math.max(0, Math.floor(loopStartSec * sr))
    const loopEndSample = Math.min(channel.length, Math.ceil(loopEndSec * sr))
    if (loopEndSample - loopStartSample < 1) return new Float32Array(pixelW)

    const result = new Float32Array(pixelW)
    const cssPerPixel = canvasWidthCss / pixelW
    const secPerCssPx = this.secPerCssPx(clipWidthCss)

    for (let x = 0; x < pixelW; x++) {
      const cssL = canvasLeftCss + x * cssPerPixel
      const cssR = cssL + cssPerPixel
      const clipTL = cssL * secPerCssPx
      const clipTR = cssR * secPerCssPx
      let t = clipTL
      let maxAbs = 0
      // Walk one tile segment at a time. Each iteration consumes either
      // the remainder of the current tile or the rest of the pixel range,
      // whichever is smaller. The Math.max floor guarantees forward
      // progress — wrapTileTime snaps the FP tileT==loopLen edge, and the
      // epsilon covers any other degenerate remainder.
      while (t < clipTR) {
        const shifted = t + loopPhaseSec
        const tileT = wrapTileTime(shifted, loopLen)
        const remInTile = loopLen - tileT
        const tSegEnd = Math.min(clipTR, t + Math.max(remInTile, 1e-9))
        const srcStart = loopStartSample + Math.floor(tileT * sr)
        const srcEnd = Math.min(
          loopEndSample,
          loopStartSample + Math.ceil((tileT + (tSegEnd - t)) * sr),
        )
        for (let i = Math.max(loopStartSample, srcStart); i < srcEnd; i++) {
          const v = channel[i]
          const abs = v < 0 ? -v : v
          if (abs > maxAbs) maxAbs = abs
        }
        t = tSegEnd
      }
      result[x] = maxAbs
    }
    return result
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

      // During a left-edge resize drag, let the canvas window extend LEFT
      // of the clip origin (negative window coords) so the strip being
      // revealed by an extend is already painted. The tiled painters wrap
      // negative time via positive-modulo; the plain (trim) sample window
      // is bounded here by the remaining source offset (there is nothing
      // earlier than source start to show), and everything is bounded by
      // timeline zero. All three bounds are timeline-fixed during the
      // drag, which is what keeps the window constant frame-to-frame.
      let minLeftCss = 0
      const dragSecPerCssPx = this.secPerCssPx(clipWidthCss)
      if (
        this.activeResizeSide === 'start' &&
        !this.renderContent &&
        dragSecPerCssPx > 0
      ) {
        const pxPerSecCss = 1 / dragSecPerCssPx
        let boundCss = -Math.max(0, this.startTime) * pxPerSecCss
        const trimMode =
          !(this.loopEnabled && this.loopEndSec - this.loopStartSec > 0.0001) &&
          (this.originalDuration || 0) > 0.0001
        if (trimMode) {
          const offsetLeftSec = Math.max(
            0,
            (this.loopPhaseSec ?? 0) - this.resizeStartDeltaSec,
          )
          boundCss = Math.max(boundCss, -offsetLeftSec * pxPerSecCss)
        }
        minLeftCss = Math.min(0, boundCss)
      }

      let canvasLeftCss: number
      let canvasWidthCss: number
      if (scrollEl) {
        const scrollRect = scrollEl.getBoundingClientRect()
        const visibleLeftInClip = Math.max(
          minLeftCss,
          scrollRect.left - clipRect.left,
        )
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
          last.clipWidthCss === clipWidthCss &&
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
          canvasLeftCss = Math.max(
            minLeftCss,
            visibleLeftInClip - SCROLL_MARGIN_CSS,
          )
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
      // Quantize the canvas window to whole device pixels. With a
      // fractional window, the bitmap→CSS scale (pixelW vs. CSS width)
      // rounds to a slightly different value on every repaint — during
      // a live resize drag that reads as the waveform trembling.
      // Quantized, the scale is exactly 1/dpr on every frame.
      //
      // The window POSITION is quantized on the TIMELINE device-pixel
      // grid — the clip's timeline position plus the window offset —
      // NOT clip-relative. The clip origin sits at a fractional position
      // (and moves fractionally during a left-edge drag), so rounding in
      // clip coordinates would land the window on a slightly different
      // timeline alignment per repaint and the waveform would visibly
      // re-rasterize: trembling during drags, and a one-shot "redraw"
      // shimmer when the release repaint didn't share the drag repaints'
      // grid. The timeline grid is invariant across drag frames
      // (startTime and the window offset shift complementarily), across
      // the release repaint (same startTime), and under scroll — so
      // consecutive repaints are pixel-identical or exact whole-pixel
      // translations, never a sub-pixel re-rasterization.
      if (!this.renderContent && dragSecPerCssPx > 0) {
        const pxPerSecCss = 1 / dragSecPerCssPx
        const clipTimelineLeftCss = this.startTime * pxPerSecCss
        const timelineBase = clipTimelineLeftCss + canvasLeftCss
        canvasLeftCss =
          Math.round(timelineBase * dpr) / dpr - clipTimelineLeftCss
      } else {
        canvasLeftCss = Math.round(canvasLeftCss * dpr) / dpr
      }
      canvasWidthCss = Math.round(canvasWidthCss * dpr) / dpr
      if (canvasWidthCss <= 0) return

      const pixelW = Math.max(1, Math.round(canvasWidthCss * dpr))
      const pixelH = Math.max(1, Math.round(cssH * dpr))

      // Sample range that maps to this canvas window within the clip.
      // The span is capped at duration-worth of samples so a shrink drag
      // cuts the waveform off at the drag edge instead of squishing the
      // full buffer into the shrinking width (the store only re-slices
      // PCM on drag end) — see computeClipSampleWindow.
      const totalSamples = this.pcm?.[0]?.length ?? 0
      const stableSecPerCssPx = dragSecPerCssPx
      const { startSample, endSample } = computeClipSampleWindow({
        totalSamples,
        duration: this.duration,
        sampleRate: this.sampleRate,
        // Non-loop trim: loopPhaseSec doubles as the source-start offset;
        // compensate live for an in-progress left-edge drag so content
        // stays timeline-anchored (loop clips handle phase in the tiled
        // branches via paintPhaseSec instead). Same degenerate-loop-region
        // predicate as trimMode above — keep the two gates in agreement.
        // NOTE: this fork has no concept of `reversed` — for a reversed
        // clip the store computes the live offset from the RIGHT edge, not
        // the left (see ClipSlice.tsx resizeClip), so this left-edge-only
        // compensation under-/over-shoots during an in-progress drag on a
        // reversed clip. The mid-drag preview is therefore
        // phase-uncompensated for reversed clips; it settles to the
        // correct window once the store's authoritative resizeClip commits
        // on drag release.
        sourceOffsetSec:
          this.loopEnabled && this.loopEndSec - this.loopStartSec > 0.0001
            ? 0
            : Math.max(0, (this.loopPhaseSec ?? 0) - this.resizeStartDeltaSec),
        clipWidthCss,
        canvasLeftCss,
        canvasWidthCss,
        secPerCssPx: stableSecPerCssPx,
      })

      // peaksPreLooped forces the precomputed-peaks fallback only when the
      // PCM can't represent the clip on its own (it's the un-tiled
      // original, shorter than the clip). When the PCM already spans the
      // clip's duration — the host re-slices PCM on resize end — the plain
      // range render is equally correct and far sharper than the host's
      // low-bin peaks (a shrunk clip otherwise visibly degrades the moment
      // a resize drag commits).
      const pcmSpansClip =
        this.sampleRate > 0 &&
        totalSamples / this.sampleRate >= this.duration - 0.001

      // Short-circuit when nothing material changed since the last paint.
      // Canvas position + sample range are part of the key so a scroll
      // or zoom that shifts the window forces a repaint.
      const pcmRef = this.pcm?.[0] ?? null
      const tierBins =
        this.pcm && (!this.peaksPreLooped || pcmSpansClip)
          ? this.tierForBins(pixelW)
          : 0
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
        this.lastPaintState.loopEnabled === this.loopEnabled &&
        this.lastPaintState.loopStartSec === this.loopStartSec &&
        this.lastPaintState.loopEndSec === this.loopEndSec &&
        this.lastPaintState.loopPhaseSec === this.loopPhaseSec &&
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
          clipWidthCss, canvasLeftCss, canvasWidthCss, startSample, endSample,
          loopEnabled: this.loopEnabled,
          loopStartSec: this.loopStartSec,
          loopEndSec: this.loopEndSec,
          loopPhaseSec: this.loopPhaseSec,
        }
      }

      // Custom renderer (MIDI clips) takes precedence. These get the
      // full-clip canvas (not windowed) because MIDI note positions
      // are computed against clip coordinates — windowing would require
      // a protocol update for the render callback.
      if (this.renderContent) {
        // Drag-stable geometry: derive the content width from the parent's
        // px/sec (constant during a resize drag) rather than the
        // layout-quantized element width, and pin the canvas CSS size 1:1
        // to the bitmap. With `width: 100%` the bitmap rescaled against the
        // moving element every frame — a ±1px rounding of the backing store
        // rescaled the whole painting, the subtle note-shimmer seen while
        // dragging MIDI clip edges. The renderer receives the UNROUNDED
        // width (see computeContentPixelWidth) so mark positions derived
        // from it don't tremble as the rounded bitmap width steps during a
        // drag. Overflow past the element is cropped by the clip's
        // `overflow: hidden`.
        const contentParent = clipEl.parentElement
        const parentW = contentParent
          ? contentParent.getBoundingClientRect().width
          : clipWidthCss
        const pxPerSecCss =
          this.totalDuration > 0 ? parentW / this.totalDuration : 0
        // Left-edge drag in progress: pre-paint a lead-in margin left of
        // the clip start so the rest of the drag slides the canvas
        // instead of repainting (see repaintForResizeDrag / paintLeadInSec).
        let lead =
          this.activeResizeSide === 'start'
            ? this.chooseLeadInSec(pxPerSecCss)
            : 0
        // Quantize the re-anchor so the new bitmap's content is an EXACT
        // whole-device-pixel translation of the previous one (positions
        // are linear in time, so a whole-pixel origin shift translates
        // every mark without changing its sub-pixel phase). The canvas
        // style.left carries the fractional remainder, making the swap
        // compositor-identical — otherwise every note's antialiasing
        // re-rasterizes at a new sub-pixel offset and the whole clip
        // visibly blinks once per re-anchor.
        if (lead > 0 && this.lastPaintState && pxPerSecCss > 0) {
          const originRelPrev =
            this.resizeStartDeltaSec -
            this.paintAnchorDeltaSec -
            this.paintLeadInSec
          const pxDevPerSec = pxPerSecCss * dpr
          const shiftQ =
            Math.round((originRelPrev + lead) * pxDevPerSec) / pxDevPerSec
          const leadQ = shiftQ - originRelPrev
          if (leadQ > 0) lead = leadQ
        }
        this.paintLeadInSec = lead
        this.paintAnchorDeltaSec = this.resizeStartDeltaSec
        const { contentW, bitmapW } = computeContentPixelWidth({
          duration: this.duration + lead,
          parentWidthCss: parentW,
          totalDuration: this.totalDuration,
          dpr,
          fallbackClipWidthCss: clipWidthCss,
        })
        this.canvas.style.left = `${-lead * pxPerSecCss}px`
        this.canvas.style.width = `${bitmapW / dpr}px`
        if (this.canvas.width !== bitmapW) this.canvas.width = bitmapW
        ctx.clearRect(0, 0, bitmapW, pixelH)
        this.renderContent(ctx, contentW, pixelH, this)
        // Persist so repaintForResizeDrag can freeze the bitmap on
        // right-edge shrink (content marks don't depend on duration; the
        // element's overflow crop is exact) — without this, custom-content
        // clips repainted on every shrink mousemove.
        persistPaintState()
        return
      }

      // PCM-based rendering. Falls through to the precomputed peaks path
      // only when PCM isn't available.
      if (this.pcm && this.pcm[0] && this.pcm[0].length > 0) {
        const loopLen = this.loopEndSec - this.loopStartSec
        const loopActive =
          this.loopEnabled && loopLen > 0.0001 && this.sampleRate > 0
        // Resize-tile: clip was stretched past its original PCM length
        // without an explicit loop region — tile the whole original PCM.
        // Equivalent to a loop region of [0, originalDuration].
        // Intentionally ignores peaksPreLooped: the PCM-aware tile render
        // is sharper than the host's pre-tiled peaks fallback whenever
        // PCM is available.
        const resizeTile =
          !loopActive &&
          this.sampleRate > 0 &&
          this.originalDuration > 0.0001 &&
          this.duration > this.originalDuration + 1e-6

        if (loopActive) {
          // Tile-aware: each canvas pixel maps to clip time, wraps modulo
          // loopLen, then offsets by loopStartSec to read source PCM —
          // mirrors what the audio engine plays.
          const samplesPerPixel =
            stableSecPerCssPx * (canvasWidthCss / pixelW) * this.sampleRate

          if (this.renderPcmBranch(
            ctx, pixelW, pixelH, samplesPerPixel,
            () => this.renderSampleLineTiled(
              ctx, pixelW, pixelH,
              canvasLeftCss, canvasWidthCss, clipWidthCss,
              this.loopStartSec, this.loopEndSec, this.paintPhaseSec(loopLen),
            ),
            (idx) => this.computePeaksFromPcmRangeTiled(
              pixelW, canvasLeftCss, canvasWidthCss, clipWidthCss, idx,
              this.loopStartSec, this.loopEndSec, this.paintPhaseSec(loopLen),
            ),
          )) {
            this.drawLoopSeamNotches(
              ctx, pixelW, pixelH, canvasLeftCss, canvasWidthCss,
              clipWidthCss, loopLen, this.paintPhaseSec(loopLen),
            )
            persistPaintState()
            return
          }
        } else if (resizeTile) {
          // No explicit loop, but duration exceeds the source PCM — tile
          // against [0, originalDuration] so the waveform mirrors the
          // implicit looping done by the resize playback path.
          const samplesPerPixel =
            stableSecPerCssPx * (canvasWidthCss / pixelW) * this.sampleRate

          if (this.renderPcmBranch(
            ctx, pixelW, pixelH, samplesPerPixel,
            () => this.renderSampleLineTiled(
              ctx, pixelW, pixelH,
              canvasLeftCss, canvasWidthCss, clipWidthCss,
              0, this.originalDuration, 0,
            ),
            (idx) => this.computePeaksFromPcmRangeTiled(
              pixelW, canvasLeftCss, canvasWidthCss, clipWidthCss, idx,
              0, this.originalDuration, 0,
            ),
          )) {
            persistPaintState()
            return
          }
        } else if (!this.peaksPreLooped || pcmSpansClip) {
          const samplesInWindow = endSample - startSample
          const samplesPerPixel = samplesInWindow / pixelW

          if (this.renderPcmBranch(
            ctx, pixelW, pixelH, samplesPerPixel,
            () => this.renderSampleLine(
              ctx, pixelW, pixelH, startSample, endSample,
            ),
            (idx) => this.computePeaksFromPcmRange(
              startSample, endSample, pixelW, idx,
            ),
          )) {
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
        const fbLoopLen = this.loopEndSec - this.loopStartSec
        if (this.loopEnabled && fbLoopLen > 0.0001) {
          this.drawLoopSeamNotches(
            ctx, pixelW, pixelH, canvasLeftCss, canvasWidthCss,
            clipWidthCss, fbLoopLen, this.paintPhaseSec(fbLoopLen),
          )
        }
        persistPaintState()
      }
    })
  }

  /**
   * Small notch ticks at the clip's top edge marking loop wrap points
   * (tile seams), so an extended bounced clip shows exactly where it
   * loops. Pass the DRAG-COMPENSATED phase (paintPhaseSec) so notches
   * stay timeline-anchored mid-resize. Skipped when tiles are too narrow
   * for the marks to be meaningful (same 16px floor as seam snapping).
   */
  private drawLoopSeamNotches(
    ctx: CanvasRenderingContext2D,
    pixelW: number,
    pixelH: number,
    canvasLeftCss: number,
    canvasWidthCss: number,
    clipWidthCss: number,
    loopLen: number,
    phaseInLoop: number,
  ) {
    const secPerCss = this.secPerCssPx(clipWidthCss)
    if (!(secPerCss > 0) || !(loopLen > 0) || canvasWidthCss <= 0) return
    if (loopLen / secPerCss < 16) return
    const seams = computeLoopSeamTimes(
      this.duration,
      loopLen,
      phaseInLoop,
      canvasLeftCss * secPerCss,
      (canvasLeftCss + canvasWidthCss) * secPerCss,
    )
    if (seams.length === 0) return
    const dpr = pixelW / canvasWidthCss
    const notchH = Math.min(pixelH, 7 * dpr)
    for (const t of seams) {
      const x = (t / secPerCss - canvasLeftCss) * dpr
      // Dark underlay + light tick so the mark reads on any clip color
      // and over any waveform density.
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(x - 1.5 * dpr, 0, 3 * dpr, notchH)
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.fillRect(x - 0.5 * dpr, 0, dpr, notchH)
    }
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

  /**
   * Mark a loop sub-region of the source PCM for tile-aware rendering.
   * When enabled with a positive-length region, the PCM render path
   * tiles `[loopStartSec, loopEndSec)` across the clip's full duration
   * (matching the audio engine's `sourceNode.loop` semantics) and stays
   * sample-accurate at extreme zoom. Pass `enabled=false` to render the
   * PCM linearly.
   */
  public setLoopRegion(
    enabled: boolean,
    startSec: number,
    endSec: number,
    phaseSec: number = 0,
  ) {
    if (
      this.loopEnabled === enabled &&
      this.loopStartSec === startSec &&
      this.loopEndSec === endSec &&
      this.loopPhaseSec === phaseSec
    ) {
      return
    }
    this.loopEnabled = enabled
    this.loopStartSec = startSec
    this.loopEndSec = endSec
    this.loopPhaseSec = phaseSec
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
    this.hideDragGhost()
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
  /**
   * Snap-to-grid config for the cut-tool indicator, pushed in by the host
   * app. `gridSeconds` is one grid division in seconds (0 = no grid);
   * `enabled` mirrors the app's snap toggle. When enabled, the cut-line
   * indicator snaps to grid; otherwise it follows the pointer freely.
   */
  public snapConfig: { gridSeconds: number; enabled: boolean } = {
    gridSeconds: 0,
    enabled: false,
  }
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
    clip.on('update', (side) => {
      // Side-less update = body drag; sided updates are resizes
      if (!side) this.emit('clip-drag', clip)
    })
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

  /**
   * Push the host app's snap-to-grid state so the cut-tool indicator can
   * snap to grid lines. `gridSeconds` is one grid division in seconds.
   */
  public setSnapConfig(gridSeconds: number, enabled: boolean) {
    this.snapConfig = { gridSeconds: Math.max(0, gridSeconds), enabled }
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
