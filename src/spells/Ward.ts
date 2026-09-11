import {
	AdditiveBlending,
	DoubleSide,
	Mesh,
	MeshBasicNodeMaterial,
	PointLight,
	Scene,
	RingGeometry,
	SphereGeometry,
	Vector3,
	Vector4,
} from 'three/webgpu';
import {
	atan,
	color,
	cross,
	exp,
	float,
	fract,
	max,
	mix,
	mx_noise_float,
	normalView,
	positionLocal,
	pow,
	sin,
	smoothstep,
	step,
	uniform,
	vec3,
} from 'three/tsl';
import { transparentMRT } from '../scene/gbuffer';
import type { Chime } from '../audio/Chime';

/** The one-shot `Chime` holds for this spell — loaded in `main`, at the gate. */
export const WARD_SOUND = 'ward';

/** Impacts the shell can show at once; a fourth reuses the oldest slot. */
const IMPACTS = 3;

/**
 * The ring on the floor: where its inner edge sits as a fraction of its outer, how
 * far past the cage it is drawn, and how far off the stone.
 *
 * Wider than the shell on purpose. A ring exactly under the silhouette reads as the
 * shell's shadow; a little outside it reads as the ground the shell was raised from,
 * which is the claim being made.
 *
 * The height is measured, not assumed, and the first guess was wrong in the way that
 * costs an hour: the floor *here* is not the flagstones. `MagicCircleDecal` is laid
 * over them and raycasts down onto it at **y = 0.051** everywhere the ring falls, so
 * a ring at 0.028 was two centimetres inside the carving and depth-tested away
 * entirely — invisible even forced to flat opaque cyan, which is what finally ruled
 * the shader out. 0.056 clears the decal by 5 mm: still flat on the ground to look
 * at, never inside it.
 */
const RING_INNER = 0.9;
const RING_SPREAD = 1.12;
const RING_HEIGHT = 0.056;

/** Marks around the ring. */
const RING_GLYPHS = 34;

const GROW = 0.4;
const COLLAPSE = 0.7;

/** Shortest holding phase worth having, whatever the sound says. */
const MIN_HOLD = 0.6;

/** How much of the ward one hit takes out. Three hits shatter it. */
const IMPACT_COST = 0.34;

type Phase = 'idle' | 'rising' | 'holding' | 'collapsing';

/**
 * A dome of hardened air. Where it stands, how big it is and how long it lasts
 * all come from the circle that summoned it — a wide, cleanly drawn ring buys a
 * bigger, longer-lived ward, which is the one place in the atelier where the
 * quality of the line, not just its shape, is worth something.
 *
 * It is also the only thing in the scene the player's own spells can collide
 * with: a fireball crossing the shell detonates against it and leaves cracks.
 */
export class Ward {

	private phase: Phase = 'idle';
	private elapsed = 0;
	private duration = 6;
	private radius = 1.5;
	private health = 1;

	private readonly centre = new Vector3();
	private readonly local = new Vector3();

	private readonly uAlpha = uniform( 0 );
	private readonly uPhase = uniform( 0 );
	private readonly uShatter = uniform( 0 );
	private readonly uImpacts = Array.from( { length: IMPACTS }, () => uniform( new Vector4( 0, 1, 0, - 1 ) ) );

	private readonly dome: Mesh;

	/**
	 * The ring of marks the ward stands in.
	 *
	 * A shell hanging at chest height is a claim about a piece of *floor*, and
	 * closing the dome into a cage took away the thing that used to say so — the old
	 * hemisphere met the stone and drew its own footprint there. This puts it back
	 * explicitly, and it does more than tidy: it is what stops the cage reading as
	 * floating, because a thing with a mark under it is a thing standing somewhere.
	 */
	private readonly circle: Mesh;

	private readonly light: PointLight;

	private nextSlot = 0;

