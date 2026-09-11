import {
	AdditiveBlending,
	Color,
	type Mesh,
	MeshBasicNodeMaterial,
	type Object3D,
	type PointLight,
	Sprite,
	SpriteNodeMaterial,
	Vector3,
} from 'three/webgpu';
import { Fn, float, normalView, pow, smoothstep, uniform, uv } from 'three/tsl';
import { transparentMRT } from './gbuffer';
import type { ColorUniform, FloatUniform } from '../tsl-types';

/** Meshes named like this in the GLB, and the point light that goes with each. */
const ORB_PREFIX = 'SpookyOrb_';
const LIGHT_PREFIX = 'SpookyOrbLight_';

/**
 * How sharply the ball falls off towards its own silhouette. Low numbers give a
 * wide soft ball, high ones a small hot centre in a dark shell.
 */
const RIM_FALLOFF = 1.6;

/** Halo diameter, in orb diameters. */
const HALO_SPREAD = 3.4;

/**
 * How sharply the halo falls off, and how bright it starts.
 *
 * The falloff has to be steep or the gradient reaches the edge of its own quad
 * while still faintly lit, and the halo grows a visible rim — a second hard disc
 * around the one this exists to soften.
 */
const HALO_FALLOFF = 3.4;
const HALO_STRENGTH = 0.55;

/**
 * What the additive ball is multiplied by. The asset lit these with an emissive
 * of 7.6 against a shading model; drawn additively that same number is a very
 * different quantity, and matched by eye it lands about here.
 */
const CORE_GAIN = 3.2;

/** Metres the wander carries an orb, and roughly how long a full circuit takes. */
const DRIFT = 0.085;
const DRIFT_PERIOD = 19;

/**
 * The witch's floating lights.
 *
 * The GLB models each one as a solid emissive sphere, which is the one thing a
 * glow is not: a sphere lit uniformly across its whole surface has a hard
 * silhouette, and a hard-edged disc of constant brightness reads as a light bulb
 * — or as a debug gizmo for the point light that is actually doing the lighting.
 * They also never moved, and nothing in a room lit by candles should be that
 * still.
 *
 * So the mesh is kept but stops being a surface. It is drawn additively with its
 * opacity falling off towards the silhouette, which dissolves the edge the eye
 * was reading as an object, and a billboarded halo is hung around it for the
 * bleed a real light has. Then every orb is given its own size, tint, brightness
 * and set of drift frequencies, so no two are the same and no two are in step.
 *
 * The lighting is untouched. Each orb has a `SpookyOrbLight_N` point light of its
 * own in the rig — appearance and illumination were already separate — so this
 * only changes how they read, and the lights are carried along by the drift so
 * the bounce on the ceiling wanders with them.
 */
export class SpookyOrbs {

	private readonly orbs: Orb[] = [];
	private clock = 0;
	private readonly world = new Vector3();
	private readonly local = new Vector3();

	constructor( root: Object3D, rig: Object3D ) {

		const lights = new Map<string, PointLight>();

		rig.traverse( ( object ) => {

			if ( object.name.startsWith( LIGHT_PREFIX ) ) {

				lights.set( object.name.slice( LIGHT_PREFIX.length ), object as PointLight );

			}

		} );

		const found: Mesh[] = [];

		root.traverse( ( object ) => {

			if ( ( object as Mesh ).isMesh === true && object.name.startsWith( ORB_PREFIX ) ) found.push( object as Mesh );

		} );

		for ( const mesh of found ) {

			const id = mesh.name.slice( ORB_PREFIX.length );
			this.orbs.push( this.dress( mesh, lights.get( id ) ?? null, this.orbs.length ) );

		}

	}

	get count(): number {

		return this.orbs.length;

	}

	update( dt: number ): void {

		this.clock += dt;

		for ( const orb of this.orbs ) {

			const t = this.clock;

			// Three sines at frequencies that do not divide into one another, so the
			// path never closes and never reads as a loop.
			this.world.set(
				orb.base.x + Math.sin( t * orb.rate.x + orb.phase.x ) * orb.swing.x,
				orb.base.y + Math.sin( t * orb.rate.y + orb.phase.y ) * orb.swing.y,
				orb.base.z + Math.sin( t * orb.rate.z + orb.phase.z ) * orb.swing.z,
			);

			this.place( orb.mesh, this.world );
			this.place( orb.halo, this.world );
			if ( orb.light !== null ) this.place( orb.light, this.world );

			// Two beats rather than one: a single sine is a pulse, and a pulse reads
			// as a machine. The second is off-frequency and half the depth, which is
			// enough to keep the brightness from ever repeating.
			const twinkle = 1
				+ Math.sin( t * orb.beat + orb.phase.x ) * 0.20
				+ Math.sin( t * orb.beat * 1.63 + orb.phase.z ) * 0.09;

			orb.gain.value = orb.brightness * twinkle;

		}

	}

	/** Moves an object to a world point, whatever it happens to be parented to. */
	private place( object: Object3D, world: Vector3 ): void {

		const parent = object.parent;

		if ( parent === null ) {

			object.position.copy( world );
			return;

		}

		// `updateWorldMatrix( true, false )`, not `updateMatrixWorld()`. The second
		// walks the parent's whole *subtree*, and both parents here are the two
		// biggest objects in the scene: the orb meshes and haloes hang off `Scene`
		// (460 nodes) and the lights off `BlenderLightRig` (57). Three objects per
		// orb, seven orbs, is about 6,800 node visits every frame to move twenty-one
		// things — 0.58 ms of measured CPU, and all of it redone by `render()` a
		// moment later. What is actually needed is the parent's *ancestors*, which
		// is what this asks for.
		parent.updateWorldMatrix( true, false );
		object.position.copy( parent.worldToLocal( this.local.copy( world ) ) );

	}

