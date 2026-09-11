import { Fn, dot, float, floor, fog, fract, mix, mx_fractal_noise_float, normalWorldGeometry, pow, rangeFogFactor, sin, smoothstep, step, vec3 } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../tsl-types';

/**
 * The dusk ramp, in linear light. These are the same tiny numbers the room's
 * world colour uses — the flat background this replaces was ( 0.018, 0.008,
 * 0.035 ) and read as a mid purple once tone-mapped — so a value that looks
 * black written down here is not.
 *
 * Three stops rather than two, because a straight mix between a warm horizon and
 * a cool zenith spends half the sky somewhere in between and that middle is
 * exactly where a two-colour ramp reads as a tint rather than as a sky. A short
 * warm band, a violet shoulder, then a long fall into indigo puts most of the
 * sky in the cool and keeps the warmth where a dusk actually keeps it.
 *
 * The warm/cool split is doing a second job. Every light in this room is warm —
 * candle flame, cauldron, the desk's own bounce — standing in a space washed
 * violet, and a sky that is warm low and cold high sets the same opposition
 * behind them at the scale of the whole frame. It is the contrast that does the
 * work, not the saturation: nothing here is bright.
 */
const ZENITH = vec3( 0.0032, 0.0026, 0.0170 );
const MID = vec3( 0.028, 0.012, 0.050 );
const HORIZON = vec3( 0.095, 0.028, 0.066 );

/** Where the violet shoulder sits, as a fraction of the way to the zenith. */
const MID_AT = 0.28;

/** Amber-rose, right on the line where the sky meets the top of the wall. */
const GLOW = vec3( 0.105, 0.042, 0.044 );

/** How high that band reaches. */
const GLOW_HEIGHT = 0.2;

/**
 * The air in the room, and it exists to kill one specific line.
 *
 * Where the top of the stone wall meets the sky is the highest-contrast edge in
 * the frame, and not by accident: every lamp in the room is *below* the wall's
 * top course, so the last row of bricks is the darkest thing in view, and it
 * happens to sit directly against the brightest part of the sky. Two flat planes
 * glued together, and no amount of work on the sky alone can fix it — the hard
 * edge belongs to the geometry.
 *
 * Real air fixes it by scattering skylight into the line of sight, which lifts
 * distant dark things towards the colour of the sky behind them. That is a
 * straight mix towards a dim colour, and the useful thing about mixing towards a
 * *dim* colour is that it moves shadows a long way and highlights almost not at
 * all: the wall's black top course rises to meet the sky while the candle pools,
 * which are far brighter than this, barely register it.
 *
 * The colour is the sky's own, taken from between the horizon band and the
 * shoulder, so what the wall fades into is what is standing above it.
 */
const HAZE_COLOUR = vec3( 0.055, 0.020, 0.058 );

/**
 * Where the haze starts and where it would reach full strength. The near figure
 * clears the whole desk — the parchment is about a metre from the seated camera
 * and must not pick up any of this — and the far one is deliberately well past
 * the back wall at eight metres, so the room lands on the early, gentle part of
 * the curve rather than anywhere near saturation.
 *
 * What each distance in the room actually receives, at these figures:
 *
 *   parchment  1.2 m    0%
 *   dummy      4.0 m    0%
 *   side wall  5.5 m    4%
 *   wall top   8.3 m   29%
 *
 * The gradient across those last two is the point. Bringing `HAZE_FAR` in to 13
 * puts 47% on the wall top, which softens the seam further and starts flattening
 * the brickwork with it; the wall has to stay a wall.
 */
const HAZE_NEAR = 4;
const HAZE_FAR = 16;

/** Slow, very low-contrast cloud in the upper sky. Cheap depth, not weather. */
const HAZE = vec3( 0.020, 0.012, 0.036 );
const HAZE_SCALE = 1.5;

/**
 * Star layers, coarse to fine. Three of them rather than one is what gives the
 * field its size variance: a sparse layer of large bright stars over two denser
 * layers of small faint ones reads as depth, where a single layer reads as noise
 * however much you jitter it.
 *
 * `density` is cells per unit of direction, `size` the star radius within a cell,
 * `rarity` how full a cell's draw has to be to hold a star at all, and `gain` the
 * brightness before per-star variation.
 */
const LAYERS = [
	{ density: 26, size: 0.11, rarity: 0.93, gain: 0.85 },
	{ density: 58, size: 0.085, rarity: 0.95, gain: 0.34 },
	{ density: 115, size: 0.07, rarity: 0.962, gain: 0.16 },
] as const;

/** Star tints, coolest to warmest; most sit near the middle. */
const STAR_COOL = vec3( 0.62, 0.74, 1 );
const STAR_WARM = vec3( 1, 0.82, 0.62 );

/** Value noise on a cell index. Cheap, stable, and enough for a star field. */
const hash = /*@__PURE__*/ Fn( ( [ cell, salt ]: [ Vec3Node, FloatNode ] ) =>
	fract( sin( dot( cell.add( salt ), vec3( 127.1, 311.7, 74.7 ) ) ).mul( 43758.5453 ) ) );

