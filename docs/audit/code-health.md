# 코드 건강도 감사

Analysis complete. Here are the findings.

## 1. Circular dependencies — CLEAN

`npx madge --circular --extensions ts,tsx src` → **"No circular dependency found"** (151 files processed). Nothing to fix.

`--orphans` returned only test files + `src/main.tsx` (the Vite entry). No dead modules.

## 2. Layer violations — CLEAN

- `src/engine/**` imports only `./types`, `./rng`, `./fitness`, `./tactics`, `./lineup`, `./formations`, `./strength`, `./simulate`. Zero UI/game imports.
- `src/data/**` imports only `../engine/types`, `../engine/formations`, and team JSON. Clean.
- `src/game/**` imports only `../engine/*` and sibling `./` modules. Zero `src/ui` imports.
- `three/` ↔ `pixi/`: no cross-import. The only "pixi" token in `three/` is a comment at `Match3D.tsx:12`; the fallback is injected as a `ReactNode` prop precisely to keep the chunks separate. Correctly done.

## 3. Duplicated logic — the real problem (~350 duplicated lines)

Good news first: **formation coordinates are NOT duplicated.** `src/ui/pitch/formations.ts:13-70` holds the single `HOME_COORDS` table and all three renderers call `slotCoords` from it (`PitchView.tsx:3`, `PixiPitch.tsx:4`, `movement.ts:16`). `src/engine/formations.ts` is only 35 lines (slot *positions*, not coordinates). Keep this.

### A. Two `toWorld` functions with the same name, different signature and different origin — highest footgun

| | file:line | signature | origin |
|---|---|---|---|
| 3D | `three/types.ts:13-15` | `toWorld(x, y) → {x, z}` | centered (−52.5..+52.5) |
| 2D | `pixi/stage.ts:33-35` | `toWorld(p: Pt) → {x, y}` | top-left (0..105) |
| SVG | `PitchView.tsx:10-12` | `sx(x)`/`sy(y)` inline | top-left |

`PITCH_W`/`PITCH_H = 105/68` is declared three times: `three/types.ts:9-10`, `pixi/stage.ts:11-12`, `PitchView.tsx:8-9`.

### B. Pitch marking geometry — 3 copies, already drifted

`three/textures.ts:17-37` is the canonical spec (`PENALTY_BOX_W = 40.32`, `GOAL_AREA_W = 18.32`, `CENTER_CIRCLE_R = 9.15`, `PENALTY_SPOT_D = 11`, `CORNER_R = 1`), drawn at `textures.ts:216-288`. But:
- `PitchView.tsx:108-133` (`PitchMarkings`) re-hardcodes `penH = 40.3`, `goalH = 18.3`
- `PixiPitch.tsx:154-197` (`drawPitch`) re-hardcodes `penH = 40.3`, `goalH = 18.3`

**The 2D renderers are drawing a 2cm-wrong penalty box**, and both omit the penalty spots, penalty arc, and corner arcs the 3D canvas draws. ~55 duplicated lines.

### C. Choreography keyframe sampling — 3 implementations of one algorithm

All three re-derive "walk `ChoreoStep[]` to find segment k, compute u, lerp ball, lerp movers by playerId":
- `three/movement.ts:188-223` `sampleSequence()` — returns `{ball, movers, segIndex, u, finished, after, start}`
- `pixi/PixiPitch.tsx:213-236` `sampleSeq()` — same walk, then applies bezier
- `PitchView.tsx:67-93` `ChoreoLayer` — same walk via a `setTimeout` chain + CSS transitions

~60 lines. A shared `sampleChoreo(steps, t)` returning movement.ts's richer `SeqSample` serves all three (pixi layers bezier on the returned segment; SVG needs only `segIndex` + duration).

### D. Ball trajectory — two incompatible models, and they disagree