	private dress( mesh: Mesh, light: PointLight | null, index: number ): Orb {

		mesh.updateMatrixWorld( true );

		const base = new Vector3().setFromMatrixPosition( mesh.matrixWorld );

		mesh.geometry.computeBoundingSphere();
		const radius = ( mesh.geometry.boundingSphere?.radius ?? 0.05 ) * mesh.scale.x;

		// Whatever the asset gave this one, kept as the starting point so the room's
		// two families of orb survive; the jitter below only breaks the ties.
		const source = mesh.material as { emissive?: Color };
		const tint = new Color().copy( source.emissive ?? new Color( 0x95ffbc ) );

		// Deterministic per-orb variation. Irrational-ish steps so seven orbs never
		// land on the same value twice.
		const r = ( k: number ) => fract( ( index + 1 ) * k );

		tint.offsetHSL( ( r( 0.7548 ) - 0.5 ) * 0.06, ( r( 0.5698 ) - 0.5 ) * 0.2, ( r( 0.3163 ) - 0.5 ) * 0.1 );

		const brightness = ( 0.72 + r( 0.8090 ) * 0.62 ) * CORE_GAIN;

		const gain = uniform( brightness );
		const uTint = uniform( tint );

		mesh.material = coreMaterial( uTint, gain );
		mesh.renderOrder = 9;

		const halo = new Sprite( haloMaterial( uTint, gain ) );
		halo.scale.setScalar( radius * 2 * HALO_SPREAD * ( 0.8 + r( 0.6180 ) * 0.5 ) );
		halo.renderOrder = 8;
		halo.frustumCulled = false;
		mesh.parent?.add( halo );

		const swing = new Vector3(
			DRIFT * ( 0.6 + r( 0.2236 ) ),
			DRIFT * ( 0.35 + r( 0.4142 ) * 0.5 ),
			DRIFT * ( 0.6 + r( 0.7320 ) ),
		);

		const base_rate = ( Math.PI * 2 ) / DRIFT_PERIOD;

		return {
			mesh,
			halo,
			light,
			base,
			gain,
			brightness,
			swing,
			rate: new Vector3(
				base_rate * ( 0.8 + r( 0.1231 ) * 0.6 ),
				base_rate * ( 1.3 + r( 0.9101 ) * 0.7 ),
				base_rate * ( 0.7 + r( 0.5551 ) * 0.5 ),
			),
			phase: new Vector3( r( 0.3301 ), r( 0.7717 ), r( 0.1414 ) ).multiplyScalar( Math.PI * 2 ),
			beat: 0.55 + r( 0.4531 ) * 0.75,
		};

	}

}

interface Orb {
	mesh: Mesh;
	halo: Sprite;
	light: PointLight | null;
	/** Where the asset put it; the drift is measured from here. */
	base: Vector3;
	gain: FloatUniform;
	brightness: number;
	swing: Vector3;
	rate: Vector3;
	phase: Vector3;
	beat: number;
}

function fract( value: number ): number {

	return value - Math.floor( value );

}

/**
 * The ball itself. Additive and view-dependent: `normalView.z` is 1 where the
 * sphere points straight at the camera and 0 all along its silhouette, so
 * raising it to a power gives a centre that burns out into nothing at the edge
 * instead of stopping at one. That is the whole difference between a lit object
 * and a light.
 */
function coreMaterial( tint: ColorUniform, gain: FloatUniform ): MeshBasicNodeMaterial {

	const material = new MeshBasicNodeMaterial();

	material.colorNode = tint.mul( gain );

	// The discard has to live inside an `Fn` — outside one it appends to no shader
	// stack and compiles away, which is the trap `ParticleField` documents.
	material.opacityNode = Fn( () => {

		const body = pow( normalView.z.clamp( 0, 1 ), float( RIM_FALLOFF ) ).toVar();

		body.lessThan( 0.01 ).discard();

		return body;

	} )();

	material.transparent = true;
	material.depthWrite = false;
	material.blending = AdditiveBlending;

	// Marked as a glow so `Post` gives it no ambient occlusion — see `gbuffer.ts`.
	material.mrtNode = transparentMRT();

	return material;

}

/** The bleed around it: a billboarded radial gradient, and nothing else. */
function haloMaterial( tint: ColorUniform, gain: FloatUniform ): SpriteNodeMaterial {

	const material = new SpriteNodeMaterial();

	material.colorNode = tint.mul( gain );

	material.opacityNode = Fn( () => {

		const radial = uv().sub( 0.5 ).length().mul( 2 );
		const glow = pow( smoothstep( 1, 0, radial ), float( HALO_FALLOFF ) ).toVar();

		// A low threshold on purpose: discard is a hard cut, and on a gradient this
		// wide a cut at one percent is a faint ring right where the halo should be
		// disappearing into nothing.
		glow.lessThan( 0.002 ).discard();

		return glow.mul( HALO_STRENGTH );

	} )();

	material.transparent = true;
	material.depthWrite = false;
	material.blending = AdditiveBlending;
	material.mrtNode = transparentMRT();

	return material;

}
