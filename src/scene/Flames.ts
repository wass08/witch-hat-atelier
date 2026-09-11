import {
	Box3,
	CanvasTexture,
	Group,
	type Mesh,
	type Object3D,
	SRGBColorSpace,
	Sprite,
	SpriteNodeMaterial,
	Vector3,
} from 'three/webgpu';
import {
	Fn,
	TWO_PI,
	billboarding,
	fract,
	mix,
	modelWorldMatrix,
	mx_worley_noise_float,
	sin,
	spherizeUV,
	texture,
	time,
	uv,
	vec2,
	vec3,
	vec4,
} from 'three/tsl';
import type { FloatNode, Vec3Node } from '../tsl-types';
import { transparentMRT } from './gbuffer';

/**
 * The room's fire, ported from the three.js `webgpu_tsl_vfx_flames` example.
 *
 * The GLB models each flame as a solid little teardrop — 16 triangles for a
 * candle, 480 for a torch — and the emissive material this replaces could only
 * ever make that *geometry* brighter and dimmer. What reads as a flame is not
 * brightness, it is the shape moving: a body that leans, narrows and sheds
 * tongues off its tip. None of that is in the mesh, so the mesh is not drawn.
 * Each one is hidden and a billboarded sprite stands in its place, with the
 * whole flame — silhouette, motion and colour — generated in the fragment
 * shader.
 *
 * Two departures from the example, both deliberate:
 *
 * - **The cellular noise is procedural.** The example scrolls a 256² voronoi
 *   tile; this calls `mx_worley_noise_float` on the same coordinates instead.
 *   It is the same F1-distance field the tile holds, minus a texture to ship
 *   and minus the seam where the tile wraps, and it takes a third coordinate —
 *   which is what gives each flame its own slice of the field.
 * - **Every flame is one material.** The seed comes out of `modelWorldMatrix`,
 *   so a flame's phase and its slice of the noise both follow from where it
 *   stands: nine flames, one pipeline, and no two of them in unison. The
 *   emissive material this replaces made the same point with `positionWorld`,
 *   and it is worth keeping — a shelf of candles pulsing together reads as a
 *   loop immediately.
 */

/**
 * The materials the .blend puts on a flame, and how far up the mesh it replaces
 * each kind's sprite is anchored, as a fraction of that mesh's height.
 *
 * The two kinds are not modelled the same way, so a single rule cannot place
 * both. A candle's flame is a sixteen-triangle cone standing on its wick: the
 * bounding box starts exactly where the fire does, and the sprite sits at zero.
 * A torch's is a 480-triangle volume that sockets *into* the head, and its box
 * starts two centimetres inside the wood — anchored there, the sprite burns
 * around the head instead of rising out of it.
 *
 * The top of the wood is only that 2 cm up and stopping there is still too low,
 * because the shader's flame has a soft spreading base where the asset's cone
 * has a hard one, and a soft base reads lower than it sits. So the torch figure
 * is matched by eye rather than derived — the one number here that is.
 */
const FLAME_MATERIALS = new Map( [
	[ 'Flame_Emission', 0 ],
	[ 'emissive yellow', 0.35 ],
] );

/**
 * The gradient the flame's core is coloured through, from its cool outer edge
 * to white-hot. The two middle stops are the .blend's own flame colours, so the
 * candles still sit where the reference render put them; the example's are a
 * blue-to-magenta rise, which is glorious and belongs to a different room.
 */
const PALETTE = [ '#1a0500', '#8c2400', '#ff7b2e', '#ffd9a0', '#fff6e8' ];

/** Emissive strength. The .blend gives these flames 8, and so did the material. */
const EMISSION = 7;

/** Cells across the sprite. The example's tile carries roughly this many. */
const CELLS = 3;

/**
 * How much taller than the mesh it replaces a sprite is. Well over one because
 * the flame does not fill its quad: the silhouette clears the sprite's edges,
 * and its tip fades out around four fifths of the way up. At 2 the drawn flame
 * covers about what the GLB's cone covered.
 */
const HEIGHT_GAIN = 2;

/** Flame width as a fraction of its height. The example's sprite is 0.5. */
const ASPECT = 0.62;

