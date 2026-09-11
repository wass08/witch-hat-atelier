import { mx_fractal_noise_float } from 'three/tsl';
import type { FloatNode, Vec3Node } from '../tsl-types';

/**
 * Blender's Noise Texture and Color Ramp, close enough to read the .blend's own
 * numbers off a node and have them mean the same thing here.
 *
 * Both live in one place because more than one material in the room is built out
 * of them — the witchy book covers and the potion on the desk — and the constants
 * below are the sort that have to agree everywhere or nowhere.
 */

/**
 * The spread correction. Blender scales its Perlin gradients so a single octave
 * nearly fills [-1,1]; MaterialX leaves them around ±0.7, so even after matching
 * the octave count and the amplitude normalisation the result sits in the middle
 * of the range and never reaches the ends.
 *
 * That matters wherever the .blend keys on the ends. The book covers' gilding
 * lives entirely in the band between 0.82 and 0.88, and at MaterialX's own spread
 * nothing on the cover ever gets there — measured, not assumed. Correcting it
 * once, here, is what lets every Color Ramp downstream stay literally the numbers
 * Blender uses; nudging thresholds instead hides the same mismatch in every
 * material that has one, and flattens their contrast on the way past.
 */
const SPREAD = 1.6;

/**
 * Blender's Noise Texture — 3D, FBM, normalized.
 *
 * Blender's `detail` is one short of the octave count, and Blender divides the
 * summed octaves by their total amplitude before mapping [-1,1] onto [0,1].
 * `mx_fractal_noise_float` does neither, and comes back signed and roughly
 * `(1 - r^n) / (1 - r)` times too large. Both of those are exact conversions.
 */
export function blenderNoise( coord: Vec3Node, scale: number, detail: number, roughness: number ): FloatNode {

	const octaves = detail + 1;
	const amplitude = SPREAD * ( 1 - roughness ) / ( 1 - roughness ** octaves );

	return mx_fractal_noise_float( coord.mul( scale ), octaves, 2, roughness, amplitude ).mul( 0.5 ).add( 0.5 );

}

/**
 * Blender's LINEAR Color Ramp between two stops, as the blend factor between
 * them: flat below the first, flat above the second, a straight line between.
 * Ramps with more stops chain these.
 */
export function blenderRamp( value: FloatNode, low: number, high: number ): FloatNode {

	return value.sub( low ).div( high - low ).clamp( 0, 1 );

}
