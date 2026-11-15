/**
 * Themeable clip colours (wavvy WVY-1777, light mode).
 *
 * Every colour the clips plugin used to hardcode for a dark background is
 * now a CSS custom property whose fallback is EXACTLY the old literal, so a
 * host that sets none of them renders byte-for-byte as before. Custom
 * properties inherit through the shadow DOM, so the host sets them on the
 * wavesurfer container or any ancestor (e.g. `:root[data-theme="light"]`).
 *
 * - DOM colours (frame outline, label, handles) are inline `var(--x, literal)`
 *   values — they follow a variable change on their own, no repaint needed.
 * - Canvas colours (waveform fill, sample line + dots) are resolved from the
 *   clips overlay's computed style, cached per plugin instance, and dropped
 *   only by `ClipsPlugin.invalidatePaint()`.
 *
 * Lives at src root (NOT src/plugins/ — rollup globs every top-level plugins
 * file as a default-export-only entry) so the named exports stay testable
 * without breaking the CJS/UMD plugin builds.
 */

/** The custom property names, one per colour role. */
export const CLIP_THEME_VARS = {
  /** Unselected clip frame (outline colour). */
  outline: '--ws-clip-outline-color',
  /** Selected clip frame (outline colour). */
  selectedOutline: '--ws-clip-selected-outline-color',
  /** Clip name / label text colour. */
  labelColor: '--ws-clip-label-color',
  /** Clip label text-shadow (a full `text-shadow` value, or `none`). */
  labelShadow: '--ws-clip-label-shadow',
  /** Left/right resize-handle edge (border colour). */
  handle: '--ws-clip-handle-color',
  /** Canvas: waveform peak-envelope fill. */
  wave: '--ws-clip-wave-color',
  /** Canvas: extreme-zoom sample line AND its per-sample dots. */
  sample: '--ws-clip-sample-color',
} as const

/** The pre-WVY-1777 literals — the fallback of every variable above. */
export const CLIP_THEME_FALLBACKS = {
  outline: 'rgba(255,255,255,0.18)',
  selectedOutline: '#fff',
  labelColor: '#fff',
  labelShadow: '0 1px 2px rgba(0,0,0,0.5)',
  handle: 'rgba(255,255,255,0.5)',
  wave: 'rgba(255,255,255,0.4)',
  sampleLine: 'rgba(255,255,255,0.85)',
  sampleDot: 'rgba(255,255,255,0.9)',
} as const

const v = (name: string, fallback: string) => `var(${name}, ${fallback})`

/** Inline-style values for the clip DOM. */
export const CLIP_DOM_STYLE = {
  outline: `2px solid ${v(CLIP_THEME_VARS.outline, CLIP_THEME_FALLBACKS.outline)}`,
  selectedOutline: `2px solid ${v(CLIP_THEME_VARS.selectedOutline, CLIP_THEME_FALLBACKS.selectedOutline)}`,
  labelColor: v(CLIP_THEME_VARS.labelColor, CLIP_THEME_FALLBACKS.labelColor),
  labelShadow: v(CLIP_THEME_VARS.labelShadow, CLIP_THEME_FALLBACKS.labelShadow),
  handleBorder: `2px solid ${v(CLIP_THEME_VARS.handle, CLIP_THEME_FALLBACKS.handle)}`,
} as const

/** Resolved canvas colours, always non-empty strings safe for fillStyle/strokeStyle. */
export type ClipCanvasColors = {
  readonly wave: string
  readonly sampleLine: string
  readonly sampleDot: string
}

export const DEFAULT_CLIP_CANVAS_COLORS: ClipCanvasColors = Object.freeze({
  wave: CLIP_THEME_FALLBACKS.wave,
  sampleLine: CLIP_THEME_FALLBACKS.sampleLine,
  sampleDot: CLIP_THEME_FALLBACKS.sampleDot,
})

/** A usable colour from a computed custom-property value, else `fallback`.
 *  Empty / whitespace → fallback; a value the platform says is not a colour
 *  (when `CSS.supports` exists) → fallback, so a typo never reaches the
 *  canvas (an invalid fillStyle is silently ignored and the previous colour
 *  would leak into the next fill). */
function pickColor(raw: string | null | undefined, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return fallback
  try {
    const css = (globalThis as any).CSS
    if (css && typeof css.supports === 'function' && !css.supports('color', value)) return fallback
  } catch {
    return fallback
  }
  return value
}

/**
 * Resolve the canvas colours from `el`'s computed style. Never throws; any
 * missing / invalid variable yields its literal fallback. Returns null when
 * `el` is not in a document (computed custom properties are not meaningful
 * yet) — callers must NOT cache that case.
 */
export function resolveClipCanvasColors(el: Element | null | undefined): ClipCanvasColors | null {
  if (!el || !el.isConnected) return null
  try {
    const view = el.ownerDocument?.defaultView
    if (!view || typeof view.getComputedStyle !== 'function') return null
    const cs = view.getComputedStyle(el)
    const sample = cs.getPropertyValue(CLIP_THEME_VARS.sample)
    return Object.freeze({
      wave: pickColor(cs.getPropertyValue(CLIP_THEME_VARS.wave), CLIP_THEME_FALLBACKS.wave),
      sampleLine: pickColor(sample, CLIP_THEME_FALLBACKS.sampleLine),
      sampleDot: pickColor(sample, CLIP_THEME_FALLBACKS.sampleDot),
    })
  } catch {
    return null
  }
}
