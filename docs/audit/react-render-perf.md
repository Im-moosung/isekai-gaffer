# React 렌더 효율 감사

## Summary

The store-subscription layer is **clean** — there is not a single offending selector. The real costs are (a) unmemoized derived work in `MatchScreen`'s render body, (b) zero `React.memo` anywhere, and (c) one genuine correctness+perf bug where a mid-minute store write restarts the pitch animation. Playback re-render frequency is much lower than "hot loop" intuition suggests: ~0.3–1.9 store ticks/s, because the 60fps work lives in imperative Pixi/three loops that never re-render React.

---

## 1. zustand subscription scope — no offenders

Every one of the **43** call sites uses a single-field selector (`s => s.phase`, `s => s.engine`, `s => s.submitCommand`, …). Verified by grep: **zero** `useMatchStore()` / `useCampaignStore()` without a selector, and **zero** selectors returning an object/array/tuple literal. `useShallow` / `shallow` is **not imported anywhere in the repo** — and correctly does not need to be.

Full inventory: `App.tsx:27,28,139,140,184–188`; `MatchScreen.tsx:119–129`; `ShoutBar.tsx:10–13`; `TeamTalk.tsx:29–31,33`; `TacticsBoard.tsx:53–57,232,233`; `TacticsExtras.tsx:28–30`; `OppPanel.tsx:24`; `ConsolePanel.tsx:23–25`; `SubPanel.tsx:24–26`; `HubScreen.tsx:39–42`; `EndingScreen.tsx:91,92`.

Action functions (`currentOpponent`, `matchSeed`, `startingStamina`, `submitCommand`, …) are defined once in the `create()` initializer and `set()` only ever merges data fields, so those references are stable for the app's lifetime — no `useCallback` needed.

Two related items worth noting:

| Sev | Location | Why it costs | Fix |
|---|---|---|---|
| **low-med** | `App.tsx:192` `currentOpponent()`, `App.tsx:194` `matchSeed()` | Untracked store reads **during render**. `matchSeed()` reads `records`, but the component only subscribes to `stage`/`currentOpponent`/`matchSeed`. Not a re-render cost — a **tearing hazard** under React 19 concurrent rendering, and stale-value risk if `records` ever changes without `stage` changing. | Subscribe to the underlying data instead: `useCampaignStore(s => s.records.length)` and derive, or move both into selectors. |
| **info** | `MatchScreen.tsx:174`, `MatchScreen.tsx:322` | `useMatchStore.getState()` inside a timer callback and an event handler. **Correct usage** — deliberately avoids re-subscribing the playback loop to `engine`. Leave as is. |

---

## 2. Tick loop and re-render frequency

**The loop:** `MatchScreen.tsx:169–191` — a self-rescheduling `setTimeout` chain (not `setInterval`/rAF). Each iteration reads fresh state via `getState()` (`:174`), computes `minuteDwellMs(...)` (`:182`), and calls `advanceMinute()` (`:185`).

**What each tick writes:** `matchStore.ts:310` `set({ engine: next })`, where `next` is a fresh `structuredClone` from `simulate.ts:55`. So `engine` gets a **new object identity every tick** — every `s => s.engine` subscriber re-renders. Branch writes also touch `phase`/`pauseReason` (`:282,286,290,294`) or `momentPrompt`/`firedMoments` (`:306`).

**Tick rate** (`playback.ts:16–34`): goal 6500ms, shot/save/miss 4300ms, foul/corner 2700ms, no-event 1800ms (clutch ×2), blowout ×0.6, then ÷speed. The module's own calibration target is 180–300s for 90 minutes → mean dwell 2.0–3.3s.

- **1x: ~0.30–0.50 ticks/s**
- **2x: ~0.60–1.00 ticks/s**
- **Worst case** (2x + blowout + no-event): 1800×0.6÷2 = 540ms → **1.85 ticks/s**

**Components re-rendered per tick** (broadcast mode, `playing`, 3D renderer active): `MatchScreen`, `Scorebug`, `TeamChip`×2, `SpeedToggle`, `PitchBoundary`, `Match3D`, `Ticker`, `ShoutBar` = **9 components**. (`ShoutBar` subscribes `engine` independently but batches into the same commit.)