	constructor( scene: Scene, private readonly chime: Chime ) {

		// A whole sphere, not the upper hemisphere it used to be.
		//
		// The ward was a dome standing on the flagstones, and that shape is what
		// forced its size: a hemisphere on the floor has to reach the top of the
		// dummy's head from the *floor's* centre, which is 2.192 m away — measured
		// across its 3,199 vertices — so the smallest ward that actually warded was
		// 2.35 m and filled the room. Closed around the body instead, the same
		// dummy fits inside **1.139 m**, because the radius is now measured from its
		// own middle rather than from its feet. A cage, at half the size and an
		// eighth of the volume.
		this.dome = new Mesh( new SphereGeometry( 1, 64, 32 ), this.buildMaterial() );

		// Flat on the stone, and a unit ring so one scale sets both it and the shell.
		this.circle = new Mesh( new RingGeometry( RING_INNER, 1, 128 ), this.buildCircleMaterial() );
		this.circle.rotation.x = - Math.PI / 2;
		this.circle.frustumCulled = false;
		this.circle.renderOrder = 8;
		this.circle.visible = false;
		this.dome.frustumCulled = false;
		this.dome.renderOrder = 9;
		this.dome.visible = false;

		this.light = new PointLight( 0x8fe4ff, 0, 6, 2 );
		this.light.visible = false;

		scene.add( this.dome, this.circle, this.light );

	}

	get active(): boolean {

		return this.phase !== 'idle';

	}

	/** Seconds of ward remaining, for the HUD. */
	get remaining(): number {

		return this.phase === 'holding' ? Math.max( 0, this.duration - this.elapsed ) : 0;

	}

	/**
	 * Puts the dome up, and reports how many seconds it will be there in total —
	 * which the caller needs, because that figure is no longer the one it passed in.
	 *
	 * The ward runs for exactly as long as its sound. `duration` is only the
	 * *holding* phase, so the rise and the collapse have to come out of the sample's
	 * length before it is used; and it is only a fallback, for the case where the
	 * sample has not finished decoding yet.
	 *
	 * This does mean roundness no longer buys a longer ward — that was the one
	 * thing in the game reading how *well* a sigil was drawn rather than which one,
	 * and it is worth knowing it has gone quiet rather than discovering it later.
	 */
	raise( centre: Vector3, radius: number, duration: number ): number {

		const sound = this.chime.duration( WARD_SOUND );

		// Below the floor there is no holding phase left at all, and the dome would
		// snap open and shut; better a slightly long ward than a broken one.
		const hold = sound === null ? duration : Math.max( MIN_HOLD, sound - GROW - COLLAPSE );

		this.centre.copy( centre );
		this.radius = radius;
		this.duration = hold;
		this.health = 1;
		this.elapsed = 0;
		this.phase = 'rising';

		for ( const impact of this.uImpacts ) impact.value.set( 0, 1, 0, - 1 );

		this.uShatter.value = 0;
		this.dome.position.copy( centre );
		this.dome.visible = true;

		// Under it, on the floor rather than at the cage's own height.
		this.circle.position.set( centre.x, RING_HEIGHT, centre.z );
		this.circle.scale.setScalar( radius * RING_SPREAD );
		this.circle.visible = true;
		this.light.visible = true;
		this.light.position.copy( centre ).addScaledVector( UP, radius * 0.45 );

		// The sample, not `chime.ring`. The synthesised bell is still in `Chime` and
		// still worth keeping — but this is the spell being cast, and the crack
		// below is a separate event with its own sound, so only the raise moves.
		this.chime.play( WARD_SOUND, 0.5 );

		return GROW + hold + COLLAPSE;

	}

	/**
	 * Something has arrived at `point`. If it is inside the shell, returns where
	 * it should stop instead — on the surface — and cracks the glass there.
	 */
	intercept( point: Vector3 ): Vector3 | null {

		if ( this.phase !== 'rising' && this.phase !== 'holding' ) return null;

		const offset = this.local.copy( point ).sub( this.centre );

		// No floor guard any more. It existed because a dome standing on the stone
		// has a rim, and a shot passing under that rim was never inside anything;
		// a closed shell has no underneath, so being within the radius is the whole
		// of the test.
		if ( offset.length() > this.radius ) return null;

		const surface = offset.clone().normalize();

		this.crack( surface );

		return surface.multiplyScalar( this.radius ).add( this.centre );

	}

	/**
	 * Where a shot fired from `from` at `target` meets the shell, or null if the
	 * target was never behind it in the first place.
	 */
	deflect( from: Vector3, target: Vector3 ): Vector3 | null {

		if ( this.phase !== 'rising' && this.phase !== 'holding' ) return null;
		if ( this.local.copy( target ).sub( this.centre ).length() > this.radius ) return null;

		// Ray/sphere: the near root is where it enters the dome.
		const direction = target.clone().sub( from ).normalize();
		const toCentre = from.clone().sub( this.centre );

		const b = 2 * direction.dot( toCentre );
		const c = toCentre.lengthSq() - this.radius * this.radius;
		const discriminant = b * b - 4 * c;

		if ( discriminant < 0 ) return null;

		const t = ( - b - Math.sqrt( discriminant ) ) / 2;

		if ( t <= 0 ) return null;

		const surface = from.clone().addScaledVector( direction, t );

		this.crack( surface.clone().sub( this.centre ).normalize() );

		return surface;

	}

