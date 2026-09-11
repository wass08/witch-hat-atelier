import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Mesh,
	MeshBasicNodeMaterial,
	PointLight,
	Scene,
	Sphere,
	Vector3,
	type WebGPURenderer,
} from 'three/webgpu';
import {
	attribute,
	cameraPosition,
	clamp,
	color,
	cross,
	float,
	mix,
	mx_noise_float,
	normalize,
	pow,
	smoothstep,
	uniform,
	vec3,
} from 'three/tsl';
import { transparentMRT } from '../scene/gbuffer';
import type { Chime } from '../audio/Chime';
import { ParticleField } from './ParticleField';

/** Cross-sections along each ribbon. More means a finer jag. */
const SECTIONS = 26;

/**
 * Ribbon layout — the bolt's anatomy, and the whole of what makes it read as
 * lightning rather than as a lit line.
 *
 * It was a trunk and three branches, which is enough to say "not straight" and
 * nothing more. What an arc actually looks like is a *core with a fringe*: a few
 * strands winding around each other down the middle, filaments peeling off all
 * along them, and a burst of short ones at each end where the charge arrives and
 * has nowhere left to go. Four ribbons cannot describe that at any width; twenty
 * can, and cost 26 sections of two vertices each to say it.
 *
 * Four groups, and each is doing a different job:
 *
 * - **the core**, three strands spanning the whole path and pinned at both ends,
 *   with different drifts so they wind about one another instead of overlaying;
 * - **the fringe**, eight short filaments hanging off at intervals with free tips,
 *   which is what stops the middle of the bolt reading as a tube;
 * - **the impact burst**, six very short ones at the far end. Some have a
 *   *negative* length, which runs their span backwards down the path — that is
 *   what makes the burst radiate rather than all rake forward, since drift alone
 *   is perpendicular and cannot send anything back the way it came;
 * - **the muzzle burst**, three of the same at the quill end, because the charge
 *   leaves from somewhere as well as arriving.
 */
const RIBBONS = [
	// The core.
	{ start: 0.0, length: 1.0, pinStart: 1, pinEnd: 1, width: 1.0, drift: [ 0, 0 ] },
	{ start: 0.0, length: 1.0, pinStart: 1, pinEnd: 1, width: 0.62, drift: [ 0.22, 0.16 ] },
	{ start: 0.0, length: 1.0, pinStart: 1, pinEnd: 1, width: 0.5, drift: [ - 0.19, 0.24 ] },

	// The fringe.
	{ start: 0.14, length: 0.20, pinStart: 1, pinEnd: 0, width: 0.34, drift: [ 0.75, 0.3 ] },
	{ start: 0.22, length: 0.16, pinStart: 1, pinEnd: 0, width: 0.28, drift: [ - 0.5, - 0.62 ] },
	{ start: 0.34, length: 0.24, pinStart: 1, pinEnd: 0, width: 0.4, drift: [ 0.62, - 0.48 ] },
	{ start: 0.41, length: 0.13, pinStart: 1, pinEnd: 0, width: 0.26, drift: [ - 0.82, 0.22 ] },
	{ start: 0.53, length: 0.21, pinStart: 1, pinEnd: 0, width: 0.36, drift: [ - 0.66, 0.34 ] },
	{ start: 0.61, length: 0.15, pinStart: 1, pinEnd: 0, width: 0.27, drift: [ 0.4, 0.78 ] },
	{ start: 0.72, length: 0.19, pinStart: 1, pinEnd: 0, width: 0.33, drift: [ 0.28, - 0.72 ] },
	{ start: 0.82, length: 0.12, pinStart: 1, pinEnd: 0, width: 0.24, drift: [ - 0.55, - 0.4 ] },

	// The impact burst.
	{ start: 0.99, length: 0.10, pinStart: 1, pinEnd: 0, width: 0.3, drift: [ 0.95, 0.35 ] },
	{ start: 0.99, length: 0.09, pinStart: 1, pinEnd: 0, width: 0.26, drift: [ - 0.85, 0.55 ] },
	{ start: 0.99, length: 0.11, pinStart: 1, pinEnd: 0, width: 0.28, drift: [ 0.2, - 1.0 ] },
	{ start: 0.99, length: - 0.09, pinStart: 1, pinEnd: 0, width: 0.26, drift: [ 0.7, - 0.7 ] },
	{ start: 0.99, length: - 0.11, pinStart: 1, pinEnd: 0, width: 0.24, drift: [ - 0.75, - 0.5 ] },
	{ start: 0.99, length: - 0.08, pinStart: 1, pinEnd: 0, width: 0.22, drift: [ - 0.3, 0.95 ] },

	// The muzzle burst.
	{ start: 0.02, length: 0.08, pinStart: 1, pinEnd: 0, width: 0.24, drift: [ 0.6, 0.7 ] },
	{ start: 0.02, length: - 0.06, pinStart: 1, pinEnd: 0, width: 0.2, drift: [ - 0.7, 0.45 ] },
	{ start: 0.02, length: - 0.07, pinStart: 1, pinEnd: 0, width: 0.22, drift: [ 0.35, - 0.8 ] },
] as const;