/**
 * Hides every flame mesh under `root` and returns a group of sprites standing
 * where they were. The group is the caller's to add to the scene.
 */
export function kindle( root: Object3D ): Group {

	const flames = new Group();
	flames.name = 'flames';

	const wicks: { mesh: Mesh; anchor: number }[] = [];

	root.traverse( ( object ) => {

		const mesh = object as Mesh;

		if ( ! mesh.isMesh ) return;

		const anchor = FLAME_MATERIALS.get( ( mesh.material as { name?: string } ).name ?? '' );

		if ( anchor !== undefined ) wicks.push( { mesh, anchor } );

	} );

	const material = flameMaterial();

	const box = new Box3();
	const size = new Vector3();
	const centre = new Vector3();
	const lit: Vector3[] = [];

	for ( const { mesh, anchor } of wicks ) {

		mesh.visible = false;

		box.setFromObject( mesh );
		box.getSize( size );
		box.getCenter( centre );

		const base = new Vector3( centre.x, box.min.y + size.y * anchor, centre.z );

		// `Flame_candle` and `Flame_candle001` share a world position to the
		// millimetre — one candle modelled twice. Two sprites there would burn at
		// double brightness and, being coplanar billboards, would z-fight as well.
		if ( lit.some( ( standing ) => standing.distanceTo( base ) < 1e-3 ) ) continue;

		lit.push( base );

		const height = size.y * HEIGHT_GAIN;
		const flame = new Sprite( material );

		// The sprite is anchored at the wick rather than at its own middle, so a
		// flame drawn taller grows upwards instead of sinking into the candle.
		flame.center.set( 0.5, 0 );
		flame.position.copy( base );
		flame.scale.set( height * ASPECT, height, 1 );

		flames.add( flame );

	}

	return flames;

}

