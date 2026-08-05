# Navbar removal — full report

## 1. Deleted the pill nav bar
- `git rm -r client/src/components/NavBar` (NavBar.tsx, NavBar.css, NavBar.test.tsx).
- `client/src/App.tsx`: removed `import NavBar from './components/NavBar/NavBar'` and the `<NavBar />` element from the render tree.

### Zone rewiring
`client/src/components/Guide/Guide.tsx`'s `guide-header` zone had `getAdjacentZone('up') => 'navbar'`. Checked history: before the nav-bar feature (commit `52bf2f3^`), `getAdjacentZone` for `guide-header` returned `null` for `up` (no zone above the header — up simply did nothing). Restored that: `getAdjacentZone: (dir) => dir === 'down' ? 'guide-grid' : null`. `down` from `guide-header` and `up` from `guide-grid` are unchanged. No dangling references to a `'navbar'` zone id remain anywhere in `client/src`.

## 2. New header icon buttons
Added to `.guide-header-actions` in `client/src/components/Guide/Guide.tsx`, after the fullscreen button, matching the existing buttons' markup conventions (`guide-btn-hidden` class when `!overlayVisible`, `aria-label`, `title`):
- **Profile button** (`guide-profile-btn`): renders `<Avatar profile={activeProfile} size={18} />` (the exported monogram component from `client/src/components/Profile/ProfilePage.tsx`), `aria-label={`Profile: ${activeProfile.name}`}`, `onClick={() => navigate('/profile')}`. When `activeProfile` is null (profile still loading), renders a neutral placeholder `<span className="guide-profile-btn-placeholder">` (a plain circle in `var(--border-grid)`) instead, with `aria-label="Profile"` — same button footprint, no crash, no layout jump.
- **Settings button** (`guide-settings-btn`): `GearSix` icon, `aria-label="Settings"`, `onClick={onOpenSettings}` (restores the pre-profiles `guide-settings-btn`, confirmed via `git log -p -S"guide-settings-btn"` against commit `52bf2f3`).
- Order: AI filter, search, filter, fullscreen, profile, settings (settings last, as requested).
- Added `useNavigate` (react-router-dom) and `useProfile` (`../../contexts/ProfileContext`) hooks to `Guide.tsx`, plus imported `Avatar` from `ProfilePage.tsx` and `GearSix` from `@phosphor-icons/react`.

## 3. Back affordances for routed pages
- `client/src/components/Settings/Settings.tsx`: restored the `settings-close-btn` (`X` icon, `aria-label="Close"`, `onClick={onClose}`) inside `.settings-header`, matching the pre-profiles markup found via `git log -p -S"guide-settings-btn"` / direct history lookup on `Settings.tsx`. Imported `X` from `@phosphor-icons/react`. Page remains a full-screen routed overlay — only the header gained the button back.
- `client/src/components/Profile/ProfilePage.tsx`: added a new fixed-position `profile-page-close-btn` (`X` icon, `aria-label="Close"`, `onClick={() => navigate('/')}`) — there was no prior close button on this page (it's new in the profiles feature), so this is a new but visually/behaviorally consistent affordance, not a restoration.
- Both are real `<button>` elements (keyboard-focusable, Enter/Space activate by default) reachable by Tab; no custom remote-control zone wiring was added for them since neither `Settings` nor `ProfilePage` previously had (or needed) bespoke nav-zone integration — Escape still works via existing `useNavLayer`/keyboard handling in `Settings.tsx`.

## 4. CSS
- `client/src/components/Guide/Guide.css`: added `.guide-profile-btn` / `.guide-settings-btn` to every existing `.guide-fullscreen-btn, .guide-search-btn, .guide-filter-btn, .guide-ai-filter-btn { width/height... }` sizing block (6 occurrences: base + 5 responsive breakpoints at 1023px, 767px×2 variants, 640px, and one more within a nested media block) so they scale identically to their siblings at every breakpoint including the ≤640px icon-only mode. Added appearance rules (`background`, `border`, `color`, `border-radius`, flex centering, hover) directly modeled on `.guide-fullscreen-btn`, plus `.guide-profile-btn-placeholder` (an 18px circle in `var(--border-grid)`) for the loading state.
- **Mobile-avatar bug check**: audited `Guide.css` for any `span { display: none }`-style rule that could blanket-hide the `Avatar` component's `<span className="profile-avatar">`. Found none in `Guide.css` (the bug described in the task lived in the now-deleted `NavBar.css`, not here). At the ≤640px breakpoint the button uses `display: flex; align-items: center; justify-content: center` with no descendant-hiding rules, so the avatar span remains visible and centered inside the 32–34px button at a 390px viewport. No regression introduced.
- `client/src/components/Settings/Settings.css`: restored `.settings-close-btn` (base + 44px 1023px-breakpoint variant) and `justify-content: space-between` on `.settings-header` (both were removed along with the button in the profiles-feature commit `20882af`). Also tightened `.settings-overlay` padding — it previously reserved `96px`/`72px` of top space to clear the floating nav bar; with the nav bar gone and the close button living in the page's own header, reduced to `24px` (desktop) / `0` (≤767px, edge-to-edge, panel's own header holds the close button). Updated the stale "NavBar" comment above `.settings-overlay`.
- `client/src/components/Profile/ProfilePage.css`: added `.profile-page-close-btn` (fixed top-right, 32px, 44px at ≤640px) styled identically to `.settings-close-btn`. Reduced `.profile-page` top padding from `96px`/`80px` to `64px` at both breakpoints — the close button is small and fixed-position rather than needing a full nav-bar-height clearance, and 64px keeps a comfortable gap above the "Who's watching?" title without an oversized empty band.