const UP = new Vector3( 0, 1, 0 );

/** The one-shot `Chime` holds for this spell — loaded in `main`, at the gate. */
export const LIGHTNING_SOUND = 'lightning';

const STRIKE_TIME = 0.45;
const LIGHT_FADE = 0.35;

/**
 * How long to keep running after the arc dies. Particles only move while their
 * field is stepped, so cutting the effect off early leaves sparks hanging in the
 * air; this covers the longest spark lifetime with room to spare.
 */
const DRAIN_TIME = 0.7;

/**
 * A bolt drawn as billboarded ribbons whose spine is displaced by noise in the
 * vertex stage: the CPU never touches a vertex, so the arc re-jags itself every
 * frame for free. Branches are the same geometry with a shorter span along the
 * path and a free tip.
 */
export class Lightning {

	private elapsed = 0;
	private striking = false;

	private readonly from = new Vector3();
	private readonly to = new Vector3();

	private readonly uFrom = uniform( new Vector3() );
	private readonly uTo = uniform( new Vector3() );
	private readonly uAlpha = uniform( 0 );
	private readonly uSeed = uniform( 0 );
	private readonly uAmplitude = uniform( 0.16 );
	private readonly uWidth = uniform( 0.024 );
	private readonly uJitter = uniform( 0 );

	private readonly bolt: Mesh;
	private readonly sparks: ParticleField;
	private readonly muzzle: PointLight;
	private readonly impact: PointLight;

	constructor( renderer: WebGPURenderer, scene: Scene, private readonly chime: Chime ) {

		this.bolt = new Mesh( buildRibbons(), this.buildMaterial() );
		this.bolt.frustumCulled = false;
		this.bolt.renderOrder = 11;
		this.bolt.visible = false;

		this.sparks = new ParticleField( renderer, scene, {
			count: 3072,
			palette: [ 0x0a1030, 0x2f6bff, 0xbfe0ff ],
		} );

		this.muzzle = new PointLight( 0x9fc4ff, 0, 2.5, 2 );
		this.muzzle.visible = false;

		this.impact = new PointLight( 0xbcd8ff, 0, 8, 2 );
		this.impact.visible = false;

		scene.add( this.bolt, this.muzzle, this.impact );

	}

	get active(): boolean {

		return this.striking;

	}

	strike( from: Vector3, to: Vector3 ): void {

		this.from.copy( from );
		this.to.copy( to );

		this.uFrom.value.copy( from );
		this.uTo.value.copy( to );

		// A fresh seed re-rolls the whole arc without rebuilding any geometry.
		this.uSeed.value = Math.random() * 100;
		this.uAmplitude.value = from.distanceTo( to ) * 0.07;

		this.elapsed = 0;
		this.striking = true;

		this.bolt.visible = true;
		this.muzzle.visible = true;
		this.impact.visible = true;
		// Held clear of the page: a point light sitting on the parchment blows the
		// whole sheet out at this falloff.
		this.muzzle.position.copy( from ).addScaledVector( UP, 0.32 );
		this.impact.position.copy( to );

		this.sparks.teleport( to );

		// A bolt has no travel: `strike` is both the cast and the arrival, so unlike
		// the fireball there is no second moment to wait for. `to` is already the
		// ward's shell when one deflected it, so the crack lands wherever the arc
		// actually stopped.
		this.chime.play( LIGHTNING_SOUND, 0.45 );

	}