/** The example's first flame, on this room's palette. */
function flameMaterial(): SpriteNodeMaterial {

	const gradient = ramp( PALETTE );

	const material = new SpriteNodeMaterial( { transparent: true, depthWrite: false } );

	material.colorNode = Fn( () => {

		// The matrix's translation column: `mat4 * ( 0, 0, 0, 1 )` is the sprite's
		// own world position, and it is a uniform, so it is constant across the
		// quad. It is the only thing separating one flame from another — they all
		// share this material — so everything that should differ is drawn from it.
		const origin = modelWorldMatrix.mul( vec4( 0, 0, 0, 1 ) ).xyz;

		// Two independent draws, and the second one matters more than the first.
		// A head start alone does not desynchronise anything: flames that all sway
		// at the same rate hold that relationship forever, however far apart they
		// are started, and the eye reads it as one animation played nine times.
		// Each flame runs its own clock between 0.8x and 1.3x, so no two of them
		// are ever in the same relationship twice.
		const scatter = hash( origin, 0 ).toVar();
		const rate = hash( origin, 4.7 ).mul( 0.5 ).add( 0.8 ).toVar();

		const clock = time.mul( rate ).add( scatter.mul( 30 ) ).toVar();

		// Main UV: bulge it out into a body, stretch that body upwards, then widen
		// it back so the flame is not pinched to a needle.
		const mainUv = uv().toVar();
		mainUv.assign( spherizeUV( mainUv, 10 ).mul( 0.6 ).add( 0.2 ) );
		mainUv.assign( mainUv.pow( vec2( 1, 2 ) ) );
		mainUv.assign( mainUv.mul( 2, 1 ).sub( vec2( 0.5, 0 ) ) );

		// The lean. The example runs one sine up the flame's height; this runs two
		// at frequencies that do not divide into each other, so the sway never comes
		// back around to where it started. Both are damped to nothing at the wick by
		// `rise`, so only the tip moves.
		const sway = sin( clock.mul( 10 ).sub( mainUv.y.mul( TWO_PI ).mul( 2 ) ) ).mul( 0.72 )
			.add( sin( clock.mul( 3.7 ).sub( mainUv.y.mul( TWO_PI ) ) ).mul( 0.28 ) );

		// ...over a slow envelope, because a candle is not evenly restless: it
		// stands nearly still for a few seconds and then dances. Two more sines with
		// no shared period, so the calm never arrives on a schedule either.
		const gust = sin( clock.mul( 0.83 ) ).mul( sin( clock.mul( 0.31 ).add( 1.7 ) ) ).mul( 0.45 ).add( 0.75 );

		const rise = mainUv.y.smoothstep( 0, 1 ).toVar();

		mainUv.x.addAssign( sway.mul( gust ).mul( rise ).mul( 0.2 ) );

		// Cellular noise climbing the flame, which is what eats the tongues out of
		// the tip. Damped by `rise` as well: a flame is solid at its base.
		const cellularUv = mainUv.mul( 0.5 ).add( vec2( 0, clock.negate().mul( 0.5 ) ) );
		const cellular = mx_worley_noise_float( vec3( cellularUv.mul( CELLS ), scatter.mul( 97 ) ) )
			.oneMinus().smoothstep( 0, 0.5 ).oneMinus().toVar();

		cellular.mulAssign( rise );

		// The silhouette: a tall ellipse with the noise bitten out of it. Below
		// zero is off the flame entirely.
		const shape = mainUv.sub( 0.5 ).mul( vec2( 3, 2 ) ).length().oneMinus().toVar();

		shape.assign( shape.sub( cellular ) );

		const alpha = shape.smoothstep( 0, 0.3 ).toVar();

		// Everything off the flame is discarded rather than left at zero alpha,
		// because the scene pass is an MRT and SSGI reads what it writes. An
		// invisible fragment still writes `diffuseColor`, and off the flame that
		// value is white — so a transparent quad lit the wall behind every torch
		// with a bright rectangle of bounce. It is only visible in `combined`,
		// which is what makes it look like a GI bug rather than a sprite.
		alpha.lessThan( 0.01 ).discard();

		// `shape` doubles as the ramp coordinate: the edge of the flame samples the
		// cool end, the core samples white-hot, and past 0.8 it is white outright.
		const colour = mix( texture( gradient, vec2( shape, 0 ) ).rgb, vec3( 1 ), shape.step( 0.8 ) );

		return vec4( colour.mul( EMISSION ), alpha );

	} )();

	// The same reason the spells' particles do it: a transparent sprite that writes
	// `diffuseColor` replaces the albedo of whatever is behind it, and the composite
	// multiplies that by GI. The discard above already keeps the quad's empty corners
	// out; this keeps the flame itself out, which the torches needed and nothing had
	// yet caught, their haloes being lost in their own glow.
	material.mrtNode = transparentMRT();

	// Yaw-only billboarding. A sprite left to its own devices also pitches to face
	// the camera, and a flame that tips towards you as you lean over the desk
	// stops looking like it is standing on the candle.
	material.vertexNode = billboarding();

	return material;

}

/**
 * One number in [0,1) from a flame's position, `salt` picking which one.
 *
 * The obvious thing — a dot product with three primes, fracted — is not good
 * enough here. It is linear, so flames standing in a row come out in a row, and
 * two of these ten landed 0.02 apart, which is close enough to watch them move
 * together. The sine hash scatters them properly, and salting it gives draws
 * independent of each other rather than two views of the same number.
 */
function hash( position: Vec3Node, salt: number ): FloatNode {

	return fract( sin( position.dot( vec3( 12.9898, 78.233, 37.719 ) ).add( salt ) ).mul( 43758.5453 ) );

}

/** A 1-pixel-tall colour ramp, sampled by the flame's own silhouette. */
function ramp( stops: string[] ): CanvasTexture {

	const canvas = document.createElement( 'canvas' );

	canvas.width = 128;
	canvas.height = 1;

	const context = canvas.getContext( '2d' );

	if ( context === null ) throw new Error( 'Flames: no 2D context for the colour ramp' );

	const fill = context.createLinearGradient( 0, 0, canvas.width, 0 );

	stops.forEach( ( stop, i ) => fill.addColorStop( i / ( stops.length - 1 ), stop ) );

	context.fillStyle = fill;
	context.fillRect( 0, 0, canvas.width, canvas.height );

	const map = new CanvasTexture( canvas );

	map.colorSpace = SRGBColorSpace;

	return map;

}
