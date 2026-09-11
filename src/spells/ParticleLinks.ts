import {
	AdditiveBlending,
	BufferGeometry,
	Color,
	DoubleSide,
	Mesh,
	MeshBasicNodeMaterial,
	Scene,
	StorageBufferAttribute,
	type WebGPURenderer,
} from 'three/webgpu';
import {
	Fn,
	If,
	Loop,
	attribute,
	cameraPosition,
	cross,
	float,
	instanceIndex,
	max,
	min,
	mix,
	positionLocal,
	storage,
	step,
	uniform,
	vec3,
	vec4,
} from 'three/tsl';
import type { FloatNode, UintNode, Vec2Buffer, Vec3Buffer, Vec3Node, Vec4Buffer } from '../tsl-types';
import { transparentMRT } from '../scene/gbuffer';

export interface LinkOptions {
	/** Half-width of a ribbon, in metres. */
	width: number;
	/** Neighbours further away than this are not linked. */
	reach: number;
	/** Ribbon colour at its dimmest and brightest. */
	palette: [ number, number ];
}

/** Vertices a particle owns: two links, four corners each. */
const PER_PARTICLE = 8;

/**
 * Draws a ribbon from every live particle to its two nearest live neighbours,
 * after the three.js `webgpu_tsl_vfx_linkedparticles` example. The web of links
 * is what carries that effect — the particles themselves are almost incidental —
 * and it is the reason the circle now reads as a constellation being drawn rather
 * than a column of sparks.
 *
 * The search is the honest O(n²): every particle walks the whole pool each frame
 * looking for its two closest neighbours. That is what fixes the particle count,
 * not the drawing — see `RuneAwakening`.
 *
 * Two departures from the example, both forced by this being a real scene rather
 * than a flat demo:
 *
 * - **Ribbons are billboarded properly.** The example gives a quad its width by
 *   offsetting the two ends in world Y, which is free and looks right as long as
 *   nothing is vertical. Our embers climb, so a link between two of them is very
 *   often *itself* vertical — and offsetting a vertical line along its own axis
 *   gives a quad of zero width. The width here is `cross( link, toCamera )`,
 *   resolved per vertex, so a ribbon faces the viewer whatever its orientation.
 * - **Links have a reach.** The example's particles are always one tight cluster
 *   around the cursor, so the two nearest neighbours are always near. These spawn
 *   across a 3.3 m ring, and without a cutoff the sparse frames web the whole
 *   circle together with metre-long strands.
 */
export class ParticleLinks {

	readonly mesh: Mesh;

	private readonly kernel;