	update( dt: number ): void {

		this.elapsed += dt;

		const t = this.elapsed / STRIKE_TIME;

		if ( t < 1 ) {

			// Three hard flickers over the life of the strike, riding a decay.
			const flicker = 0.55 + 0.45 * Math.sin( this.elapsed * 62 );

			this.uAlpha.value = ( 1 - t ) ** 0.6 * flicker;
			this.uJitter.value = this.elapsed;
			this.uWidth.value = 0.024 * ( 1 - t * 0.45 );

			this.muzzle.intensity = 0.7 * ( 1 - t ) * flicker;
			this.impact.intensity = 9 * ( 1 - t ) * flicker;

			this.sparks.configure( {
				position: this.to,
				spawnRate: 0.6 * ( 1 - t ),
				radius: 0.08,
				speed: 2.6,
				lifeSpan: 0.5,
				size: 0.018,
				drift: new Vector3( 0, 0.2, 0 ),
				buoyancy: - 2.4,
				damping: 1.6,

				// Well over the bloom threshold, and falling with the strike. Sparks
				// off an arc are the brightest thing this spell throws — and 10 was
				// not throwing them like it. A particle's additive contribution is its
				// tint times its heat ramp times the 0.22 the sprite's alpha carries,
				// so 10 puts a spark's core barely twice over a bloom that does not
				// open until 1.15: enough to be lit, not enough to halo. Against the
				// candle burning at 7 a few centimetres from the page, the brightest
				// thing in the room was a candle. 18 is where the arc's own sparks
				// glow rather than merely being visible.
				glow: 18 * ( 1 - t * 0.5 ),

				// Harder than the fireball's 0.6, because this is the one pool in the
				// room where nothing is on fire. An ember is a hot *thing* and can
				// afford to read as matter; an electrical spark is a point of light and
				// nothing else, and the round sprite — a soft radial falloff, which is
				// the silhouette of a puff of smoke — is what made these read as blue
				// confetti. The glint has spikes and a hard core.
				sparkle: 0.75,

				// Faster than the fireball's flicker, and shallower. What is being
				// described is an electrical crackle rather than a coal breathing.
				twinkle: 0.35,
				twinkleRate: 5.5,
			} );

		} else {

			this.uAlpha.value = 0;
			this.bolt.visible = false;
			this.sparks.extinguish();

			const since = this.elapsed - STRIKE_TIME;
			const fade = Math.max( 0, 1 - since / LIGHT_FADE );

			this.muzzle.intensity = 0;
			this.impact.intensity = 3 * fade ** 2;

			if ( since >= DRAIN_TIME ) {

				this.striking = false;
				this.muzzle.visible = false;
				this.impact.visible = false;

			}

		}

		this.sparks.step( dt );

	}

