import type { MeshPhysicalNodeMaterial } from 'three/webgpu';
import { bumpMap, float, mix, positionLocal, vec3 } from 'three/tsl';
import { blenderNoise, blenderRamp } from './blenderNoise';

/**
 * The two witchy tomes' covers, rebuilt from the .blend.
 *
 * `VintageWitchy_Book03_Cover` and `VintageWitchy_Book08_Cover` are the only
 * materials in the room with **no image texture anywhere in them**: three Noise
 * Textures feeding five Color Ramps, two Mix nodes and a Bump. glTF has no way
 * to express any of that, and the exporter did not even try — both materials
 * came through the file as nothing but a name:
 *
 * ```json
 * { "doubleSided": true, "name": "VintageWitchy_Book03_Cover" }
 * ```
 *
 * With no `pbrMetallicRoughness` block, the glTF defaults apply: base colour
 * white, roughness 1 and — the part that makes them look so wrong — metalness
 * **1**. A shelf of white metal books.
 *
 * The two graphs are identical apart from the dye, so this is one function with
 * the leather passed in. Every constant below is the .blend's own.
 */

/** Blender's Mapping node, uniform scale on all three axes. */
const MAPPING_SCALE = 8;

/** Gold leaf, where the finest noise peaks. Linear, straight off the Mix node. */
const GILT: Leather = [ 0.75, 0.6, 0.22 ];

/**
 * Bump strength. Blender asks for 0.25 over a distance of 1 mm; three's bump
 * takes neither a distance nor the same units, so this one number is the only
 * thing on the page matched by eye rather than read off a socket.
 */
const BUMP = 0.03;

export type Leather = [ number, number, number ];

/** Book 03, on the shelf: oxblood. */
export const OXBLOOD: [ Leather, Leather ] = [ [ 0.32, 0.05, 0.08 ], [ 0.58, 0.12, 0.16 ] ];

/** Book 08, on the desk: deep green. */
export const FOREST: [ Leather, Leather ] = [ [ 0.05, 0.22, 0.16 ], [ 0.14, 0.42, 0.3 ] ];

/** Hangs the cover's node graph on a material that arrived with none. */
export function bindBookCover( material: MeshPhysicalNodeMaterial, [ dark, light ]: [ Leather, Leather ] ): void {

	// Texture Coordinate → Object is the mesh's own local space, which the
	// exporter converted as three = ( bx, bz, -by ). Going back is ( px, -pz, py ),
	// and it is worth doing: the noise is not isotropic, and a book read along the
	// wrong axis grains the wrong way.
	const coord = vec3( positionLocal.x, positionLocal.z.negate(), positionLocal.y ).mul( MAPPING_SCALE );

	const grain = blenderNoise( coord, 18, 6, 0.7 ).toVar();
	const patina = blenderNoise( coord, 3, 4, 0.6 ).toVar();
	const fleck = blenderNoise( coord, 45, 2, 0.4 ).toVar();

	// The dye itself, darkest down in the grain.
	const leather = mix( vec3( ...dark ), vec3( ...light ), blenderRamp( grain, 0.35, 0.7 ) ).toVar();

	// Multiplied over it at 0.55: broad patches that darken whole areas of the
	// cover rather than the grain, which is what stops it reading as a flat swatch.
	const wear = mix( vec3( 0.05, 0.045, 0.04 ), vec3( 1 ), blenderRamp( patina, 0.4, 0.75 ) );

	material.colorNode = mix(
		mix( leather, leather.mul( wear ), float( 0.55 ) ),
		vec3( ...GILT ),
		blenderRamp( fleck, 0.82, 0.88 ),
	);

	// Worn leather is glossier where it has been handled, and the gold leaf is the
	// only metal on the book — the ramp is narrow enough that nothing else catches.
	material.roughnessNode = mix( float( 0.35 ), float( 0.65 ), blenderRamp( patina, 0.3, 0.8 ) );
	material.metalnessNode = mix( float( 0 ), float( 0.6 ), blenderRamp( fleck, 0.82, 0.9 ) );

	material.normalNode = bumpMap( grain, float( BUMP ) );

}
