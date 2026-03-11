# Wavvy E2E Test Writer Memory

## Project Structure
- **E2E tests directory**: `/Users/tylerg/code/wavvy/wavvy/e2e/`
- **Playwright config**: `/Users/tylerg/code/wavvy/wavvy/playwright.config.ts`
- **Framework**: Playwright, Chromium only, 90s timeout, baseURL `http://localhost:5173`
- **Dev server**: `npm run dev` in `/Users/tylerg/code/wavvy/wavvy/`

## Store Access Pattern
- `window.__mixerStore` is exposed in dev mode (Mixer.tsx line 17-19)
- Only `__mixerStore` is exposed; `__projectStore` and `__peerStore` are NOT exposed
- Access via `page.evaluate(() => (window as any).__mixerStore.getState())`

## Key Data-TestIDs
- `add-track-button`, `master-play-button`, `master-stop-button`
- `master-record-button`, `master-undo-button`, `master-redo-button`
- `master-zoom-out-button`, `master-save-button`
- `network-status-icon`, `my-peer-id`, `connect-button`, `open-network-button`
- `connection-status`, `remote-peer-id-input`

## Key CSS Selectors
- `.audio-track-container` - track wrapper (also used as focus target for Space key)
- `.audio-track-controls` - contains buttons and slider
- `.track-name` - shows "Track N"
- `.remove-track-icon` - IconX for removing tracks
- `.control-buttons-container` - contains rec, mute, arm, export buttons + volume slider
- `.project-manager` - contains the folder icon to open project drawer
- `.mantine-Slider-track` - Mantine slider track element (for volume)
- `.mantine-Drawer-content` - Mantine drawer panel

## Shadow DOM Access (WaveSurfer)
- WaveSurfer renders inside `#waveform-{id}` container
- Shadow host is `container.children[0]`, shadow root via `.shadowRoot`
- Cursor: `shadow.querySelector('[part="cursor"]')` - `style.left` is percentage
- Wrapper: `shadow.querySelector('.wrapper')` - used for bounding rect
- Regions: `shadow.querySelectorAll('[part^="region "]')`

## Existing Helper Patterns
- `waitForWaveSurferReady(page, selector)` - waits for shadow DOM `.wrapper`
- `getRegionCount(page, selector)` - counts regions in shadow DOM
- `getWrapperBoundingRect(page, selector)` - for mouse interactions
- `createRegionByDrag(page, selector, startPct, endPct)` - drag to create region
- `getTrackVolume(page, trackId)` - read from store
- `getHistoryInfo(page)` - returns length, cursor, canUndo, canRedo
- `undoOnce(page)` / `redoOnce(page)` - with waitForTimeout(300-800ms)

## Component Details
- **AudioTrack.tsx**: Volume slider uses Mantine `<Slider>` with 0-100 range (store uses 0-1)
  - `handleVolumeChange(vol)` updates WaveSurfer during drag (vol/100)
  - `handleVolumeChangeEnd(vol)` commits to store with history (vol/100)
  - Mute button calls `useMixerStore.getState().mute({ id })`
  - Space key handler on container keydown calls `playPause()`
- **MasterToolbar.tsx**: Zoom out button calls `zoomOut()` which does `Math.max(1, current - 50)`
  - Disabled when `minPxPerSec <= 1`
- **Home.tsx**: `useHotkeys` binds `mod+Z` to undo, `mod+shift+Z` to redo
- **ProjectManager.tsx**: Folder icon opens drawer, "Create" button adds project
  - Delete uses IconTrash with confirmation modal
  - Auto-creates project on mount, dirty flag prevents duplicates

## Anti-Flakiness Patterns
- **Never use fixed timeouts for playback assertions.** Use `waitForFunction` polling `currentTime` from store instead of `waitForTimeout(N)`.
- Pattern: `await page.waitForFunction((target) => { ... getCurrentTime() > target }, targetTime, { timeout: 10_000 })`
- `seek()` parameter is time in SECONDS (not a 0-1 ratio). Calculate `duration * fraction`.
- WaveSurfer cursor CSS `left` is % relative to visible viewport (zoom-dependent), not full audio duration. Use `getCurrentTime()` for reliable position checks.
- Mantine tooltip intercepts add-track-button clicks. Use `page.evaluate(() => __mixerStore.getState().addTrack())` for reliable track creation.
- Home.tsx auto-creates 1 track on mount via useEffect. Account for this in all test beforeEach hooks.

## Store Details
- **TrackSlice.mute()**: Toggles `wavesurfer.getMuted()`, changes waveColor to '#ccc' when muted
- **MasterSlice.zoomOut()**: Subtracts 50, clamped to 1, calls `zoom()` which is debounced (500ms) for history
- **MasterSlice.zoom()**: Debounces history entry creation by 500ms for scroll wheel gestures
- **Default minPxPerSec**: 100
- **Default track volume**: 1
