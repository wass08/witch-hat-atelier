import { Vector3 } from 'three/webgpu';

/**
 * Everything position-related was measured directly out of
 * `public/Witch_Hat_Atelier_fixed.glb`, so the rig lines up with the art:
 *
 *   Desk    x -1.367 .. 1.367   y 0 .. 0.957   z 2.138 .. 3.249
 *   Paper   ("Plane", Procedural Parchment Page) centred at -0.075, 0.958, 2.521
 *   Stool   z 2.772 .. 3.446    (the seat the camera sits on)
 *   Dummy   ("Training_Dummy.001") y 1.176 .. 2.131 at 0, -, -0.513
 *   Room    walls ±4.45, open towards +z so the camera can sit outside them
 */

export const NODE = {
	paper: 'Plane',
	pen: 'Pen',
	dummy: 'Training_Dummy.001',
	rune: 'MagicCircleDecal',
	cauldronSmoke: 'fx_cauldron_smoke',
} as const;

/** Camera state: seated at the desk, taking in the room. */
export const CAM_IDLE = {
	position: new Vector3( 0.0, 1.46, 3.72 ),
	// Pitched ~10° down: the parchment sits in the bottom third of frame while
	// the training dummy stays in the upper third.
	target: new Vector3( - 0.02, 0.70, - 0.25 ),
	fov: 44,
};

/** Camera state: leaning over the parchment to draw. */
export const CAM_FOCUS = {
	// 60° down from horizontal, ~1.1m out: the whole page fits the frame with
	// margin, and the sheet is foreshortened just enough to still read as a desk.
	position: new Vector3( - 0.075, 1.99, 3.15 ),
	// Aimed slightly past the sheet so it rides above the HUD's lower plates.
	target: new Vector3( - 0.075, 0.958, 2.44 ),
	fov: 40,
};

/** Ink accumulation buffer resolution (square, storage texture). */
export const INK_SIZE = 1024;

/**
 * Milliseconds of stillness after the last stroke before the sigil resolves.
 * Long enough to lift the quill between the strokes of a multi-stroke sigil
 * without the half-finished shape casting on its own.
 */
export const CAST_DELAY = 1000;

/** Ink glow for a sigil that reads as nothing in particular. */
export const IDLE_GLOW = 0x8c63d6;

/**
 * Seconds a stroke of ink stays on the page before it has faded to nothing.
 *
 * The fade is per-texel and exponential, which is what makes it read as a
 * trail rather than as the page dimming: every texel started decaying the
 * moment the nib passed over it, so the tail of a stroke is always further
 * along than its head. Long enough that a five-stroke sigil is still whole
 * when it resolves — `CAST_DELAY` of stillness happens inside this budget.
 *
 * 8.0, up from 3.0, and the old figure was set against the wrong task. It was
 * chosen so the *trail* read well — how a single stroke thins behind the nib —
 * and at 3.0 a stroke was half gone 0.78 s after the quill passed. That is fine
 * for one line and hopeless for a pentagram: five strokes take a deliberate hand
 * three to five seconds, and the last of them has to close on the first, which by
 * then was not there. You could not join up your own drawing.
 *
 * The budget the fade actually has to cover is *draw plus hold*: however long the
 * sigil takes to write, plus the `CAST_DELAY` second of stillness that resolves
 * it. What matters is the **plateau**, not this number — see `INK_SOLID`. At 4.8
 * with the knee where it now sits, a stroke holds at full black for 4.0 s and then
 * wipes away in 0.8.
 *
 * This is the dial to move if a sigil stops being finishable: it scales the whole
 * curve, plateau and wipe together, so the *look* of the dissolve is unchanged and
 * only its pace moves. Down from 6.2 (5.0 s plateau, 1.2 s wipe) because holding
 * the quill still meant waiting six seconds to watch a line leave — the wipe was
 * right and everything around it was long.
 */
export const INK_LIFETIME = 4.8;

