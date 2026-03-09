/**
 * Standalone waveform rendering utility.
 * Shared by Renderer (main waveform) and ClipsPlugin (clip mini-waveforms).
 */

export type RenderWaveformOptions = {
  waveColor?: string | string[] | CanvasGradient
  barWidth?: number
  barGap?: number
  barRadius?: number
  barHeight?: number
  barAlign?: 'top' | 'bottom'
  normalize?: boolean
}

function getPixelRatio(): number {
  return Math.max(1, window.devicePixelRatio || 1)
}

/** Convert an array of color strings to a vertical linear gradient. */
export function convertColorValues(color?: string | string[] | CanvasGradient): string | CanvasGradient {
  if (!Array.isArray(color)) return color || ''
  if (color.length < 2) return color[0] || ''

  const canvasElement = document.createElement('canvas')
  const ctx = canvasElement.getContext('2d') as CanvasRenderingContext2D
  const gradientHeight = canvasElement.height * (window.devicePixelRatio || 1)
  const gradient = ctx.createLinearGradient(0, 0, 0, gradientHeight)

  const colorStopPercentage = 1 / (color.length - 1)
  color.forEach((c, index) => {
    const offset = index * colorStopPercentage
    gradient.addColorStop(offset, c)
  })

  return gradient
}

function renderBarWaveform(
  channelData: Array<Float32Array | number[]>,
  ctx: CanvasRenderingContext2D,
  vScale: number,
  options: RenderWaveformOptions,
) {
  const topChannel = channelData[0]
  const bottomChannel = channelData[1] || channelData[0]
  const length = topChannel.length

  const { width, height } = ctx.canvas
  const halfHeight = height / 2
  const pixelRatio = getPixelRatio()

  const barWidth = options.barWidth ? options.barWidth * pixelRatio : 1
  const barGap = options.barGap ? options.barGap * pixelRatio : options.barWidth ? barWidth / 2 : 0
  const barRadius = options.barRadius || 0
  const barIndexScale = width / (barWidth + barGap) / length

  const rectFn = barRadius && 'roundRect' in ctx ? 'roundRect' : 'rect'

  ctx.beginPath()

  let prevX = 0
  let maxTop = 0
  let maxBottom = 0
  for (let i = 0; i <= length; i++) {
    const x = Math.round(i * barIndexScale)

    if (x > prevX) {
      const topBarHeight = Math.round(maxTop * halfHeight * vScale)
      const bottomBarHeight = Math.round(maxBottom * halfHeight * vScale)
      const barHeight = topBarHeight + bottomBarHeight || 1

      // Vertical alignment
      let y = halfHeight - topBarHeight
      if (options.barAlign === 'top') {
        y = 0
      } else if (options.barAlign === 'bottom') {
        y = height - barHeight
      }

      ctx[rectFn](prevX * (barWidth + barGap), y, barWidth, barHeight, barRadius)

      prevX = x
      maxTop = 0
      maxBottom = 0
    }

    const magnitudeTop = Math.abs(topChannel[i] || 0)
    const magnitudeBottom = Math.abs(bottomChannel[i] || 0)
    if (magnitudeTop > maxTop) maxTop = magnitudeTop
    if (magnitudeBottom > maxBottom) maxBottom = magnitudeBottom
  }

  ctx.fill()
  ctx.closePath()
}

function renderLineWaveform(
  channelData: Array<Float32Array | number[]>,
  ctx: CanvasRenderingContext2D,
  vScale: number,
) {
  const drawChannel = (index: number) => {
    const channel = channelData[index] || channelData[0]
    const length = channel.length
    const { height } = ctx.canvas
    const halfHeight = height / 2
    const hScale = ctx.canvas.width / length

    ctx.moveTo(0, halfHeight)

    let prevX = 0
    let max = 0
    for (let i = 0; i <= length; i++) {
      const x = Math.round(i * hScale)

      if (x > prevX) {
        const h = Math.round(max * halfHeight * vScale) || 1
        const y = halfHeight + h * (index === 0 ? -1 : 1)
        ctx.lineTo(prevX, y)
        prevX = x
        max = 0
      }

      const value = Math.abs(channel[i] || 0)
      if (value > max) max = value
    }

    ctx.lineTo(prevX, halfHeight)
  }

  ctx.beginPath()

  drawChannel(0)
  drawChannel(1)

  ctx.fill()
  ctx.closePath()
}

/**
 * Render a waveform onto a canvas 2D context.
 *
 * Supports both bar-style and line-style (mirrored envelope) waveforms,
 * with optional normalization, gradient colors, and DPI-aware scaling.
 *
 * @param channelData Array of channel data (Float32Array or number[]).
 *   Single-channel: `[peaks]`. Dual-channel: `[left, right]`.
 * @param ctx The 2D rendering context of the target canvas.
 * @param options Rendering options (colors, bar style, normalization, etc.)
 */
export function renderWaveform(
  channelData: Array<Float32Array | number[]>,
  ctx: CanvasRenderingContext2D,
  options?: RenderWaveformOptions,
): void {
  const opts = options || {}

  ctx.fillStyle = convertColorValues(opts.waveColor)

  // Vertical scaling
  let vScale = opts.barHeight || 1
  if (opts.normalize) {
    const max = Array.from(channelData[0]).reduce((m, value) => Math.max(m, Math.abs(value)), 0)
    vScale = max ? 1 / max : 1
  }

  // Render waveform as bars
  if (opts.barWidth || opts.barGap || opts.barAlign) {
    renderBarWaveform(channelData, ctx, vScale, opts)
    return
  }

  // Render waveform as a polyline
  renderLineWaveform(channelData, ctx, vScale)
}
