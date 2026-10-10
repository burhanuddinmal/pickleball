# Game Feel ("Juice") Implementation Plan

Visual-feedback polish for Pickle Smash, split into three tiers. Each tier is sized for one
Claude Code session and can be started cold: read **Ground rules** and **Shared building
blocks** first, then the tier you're doing.

> To start a session: "Implement Tier N from docs/juice-plan.md". When the tier is done, update
> its **Status** line and add any new shared APIs to *Shared building blocks*.

---

## Ground rules (all tiers)

- **Presentation only.** Nothing here may change gameplay, physics, or the fixed-tick simulation
  (`SIM.TICK_DT`). Views read state; they never write it. `RallyManager` stays deterministic so
  `tests/rally.test.ts` keeps passing.
- **Event-driven.** Effects are triggered from `GameManager.bindRallyEvents()` via the rally
  `EventBus` (`hit`, `bounce`, `net`, `rallyEnd`, `serveStart`, `swing`), or from state changes in
  `GameManager.onStateChange()`. Don't reach into `RallyManager` internals from render code.
- **Respect the "reduce effects" switch.** `GameManager.setReducedEffects()` is the single place
  that toggles motion-heavy effects. Every new camera shake, hit-stop, slow-mo, screen flash or
  large CSS animation must be disabled (or heavily toned down) when it's on. CSS: gate on
  `#ui-root.reduce-fx` and `@media (prefers-reduced-motion: reduce)`.
- **Mobile budget.** `SceneManager.quality` is `'low' | 'medium' | 'high'`. No per-frame
  allocations in `update()` loops (reuse scratch vectors). Post-processing (bloom etc.) only on
  `'high'`. Particle counts are scaled down on `'low'`.
- **Code style.** Match the surrounding code: short JSDoc on classes and non-obvious methods, TS
  strict, no new dependencies unless the tier says so (`three/examples/jsm/*` is fine).
- **Verify.** `npm run typecheck` and `npm test` must pass. Then run `npm run dev` and play a few
  rallies to check the effects look right on desktop, and in a narrow portrait viewport.
  - How Tier 1 was checked automatically: headless Chrome (`chrome.exe --headless=new
    --remote-debugging-port=… --use-angle=d3d11 --ignore-gpu-blocklist`; SwiftShader is too slow)
    driven over the DevTools protocol with Node's built-in `WebSocket`. In dev builds `window.game`
    is the `GameManager`. Set `game.heroCtl.input = new game.ai.constructor(game.ai.profile, 7)`
    so the AI plays both sides, then call `game.startPlaying()`. Subscribe to
    `game.rally.bus` events and set `game.frozen = true` a few `requestAnimationFrame`s later to
    capture a moment (`Page.captureScreenshot`, optionally with a zoomed `clip` around the
    projected ball). Captures 2 frames after a hit land inside the hit-stop; about 9 frames
    shows the sparks spread out.

---

## Shared building blocks

These exist after Tiers 1–3. Reuse them; extend rather than duplicate.