- 3D: `movement.ts:76-85` (`BALL_PEAK`), `:150-175` `arcKindFor(eventType, segIndex, segCount)`, `:178-185` `ballHeight()` — a **height (Y)** arc, kind chosen from `MatchEventType` (corner seg 0 → `'cross'` peak 6m; last seg of goal/shot/save/miss → `'shot'`)
- 2D: `stage.ts:19-93` (`easeFor`/`bezierAt`/`controlFor`) + `PixiPitch.tsx:223-224` `const isShot = i === seq.length - 2` — a **lateral bezier bulge**, kind chosen purely by segment index

So a corner kick renders as a lofted cross in 3D and as an ordinary pass in 2D. The event→arc *classification* (`arcKindFor`, 26 lines) is dimension-independent and should be shared even if the rendering of the arc stays per-renderer.

### E. Goal FX — 4 parallel implementations that don't match

| | 3D | 2D |
|---|---|---|
| particles | `fx3d.ts:298-407` `goalBurst` — 60, gravity −16, seeded via `hash01` | `pixi/fx.ts:37-80` `spawnBurst` — 44, gravity +62, seeded via `(i*37)%45` arithmetic |
| flash | `fx3d.ts:443-522` `flashQuad`, `alpha = peak*(1-u)²`, presets at `:48-50` | `PixiPitch.tsx:396-405` inline piecewise ramp, hardcoded 0.72/0.6, 520ms |
| shake | `camera.ts:213-223` `shake(t, amp, seed)` — 2-freq mix, 3-axis, metres | `stage.ts:139-146` `shakeOffset(progress01, amp)` — sin/cos decay, 2-axis, px |
| trigger | `Match3D.tsx:342-359` — `frame.event === 'goal-*'`, guarded by `goalMinute` | `PixiPitch.tsx:259-269, 332-337` — `goalArmed` on new sequence, fired at `prog >= last.t` |

Two independent "did a goal just happen" state machines and two flash curves means the goal moment literally looks different depending on which renderer is active. ~80 lines.

### F. Copy-paste inside `three/` (same layer, no excuse)

- **`disposeTree`** — `scene.ts:537-569` (33 lines) vs `fx3d.ts:535-561` (27 lines). `fx3d.ts:534`'s own comment says *"scene.ts와 같은 규칙"*. `scene.ts`'s version additionally disposes lights. Extract → saves 27 lines.
- **`toTexture`** — `scene.ts:150-166` vs `fx3d.ts:525-532`. Same function; fx3d's is the degenerate case. Saves 8 lines.
- **Contact shadow — three implementations.** `textures.ts:320-333` `makeShadowCanvas` → `scene.ts:174-190` `makeContactShadow`; and `player3d.ts:453-478` `shadowTexture()` builds its *own* radial-gradient canvas, with the comment at `:622` admitting *"Task 2 의존 없이 자체 생성"*. Gradient stops differ (`0.55/0.26/0` vs `0.95/0.62/0.16/0`), so players and the ball have visibly different shadow falloff. Saves 26 lines.

### G. Math helpers — 9 `clamp`, 4 `lerp`, 5 FNV-1a

FNV-1a, byte-identical body, five times:
`movement.ts:131-138` `hash`, `textures.ts:46-53` `fnv1a` (comment at `:45` already admits the duplication), `player3d.ts:50-57` `hash01`, `game/coach.ts:39-45` `hash`, `game/pressconf.ts:15-21` `hash`.

Worse: **`hash01` names two different algorithms** — `player3d.ts:50` takes a `string` and is FNV-1a; `textures.ts:56` takes a `number` and is xorshift-mix. `camera.ts`, `scene.ts`, `fx3d.ts` all import the numeric one. An active footgun.

`clamp`: `movement.ts:127`, `fx3d.ts:20`, `camera.ts:89`, `Match3D.tsx:71`, `player3d.ts:35`, `stage.ts:24`, `choreography.ts:22`, `simulate.ts:292`, `sfx.ts:159`.
`lerp`: `movement.ts:128`, `camera.ts:90`, `stage.ts:28` — plus `engine/tactics.ts:19` which is `lerp(t, lo, hi)` with `t` on a **0-100** scale (different contract, same name).
`easeInOutCubic`: `camera.ts:226-229` and `stage.ts:59-61` — identical.