/**
 * Ink below this is invisible on the page — the lower knee of the smoothstep
 * the parchment material composites with. The fade rate is derived from it so
 * that "vanished" means the same thing to the CPU, which spawns the motes, as
 * it does to the shader that draws the ink.
 */
export const INK_VISIBLE = 0.08;

/**
 * Ink above this reads as solid black — the *upper* knee of that same smoothstep,
 * and the knob that decides how soon a stroke starts visibly thinning.
 *
 * Anything above it is clamped to fully dark, so the higher it sits the sooner
 * the fade shows. This is the knob that decides how long a stroke holds at full
 * strength before it starts going anywhere.
 *
 * This constant and `INK_VISIBLE` are the two ends of the dissolve, and their
 * *ratio* is what decides whether a line dies as a wipe or as a block. The gap
 * between them is `INK_TAU · ln( SOLID / VISIBLE )` seconds — the time any one
 * texel takes to go from solid to invisible — and it has to be short against the
 * spread of ages along a stroke, or every texel is at a different point on the
 * curve and they all still look the same.
 *
 * At 0.45 that gap was **5.5 s**, against the ~0.6 s a hand-drawn line spans. The
 * age gradient occupied a ninth of the band, so a line faded as one flat block
 * instead of unravelling from its oldest end. At 0.122 the gap is 0.8 s, longer
 * than the spread but the same order as it, and the dissolve visibly travels the
 * line.
 *
 * Note what this is *not*: shortening the band did not shorten the ink. The
 * plateau went from 2.5 s to 4.0 s — a stroke still holds at full black far longer
 * than it did — because the plateau is `ln( 0.995 / SOLID )` and lowering the knee
 * lengthens it. Legibility and a crisp dissolve are not in tension; they were only
 * in tension while both were being asked of one number.
 *
 * Down from 0.95 originally, where it sat just under the ink's own ceiling and
 * there was no plateau at all — a stroke began thinning 0.06 s after the nib
 * passed.
 *
 * Lowering it is the safe direction for line weight. A *high* knee lightens
 * whatever part of a stroke the nib did not write at full strength, which is why
 * 0.95 was affordable only with a sharp nib (see `buildKernel`); a low one clamps
 * more of the nib's falloff band to solid, so if anything the line reads a touch
 * bolder rather than thinner.
 */
export const INK_SOLID = 0.122;

/**
 * How long a cast takes to burn the sigil off the page, in seconds.
 *
 * The rate below is derived from it, and that is the point. `INK_TAU` is defined
 * so ink reaches `INK_VISIBLE` after exactly `INK_LIFETIME` of fade, which makes
 * `INK_LIFETIME / rate` the seconds a burn needs to clear the page — an identity,
 * not a coincidence. Written as a bare multiplier (it was 4.5 against a lifetime
 * of 3.0, so: 0.667 s) it silently stops clearing the page the moment the lifetime
 * moves: at 8.0 that same 4.5 leaves the sigil sitting at 0.14, above the visible
 * knee, fading on for seconds after the spell has already gone off.
 */
export const INK_BURN_SECONDS = 0.667;

/** How much faster than the ordinary fade a cast burns the sigil off. */
export const INK_BURN_RATE = INK_LIFETIME / INK_BURN_SECONDS;

/** Seconds between live re-reads of a half-drawn sigil. */
export const PREVIEW_INTERVAL = 0.09;

/**
 * Below this $P score a sigil is considered illegible.
 *
 * Set from measurement, not taste. Drawn by hand through the real pipeline,
 * sampling at `NUM_POINTS` = 24: genuine attempts score 0.54–0.90, random
 * scribbles up to 0.50. The correct glyph essentially always wins on name, so the
 * only question a threshold answers is "did they mean anything at all", and the
 * cost of the two mistakes is lopsided — a false accept casts the wrong spell,
 * a false reject reads as the game being broken. Hence the bar sits just under
 * the worst genuine attempt rather than safely above the best scribble.
 */
export const RECOGNITION_THRESHOLD = 0.48;