→ **~3–5 component renders/s typical, ~17 renders/s worst case. Double in dev under StrictMode.**

Extra renders beyond the tick:
- `MatchScreen.tsx:250,252` — `setCrowdSwell(true)` then `(false)` 4s later ⇒ **+2 renders per goal**.
- `MatchScreen.tsx:199–210` — the mount/exit effect lists `tacticsMounted` in its own deps while setting it ⇒ **+1 render per pause transition**.
- `PitchView.tsx:69–76` — `ChoreoLayer` fires up to 3 `setTarget` timers per minute (only when SVG is the active renderer).

**If SVG `PitchView` is the active renderer** (2D toggle + no WebGL, or the Pixi/3D fallback path fires), add `PitchView` + `PitchMarkings` + `SideDots`×2 + 22 dot `<g>` subtrees ≈ **250 SVG nodes reconciled per tick**. That's the only configuration where tick-driven React work is material.

---

## 3. Missing memoization

### 3a. `MatchScreen` render body — 5 full passes over `engine.events` per render

| Sev | Location | Why it costs | Fix |
|---|---|---|---|
| **high** | `MatchScreen.tsx:338` `const lines = shown.map(e => commentate(e, home, away))` | The worst one. `commentate` (`commentary.ts:11`) does `acting.squad.find(...)` — a linear scan of the 26-player squad **per event**. By minute 90 that's ~60 events × 26 = **~1,560 comparisons + 60 template strings, rebuilt on every render**. `Ticker` (`Ticker.tsx:11–12`) then uses **only the last two entries**. | Pass just the two lines, or `useMemo` on `[engine?.events, home, away]`. Better: hoist a `Map<id, Player>` per team and build only `lines.slice(-2)`. Removes ~99% of the work. |
| **med** | `MatchScreen.tsx:337, 341–343, 345, 348` | Four more O(events) passes per render: `filter(minute <= displayMinute)`, the `shownScore` accumulation loop, `some(minute === displayMinute)`, `filter(minute === displayMinute)`. | Collapse into one `useMemo` on `[engine]` producing `{ shown, shownScore, minuteEvents, fastForward }`. |
| **med** | `MatchScreen.tsx:348` vs `:220–224` | `minuteEvents` duplicates the scan already performed inside the `highlight` `useMemo`. `:352` `minuteDwellMs(...)` also duplicates the computation the playback effect already did at `:182`. | Return `minuteEvents` and `dwell` from the existing `highlight` memo. |
| **med** | `MatchScreen.tsx:374–388` | `pitchProps` object literal + `pitchSvg` + `pitch2d` element trees rebuilt every render. Harmless today only because **nothing is memoized** — the moment you add `React.memo` to `PitchView`, these break it immediately. | `useMemo` `pitchProps`; hoist `pitchSvg`/`pitch2d` into memos keyed on it. |

### 3b. The animation-restart bug

| Sev | Location | Why it costs | Fix |
|---|---|---|---|
| **med-high** | `MatchScreen.tsx:215–228` — `useMemo(..., [engine])` | The memo is keyed on **`engine` object identity**, but `engine` is replaced by *any* store write, not just a minute advance. `matchStore.shout()` (`:418`) writes a fresh `structuredClone` while `phase === 'playing'`. Result: pressing a ShoutBar button mid-minute produces a new `seq` array ⇒ `PitchView.tsx:69` restarts the keyframe timers from step 0, `PixiPitch.tsx:259` (`p.sequence !== curSeq`) resets `seqStart` and clears the trail, and `Match3D.tsx:296` (`p.sequence !== lastSeq`) resets `minuteStart`. **The ball visibly teleports back to the start of the highlight.** This is both wasted work and a visual defect. | Key the memo on the minute, not the object: `[engine?.minute, engine?.events.length]`, and read `engine` through a ref inside. The comment at `:213–214` states the intent ("sequence reference stable for the whole minute") — the dep array just doesn't deliver it. |

### 3c. Per-render O(n·m) squad scans (paused/tactics path, not tick-driven)