| Module | What it gives you |
| --- | --- |
| `src/game/HitStop.ts` | The one time-scale controller. `trigger(seconds)` is a brief hit-stop (`active`); `slowMo(seconds, scale)` is longer slow motion (`slowActive`); where they overlap the slower wins. `scale(dt)` converts real frame time into sim time. `enabled` follows reduce-effects (turns off both). |
| `src/render/Particles.ts` | `Particles`: pooled GPU point sprites (one draw call per pool). `emit({ pos, vel, life, size, color, gravity, drag, grow })`. Construct one pool per blending mode. The vertex shader pulls each sprite toward the camera by its radius so the court doesn't slice flat quads. Reuse that trick for any new sprite near the ground. |
| `src/render/Effects.ts` | High-level one-shot VFX: `hitBurst(pos, dir, intensity)`, `bounceBurst(pos, speed)`, `netPuff(pos, tape)`, `whiffPuff(pos)`, `footDust(pos, dir)`, `confetti(pos)` / `clearConfetti()`, `update(dt)`. Owns the particle pools, the ground-ring pool and the confetti pool. `flashEnabled` follows reduce-effects. |
| `src/render/Confetti.ts` | Instanced flutter quads (one draw call): `burst(center, count)`, `update(dt)`, `clear()`. Idle once everything has landed and faded. |
| `src/render/BallView.ts` | `onHit(dir, intensity)` / `onBounce(speed)` drive a damped-spring squash & stretch. Trail (a `RibbonTrail`) fades along its length and is coloured by speed. Contact shadow tightens and darkens near the ground. |
| `src/render/RibbonTrail.ts` | Camera-facing tapered ribbon: `push(pos)`, `build(camera, width, color, opacity)`, `reset()`. Used by the ball trail and `PaddleSwoosh`. |
| `src/render/PaddleSwoosh.ts` | Ribbon behind `AthleteRig.paddleTip` while `athlete.swing.active`; stops recording when the tip doesn't move, so it freezes during hit-stop. |
| `AthleteRig.paddleTip` | Empty `Object3D` at the paddle-face centre on both rigs (`PADDLE_FACE_CENTER` in `PaddleModel.ts`). Use `getWorldPosition()` for anything that needs to come from the paddle. |
| `src/court/Net.ts` | `NetView`: `onHit(x, tape)` sends a shader ripple through the net (z offset plus a white sheen, because z alone barely shows from the broadcast camera) and flashes the tape warm on a cord. `update(dt)`. `flashEnabled` follows reduce-effects. |
| `src/render/LineCalls.ts` | `showOut(x, z)` (ring and upright "OUT" sprite, stays until `clear()`), `showClose(x, z, viewSide)` ("CLOSE!" plus a line highlight, 0.8 s). Labels come from `labelTexture(text, color)` in `Textures.ts` (`userData.aspect` gives width/height). |
| `src/render/Indicators.ts` | Aim ring pops in and out over 0.12 s. Landing ring takes `remaining01` and closes from 1.8× to 1×. |
| `src/render/CameraRig.ts` | `impulse(strength)`: short dolly "kick" toward the net. `shake(amount)`: trauma (decays 1.6/s, visible as trauma² rotational noise). `punch(deg)`: brief FOV narrowing on top of `baseFov`. All three are gated by `shakeEnabled` (reduce-effects). Framing math uses `baseFov`, never the punched FOV. `setPointFocus(pos \| null)`: point-end push-in (15% along the line to `pos`, so it keeps its screen spot, plus a lateral drift). `orbit(center \| null, side)`: match-over orbit that takes over orientation; eased in polar coordinates so it swings around the winner, never through them; still under reduce-effects. `snap()` ends the orbit. |
| `src/ui/HUD.ts` | Score and rally values "bump" via CSS classes (`.bump`). `showBanner(..., slam)` has a scale-and-fade exit and a skewed "slam" entrance. `edgeGlow('good' \| 'bad')`, `setGamePoint('hero' \| 'rival' \| null)`. `callout(text, level)` (under the scoreboard, clear of the court), `setRallyHeat(0..3)` (`.hot` + `data-heat` on the rally counter), `flyPoint(holder, x, y, onLand)` (WAAPI "+1" arc from a screen point into a score box). |
| `AthleteRig` (both rigs) | `react('win' \| 'lose' \| null)`, `onHit(intensity)` (power contacts hold the follow-through), `setMarkerPulse(on)`. All pose work lives in the shared `SwingPose` (reaction blend, wind-up, follow-through hold) and exposes `bodyLift`, `torsoBend`, `headDrop` and `dip` for the rigs to apply. `MarkerPulse` animates the ground ring. |
| `src/court/Crowd.ts` | `cheer(strength)`, `setTension(0..1)` (eased; faster, bigger idle bob), `gasp()` (lean toward the court for about 1 s). |
| `src/court/Environment.ts` | `buildEnvironment()` also returns `ambient` (`Ambient.update(dt)`: drifting cloud sprites and tree sway; null on `'low'`). |
| `SceneManager` bloom | `EffectComposer` + `UnrealBloomPass` + `OutputPass` on `'high'` only (multisampled HalfFloat target). Threshold 0.95 on linear radiance, so lit diffuse surfaces don't bloom; emissive and additive things do. |
| `RallyEvents.swingEnd` | `{ athlete, kind, contact }` when a swing finishes; `contact: false` is a whiff. |
| `RuleManager.distanceToNearestLine(x, z)` | Distance to the nearest sideline or baseline segment. For presentation only. |
| `GameManager.setReducedEffects(v)` | Persists to `SaveData.customData.reducedEffects`; defaults from `prefers-reduced-motion`. Toggled from the pause menu (EFFECTS button). |

