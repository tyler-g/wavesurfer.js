/**
 * The Timeline plugin adds timestamps and notches under the waveform.
 *
 * Grid lines (the per-track vertical grid Wavvy draws under clips) are
 * CANVAS-rendered and viewport-culled (2026-09-04): one canvas sized to the
 * visible scroll window (+margin), repainted from the `scroll` event's own
 * pixel coordinates and translated into place. The previous implementation
 * created one DOM div per grid line over the WHOLE project duration on every
 * `redraw` (a zoom step at 1/32 grid × 300 s × 6 tracks built ~29k divs), and
 * `virtualAppend` registered one scroll listener per line, each doing a
 * `clientWidth` read + append/remove — O(lines) forced reflows per scroll.
 * The canvas path does zero layout reads on scroll and O(visible lines) work.
 */

import BasePlugin, { type BasePluginEvents } from '../base-plugin.js'
import createElement from '../dom.js'

export type TimelinePluginOptions = {
  /** The height of the timeline in pixels, defaults to 20 */
  height?: number
  /** HTML element or selector for a timeline container, defaults to wavesufer's container */
  container?: HTMLElement | string
  /** Pass 'beforebegin' to insert the timeline on top of the waveform */
  insertPosition?: InsertPosition
  /** The duration of the timeline in seconds, defaults to wavesurfer's duration */
  duration?: number
  /** Interval between ticks in seconds */
  timeInterval?: number
  /** Interval between numeric labels in seconds */
  primaryLabelInterval?: number
  /** Interval between secondary numeric labels in seconds */
  secondaryLabelInterval?: number
  /** Interval between numeric labels in timeIntervals (i.e notch count) */
  primaryLabelSpacing?: number
  /** Interval between secondary numeric labels  in timeIntervals (i.e notch count) */
  secondaryLabelSpacing?: number
  /** offset in seconds for the numeric labels */
  timeOffset?: number
  /** Custom inline style to apply to the container */
  style?: Partial<CSSStyleDeclaration> | string
  /** Turn the time into a suitable label for the time. */
  formatTimeCallback?: (seconds: number) => string
  /** Opacity of the secondary labels, defaults to 0.25 */
  secondaryLabelOpacity?: number
  /** Show vertical grid lines extending through the track waveform area, defaults to false */
  gridLines?: boolean
  /** Color of the grid lines, defaults to 'rgba(255, 255, 255, 0.05)' */
  gridLinesColor?: string
  /** Grid line placement mode: 'beats' places at beat positions based on tempo, 'seconds' places at every time notch. Defaults to 'beats'. */
  gridMode?: 'beats' | 'seconds'
  /** Tempo in BPM for beat-based grid lines. Required when gridMode is 'beats'. Defaults to 120. */
  tempo?: number
  /** Grid subdivision as a snap grid value (e.g. '1 Bar', '1/4', '1/8', '1/16T'). Controls grid line density. Defaults to '1/4' (every beat). */
  gridSubdivision?: string
}

const defaultOptions = {
  height: 20,
  timeOffset: 0,
  formatTimeCallback: (seconds: number) => {
    if (seconds / 60 > 1) {
      // calculate minutes and seconds from seconds count
      const minutes = Math.floor(seconds / 60)
      seconds = Math.round(seconds % 60)
      const paddedSeconds = `${seconds < 10 ? '0' : ''}${seconds}`
      return `${minutes}:${paddedSeconds}`
    }
    const rounded = Math.round(seconds * 1000) / 1000
    return `${rounded}`
  },
}

// Painted-window margin on each side of the viewport (CSS px). Scrolls that
// stay inside the painted window need no repaint at all — only the (rare)
// exit repaints and re-translates the canvas.
const GRID_PAINT_MARGIN = 200
// Coarsening floor: when a line tier's spacing falls below this many CSS px
// (extreme zoom-out on a narrow grid), thin the drawn lines by a power-of-2
// index step. Classification math is untouched (beat-space law) — this only
// chooses WHICH lines are drawn, and the old DOM version drew an unreadable
// smear at these densities anyway.
const GRID_MIN_SPACING_PX = 3

export type TimelinePluginEvents = BasePluginEvents & {
  ready: []
}