	update( dt: number ): void {

		if ( this.phase === 'idle' ) return;

		this.elapsed += dt;
		this.uPhase.value += dt * 0.35;

		for ( const impact of this.uImpacts ) {

			if ( impact.value.w >= 0 ) impact.value.w += dt;

		}

		if ( this.phase === 'rising' ) {

			const t = Math.min( 1, this.elapsed / GROW );

			// Overshoots a little on the way up, the way a bubble snaps into shape.
			const scale = this.radius * ( 1 + Math.sin( t * Math.PI ) * 0.06 ) * ( t * t * ( 3 - 2 * t ) );

			this.dome.scale.setScalar( Math.max( 0.001, scale ) );
			this.circle.scale.setScalar( Math.max( 0.001, this.radius * RING_SPREAD * ( t * t * ( 3 - 2 * t ) ) ) );
			this.uAlpha.value = t;
			this.light.intensity = 2.2 * t;

			if ( t >= 1 ) {

				this.phase = 'holding';
				this.elapsed = 0;

			}

			return;

		}

		if ( this.phase === 'holding' ) {

			this.dome.scale.setScalar( this.radius );
			this.circle.scale.setScalar( this.radius * RING_SPREAD );

			// Held at full until the collapse takes it, and no pre-fade.
			//
			// There used to be one — `min( 1, left )`, ramping the alpha to zero over
			// the last second — and it ran the exit twice. The dome faded away, and
			// then `collapsing` reset the alpha to one and faded it away again while
			// expanding it, so what you saw was the ward ending, coming back, and
			// ending a second time. The collapse is the real exit and the only one
			// worth keeping; this fade was quietly competing with it.
			//
			// The health term stays: a ward that has taken hits should sit dimmer
			// than a fresh one. That is about damage, not about time running out.
			this.uAlpha.value = 0.55 + this.health * 0.45;
			this.light.intensity = 2.2 * this.health;

			const left = this.duration - this.elapsed;

			if ( left <= 0 ) this.collapse( false );

			return;

		}

		const t = Math.min( 1, this.elapsed / COLLAPSE );

		this.dome.scale.setScalar( this.radius * ( 1 + t * 0.25 ) );
		this.uAlpha.value = ( 1 - t ) ** 2;
		this.uShatter.value = Math.max( 0, this.uShatter.value - dt * 2 );
		this.light.intensity = 4 * ( 1 - t ) ** 2;

		if ( t >= 1 ) {

			this.phase = 'idle';
			this.dome.visible = false;
			this.circle.visible = false;
			this.light.visible = false;
			this.uAlpha.value = 0;

		}

	}

	private crack( direction: Vector3 ): void {

		const slot = this.uImpacts[ this.nextSlot ];

		slot.value.set( direction.x, direction.y, direction.z, 0 );
		this.nextSlot = ( this.nextSlot + 1 ) % IMPACTS;

		this.health -= IMPACT_COST;
		this.light.intensity = 6;

		this.chime.crack( this.health <= 0 ? 1.6 : 1 );

		if ( this.health <= 0 ) {

			this.uShatter.value = 1;
			this.collapse( true );

		}

	}

	private collapse( shattered: boolean ): void {

		if ( this.phase === 'collapsing' || this.phase === 'idle' ) return;

		this.phase = 'collapsing';
		this.elapsed = shattered ? 0 : 0;

	}

