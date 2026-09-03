/**
 * The Timeline plugin adds timestamps and notches under the waveform.
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

export type TimelinePluginEvents = BasePluginEvents & {
  ready: []
}

class TimelinePlugin extends BasePlugin<TimelinePluginEvents, TimelinePluginOptions> {
  private timelineWrapper: HTMLElement
  private gridOverlay: HTMLElement | null = null
  private unsubscribeNotches: (() => void)[] = []
  protected options: TimelinePluginOptions & typeof defaultOptions
  private gridLinesEnabled: boolean = false
  private gridMode: 'beats' | 'seconds' = 'beats'
  private tempo: number = 120
  private gridSubdivision: string = '1/4'

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
    wrapper.appendChild(this.gridOverlay)

    this.subscriptions.push(this.wavesurfer.on('redraw', () => this.initTimeline()))

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

  private initTimeline() {
    this.unsubscribeNotches.forEach((unsubscribe) => unsubscribe())
    this.unsubscribeNotches = []

    const duration = this.wavesurfer?.getEffectiveDuration() ?? this.options.duration ?? 0
    const pxPerSec = (this.wavesurfer?.getWrapper().scrollWidth || this.timelineWrapper.scrollWidth) / duration
    const timeInterval = this.options.timeInterval ?? this.defaultTimeInterval(pxPerSec)
    const primaryLabelInterval = this.options.primaryLabelInterval ?? this.defaultPrimaryLabelInterval(pxPerSec)
    const primaryLabelSpacing = this.options.primaryLabelSpacing
    const secondaryLabelInterval = this.options.secondaryLabelInterval ?? this.defaultSecondaryLabelInterval(pxPerSec)
    const secondaryLabelSpacing = this.options.secondaryLabelSpacing
    const isTop = this.options.insertPosition === 'beforebegin'

    const gridLines = this.gridLinesEnabled
    const gridLinesColor = this.options.gridLinesColor ?? 'rgba(255, 255, 255, 0.12)'

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

    // Clear grid overlay
    if (this.gridOverlay) {
      this.clearChildren(this.gridOverlay)
      this.gridOverlay.style.display = gridLines ? '' : 'none'
    }

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

      // Add grid line at every notch when in 'seconds' mode
      if (gridLines && this.gridMode === 'seconds' && this.gridOverlay) {
        const gridLine = createElement('div', {
          style: {
            position: 'absolute',
            top: '0',
            left: `${offset}px`,
            width: '1px',
            height: '100%',
            backgroundColor: gridLinesColor,
            pointerEvents: 'none',
          },
        })
        this.virtualAppend(offset, this.gridOverlay, gridLine)
      }
    }

    // Add beat-based grid lines when in 'beats' mode (default)
    if (gridLines && this.gridMode === 'beats' && this.gridOverlay) {
      const beatDuration = 60 / this.tempo
      const barDuration = beatDuration * 4
      const gridInterval = this.subdivisionToSeconds(this.gridSubdivision, beatDuration, barDuration)
      // Line-weight classification runs on EXACT integer arithmetic: line i
      // sits at i·num/den beats, so on-beat ⟺ (i·num) % den === 0 and
      // on-bar ⟺ (i·num) % (den·4) === 0. The old float test
      // (|time % barDuration| < 0.001) misclassified lines at any tempo
      // whose beat length isn't binary-exact, and the misclassification
      // CHANGED per tempo tick — bar/beat lines visibly flickered in
      // opacity during a tempo drag even though their pixels never moved.
      const { num: gNum, den: gDen } = this.subdivisionToBeatsFraction(this.gridSubdivision)
      // Pixel placement runs in beat space too: beatsPos is tempo-INDEPENDENT
      // and pxPerBeat is what the host's beat-anchored zoom holds constant,
      // so offsets are bit-stable across a tempo drag. The old form rounded
      // time to 10ms before scaling (±5ms × pxPerSec = up to ±1px, landing
      // differently at every tempo) — gridlines visibly jittered left/right
      // during a tempo drag even though their true positions never moved.
      const pxPerBeat = beatDuration * pxPerSec

      for (let i = 0; i * gridInterval < duration; i++) {
        const beatsNumerator = i * gNum
        const beatsPos = beatsNumerator / gDen
        const offset = beatsPos * pxPerBeat + this.options.timeOffset * pxPerSec
        // Bar lines at full opacity, beat lines at medium, sub-beat at low
        const atBar = beatsNumerator % (gDen * 4) === 0
        const atBeat = beatsNumerator % gDen === 0
        const opacity = atBar ? '1' : atBeat ? '0.4' : '0.18'
        const gridLine = createElement('div', {
          style: {
            position: 'absolute',
            top: '0',
            left: `${offset}px`,
            width: '1px',
            height: '100%',
            backgroundColor: gridLinesColor,
            opacity,
            pointerEvents: 'none',
          },
        })
        this.virtualAppend(offset, this.gridOverlay, gridLine)
      }
    }

    this.clearChildren(this.timelineWrapper)
    this.timelineWrapper.appendChild(timeline)

    this.emit('ready')
  }

  /** Grid subdivision as an exact fraction of a BEAT (num/den). Keep in
   *  lockstep with subdivisionToSeconds — integer beat math is what keeps
   *  bar/beat line classification stable across tempos (see the grid loop). */
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