class TimelinePlugin extends BasePlugin<TimelinePluginEvents, TimelinePluginOptions> {
  private timelineWrapper: HTMLElement
  private gridOverlay: HTMLElement | null = null
  private gridCanvas: HTMLCanvasElement | null = null
  private unsubscribeNotches: (() => void)[] = []
  protected options: TimelinePluginOptions & typeof defaultOptions
  private gridLinesEnabled: boolean = false
  private gridMode: 'beats' | 'seconds' = 'beats'
  private tempo: number = 120
  private gridSubdivision: string = '1/4'
  /** Layout snapshot recomputed once per redraw (the ONLY layout read). */
  private gridLayout: { duration: number; pxPerSec: number } | null = null
  /** Painted window in timeline CSS px — [from, to) currently on the canvas. */
  private paintedFrom = 0
  private paintedTo = 0

  constructor(options?: TimelinePluginOptions) {
    super(options || {})

    this.options = Object.assign({}, defaultOptions, options)
    this.gridLinesEnabled = options?.gridLines ?? false
    this.gridMode = options?.gridMode ?? 'beats'
    this.tempo = options?.tempo ?? 120
    this.gridSubdivision = options?.gridSubdivision ?? '1/4'
    this.timelineWrapper = this.initTimelineWrapper()
  }

  public static create(options?: TimelinePluginOptions) {
    return new TimelinePlugin(options)
  }

  /** Called by wavesurfer, don't call manually */
  onInit() {
    if (!this.wavesurfer) {
      throw Error('WaveSurfer is not initialized')
    }

    let container = this.wavesurfer.getWrapper()
    if (this.options.container instanceof HTMLElement) {
      container = this.options.container
    } else if (typeof this.options.container === 'string') {
      const el = document.querySelector(this.options.container)
      if (!el) throw Error(`No Timeline container found matching ${this.options.container}`)
      container = el as HTMLElement
    }

    if (this.options.insertPosition) {
      ;(container.firstElementChild || container).insertAdjacentElement(
        this.options.insertPosition,
        this.timelineWrapper,
      )
    } else {
      container.appendChild(this.timelineWrapper)
    }

    // Create grid overlay inside the wavesurfer wrapper (sibling to canvases)
    // so it's not clipped by the scroll container's overflow-y: hidden
    const wrapper = this.wavesurfer.getWrapper()
    this.gridOverlay = createElement('div', {
      part: 'timeline-grid',
      style: {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '1',
      },
    })
    // Vertical grid lines are uniform top-to-bottom, so the canvas backing
    // store is ONE device pixel tall and CSS-stretched to full height —
    // repaints never read or depend on the track's height.
    this.gridCanvas = createElement('canvas', {
      style: {
        position: 'absolute',
        top: '0',
        left: '0',
        height: '100%',
        pointerEvents: 'none',
        willChange: 'transform',
      },
    }) as HTMLCanvasElement
    this.gridOverlay.appendChild(this.gridCanvas)
    wrapper.appendChild(this.gridOverlay)

    this.subscriptions.push(this.wavesurfer.on('redraw', () => this.initTimeline()))
    // ONE scroll subscription per plugin instance (the old per-line
    // virtualAppend registered one per grid line/notch). The event args carry
    // the viewport in px — no layout reads here.
    this.subscriptions.push(
      this.wavesurfer.on('scroll', (_start, _end, scrollLeft, scrollRight) => {
        if (!this.gridLinesEnabled) return
        if (scrollLeft >= this.paintedFrom && scrollRight <= this.paintedTo) return
        this.paintGrid(scrollLeft, scrollRight)
      }),
    )

    if (this.wavesurfer?.getDuration() || this.options.duration) {
      this.initTimeline()
    }
  }

  /** Toggle vertical grid lines extending through the track waveform area */
  public setGridLines(enabled: boolean) {
    this.gridLinesEnabled = enabled
    this.initTimeline()
  }

  /** Returns whether grid lines are currently enabled */
  public getGridLines(): boolean {
    return this.gridLinesEnabled
  }

  /** Update the tempo (BPM) and re-render beat-based grid lines */
  public setTempo(bpm: number) {
    this.tempo = bpm
    this.initTimeline()
  }

  /** Update the grid subdivision (e.g. '1 Bar', '1/4', '1/8T') and re-render */
  public setGridSubdivision(value: string) {
    this.gridSubdivision = value
    this.initTimeline()
  }

  /** Unmount */
  public destroy() {
    this.unsubscribeNotches.forEach((unsubscribe) => unsubscribe())
    this.unsubscribeNotches = []
    this.timelineWrapper.remove()
    this.gridOverlay?.remove()
    this.gridOverlay = null
    this.gridCanvas = null
    super.destroy()
  }