	private buildMaterial(): MeshBasicNodeMaterial {

		const material = new MeshBasicNodeMaterial();

		const t = attribute<'float'>( 'aT', 'float' );
		const side = attribute<'float'>( 'aSide', 'float' );
		const seed = attribute<'float'>( 'aSeed', 'float' );
		const span = attribute<'vec2'>( 'aSpan', 'vec2' );
		const pin = attribute<'vec2'>( 'aPin', 'vec2' );
		const drift = attribute<'vec2'>( 'aDrift', 'vec2' );
		const width = attribute<'float'>( 'aWidth', 'float' );

		const pathT = span.x.add( t.mul( span.y ) );

		const axis = this.uTo.sub( this.uFrom );
		const direction = normalize( axis );

		// Stable-ish frame around the bolt; the arc never runs vertically here, so
		// crossing with world up is safe.
		const right = normalize( cross( direction, vec3( 0, 1, 0 ) ) );
		const up = cross( right, direction );

		const noiseSeed = seed.add( this.uSeed );
		const wobbleA = mx_noise_float( vec3( pathT.mul( 13 ), noiseSeed, this.uJitter.mul( 9 ) ) );
		const wobbleB = mx_noise_float( vec3( pathT.mul( 9 ).add( 31 ), noiseSeed.add( 7 ), this.uJitter.mul( 7 ) ) );

		// Pinned ends stay welded to the quill and the target; free tips flare out.
		const envelope = mix( float( 1 ), smoothstep( 0, 0.14, t ), pin.x )
			.mul( mix( float( 1 ), smoothstep( 0, 0.18, t.oneMinus() ), pin.y ) );

		const spine = this.uFrom.add( axis.mul( pathT ) )
			.add( right.mul( wobbleA ).add( up.mul( wobbleB ) ).mul( this.uAmplitude.mul( envelope ) ) )
			.add( right.mul( drift.x ).add( up.mul( drift.y ) ).mul( t.mul( this.uAmplitude ).mul( 1.6 ) ) );

		// Billboard the ribbon: widen perpendicular to both the bolt and the eye.
		const flat = normalize( cross( direction, normalize( cameraPosition.sub( spine ) ) ) );
		const taper = mix( float( 1 ), t.oneMinus().add( 0.25 ), pin.y.oneMinus() );

		material.positionNode = spine.add( flat.mul( side.mul( this.uWidth ).mul( width ).mul( taper ) ) );

		// Triangular falloff across the ribbon reads as a glowing core with haze.
		const core = pow( side.abs().oneMinus(), 1.6 );

		// White down the middle, colour in the haze around it. A bolt lit in its own
		// colour all the way through reads as a painted line; what says *arc* is a
		// centre too bright to have a colour at all, with the blue only in what
		// spills off it. 1.9 puts that centre well over the 1.15 bloom threshold so
		// the fringe it throws is the pass's, not the ribbon's.
		material.colorNode = mix( color( 0x2b6bff ), color( 0xffffff ), pow( core, 1.5 ) ).mul( 1.9 );
		material.opacityNode = clamp( core.mul( envelope ).mul( this.uAlpha ), 0, 1 );

		material.transparent = true;
		material.depthWrite = false;
		material.blending = AdditiveBlending;

		// The MRT marker. Twenty billboarded ribbons are twenty camera-facing quads
		// hanging in mid-air, which is the exact case this exists for.
		material.mrtNode = transparentMRT();

		return material;

	}

}

/** One triangle strip per ribbon, packed into a single indexed geometry. */
function buildRibbons(): BufferGeometry {

	const vertices = RIBBONS.length * SECTIONS * 2;

	const position = new Float32Array( vertices * 3 );
	const aT = new Float32Array( vertices );
	const aSide = new Float32Array( vertices );
	const aSeed = new Float32Array( vertices );
	const aWidth = new Float32Array( vertices );
	const aSpan = new Float32Array( vertices * 2 );
	const aPin = new Float32Array( vertices * 2 );
	const aDrift = new Float32Array( vertices * 2 );
	const indices: number[] = [];

	let v = 0;

	RIBBONS.forEach( ( ribbon, r ) => {

		const base = v;

		for ( let s = 0; s < SECTIONS; s ++ ) {

			const t = s / ( SECTIONS - 1 );

			for ( const side of [ - 1, 1 ] ) {

				aT[ v ] = t;
				aSide[ v ] = side;
				aSeed[ v ] = r * 19.7;
				aWidth[ v ] = ribbon.width;
				aSpan[ v * 2 ] = ribbon.start;
				aSpan[ v * 2 + 1 ] = ribbon.length;
				aPin[ v * 2 ] = ribbon.pinStart;
				aPin[ v * 2 + 1 ] = ribbon.pinEnd;
				aDrift[ v * 2 ] = ribbon.drift[ 0 ];
				aDrift[ v * 2 + 1 ] = ribbon.drift[ 1 ];
				v ++;

			}

			if ( s > 0 ) {

				const a = base + ( s - 1 ) * 2;
				indices.push( a, a + 1, a + 2, a + 1, a + 3, a + 2 );

			}

		}

	} );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'aT', new BufferAttribute( aT, 1 ) );
	geometry.setAttribute( 'aSide', new BufferAttribute( aSide, 1 ) );
	geometry.setAttribute( 'aSeed', new BufferAttribute( aSeed, 1 ) );
	geometry.setAttribute( 'aWidth', new BufferAttribute( aWidth, 1 ) );
	geometry.setAttribute( 'aSpan', new BufferAttribute( aSpan, 2 ) );
	geometry.setAttribute( 'aPin', new BufferAttribute( aPin, 2 ) );
	geometry.setAttribute( 'aDrift', new BufferAttribute( aDrift, 2 ) );
	geometry.setIndex( indices );

	// Every vertex is placed by the vertex stage, so the geometry's own bounds are
	// meaningless; give it a sphere big enough that nothing ever culls it.
	geometry.boundingSphere = new Sphere( new Vector3(), 100 );

	return geometry;

}