	constructor(
		private readonly renderer: WebGPURenderer,
		scene: Scene,
		private readonly count: number,
		positions: Vec3Buffer,
		lives: Vec2Buffer,
		options: LinkOptions,
	) {

		const vertices = count * PER_PARTICLE;

		// `position` is written by the compute kernel, so it has to be a storage
		// attribute rather than a plain one; `axis` carries what the vertex stage
		// needs to give the ribbon its width, and `tint` its colour and fade.
		const positionAttribute = new StorageBufferAttribute( vertices, 4 );
		const axisAttribute = new StorageBufferAttribute( vertices, 4 );
		const tintAttribute = new StorageBufferAttribute( vertices, 4 );

		const geometry = new BufferGeometry();

		geometry.setAttribute( 'position', positionAttribute );
		geometry.setAttribute( 'linkAxis', axisAttribute );
		geometry.setAttribute( 'linkTint', tintAttribute );
		geometry.setIndex( buildIndices( count ) );

		const linkPositions = storage( positionAttribute, 'vec4', vertices );
		const linkAxis = storage( axisAttribute, 'vec4', vertices );
		const linkTint = storage( tintAttribute, 'vec4', vertices );

		this.kernel = this.buildKernel( positions, lives, linkPositions, linkAxis, linkTint, options );

		const material = new MeshBasicNodeMaterial();

		// Give the ribbon its width here rather than in the compute pass, because
		// this is the stage that knows where the camera is. `axis.xyz` is the link's
		// other end and `axis.w` the signed half-width, so the two ends of a quad
		// splay apart along the same screen-facing direction.
		// Read by *name*, not with `storage(...).toAttribute()`. That helper binds a
		// buffer as an anonymous attribute, and with two extra vec4 streams on one
		// geometry the second one silently resolves to the first: the ribbon took its
		// half-width from the tint's alpha, so instead of six millimetres it splayed
		// by up to a metre in an arbitrary direction. Naming them removes the
		// ambiguity — and the symptom looked like a broken neighbour search rather
		// than a binding, since the buffer the compute pass wrote was perfectly fine.
		const other = attribute<'vec4'>( 'linkAxis', 'vec4' );
		const along = other.xyz.sub( positionLocal );
		const toViewer = cameraPosition.sub( positionLocal );
		const sideways = cross( along, toViewer ).toVar();

		// A link pointing straight at the camera has no width and no side vector;
		// dividing by its own length would hand the rasteriser a NaN.
		const side = sideways.div( max( sideways.length(), float( 1e-5 ) ) ).mul( other.w );

		const tint = attribute<'vec4'>( 'linkTint', 'vec4' );

		// Same reason as the particles themselves: a ribbon that found no neighbour,
		// or whose ends have burnt out, collapses to zero alpha but still writes the
		// scene pass's auxiliary buffers, and SSGI bounces the result. Two degenerate
		// triangles per dead link is cheap; a grey smear across the floor is not.
		material.positionNode = positionLocal.add( side );
		material.colorNode = tint.xyz;
		material.opacityNode = Fn( () => {

			const fade = tint.w.toVar();

			fade.lessThan( 0.01 ).discard();

			return fade;

		} )();

		material.transparent = true;
		material.depthWrite = false;
		material.side = DoubleSide;
		material.blending = AdditiveBlending;

		// As with the particles: a ribbon must not overwrite the albedo of the floor
		// it is drawn over, or SSGI stops bouncing anything underneath it.
		material.mrtNode = transparentMRT();

		this.mesh = new Mesh( geometry, material );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 11;

		// The kernel writes world positions straight into the buffer, so the mesh
		// must not carry a transform of its own — `positionLocal` above is world.
		this.mesh.matrixAutoUpdate = false;

		scene.add( this.mesh );

	}

	/** Rebuilds every ribbon. Call after the pool has been advanced. */
	step(): void {

		this.renderer.compute( this.kernel );

	}