  private initTimelineWrapper(): HTMLElement {
    return createElement('div', { part: 'timeline-wrapper', style: { pointerEvents: 'none' } })
  }

  // Return how many seconds should be between each notch
  private defaultTimeInterval(pxPerSec: number): number {
    if (pxPerSec >= 25) {
      return 1
    } else if (pxPerSec * 5 >= 25) {
      return 5
    } else if (pxPerSec * 15 >= 25) {
      return 15
    }
    return Math.ceil(0.5 / pxPerSec) * 60
  }

  // Return the cadence of notches that get labels in the primary color.
  private defaultPrimaryLabelInterval(pxPerSec: number): number {
    if (pxPerSec >= 25) {
      return 10
    } else if (pxPerSec * 5 >= 25) {
      return 6
    } else if (pxPerSec * 15 >= 25) {
      return 4
    }
    return 4
  }

  // Return the cadence of notches that get labels in the secondary color.
  private defaultSecondaryLabelInterval(pxPerSec: number): number {
    if (pxPerSec >= 25) {
      return 5
    } else if (pxPerSec * 5 >= 25) {
      return 2
    } else if (pxPerSec * 15 >= 25) {
      return 2
    }
    return 2
  }

  private virtualAppend(start: number, container: HTMLElement, element: HTMLElement) {
    let wasVisible = false

    const renderIfVisible = (scrollLeft: number, scrollRight: number) => {
      if (!this.wavesurfer) return
      const width = element.clientWidth
      const isVisible = start >= scrollLeft && start + width < scrollRight

      if (isVisible === wasVisible) return
      wasVisible = isVisible

      if (isVisible) {
        container.appendChild(element)
      } else {
        element.remove()
      }
    }

    if (!this.wavesurfer) return
    const scrollLeft = this.wavesurfer.getScroll()
    const scrollRight = scrollLeft + this.wavesurfer.getWidth()

    renderIfVisible(scrollLeft, scrollRight)

    this.unsubscribeNotches.push(
      this.wavesurfer.on('scroll', (_start, _end, scrollLeft, scrollRight) => {
        renderIfVisible(scrollLeft, scrollRight)
      }),
    )
  }

  private clearChildren(el: HTMLElement) {
    while (el.firstChild) {
      el.removeChild(el.firstChild)
    }
  }

  /**
   * Paint the grid lines covering [scrollLeft, scrollRight) plus margin.
   * Pure canvas work from the cached layout snapshot — no DOM reads.
   * Positions/classification keep the beat-space-only law (see CLAUDE.md):
   * exact integer rationals for bar/beat classing, `beatsPos × pxPerBeat`
   * placement with no time rounding.
   */
  private paintGrid(scrollLeft: number, scrollRight: number) {
    const canvas = this.gridCanvas
    const layout = this.gridLayout
    if (!canvas) return
    if (!this.gridLinesEnabled || !layout || layout.duration <= 0) {
      this.paintedFrom = 0
      this.paintedTo = 0
      canvas.style.display = 'none'
      return
    }
    canvas.style.display = ''

    const { duration, pxPerSec } = layout
    const totalWidth = duration * pxPerSec
    const from = Math.max(0, scrollLeft - GRID_PAINT_MARGIN)
    const to = Math.min(totalWidth, scrollRight + GRID_PAINT_MARGIN)
    const widthCss = Math.max(0, to - from)
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const widthDev = Math.max(1, Math.round(widthCss * dpr))
    const lineDev = Math.max(1, Math.round(dpr)) // ≈1 CSS px, device-aligned

    if (canvas.width !== widthDev) canvas.width = widthDev
    if (canvas.height !== 1) canvas.height = 1
    canvas.style.width = `${widthCss}px`
    canvas.style.transform = `translateX(${from}px)`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, widthDev, 1)

    const color = this.options.gridLinesColor ?? 'rgba(255, 255, 255, 0.12)'
    ctx.fillStyle = color

    const timeOffsetPx = this.options.timeOffset * pxPerSec