	/**
	 * The ring's marks.
	 *
	 * Glyphs rather than a drawn circle, and the difference is in how they are
	 * spaced: `fract( angle × COUNT )` cuts the ring into equal cells, and a noise
	 * read at the cell's own index decides how wide the mark in it is and how
	 * brightly it burns. So no two are alike and none of them is a dash — the eye
	 * reads a row of *characters* rather than a dotted line, which is the whole
	 * difference between a ward's inscription and a selection marker.
	 *
	 * The band across the ring's width is what gives each mark a body; without it
	 * the geometry's inner and outer edges are the only edges in the thing and it
	 * reads as a hoop.
	 */
	private buildCircleMaterial(): MeshBasicNodeMaterial {

		const material = new MeshBasicNodeMaterial();

		// Where on the ring, and where across it.
		const around = atan( positionLocal.y, positionLocal.x ).div( Math.PI * 2 ).add( this.uPhase.mul( 0.02 ) );
		const across = positionLocal.length().sub( RING_INNER ).div( float( 1 ).sub( RING_INNER ) ).clamp( 0, 1 );

		const cell = around.mul( RING_GLYPHS );
		const index = cell.floor();
		const within = cell.fract();

		// One stable number per cell, and everything about that glyph comes off it.
		const roll = mx_noise_float( vec3( index.mul( 0.37 ), 0, 0 ) ).mul( 0.5 ).add( 0.5 );
		const width = roll.mul( 0.26 ).add( 0.12 );

		const mark = smoothstep( width, width.mul( 0.55 ), within.sub( 0.5 ).abs() )
			.mul( smoothstep( 0.0, 0.22, across ) )
			.mul( smoothstep( 1.0, 0.78, across ) );

		// A thin keel line under the glyphs so the ring is a ring even where a cell
		// happens to be empty.
		const keel = smoothstep( 0.16, 0.0, across.sub( 0.5 ).abs() ).mul( 0.22 );

		// Each glyph breathes at its own pace, which is what makes an inscription
		// read as *live* rather than printed.
		const pulse = sin( this.uPhase.mul( 2.4 ).add( roll.mul( 20 ) ) ).mul( 0.5 ).add( 0.5 ).mul( 0.45 ).add( 0.55 );

		const glow = mark.mul( pulse ).add( keel );

		material.colorNode = mix( color( 0x2ad8ff ), color( 0xdff6ff ), mark )
			.mul( glow.mul( 2.4 ).add( 0.2 ) );

		material.opacityNode = glow.mul( this.uAlpha ).clamp( 0, 1 );

		material.transparent = true;
		material.depthWrite = false;
		material.side = DoubleSide;
		material.blending = AdditiveBlending;

		// Flat on the floor and facing the camera edge-on: exactly the case that
		// tells SSGI the flagstones are a wall. See `scene/gbuffer.ts`.
		material.mrtNode = transparentMRT();

		return material;

	}