### H. React shell duplication between the two renderer components

- `cssColor` — `PixiPitch.tsx:36-49` vs `Match3D.tsx:74-86`, 14 lines each, near-identical
- `webglAvailable` `PixiPitch.tsx:52-59` vs `webgl2Available` `Match3D.tsx:89-96`
- `HOME_FALLBACK`/`AWAY_FALLBACK` `0xe63946`/`0x4895ef` — `PixiPitch.tsx:32-33`, `Match3D.tsx:37-38`, and again as `--bc-home`/`--bc-away` in `src/ui/tokens.css:13-14`
- mount-once `useEffect([])` + `propsRef.current = props` + `failed` state + `reducedMql` — `PixiPitch.tsx:73-90` vs `Match3D.tsx:126-140`
- Morale badge `>=75 → 🔥 / <=35 → 😰` — `PitchView.tsx:180-185` `moodBadge()` vs `PixiPitch.tsx:304` inline ternary

### Proposed shared modules

```
src/ui/pitch/shared/
  geometry.ts      PITCH_W/H, FIELD_MARKS (canonical 40.32/18.32/16.5/5.5/9.15/11/1),
                   toWorldCentered(x,y)->{x,z}, toWorldTopLeft(x,y)->{x,y}
  choreo-sample.ts sampleChoreo(steps,t) -> {segIndex,u,finished,after,ball,movers}
                   arcKindFor(eventType, segIndex, segCount)
  fx-timeline.ts   flashCurve(u,preset), shakeEnvelope(u), BURST spec (normalized)
  hash.ts          fnv1a(s), unit01(s), hash01i(n), hash2(a,b,salt)
  num.ts           clamp, clamp01, lerp, smoothstep, easeInOutCubic, easeInOutQuad
src/ui/pitch/three/dispose.ts    disposeTree, toTexture
src/ui/pitch/renderer-shell.ts   cssColor, webglAvailable(v), TEAM_COLOR_FALLBACK, moodBadge
```

Gross removal ≈ **357 lines** (markings 55 · choreo 60 · arc 26 · goal FX 80 · dispose/toTexture 35 · shadow 26 · hash/math 45 · shell 30). Net after ~130 lines of shared code: **~225 lines**. The bigger win is behavioural: 2D and 3D would stop disagreeing on pitch dimensions, corner trajectories, and goal-flash timing.

## 4. Oversized files