    if (this.gridMode === 'seconds') {
      const timeInterval = this.options.timeInterval ?? this.defaultTimeInterval(pxPerSec)
      const spacingPx = timeInterval * pxPerSec
      if (spacingPx > 0) {
        const first = Math.max(0, Math.floor((from - timeOffsetPx) / spacingPx))
        const last = Math.min(Math.ceil(duration / timeInterval), Math.ceil((to - timeOffsetPx) / spacingPx))
        for (let i = first; i <= last; i++) {
          if (i * timeInterval >= duration) break
          const offset = (Math.round((i * timeInterval + this.options.timeOffset) * 100) / 100) * pxPerSec
          ctx.fillRect(Math.round((offset - from) * dpr), 0, lineDev, 1)
        }
      }
    } else {
      const beatDuration = 60 / this.tempo
      // Line-weight classification runs on EXACT integer arithmetic: line i
      // sits at i·num/den beats, so on-beat ⟺ (i·num) % den === 0 and
      // on-bar ⟺ (i·num) % (den·4) === 0. Pixel placement runs in beat space
      // (beatsPos × pxPerBeat, no time rounding) so offsets are bit-stable
      // across a tempo drag — see the beat-space-only law in CLAUDE.md.
      const { num: gNum, den: gDen } = this.subdivisionToBeatsFraction(this.gridSubdivision)
      const pxPerBeat = beatDuration * pxPerSec
      const spacingPx = (gNum / gDen) * pxPerBeat
      if (spacingPx > 0) {
        // Density coarsening: power-of-2 index step so sub-pixel-dense grids
        // don't paint an opaque smear (power of 2 keeps bar alignment on all
        // binary subdivisions; triplet grids degrade to a sparse regular
        // pattern, which is the best any thinning can do there).
        let step = 1
        while (spacingPx * step < GRID_MIN_SPACING_PX) step *= 2
        const totalBeats = duration / beatDuration
        const maxI = Math.ceil((totalBeats * gDen) / gNum)
        let first = Math.max(0, Math.floor((from - timeOffsetPx) / (spacingPx * step)) * step)
        const last = Math.min(maxI, Math.ceil((to - timeOffsetPx) / spacingPx))
        for (let i = first; i <= last; i += step) {
          const beatsNumerator = i * gNum
          const beatsPos = beatsNumerator / gDen
          if (beatsPos * beatDuration >= duration) break
          const offset = beatsPos * pxPerBeat + timeOffsetPx
          // Bar lines at full opacity, beat lines at medium, sub-beat at low
          const atBar = beatsNumerator % (gDen * 4) === 0
          const atBeat = beatsNumerator % gDen === 0
          ctx.globalAlpha = atBar ? 1 : atBeat ? 0.4 : 0.18
          ctx.fillRect(Math.round((offset - from) * dpr), 0, lineDev, 1)
        }
        ctx.globalAlpha = 1
      }
    }