Key hook points:

- `GameManager.frame()`: real `dt` → `HitStop.scale()` → sim accumulator. `render()` receives
  both the scaled ("world") dt and the real dt. World views (athletes, ball, crowd, effects) use
  the scaled dt; camera and HUD use real dt.
- `GameManager.bindRallyEvents()`: all gameplay-triggered feedback.
- `GameManager.onRallyEnd()` and `POINT_PAUSE` (1.9 s): point-end presentation window.

---

## Tier 1: Core impact feedback

**Status:** ✅ Done.

Goal: make every paddle contact and bounce *feel* like something, cheaply.

1. **Hit-stop.** `src/game/HitStop.ts`; trigger from the `hit` event: about 70 ms for power hits,
   about 40 ms for medium ones, none for soft dinks. Sim runs at about 4% speed during the stop. A
   stop that starts mid-frame drops the rest of that frame's accumulator so the freeze is crisp.
2. **Impact burst.** `Effects.hitBurst()`: additive flash sprite plus 6–14 sparks thrown along the
   new ball direction, scaled by intensity.
3. **Ball squash & stretch.** `BallView`: stretch along the launch direction on hit, squash on the
   vertical axis on bounce, via a damped spring (slight jelly overshoot). Applied to a parent
   group so the spinning ball texture is unaffected.
4. **Trail fade + speed colour.** Per-vertex RGBA (fades to the tail); pale yellow → orange →
   red as speed rises. Removed the old unused `alpha` attribute and per-frame allocations.
5. **Bounce dust + ring.** `Effects.bounceBurst()`: dust puff and an expanding ground ring, sized
   by impact speed. Out-of-bounds bounces get a red-tinted ring.
6. **Camera kicks for more hits.** Small kick on every hero contact, bigger on power shots from
   either player (previously only `intensity > 0.8`).
7. **HUD bumps.** Score pops when it changes; rally counter pops on each hit.
8. **Reduce-effects switch.** Pause menu toggle; turns off shake, hit-stop, flash sprite and the
   CSS bumps.

---

## Tier 2: Readability & key moments

**Status:** ✅ Done. Notes:
- The landing countdown uses rally (sim) time (`rally.time`), not wall-clock time, so hit-stop
  doesn't throw the ring off.
- The OUT label is an upright, always-on-top sprite next to the red ground ring. A label flat on
  the ground was unreadable at the far baseline.
- Close calls only count the first bounce after a hit, on the receiver's side.
- `buildNet()` was removed. `GameManager` was its only user and now uses `NetView`.
- Checked the same way as Tier 1 (headless Chrome over CDP), with zoomed `clip` captures of the
  net and the hero's paddle. Fake `net` events can be emitted on `game.rally.bus` to trigger the
  ripple on demand.

Goal: make the ball easier to read and give the special moments (net cords, line calls) their
own look. Builds on Tier 1 modules.

### 2.1 Net ripple and tape flash
- Refactor `buildNet()` (`src/court/Net.ts`) into a `NetView` class (keep `buildNet` as a thin
  wrapper if anything else uses it) that exposes `onHit(x: number, tape: boolean)` and
  `update(dt)`.
- Ripple: `onBeforeCompile` on the net material. Uniforms `uHitX`, `uAmp`, `uTime`. Displace
  vertices along z by `uAmp * exp(-|x - uHitX| * 2) * sin(uTime * 30 - |x - uHitX| * 8)`, with
  `uAmp` decaying to 0 over about 0.5 s. Don't move the bottom edge or the top edge's *height*:
  physics uses `netHeightAt()`.
- Tape hit (`e.tape`): tape material emissive flashes white over about 0.25 s, plus
  `cameraRig.impulse(0.25)` and a small `Effects` puff at the contact point.
- Wire from the `net` event in `GameManager.bindRallyEvents()`.

### 2.2 Landing-marker countdown
- `predictLanding()` already returns `{ point, time, hitsNet }`. Store `time` and the
  wall-clock time it was predicted at alongside `this.landing` in `GameManager`.