| lines | file | verdict |
|---|---|---|
| 1052 | `three/player3d.ts` | **Split — but the seam is already drawn.** `:26-347` is pure three-free pose math (`gaitAngles`, `kickAngles`, `celebrateOffset`, `diveAngles`, color helpers), `:349-1052` is three rig assembly. The banner comment at `:349` marks the exact cut. → `player3d/pose.ts` (~320) + `player3d/rig.ts` (~700). The rig half could shed another ~120 by extracting the geometry/material/texture caches (`:384-478`) into `player3d/cache.ts`. |
| 602 | `match/MatchScreen.tsx` | **Genuine god component — 8 responsibilities.** Playback timer loop (`:169-191`), tactics-mode mount/exit choreography (`:197-210`), highlight sequence selection (`:215-228`), whistle/goal/crowd audio wiring (`:232-288`), TTS wiring (`:258-273`), renderer chain assembly (`:374-388`), full JSX (`:390-556`), plus two co-located subcomponents (`SpeedToggle :561-577`, `StatsTable :588-602`). Natural split: `usePlaybackLoop()`, `useMatchAudio()` (whistle + goal + crowd + TTS, five effects), `useHighlightSequence()`, `<PitchChain>`, and move `SpeedToggle`/`StatsTable` to their own files. Would leave ~250 lines of actual screen. |
| 587 | `three/movement.ts` | Justified — one coherent pure function (`computeFrame`) plus its helpers, heavily documented, 642 lines of tests. Leave. |
| 569 | `three/scene.ts` | Borderline. Mixes pitch/goals (`:223-306`), stands + ad boards (`:308-366`), crowd instancing + wave (`:368-440, 473-485`), floodlights + lighting (`:442-471`), and the duplicated `disposeTree`. Crowd instancing (`scene/crowd.ts`, ~110 lines) is the clean extraction; `disposeTree`/`toTexture` move to the shared `dispose.ts`. |
| 561 | `three/fx3d.ts` | Three unrelated features in one file: ball (`:130-268`), goal burst (`:270-407`), flash quad (`:409-522`). Split into `fx/ball.ts`, `fx/burst.ts`, `fx/flash.ts`; the tail (`:524-561`) is the duplicated helpers. |
| 505 | `audio/sfx.ts` | Borderline-justified. Sample loading + mute state + PRNG + AudioContext + 4 sound generators (`crowdLoop :247`, `goalBurst :342`, `whistle :408`, `concedeMurmur :460`). If split: `sfx/context.ts` (state, mute, ctx, loading) + `sfx/sounds.ts` (the four generators). Low priority. |
| 443 | `three/Match3D.tsx` | Justified for what it does, but the low-power degradation logic (`:43-50, 104-120, 262-292`) is a separate concern → `use3dQuality()` hook, ~60 lines. |
| 435 | `pixi/PixiPitch.tsx` | The 435 lines are almost all inside one `useEffect`. The `sampleSeq`, flash-curve and goal-trigger blocks should move to `stage.ts`/shared (per §3C/E), taking it to ~330. |
| 426 | `game/matchStore.ts` | **Mixes store with domain tables.** `:29-146` is pure lookup data + pure functions (`TEAM_TALK_TABLE`, `EXPECTATION_ADJUST`, `teamExpectation`, `recommendedTone`, `SHOUT_TABLE`, `scoreSituation`) with no zustand involvement; `:190-426` is the store. Extract `game/teamTalkRules.ts` (~120 lines) — mirrors the existing `teamTalkLines.ts` split. |
| 401 | `three/camera.ts` | Justified. Pure shot math + one rig, 459 lines of tests. |
| 395 | `three/textures.ts` | Justified — a canvas-generator library, each function independent. |
| 314 | `game/pressconf.ts` | Justified (mostly Korean copy tables). |

## 5. Test coverage gaps

`@vitest/coverage-v8` is not installed, so no numeric coverage (did not install per instructions). Baseline: **`npx vitest run` → 62 files, 701 tests, all passing, 2.26s.**

Analytically, **every module under `src/engine`, `src/game`, `src/ai`, `src/online`, `src/audio` has a test file or is directly exercised by one.** Specifically checked:

- `src/engine/formations.ts` — no own test file, but `XI_SLOTS` + `mapFormation` are both imported and asserted by `src/engine/__tests__/lineup.test.ts:5`. Covered.
- `src/data/groupStage.ts` — no own test file, but `GROUP_MATCHES` is tested in `src/data/__tests__/loader.test.ts:10,89`. Covered.
- `src/engine/fixtures/testTeams.ts` — a test fixture, used by 31 test files.

**The one real gap: `api/narrate.ts` (131 lines) has no test at all.** It is the serverless AI proxy — the only source file with zero test coverage of any kind. Its client-side counterparts (`ai/aiClient`, `ai/requestGuard`, `ai/safeguard`, `ai/prompts`) are all tested; the handler itself is not.

**Secondary gap: `NewspaperCard.tsx:114-206` `renderNewspaperPng`** (~92 lines of canvas drawing) is explicitly untestable in jsdom by design (comment at `:109`: *"jsdom에서 getContext('2d')가 null → null 반환(테스트 스킵). 브라우저 E2E 검증"*) — and there is no E2E suite. This is the largest block of never-executed production code.