    this.paintedFrom = from
    this.paintedTo = to
  }

  private initTimeline() {
    this.unsubscribeNotches.forEach((unsubscribe) => unsubscribe())
    this.unsubscribeNotches = []

    const duration = this.wavesurfer?.getEffectiveDuration() ?? this.options.duration ?? 0
    const pxPerSec = (this.wavesurfer?.getWrapper().scrollWidth || this.timelineWrapper.scrollWidth) / duration

    // Grid: cache the layout snapshot and repaint the visible window.
    this.gridLayout = duration > 0 && isFinite(pxPerSec) ? { duration, pxPerSec } : null
    if (this.gridOverlay) {
      this.gridOverlay.style.display = this.gridLinesEnabled ? '' : 'none'
    }
    if (this.wavesurfer) {
      const scrollLeft = this.wavesurfer.getScroll()
      this.paintGrid(scrollLeft, scrollLeft + this.wavesurfer.getWidth())
    }

    // Notch bar: Wavvy's per-track instances run with height 0 (grid only) —
    // skip building the invisible label DOM entirely (the old code built one
    // div per notch, plus a scroll listener each, for a 0-height bar).
    if (this.options.height <= 0) {
      this.clearChildren(this.timelineWrapper)
      this.emit('ready')
      return
    }

    const timeInterval = this.options.timeInterval ?? this.defaultTimeInterval(pxPerSec)
    const primaryLabelInterval = this.options.primaryLabelInterval ?? this.defaultPrimaryLabelInterval(pxPerSec)
    const primaryLabelSpacing = this.options.primaryLabelSpacing
    const secondaryLabelInterval = this.options.secondaryLabelInterval ?? this.defaultSecondaryLabelInterval(pxPerSec)
    const secondaryLabelSpacing = this.options.secondaryLabelSpacing
    const isTop = this.options.insertPosition === 'beforebegin'

    const timeline = createElement('div', {
      style: {
        height: `${this.options.height}px`,
        overflow: 'hidden',
        fontSize: `${this.options.height / 2}px`,
        whiteSpace: 'nowrap',
        ...(isTop
          ? {
              position: 'absolute',
              top: '0',
              left: '0',
              right: '0',
              zIndex: '2',
            }
          : {
              position: 'relative',
            }),
      },
    })

    timeline.setAttribute('part', 'timeline')

    if (typeof this.options.style === 'string') {
      timeline.setAttribute('style', timeline.getAttribute('style') + this.options.style)
    } else if (typeof this.options.style === 'object') {
      Object.assign(timeline.style, this.options.style)
    }

    const notchEl = createElement('div', {
      style: {
        width: '0',
        height: '50%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: isTop ? 'flex-start' : 'flex-end',
        top: isTop ? '0' : 'auto',
        bottom: isTop ? 'auto' : '0',
        overflow: 'visible',
        borderLeft: '1px solid currentColor',
        opacity: `${this.options.secondaryLabelOpacity ?? 0.25}`,
        position: 'absolute',
        zIndex: '1',
      },
    })

    for (let i = 0, notches = 0; i < duration; i += timeInterval, notches++) {
      const notch = notchEl.cloneNode() as HTMLElement
      const isPrimary =
        Math.round(i * 100) % Math.round(primaryLabelInterval * 100) === 0 ||
        (primaryLabelSpacing && notches % primaryLabelSpacing === 0)
      const isSecondary =
        Math.round(i * 100) % Math.round(secondaryLabelInterval * 100) === 0 ||
        (secondaryLabelSpacing && notches % secondaryLabelSpacing === 0)

      if (isPrimary || isSecondary) {
        notch.style.height = '100%'
        notch.style.textIndent = '3px'
        notch.textContent = this.options.formatTimeCallback(i)
        if (isPrimary) notch.style.opacity = '1'
      }

      const mode = isPrimary ? 'primary' : isSecondary ? 'secondary' : 'tick'
      notch.setAttribute('part', `timeline-notch timeline-notch-${mode}`)

      const offset = (Math.round((i + this.options.timeOffset) * 100) / 100) * pxPerSec
      notch.style.left = `${offset}px`
      this.virtualAppend(offset, timeline, notch)
    }

    this.clearChildren(this.timelineWrapper)
    this.timelineWrapper.appendChild(timeline)

    this.emit('ready')
  }

  /** Grid subdivision as an exact fraction of a BEAT (num/den). Keep in
   *  lockstep with subdivisionToSeconds — integer beat math is what keeps
   *  bar/beat line classification stable across tempos (see paintGrid). */
  private subdivisionToBeatsFraction(sub: string): { num: number; den: number } {
    switch (sub) {
      case '8 Bars': return { num: 32, den: 1 }
      case '4 Bars': return { num: 16, den: 1 }
      case '2 Bars': return { num: 8, den: 1 }
      case '1 Bar': return { num: 4, den: 1 }
      case '1/2': return { num: 2, den: 1 }
      case '1/2T': return { num: 4, den: 3 }
      case '1/4': return { num: 1, den: 1 }
      case '1/4T': return { num: 2, den: 3 }
      case '1/8': return { num: 1, den: 2 }
      case '1/8T': return { num: 1, den: 3 }
      case '1/16': return { num: 1, den: 4 }
      case '1/16T': return { num: 1, den: 6 }
      case '1/32': return { num: 1, den: 8 }
      default: return { num: 1, den: 1 } // fallback to quarter note
    }
  }

  /** Convert a grid subdivision string to a duration in seconds */
  private subdivisionToSeconds(sub: string, beatDuration: number, barDuration: number): number {
    switch (sub) {
      case '8 Bars': return barDuration * 8
      case '4 Bars': return barDuration * 4
      case '2 Bars': return barDuration * 2
      case '1 Bar': return barDuration
      case '1/2': return beatDuration * 2
      case '1/2T': return (beatDuration * 2) * 2 / 3
      case '1/4': return beatDuration
      case '1/4T': return beatDuration * 2 / 3
      case '1/8': return beatDuration / 2
      case '1/8T': return beatDuration / 3
      case '1/16': return beatDuration / 4
      case '1/16T': return beatDuration / 6
      case '1/32': return beatDuration / 8
      default: return beatDuration // fallback to quarter note
    }
  }
}

export default TimelinePlugin
