# design.md — VectorScape

The look and *feel* direction. Navigation feel is the north star, so this doc is not decoration — it's the spec for the one thing that has to be exceptional. When Claude Code makes a visual or motion choice, it defers to this over its defaults.

## The feeling we're after

You are not reading a chart. You are **flying through a place** — an observatory of meaning, a cartography of a dataset rendered as deep space. The emotional target is the quiet awe of a planetarium and the precision of a star chart: vast, dark, luminous, calm. Data points are stars; clusters are constellations and nebulae; moving through them should feel weightless and intentional, never twitchy.

The failure mode to avoid at all costs is "correct but ugly" — the flat, gray, utilitarian scatter plot that TensorFlow Projector and most embedding tools ship. Every choice below exists to escape that.

## Atmosphere

- **Deep, near-black background** with a faint cool gradient (not pure `#000` — a very dark blue-black, around `#05060a`, so glowing points read richly). Subtle vignette toward the edges.
- **Depth through fog.** Exponential fog the same color as the background, so distant data fades into darkness — this is what creates the sense of depth and scale. Tune density so the far field dissolves gently, not abruptly.
- **Luminous data.** Points glow via additive blending; overlapping points in a dense cluster build into a bright nebula core. Selective bloom on the data only — never on UI or labels.
- **Optional depth-of-field** as a "high quality" toggle: a soft bokeh that makes the focused cluster crisp and the rest dreamy. Off by default (it's the most expensive effect); on for screenshots and slow exploration.
- **Subtle ambient life.** When idle, the space drifts almost imperceptibly — a slow parallax, a faint twinkle — so it never feels frozen. Restraint is key; this is a breath, not an animation.

## Color

- **Background and chrome:** dark, cool, recessive. UI is glass — translucent dark panels with a hairline light border, blurred backdrop — so it floats over the space without blocking it.
- **Data color = meaning.** Cluster colors come from the data (one hue per cluster), drawn from a palette that stays legible against black and separable from each other — luminous teals, blues, ambers, roses, violets, greens. Avoid muddy mid-tones and avoid the clichéd purple-on-white SaaS gradient entirely.
- **Accent (one):** a single warm signal color for interactive highlights and the focused/selected state — something like a warm amber/gold that reads as "here, this one." Use it sparingly; its power is its rarity.

## Motion (the heart of it)

- **Everything eases.** No linear, no snapping. Camera moves use smoothed damping (`camera-controls` `smoothTime` ≈ 0.4–0.8s); fly-to-cluster decelerates into its target like a craft arriving, not a cut.
- **Momentum on release.** Letting go of a drag lets the view coast and settle, never stops dead.
- **Fly-to is choreographed,** not teleported: a gentle reframe that keeps the user oriented (they should always understand where they just came from).
- **Reveals are staggered.** On load and on the intro flythrough, structure resolves progressively — far field first as a haze, then cores brightening, then labels fading in as you approach. The galaxy↔architectural morph is a *feeling* of arrival: from a glowing field seen from afar to larger, calmer, labeled forms you move among.
- **The intro flythrough** is the single most important first impression: a slow, confident, cinematic path through the SKM galaxy that ends by handing the user the controls. Skippable, never forced twice.

## Typography & UI

- **Distinctive, not default.** Avoid Inter/Roboto/Arial/system. Pair a characterful display face for the landing and headings with a clean, quiet body/UI face that disappears into the work. A precise monospace for data readouts (coordinates, counts, cluster ids) reinforces the "instrument" feeling.
- **UI gets out of the way.** Panels are minimal glass, summoned when needed and dismissible. The data is the interface; chrome is a thin layer over it. No dense toolbars competing with the space.
- **Labels are quiet until relevant.** Cluster labels fade in by proximity/zoom, declutter automatically, and never crowd the view. Legible (soft shadow for contrast against bright cores), never shouty.

## Landing page

The landing is a trailer, not a brochure. Lead with motion — a live or pre-rendered glimpse of the galaxy in gentle drift behind a spare, confident headline. One clear split: **see a demo** (the SKM lens) and **bring your data** (the sandbox). The "XR coming soon" section sits below as a promise, framed honestly. Editorial, dark, cinematic; generous negative space; one memorable hero moment rather than many small ones.

## The test

If a first-time visitor's instinct after ten seconds is to *keep flying* — to lean in and explore rather than look for the next button — the design is working. If it feels like a dashboard, it isn't.