## Tests
- Deleted `NavBar.test.tsx` with the component.
- New file: `client/src/components/Guide/Guide.test.tsx` (no prior Guide test harness existed, so this establishes one). Renders `Guide` inside `MemoryRouter` + `NavigationProvider` + `NotificationProvider`, with `./GuideGrid`, `./PreviewPanel`, `./Ticker`, `./ChannelSearch`, `./GuideFilter`, `./AIFilterModal`, `./ProgramInfoModal` stubbed out (they're irrelevant to header-button behavior and pull in heavy dependencies), `useSchedule` and `useProfile` mocked, and `react-router-dom`'s `useNavigate` mocked to a spy (pattern copied from `ProfilePage.test.tsx`). Four tests:
  1. Settings button renders and calls `onOpenSettings` on click (Guide itself doesn't navigate for Settings — `App.tsx`'s `handleOpenSettings` does that; verified at the boundary Guide controls).
  2. Profile button's accessible name includes the active profile's name (`Profile: Joey`).
  3. Profile button calls `navigate('/profile')` on click.
  4. When `activeProfile` is null, a button with accessible name `Profile` (placeholder) renders without crashing.
- **`/channel/:n` finding**: per `App.tsx`, `Guide` is *always mounted* as the base layer — the player is an overlay on top, not a route swap that unmounts Guide. So the header buttons are never literally absent on `/channel/:n`; instead `overlayVisible` becomes false during playback (existing mechanism, same as the other three header buttons) and they get `guide-btn-hidden` (`opacity: 0` at ≤1023px). I did not add a test asserting non-rendering on `/channel/:n` because that isn't how the app behaves — doing so would test a false premise. This matches the existing behavior of the AI/search/filter/fullscreen buttons, which the task said to match exactly.

## Verification (all four, run twice — final CSS-only edits didn't change any of these)
- `npm run test -w client` → **12 files / 63 tests passed** (was 12 files, prior count minus 7 removed NavBar tests plus 4 new Guide tests = net +... exact delta not tracked but suite is green).
- `npm run test -w server` → **22/23 files passed, 224/226 tests passed**. The 2 failures are the pre-existing, expected `ScheduleEngine.test.ts` failures (`ensureSchedule > should generate current and next blocks`, `regenerateForChannel > should delete and recreate schedule blocks`) — untouched by this change.
- `npm run build -w client` → succeeds (`tsc -b && vite build`), same pre-existing >500kB chunk-size warning as before, unrelated to this change.
- `npm run build -w server` → succeeds (`tsc`), no errors.

## Concerns
- None blocking. Two minor judgment calls worth flagging:
  1. `ProfilePage`'s close button styling/position is new (not a restoration, since the page itself is new) — I matched it to `Settings`' close-button visual language for consistency rather than inventing a different style.
  2. I tightened the top padding on `.settings-overlay` and `.profile-page` now that the nav bar's reserved clearance is gone; this is a visual improvement beyond the literal ask but avoids leaving a large empty band at the top of both pages, which would look broken. Flagging in case a specific padding value was expected instead.