- `Indicators.update()` takes a `remaining01` (1 just after the opponent's hit, 0 at bounce). The
  ring scales from about 1.8× down to 1× and gets more opaque as it closes. Keep the green "good"
  colour logic.

### 2.3 Line calls
- On `rallyEnd` with `reason === 'OUT_OF_BOUNDS'`, show a ground decal at the last bounce position
  (track the last `bounce` event's pos in `GameManager`) with a canvas-texture "OUT" label (add a
  `labelTexture(text, color)` helper to `src/render/Textures.ts`). Clear it in `beginServe()`.
- Close call: on an in-bounds `bounce` within 0.10 m of a sideline or baseline (add
  `distanceToNearestLine(x, z)` to `RuleManager.ts`, with a unit test), flash a short line
  highlight at that point and show a small floating "CLOSE!" label (DOM or sprite) for about 0.8 s.

### 2.4 Trauma shake and FOV punch (`src/render/CameraRig.ts`)
- Add `trauma` (0..1, decays about 1.6/s). `shake(amount)` adds to it. Each frame offset the
  camera rotation (pitch/yaw/roll) by `trauma² * maxAngle * noise(t)` using smooth noise (sum of
  sines at unrelated frequencies is fine). `applyOrientation()` sets rotation, so apply the offset
  in `apply()` after it.
- FOV punch: `punch(deg)` temporarily narrows FOV, damped back. Store the base FOV computed in
  `setAspect()`; don't overwrite it.
- Use: tape hits → shake 0.35; power smashes → punch 1.5°. Both off under reduce-effects.

### 2.5 Paddle swoosh
- Extract the camera-facing ribbon logic from `BallView` into `src/render/RibbonTrail.ts`
  (fade + colour support from Tier 1), and use it for both the ball trail and the paddle.
- Add `readonly paddleTip: THREE.Object3D` to the `AthleteRig` interface; place an empty
  `Object3D` at the paddle face centre in both `PrimitiveAthleteView` and `SkinnedAthleteView`.
- Swoosh is visible only while `athlete.swing.active`, width and opacity scaled by swing progress.
  Tint per player (hero yellow, rival teal).
- Use the unused `swing` event for an `Effects` whiff puff when a swing finishes without contact
  (check `swing.contact` when the swing ends, or add a `swingEnd` event to `RallyEvents`; if you
  add an event, extend `tests/rally.test.ts`).

### 2.6 HUD polish
- Banner (`src/ui/styles.css` `.banner`): add an exit animation (scale up and fade) instead of
  only the opacity transition, and a "slam" variant for WINNER! (`.banner.slam .big` with a
  stronger overshoot plus a skew).
- Screen-edge glow: a full-screen `div.edge-glow` in `HUD` with an inset box-shadow, tinted green
  (point won) or red (point lost), fading over about 0.6 s. Off under reduce-effects.
- GAME POINT: a separate pulsing badge element in the HUD rather than appended to the small text.
- Aim ring (`src/render/Indicators.ts`): scale-in over about 0.12 s on show and scale-out on hide,
  instead of toggling `visible` instantly.
- Ball shadow (`BallView`): sharper (smaller scale curve) and darker as the ball nears the ground.

**Acceptance:** typecheck and tests pass. A net cord visibly shakes the net and the camera. An
out ball leaves an OUT mark through the point pause. The landing ring visibly counts down.

---

## Tier 3: Celebration & atmosphere

**Status:** ✅ Done (3a and 3b in one session). Notes:
- "Decides a game or match point" means the point was *played at* game point (either side), so
  saved game points get slow-mo too. There's one game per match here, so game point = match point.
- The "+1" flyer is skipped under reduce-effects (the score just updates). Until it lands the HUD
  shows the old score; a `pointSeq` token stops a late landing from overwriting a newer score.
- Rally callouts first sat at 18% screen height, over the far court where the incoming ball is. They
  now live in `.hud-corner` under the scoreboard.
- Match-over overlay (`.match-over`) is a light, bottom-weighted gradient with no blur, so the orbit
  and confetti read behind the panel. The orbit looks low (y 0.35) so the winner sits above it.
- "NEW BEST RALLY!" needs the match best to beat the stored best *and* be at least 4 shots, so a
  first-ever match doesn't celebrate a 2-shot rally.
- Footwork dust compares velocity with a lagged copy (rate 10/s): a gap > 2.6 m/s at > 1.2 m/s
  ground speed counts as a push-off; 0.35 s cooldown per athlete.
- The skinned rig has no head bone, so `headDrop` is folded into the torso bend there; the wind-up
  `dip` is also a torso bend (the clip owns the legs).
- The sky is out of frame during play (the camera pitch is fixed). Clouds and the ball rim against
  the sky mostly show in the match-over orbit.
- Checked the same way as Tiers 1–2. To reach match over through the real flow: set `game.tally`
  one point from winning, then call `game.rally.end({ winner, reason, faultBy })`. Calling
  `endMatch()` mid-rally is an illegal FSM transition. Use `requestAnimationFrame` counts between
  `frozen` captures, not wall-clock sleeps (each headless screenshot takes about 3 s).

### 3a: Point and match moments
1. **Player reaction poses.** Add `react(kind: 'win' | 'lose' | null)` to `AthleteRig`. Win: paddle
   arm raised overhead plus a small hop. Lose: head and shoulders drop, paddle arm hangs. Implement
   as an extra target in `SwingPose` (shared by both rigs) with damped blending. Trigger in
   `onRallyEnd()` (skip for `BALL_STUCK`), clear in `beginServe()`.
2. **Point-end camera push-in.** `CameraRig.setPointFocus(pos | null)`: during `POINT_END`, ease
   a little toward the landing spot or winner (about 15% closer, slight lateral shift). Clear on
   serve.
3. **Slow motion.** Generalise `HitStop` into a time-scale controller (`slowMo(seconds, scale)`).
   Trigger about 0.6 s at 0.35× when the rally-ending bounce decides a game or match point, or ends
   a 10+ shot rally. Off under reduce-effects.
4. **Rally milestones.** At 5 / 10 / 15 shots: HUD callout ("HOT RALLY!", "ON FIRE!", …), a
   `.hot` class on the rally counter (glow), and crowd tension (see 3b).
5. **"+1" flyer.** A DOM element that starts at the projected landing spot
   (`Vector3.project(camera)`) and flies to the winner's score box, then triggers its bump.
6. **Match over.** Confetti from `Effects` (new `confetti()` emitter: coloured quads, gravity,
   flutter) on a hero win. A slow camera orbit around the winner behind the overlay (a
   `CameraRig` mode). The final score counts up. A "NEW BEST RALLY!" callout when the match's best
   rally beats the stored `stats.bestRally` (compare before overwriting).

### 3b: Atmosphere and polish
1. **Crowd tension and reactions** (`src/court/Crowd.ts`). Add a `uTension` uniform (0..1, from
   the rally shot count) that raises idle bob speed and amplitude, plus a `gasp()` method (forward
   lean pulse, `uLean`) called on net cords and close line calls.
2. **Footwork dust.** `Effects.footDust(pos)` when an athlete's acceleration is high (sprint
   start, hard direction change). Detect in `GameManager.render()` from velocity change; throttle
   per athlete.