**Big 3D files: all tested.** `player3d` (756 test lines), `movement` (642), `fx3d` (498), `camera` (459), `scene` (428), `textures` (163 + a jsdom variant), `Match3D` (`match3d.jsdom.test.tsx`), `PixiPitch`, `stage`, `pixi/fx`. Coverage discipline here is strong — the pure-math/three-injection split was clearly done to enable it.

## 6. Dead code / unused exports

Scanned all value exports (`function`/`const`/`class`/`let`) for non-test importers. 127 have no production importer, but ~97 of those are constants deliberately exported so tests can assert against them (e.g. `camera.ts:36-81` thresholds, `movement.ts:24-58` tuning constants, `playback.ts:26-34`). That's a legitimate pattern, not dead code.

**Genuinely dead — one item:**

- **`src/game/pressconf.ts:94` `ANSWER_POOLS`** — declared, exported, and referenced *nowhere*: not in production, not in tests, not even elsewhere in its own file. Its doc comment claims *"헤드라인 역분류·UI 프리뷰용"* but no such consumer exists. Delete.

**Over-broad exports (used only inside their own file, no test reference)** — harmless but widen the API surface; downgrade to module-private:
`fx3d.ts:28 TRAIL_STEP`, `:30 TRAIL_MIN_SPEED`, `:42 BURST_GRAVITY`; `textures.ts:33 SPOT_R`, `:40 GRASS_DARK`, `:41 GRASS_LIGHT`, `:42 LINE_COLOR`; `camera.ts:61 GOAL_CAM_Y`, `:63 GOAL_CAM_BEHIND`, `:64 GOAL_CAM_FOV`, `:70 CELEBRATE_Y`, `:71 CELEBRATE_FOV`, `:73 CELEBRATE_OMEGA`, `:79 SHAKE_DECAY_S`; `movement.ts:32 CONVERGE_COUNT`, `:36 CONVERGE_RANGE`, `:46 MIN_POSE_SEPARATION`, `:50 GK_BOX_DEPTH`, `:52 GK_BOX_HALF_Z`, `:54 ARRIVE_RADIUS`, `:56 CELEBRATE_MS`, `:58 DEFAULT_DWELL_MS`; `matchStore.ts:39 EXPECTATION_THRESHOLD`; `nickname.ts:10 MIN_LEN`, `:11 MAX_LEN`, `:14 PROFANITY_WORDS`; `PlayerCard.tsx:8 FIELD_AXES`, `:17 GK_AXES`; `NewspaperCard.tsx:114 renderNewspaperPng`.

## 7. TODO / FIXME / HACK / XXX

**Zero.** `grep -rn "TODO\|FIXME\|HACK\|XXX" src api --include='*.ts' --include='*.tsx'` returns nothing across all 125 source files. Notably clean — the codebase documents rationale in prose comments instead of leaving markers.

---

## Priority

1. **§3B pitch geometry** — an actual correctness bug (40.3 vs 40.32, missing arcs/spots in 2D), cheapest fix, import the constants that already exist in `textures.ts:17-37`.
2. **§3E goal FX + §3D arc classification** — the two renderers visibly disagree on the single most important moment in the product. Highest user-facing payoff.
3. **§4 `MatchScreen.tsx`** — the only true god object; 5 audio effects alone justify a `useMatchAudio()` hook.
4. **§3F `disposeTree`/`toTexture`/shadow** — pure copy-paste inside one directory, zero risk, ~60 lines, the code already admits it in comments.
5. **§3G `hash01` name collision** — two different algorithms under one name across `player3d`/`textures` is a latent bug waiting for someone to import the wrong one.
6. **§5 `api/narrate.ts`** — only untested module; it's the network boundary.
7. **§6 delete `ANSWER_POOLS`** — one line.
8. **§4 `player3d.ts` split** — the seam is already drawn at `:349`; low risk, but it's working code with 756 lines of tests behind it, so lowest urgency.