	private buildMaterial(): MeshBasicNodeMaterial {

		const material = new MeshBasicNodeMaterial();

		// On a unit sphere the surface point *is* the direction, which is what the
		// crack maths wants.
		const direction = positionLocal.normalize();

		// Cracks. Glass does not craze in wandering veins — it throws straight
		// spokes out from the point of impact, with a few concentric fractures
		// across them, inside a jagged boundary. So each impact gets a tangent
		// frame on the shell, and the pattern is drawn in polar coordinates
		// around it: angle makes the spokes, distance makes the rings.
		let cracks = this.uImpacts[ 0 ].w.mul( 0 );

		for ( const impact of this.uImpacts ) {

			const live = step( 0, impact.w );
			const axis = impact.xyz;

			// Any reference works except one parallel to the axis.
			const reference = mix( vec3( 0, 1, 0 ), vec3( 1, 0, 0 ), step( 0.9, axis.y.abs() ) );
			const tangentX = cross( axis, reference ).normalize();
			const tangentY = cross( axis, tangentX );

			const offset = direction.sub( axis.mul( direction.dot( axis ) ) );
			const azimuth = atan( offset.dot( tangentY ), offset.dot( tangentX ) );
			const reach = direction.distance( axis );

			// Sampling the noise along the fracture's length as well as its angle
			// makes each spoke wander as it travels, which is what stops the set of
			// them looking like lines of longitude.
			const wobble = mx_noise_float( vec3( azimuth.mul( 0.9 ), reach.mul( 5 ), axis.x.mul( 7 ).add( axis.z.mul( 3 ) ) ) );
			const spokes = pow( fract( azimuth.mul( 1.8 ).add( wobble.mul( 0.6 ) ) ).sub( 0.5 ).abs().mul( 2 ).oneMinus(), 12 );
			const rings = pow( fract( reach.mul( 7 ).add( wobble.mul( 0.4 ) ) ).sub( 0.5 ).abs().mul( 2 ).oneMinus(), 16 ).mul( 0.35 );

			// The damage spreads fast, then stops, with a ragged edge — and each
			// fracture is widest where it started and peters out towards its tip.
			const spread = impact.w.mul( 3.2 ).min( 1 ).mul( 0.62 ).add( wobble.mul( 0.07 ) );
			const within = smoothstep( spread, spread.mul( 0.15 ), reach );
			const fade = exp( impact.w.mul( - 0.55 ) );

			const shock = smoothstep( 0.07, 0.0, reach.sub( impact.w.mul( 2.4 ) ).abs() ).mul( exp( impact.w.mul( - 3.5 ) ) );

			cracks = cracks.add( spokes.add( rings ).mul( within ).mul( fade ).add( shock ).mul( live ) );

		}

		cracks = cracks.min( 1.4 );

		// **A bubble, not a bulkhead.**
		//
		// The shell has been three things. A fresnel wash, which from the seat was a
		// blue filter over the room — because the *dome* was room-sized and its
		// silhouette was never on screen, so the only part of it you ever saw was the
		// flat fill underneath. Plating fixed that by putting the substance on the
		// surface where it could be seen face-on.
		//
		// Closing it into a cage changed the premise. At 1.45 m around the dummy and
		// 3.9 m from the seat the shell subtends about 44°, so its **silhouette is in
		// frame** — the whole outline of it, all the time. That is the geometry a
		// fresnel term was always for, and with it available the honest shape for a
		// ward is the one a bubble has: nothing in the middle, everything at the rim.
		//
		// So the plating is gone and what is left is a film. `rim` is sharp — power
		// 2.6 rather than 2.2 — because a soap bubble's edge is *thin*, and a soft
		// one reads as fog inside a sphere rather than as a surface enclosing it.
		const rim = pow( normalView.z.abs().oneMinus(), 2.6 );

		// **Thin-film iridescence.** A bubble's colour is not a property of the bubble;
		// it is interference, so it shifts with the angle you catch it at and drifts
		// as the film moves. Two colours mixed by a slow noise over the surface, and
		// then the whole thing biased towards the violet end as the rim steepens —
		// which is the same thing thickness does to a real film.
		const drift = mx_noise_float( direction.mul( 2.1 ).add( vec3( 0, this.uPhase.mul( 0.6 ), 0 ) ) )
			.mul( 0.5 ).add( 0.5 );
		const film = mix( color( 0x3fa8ff ), color( 0xb46cff ), drift );
		const glass = mix( color( 0x1fd6ff ), film, smoothstep( 0.1, 0.8, rim ) );

		// A few brighter streaks where the film is thinnest, which is what stops an
		// even rim reading as a drawn outline.
		const sheen = smoothstep( 0.55, 0.95, drift ).mul( rim );

		// There is no band at the equator any more, and it is worth saying why it was
		// ever there. On the old hemisphere that line was where the shell met the
		// stone — a *footprint*, and the thing that stopped a small ward reading as a
		// smudge. Closed into a sphere it is not a footprint, it is a stripe through
		// the middle of a bubble, and the inscription it used to carry now lives on
		// the ring on the floor, which is where a ward's writing belongs.


		material.colorNode = glass.mul( rim.mul( 2.2 ).add( 0.25 ) )
			.add( color( 0xdff6ff ).mul( sheen.mul( 1.6 ) ) )
			.add( color( 0xeaf8ff ).mul( cracks.mul( 1.8 ) ) )
			.add( color( 0xffffff ).mul( this.uShatter ) );

		// 0.025 through the middle — a tenth of what the plating carried and a fifth
		// of the original wash. You look *through* a ward now; what tells you it is
		// there is its edge, the sheen crossing it, and whatever has just hit it.
		material.opacityNode = max(
			rim.mul( 0.8 ).add( 0.025 ).add( sheen.mul( 0.35 ) ).add( cracks ),
			this.uShatter.mul( 0.6 ),
		)
			.mul( this.uAlpha )
			.clamp( 0, 1 );

		// Blended rather than additive: an additive shell vanishes wherever the room
		// behind it is already bright, and this one has to read against a
		// candle-lit floor as well as against a dark wall.
		material.transparent = true;
		material.depthWrite = false;
		material.side = DoubleSide;

		// …and the MRT marker, so SSGI does not shade a three-metre sphere of
		// hardened air as a three-metre sphere of stone. See `scene/gbuffer.ts`.
		material.mrtNode = transparentMRT();

		return material;

	}

}

const UP = new Vector3( 0, 1, 0 );