	private buildKernel(
		positions: Vec3Buffer,
		lives: Vec2Buffer,
		linkPositions: Vec4Buffer,
		linkAxis: Vec4Buffer,
		linkTint: Vec4Buffer,
		options: LinkOptions,
	) {

		const reachSq = options.reach * options.reach;
		const width = options.width;

		const dim = uniform( new Color( options.palette[ 0 ] ) );
		const bright = uniform( new Color( options.palette[ 1 ] ) );

		/** Fraction of a particle's life still to run, 0 once it is dead. */
		const remaining = ( life: { x: FloatNode; y: FloatNode } ) =>
			life.y.sub( life.x ).div( max( life.y, float( 0.0001 ) ) ).clamp( 0, 1 );

		return Fn( () => {

			const position = positions.element( instanceIndex ).toVar();
			const life = lives.element( instanceIndex );
			const mine = remaining( life ).toVar();

			// Closest and second closest, and how much life each has left.
			const nearestSq = float( 1e6 ).toVar();
			const nextSq = float( 1e6 ).toVar();
			const nearest = vec3( 0 ).toVar();
			const next = vec3( 0 ).toVar();
			const nearestLife = float( 0 ).toVar();
			const nextLife = float( 0 ).toVar();

			If( mine.greaterThan( 0 ), () => {

				Loop( this.count, ( { i } ) => {

					const otherLife = lives.element( i );

					If( i.notEqual( instanceIndex ).and( otherLife.x.lessThan( otherLife.y ) ), () => {

						const otherPosition = positions.element( i );
						const gap = position.sub( otherPosition ).lengthSq().toVar();

						If( gap.greaterThan( 0 ).and( gap.lessThan( float( reachSq ) ) ), () => {

							If( gap.lessThan( nearestSq ), () => {

								// Demote the old winner rather than dropping it, so the
								// second ribbon really is the second closest.
								nextSq.assign( nearestSq );
								next.assign( nearest );
								nextLife.assign( nearestLife );

								nearestSq.assign( gap );
								nearest.assign( otherPosition );
								nearestLife.assign( remaining( otherLife ) );

							} ).ElseIf( gap.lessThan( nextSq ), () => {

								nextSq.assign( gap );
								next.assign( otherPosition );
								nextLife.assign( remaining( otherLife ) );

							} );

						} );

					} );

				} );

			} );

			// A link that found nobody collapses onto its own particle at zero alpha,
			// which costs two degenerate triangles and keeps the buffer branch-free.
			// `step( edge, x )` is 1 where x >= edge, so this is "a neighbour was found
			// inside the reach" without reaching for a conditional.
			const foundNear = step( nearestSq, float( reachSq ) );
			const foundNext = step( nextSq, float( reachSq ) );

			const endNear = mix( position, nearest, foundNear );
			const endNext = mix( position, next, foundNext );

			// A ribbon is only as alive as the dimmer of the two ends it joins. The
			// curve is the example's: it holds up and then lets go late.
			const fadeNear = min( nearestLife, mine ).max( 0 ).pow( 0.8 ).mul( foundNear );
			const fadeNext = min( nextLife, mine ).max( 0 ).pow( 0.8 ).mul( foundNext );

			const colourNear = mix( dim, bright, fadeNear );
			const colourNext = mix( dim, bright, fadeNext );

			const base = instanceIndex.mul( PER_PARTICLE );

			this.ribbon( linkPositions, linkAxis, linkTint, base, position, endNear, colourNear, fadeNear, width );
			this.ribbon( linkPositions, linkAxis, linkTint, base.add( 4 ), position, endNext, colourNext, fadeNext, width );

		} )().compute( this.count );

	}

	/**
	 * Writes one quad: both ends twice, splayed by the signed half-width the vertex
	 * stage turns into a screen-facing offset. Each vertex also carries the *other*
	 * end of its link, which is what lets that stage work out the direction.
	 */
	private ribbon(
		linkPositions: Vec4Buffer,
		linkAxis: Vec4Buffer,
		linkTint: Vec4Buffer,
		base: UintNode,
		from: Vec3Node,
		to: Vec3Node,
		colour: Vec3Node,
		fade: FloatNode,
		width: number,
	): void {

		const corners = [
			{ at: from, other: to, sign: width },
			{ at: from, other: to, sign: - width },
			{ at: to, other: from, sign: - width },
			{ at: to, other: from, sign: width },
		];

		corners.forEach( ( corner, i ) => {

			const slot = base.add( i );

			linkPositions.element( slot ).assign( vec4( corner.at, 1 ) );
			linkAxis.element( slot ).assign( vec4( corner.other, float( corner.sign ) ) );
			linkTint.element( slot ).assign( vec4( colour, fade ) );

		} );

	}

}

/** Two triangles per quad, two quads per particle. The pattern never changes. */
function buildIndices( count: number ): number[] {

	const indices: number[] = [];

	for ( let particle = 0; particle < count; particle ++ ) {

		for ( let link = 0; link < 2; link ++ ) {

			const corner = particle * PER_PARTICLE + link * 4;

			indices.push( corner, corner + 1, corner + 2, corner, corner + 2, corner + 3 );

		}

	}

	return indices;

}