/**
 * One layer of stars, as seen along `dir`.
 *
 * The direction is chopped into a grid of cells and each cell holds at most one
 * star, placed somewhere inside itself. Only the cell the ray lands in is tested,
 * so a star straddling a cell wall is clipped — invisible at these radii, and it
 * keeps the whole field to one lookup per layer instead of twenty-seven.
 */
const layer = /*@__PURE__*/ Fn( ( [ dir, density, size, rarity, gain ]:
	[ Vec3Node, FloatNode, FloatNode, FloatNode, FloatNode ] ) => {

	const p = dir.mul( density );
	const cell = floor( p );
	const local = p.sub( cell );

	const draw = hash( cell, float( 0 ) );
	const placeX = hash( cell, float( 17.13 ) );
	const placeY = hash( cell, float( 43.71 ) );
	const placeZ = hash( cell, float( 71.29 ) );
	const bright = hash( cell, float( 5.37 ) );
	const warmth = hash( cell, float( 93.11 ) );

	// Kept off the cell walls so the single-cell lookup does not clip it.
	const centre = vec3( placeX, placeY, placeZ ).mul( 0.7 ).add( 0.15 );
	const radius = size.mul( bright.mul( 0.75 ).add( 0.35 ) );

	// Distance from the star to the *ray*, not to the point where the ray crossed
	// the shell. The cells are a three-dimensional grid but the sky is only ever
	// sampled across a two-dimensional sphere of them, so measuring straight to
	// `local` only lights a star on the rare occasion the shell happens to pass
	// within a star radius of its centre in all three axes — which is why the
	// first field came out with about five stars in it instead of five hundred.
	// Taking the component perpendicular to `dir` asks the question that was meant:
	// does the line of sight pass close to this star.
	const delta = local.sub( centre );
	const across = delta.sub( dir.mul( delta.dot( dir ) ) ).length();

	// Squared falloff: a linear one gives every star a soft disc the size of its
	// cell, which reads as fog rather than as points of light.
	const shape = pow( smoothstep( radius, float( 0 ), across ), 2.4 );

	const tint = mix( STAR_COOL, STAR_WARM, pow( warmth, 1.6 ) );

	return tint.mul( shape ).mul( step( rarity, draw ) ).mul( gain ).mul( bright.mul( 0.8 ) .add( 0.3 ) );

} );

/**
 * The sky the tower stands under.
 *
 * The room has no ceiling, so this is a real part of the composition rather than
 * a fallback clear colour: in the seated framing it fills the top third of the
 * screen. It was one flat purple, which cannot fall off with distance or angle
 * and so reads as a lit surface rather than as space.
 *
 * Everything here is procedural and lives in the background sphere's fragment
 * shader — three builds that sphere itself for `scene.backgroundNode` and hands
 * the world-space view direction over as `normalWorldGeometry`. No texture, no
 * geometry, no draw call of its own.
 */
export function buildSky() {

	return Fn( () => {

		const dir = normalWorldGeometry;

		// 0 at the horizon, 1 overhead. Below the horizon it simply stays 0 — the
		// tower wall covers everything down there, and paying for a ground half of
		// the sky nobody can see would be waste.
		const height = smoothstep( 0, 0.85, dir.y ).toVar();

		// Horizon to shoulder, then shoulder to zenith. Above `MID_AT` the first mix
		// has already arrived at `MID`, so the second one takes over cleanly.
		const body = mix(
			mix( HORIZON, MID, smoothstep( 0, MID_AT, height ) ),
			ZENITH,
			smoothstep( MID_AT, 1, height ),
		).toVar();

		// The warm band where the sky meets the top of the wall.
		body.addAssign( GLOW.mul( smoothstep( GLOW_HEIGHT, 0, height ) ) );

		// Two octaves is plenty; this is meant to break the gradient up, not to be
		// noticed as cloud.
		const haze = mx_fractal_noise_float( dir.mul( HAZE_SCALE ), 2 ).mul( 0.5 ).add( 0.5 );
		body.addAssign( HAZE.mul( haze ).mul( height ) );

		const stars = vec3( 0 ).toVar();

		for ( const l of LAYERS ) {

			stars.addAssign( layer( dir, float( l.density ), float( l.size ), float( l.rarity ), float( l.gain ) ) );

		}

		// Stars thin out towards the horizon, where the room's own light and the
		// warm band would be washing them out anyway.
		return body.add( stars.mul( smoothstep( 0.02, 0.4, dir.y ) ) );

	} )();

}

/**
 * Aerial perspective for the room — see {@link HAZE_COLOUR}. Assigned to
 * `scene.fogNode`, which every node material picks up; the background sphere
 * three builds for `backgroundNode` sets `fog = false` on itself, so the sky is
 * the one thing this does not touch, which is correct — it *is* the far distance.
 */
export function buildHaze() {

	return fog( HAZE_COLOUR, rangeFogFactor( float( HAZE_NEAR ), float( HAZE_FAR ) ) );

}