3. **Swing anticipation.** In `SwingPose`, add a short wind-up (first ~15% of the swing pulls
   back further with a slight crouch) and a held follow-through for power contacts.
4. **Hero marker pulse.** Pulse the hero ground ring's scale and opacity when it's the hero's
   turn to hit (`r.phase === 'live' && r.lastHitter !== hero`).
5. **Bloom (high quality only).** `EffectComposer` + `UnrealBloomPass` (from `three/examples/jsm`)
   with a high threshold so only the ball, lamps, flash sprites and tape flash glow. Must not run
   on `'medium'` or `'low'`. Handle resize in `SceneManager`.
6. **Ball rim.** Fresnel rim on the ball material (`onBeforeCompile`), to separate it from the
   sky.
7. **Ambient motion.** Slowly drifting cloud sprites in the sky, gently swaying tree tops (vertex
   shader on the instanced trees), brighter lamp emissive. All cheap; skipped on `'low'`.
8. **Menu feel.** `:active` press scale and `:hover` lift on `.btn`, `.tap` and `.opt`. The title
   logo bobs gently on the main menu.

**Acceptance:** typecheck and tests pass. Winning a point shows a reaction pose and camera
push-in. Winning a match shows confetti and the orbit. With reduce-effects on, there's no slow-mo,
shake or flashes.