| Sev | Location | Why it costs | Fix |
|---|---|---|---|
| **med** | `TacticsBoard.tsx:237` `const advice = buildCoachAdvice(engine, SIDE)` | Recomputed on **every** `CoachMeeting` render. `coach.ts:66` `bottom3Stamina` does 11 × `squad.find` (26) = 286 scans **plus an `Array.sort()`**, on top of two `engine.events.filter` passes. `TacticsBoard` re-renders on every `setTab`/`setPop`/`setSubOut`/`setSubIn` — i.e. **every click on the tactics board**. | `useMemo(() => buildCoachAdvice(engine, SIDE), [engine])`. |
| **med** | `SubPanel.tsx:43–48` | `byId` = `squad.find` called 11× (11×26 = 286), then `squad.filter(p => !lineupIds.includes(p.id))` = 26×11 = 286 more. Every render, and this panel re-renders on every selection click. | Build one `Map<id, Player>` in a `useMemo` on `[state.team.squad]`; make `lineupIds` a `Set`. |
| **med** | `TacticsBoard.tsx:68–69, 87, 94–96` | `byId` closure re-scans the 26-squad on each of 4 call sites per render. | Same `Map` fix. |
| **low-med** | `OppPanel.tsx:36–42` | Same pattern for the away side (11 × 26 `find` + a `Set` rebuild) per render. | Same. |
| **low-med** | `TeamTalk.tsx:46–53` | `filter → map → reduce` over the lineup plus a `squad.find` closure, per render. Halftime-only, so cost is bounded. | `useMemo` on `[sideState]`. |
| **low-med** | `LineupScreen.tsx:30–34` | `lineupIds` Set + `bench` filter (26×11) + two `find`s rebuilt on every render; `LineupScreen` re-renders on **every drag pointer-move** via `@dnd-kit`'s `useDraggable`/`useDroppable` (`:141–149`). This is the one place with high render frequency outside the match tick. | `useMemo` `lineupIds`/`bench` on `[team.squad, lineup]`, and memoize `PitchChip`/`BenchCard` (see 3d). |
| **low** | `PitchView.tsx:140–141` | `new Map(squad.map(...))` **twice** per `SideDots` call × 2 sides = 4 Maps over 26 players (104 entries) per render, plus 11 `slotCoords` allocations (`:145`). Only on the tick path when SVG is the active renderer. | One `useMemo`'d Map per side; `slotCoords` (`formations.ts:79`) could return frozen module-scope objects instead of allocating. |
| **low** | `HubScreen.tsx:50, 86` | `loadTeam` (`loader.ts:90`) is **uncached** and re-runs full validation (`loader.ts:63–87`: 26 object spreads + ~200 `Object.entries` range checks) on every call. HubScreen calls it 1 + up to 8 times per render ≈ **~2,000 checks/render**. Not on a timer, so low. | Add a module-level `Map` cache inside `loadTeam`. Fixes this and `EndingScreen.tsx:104`'s `loadAllTeams()` (12×) in one line. Note `App.tsx:144,190` already work around this with `useMemo`. |
| **low** | `EndingScreen.tsx:115` `tally(records)` | Unmemoized while its two neighbours (`:102`, `:107`) are memoized. Trivial cost (≤8 records), just inconsistent. | Fold into the existing memo. |
| **low** | `App.tsx:158, 170` `tactics ?? pickBestXI(kor)` | `pickBestXI` (`lineup.ts:16–22`) does **11 × (filter + sort over 26 players)** and is called unmemoized in the render body. Today `tactics` is always non-null at `:170` (set together with `setStep('match')`), but if that ever changes, a fresh object flows into `MatchScreen`'s `initialTactics` dep (`:156`) and **restarts the match on every render**. Latent footgun. | `useMemo(() => tactics ?? pickBestXI(kor), [tactics, kor])`. |

### 3d. `React.memo`: zero usages

**`React.memo` appears nowhere in `src/`.** Combined with the object/closure props below, adding it today would be a no-op — the props change identity every render regardless:

| Location | Inline prop that would defeat `memo` |
|---|---|
| `MatchScreen.tsx:374` | `pitchProps` object literal → spread into `PitchView`/`PixiPitch`/`Match3D` |
| `MatchScreen.tsx:381–388` | `pitchSvg` / `pitch2d` element trees, passed as `fallback` props |
| `MatchScreen.tsx:519` | `onDone={result => finishMatch(result)}` |
| `MatchScreen.tsx:532` | `onClick={() => { reset(); startMatch(...) }}` |
| `MatchScreen.tsx:570` | `onClick={() => onChange(s)}` (inside `SpeedToggle`'s map) |
| `TacticsBoard.tsx:90` | `ghost={{ slotIndex, number }}` object literal → `PitchView` |
| `TacticsBoard.tsx:80, 84, 202, 203, 204` | `onDotClick` / `resetSub` / `onSelectOut` / `onSelectIn` / `onConfirmed` closures |
| `LineupScreen.tsx:105, 124` | `onClick={() => handleClick(...)}` per chip/card |
| `SubPanel.tsx:84, 99` | `onSelect={() => pickOut(...)}` per card |

**Highest-leverage memo targets, in order:** `PitchView` (22 dots, tick-driven), `SubCard` (`SubPanel.tsx:113`, 26 instances), `PitchChip`/`BenchCard` (`LineupScreen.tsx:151,175`, 26 instances re-rendered per drag frame), `PlayerRadar` (`PlayerCard.tsx:147` — pure math over static player stats, rendered 15× in the bench list), `Scorebug`. Each needs its inline props stabilized first.

Positive note: `Match3D.tsx:130` and `PixiPitch.tsx:78` deliberately funnel props through a ref so the 60fps loops read fresh props without React involvement. That's the right architecture and it's why the tick path is cheap despite everything above.

---

## 4. List keys

| Sev | Location | Verdict |
|---|---|---|
| **low** | `PitchView.tsx:155` `key={`${which}-${i}`}` | Index key over the 11-slot lineup. Defensible — the key identifies a *pitch slot*, not a player, and on substitution you *want* DOM reuse so the CSS position transition plays. Switching to `slot.playerId` would actually make subs snap. **Leave as is**; add a comment. |
| **low** | `ShootoutPanel.tsx:77` `key={i}` | Index key on `<li>` wrapping a `<select>`. `setKicker` (`:45–54`) **swaps entries between slots**, so identity does shift under the key. Harmless only because the `<select>` is fully controlled by `value={id}` and holds no uncontrolled state. Fragile if a child ever gains local state. |
| **low** | `ShootoutPanel.tsx:119` | Append-only reveal list — index keys fine. |
| **low** | `EndingScreen.tsx:167`, `PlayerCard.tsx:170,175,180`, `PressConference.tsx:93` | Fixed-length static lists (epilogue paragraphs, 6/3 radar axes, 3 answer options). Index keys correct. |
| **ok** | `HubScreen.tsx:84`, `EndingScreen.tsx:205` | Composite keys with an index tiebreaker over append-only lists. Fine. |
| **ok — intentional** | `Ticker.tsx:18,23` `key={`${lines.length}-prev`}`; `MatchScreen.tsx:481,489,498` `key={`drama-${displayMinute}`}` | Deliberately *unstable* keys used to force remount so a CSS enter-animation replays. Correct idiom. `lines.length` only changes when a new event lands, so this does **not** remount every tick. |

**No `Math.random()` or `Date.now()` keys anywhere** — consistent with the project's determinism rule.

---

## 5. React 19 specifics

| Sev | Location | Finding |
|---|---|---|
| **info** | `main.tsx:8–10` | `<StrictMode>` **is on**. Every component double-renders in dev, so any React DevTools Profiler numbers are **2× inflated**. Measure a production build, or temporarily strip StrictMode when profiling. |
| **info** | — | No direct `useSyncExternalStore` usage. zustand v5.0.14 uses it internally; React 19.2.7; **React Compiler is not enabled** (`vite.config.ts` has plain `@vitejs/plugin-react`, no `babel-plugin-react-compiler`). Enabling it would auto-fix most of §3a/3d, but it's a risky dependency change this close to the 2026-08-03 deadline. |
| **med** | `PixiPitch.tsx:78`, `Match3D.tsx:130` | `propsRef.current = props` is a **ref mutation during render**. React 19's concurrent renderer may discard and replay a render; the ref would then hold props from a commit that never happened. Under StrictMode it's assigned twice per render today (harmless). **Fix:** move to `useEffect(() => { propsRef.current = props })` with no dep array. |
| **med** | `PixiPitch.tsx:95–116` | Under StrictMode the effect runs → cleanup → runs again. `start()` `await`s `application.init()` — which **creates a real WebGL context** — *before* checking `destroyed` at `:111`. So dev builds construct and immediately destroy one full Pixi `Application`. `Match3D.tsx:148–151` handles this correctly (bails on `cancelled` right after the dynamic import, before `buildScene`). **Fix:** hoist a `if (destroyed) return` check before `application.init()`, or gate the whole thing behind a mount flag. Dev-only, but it distorts startup profiling. |
| **low** | `MatchScreen.tsx:199–210` | `useEffect` whose dep array (`[tacticsMode, tacticsMounted]`) contains the state it sets. Causes a redundant second effect run + render per pause. **Fix:** drop `tacticsMounted` and use a ref for the "was mounted" check. |
| **low** | `MatchScreen.tsx:242–253, 258–268, 276–281` | Three effects with `engine` in deps that therefore fire on **every tick**; each does an `engine.events.find`/`filter` pass. Side effects are ref-guarded so behaviour is correct, but that's 3 more O(events) scans per tick on top of §3a's five. **Fix:** depend on `engine?.minute` instead of `engine`. |
| **ok** | `MatchScreen.tsx:169–191` | Playback effect deps `[phase, speed, advanceMinute]` are correct — the loop self-reschedules and deliberately avoids `engine`. Changing speed mid-play cancels and reschedules with a fresh dwell (no double-advance). |
| **ok** | `Match3D.tsx:438`, `PixiPitch.tsx:420` | Empty dep arrays with `eslint-disable` — **intentional and correct**. The THREE scene (4,200-instance crowd + textures) and the Pixi `Application` are built exactly once per mount. No scene is being rebuilt per render. |
| **ok** | `ConsolePanel.tsx:36–40` | Deliberately narrowed to `[phase]` with a documented rationale (sync draft only on intervention-window entry). Correct. |

---

## 6. Context providers

**None.** `createContext` / `useContext` / `.Provider` appear nowhere in `src/`. All cross-component state flows through the two zustand stores or props. Nothing to fix here.

---

## Recommended order of work

1. **`MatchScreen.tsx:338`** — stop calling `commentate` over the full event history every render. Single biggest win, ~5 lines. *(high)*
2. **`MatchScreen.tsx:215`** — re-key the `highlight` memo to `engine.minute`. Fixes the visible ball-teleport when shouting mid-minute. *(med-high, also a bug fix)*
3. **`MatchScreen.tsx:337–352`** — collapse the five event-array passes into one memo. *(med)*
4. **`TacticsBoard.tsx:237`** — `useMemo` `buildCoachAdvice`. One line, removes a sort + ~300 scans from every board click. *(med)*
5. **`loader.ts:90`** — add a module-level cache to `loadTeam`. One line, removes ~2,000 validation checks per `HubScreen` render and lets callers drop their defensive `useMemo`s. *(low, but free)*
6. **`PixiPitch.tsx:78` / `Match3D.tsx:130`** — move ref writes out of render. *(med, correctness under concurrent rendering)*
7. Squad-`Map` refactor across `SubPanel` / `TacticsBoard` / `OppPanel` / `PitchView`, then `React.memo` on `PitchView`, `SubCard`, `PitchChip`, `BenchCard`, `PlayerRadar`. *(med, larger diff)*

Items 1–6 are roughly 40 lines total and carry essentially no regression risk — reasonable to land before the deadline. Item 7 is a wider refactor; given that measured tick pressure is only 3–5 renders/s, it's optional unless the drag interaction in `LineupScreen` feels sluggish in testing.