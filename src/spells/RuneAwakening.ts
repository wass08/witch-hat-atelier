import {
	AdditiveBlending,
	CylinderGeometry,
	DoubleSide,
	Group,
	Mesh,
	MeshBasicNodeMaterial,
	PointLight,
	Scene,
	Vector3,
	type WebGPURenderer,
} from 'three/webgpu';
import {
	atan,
	cameraPosition,
	color,
	float,
	mix,
	mx_fractal_noise_float,
	mx_fractal_noise_vec3,
	normalView,
	positionLocal,
	positionWorld,
	pow,
	sin,
	smoothstep,
	time,
	uniform,
	vec3,
} from 'three/tsl';
import { transparentMRT } from '../scene/gbuffer';
import type { Chime } from '../audio/Chime';
import { ParticleField } from './ParticleField';

/** Radius of `MagicCircleDecal` in the GLB. */
const RUNE_RADIUS = 3.3;

/** Pillars of light that stand up on the ring when the circle wakes. */
/** The one-shot `Chime` holds for this spell — loaded in `main`, at the gate. */
export const RUNE_SOUND = 'rune';

const PILLARS = 12;
const PILLAR_RING = 2.95;
const PILLAR_HEIGHT = 2.6;

/**
 * The pillars are **fire**, and every number here is about how a flame behaves
 * rather than how a beam is drawn.
 *
 * Three shapes have stood on this ring. A column of scrolling noise, which was a
 * fog because nothing in it held an edge. Then rings climbing a shaft, which held
 * edges but held them too well — a thing with regular geometry reads as a machine,
 * and what is coming out of a six-metre carving cut by a witch is not machinery.
 * What it should be is a column of flame: a pool at the foot, a body that rises,
 * and a top that comes apart into wisps.
 *
 * The recipe is the standard one for fire and each part earns its place:
 *
 * - **`RISE`** scrolls the noise field *downwards* through the pillar, which the
 *   eye reads as the fire climbing. It is the only motion here; everything else is
 *   shape.
 * - **`WARP`** displaces the sample position by a second, coarser noise before the
 *   first is read. Unwarped fractal noise gives soft round blobs — clouds — and the
 *   warp is what curdles them into tongues and folds. It is the single difference
 *   between smoke and flame.
 * - **`BREAK`** is a threshold on the noise that *rises with height*: low at the
 *   base, so the fire there is a solid pool, and high at the top, where only the
 *   densest parts of the field survive it. That is what makes the column come
 *   apart into detached wisps as it goes up, rather than fading out as a gradient.
 *   A flame does not fade; it breaks.
 * - **`EDGE`** is how sharply that threshold cuts. Wide enough not to alias, narrow
 *   enough that a tongue has a border rather than a haze.
 */
/**
 * Two of these were found by looking rather than reasoned about, and both failures
 * are worth keeping.
 *
 * **`SCALE` 10, not 2.4.** A pillar is 13 cm across at its widest. At 2.4 features
 * per metre the noise barely changes over that, so every fragment of a pillar sampled
 * nearly the same value and the fire came out as a slab of even brightness — a
 * marble column, not a flame. The field has to be finer than the thing it is drawn
 * on.
 *
 * **`STRETCH`, which exists because three-octave fractal noise does not span 0..1.**
 * It clusters near the middle, so the first version thresholded against numbers the
 * field never reached and the pillars rendered *completely empty*. Stretching the
 * useful band out to the full range first is what makes `BREAK` mean anything.
 *
 * `EDGE` 0.06 is the last of it: at 0.17 the tongues had haze for borders and the
 * column read as textured rather than burning. A flame has an edge.
 */
const FLAME_SCALE = 10;
const FLAME_RISE = 2.6;
const FLAME_WARP = 0.7;
const FLAME_STRETCH = [ 0.38, 0.62 ] as const;
const FLAME_BREAK = [ 0.20, 1.0 ] as const;
const FLAME_EDGE = 0.06;

/**
 * How fast the fire takes hold and how slowly it lets go, as rates per second,
 * and the level below which there is nothing left to draw.
 *
 * The charge's own decay is 1.6 s and it was driving everything, so when the spell
 * ended the columns went out with it — and because the alpha only ever fell with
 * the *climb*, what that looked like was the fire retracting into the floor and
 * then stopping, rather than burning down. At 1.05 the beams take about two and a
 * half seconds to fade, and they go on burning into the drain, after the circle
 * itself has gone quiet.
 *
 * The attack is fast because it is not the interesting half: the fire arriving is
 * the crest doing the work, and a slow follower there would only blunt it.
 */
const BEAM_ATTACK = 9;
const BEAM_RELEASE = 1.05;

/**
 * The level at which there is provably nothing left to draw.
 *
 * Not a guess: the extinction line sits at `(1 − beam) × OVERRUN` and its gradient
 * is `OUT_WIDTH` deep, so the last lit fragment leaves the top of the column when
 * `(1 − beam) × 1.3 − 0.28 > 1`, which is beam < 0.015. Below that the mesh is
 * drawing twelve cylinders of nothing, and an exponential release would take
 * another second and a half to admit it.
 */
const BEAM_GONE = 0.015;

/**
 * How the fire goes out: an extinction line sweeping **upwards**, and how far it
 * runs past the top of the column.
 *
 * Bottom-up rather than top-down, and the reason is where the fuel is. This fire
 * is fed by the carving, so when the spell ends it is cut off at the *source* —
 * the base goes dark first and the last of the flame rises off the floor and
 * comes apart, the way a gas flame lifts and dies when the tap is closed. Sinking
 * back into the ring is the other option and reads as the fire being *pulled*
 * down, which is a different claim about what just happened.
 *
 * The width is what keeps it from being a wipe: 0.28 of the column's height is a
 * long enough gradient that the line never has an edge you could point at.
 */
const BEAM_OUT_WIDTH = 0.28;
const BEAM_OUT_OVERRUN = 1.3;

const ATTACK = 0.7;
const HOLD = 1.8;
const DECAY = 1.6;

/** How much of the room the rune keeps lit while another spell passes overhead. */
export interface RuneTarget {
	setCharge( amount: number ): void;
	setPhase( radians: number ): void;
}

/**
 * Wakes the 6.6 m sigil burned into the floor: the carving spins up and brightens,
 * a shaft of light stands up out of it, and embers climb the shaft.
 *
 * The rotation is integrated here rather than driven off `time` directly, which is
 * what lets it sit perfectly still at rest and still spin up and wind down without
 * the phase ever jumping.
 */
export class RuneAwakening {

	private elapsed = 0;
	private awake = false;
	private drain = 0;
	private phase = 0;
	private ambient = 0;
	private charge = 0;

	/**
	 * How far the fire has climbed, and how much of it is left.
	 *
	 * Two values rather than one, because the rise and the exit are not the same
	 * move played backwards. `reach` only ever grows while the circle is awake, so
	 * a column that has stood up stays stood up; `beam` is the level the flame is
	 * burning at, and it lets go far more slowly than the charge does — which is
	 * what turns the end of the spell from a switch into a dying fire.
	 */
	private readonly uReach = uniform( 0 );
	private readonly uBeam = uniform( 0 );

	private reach = 0;
	private beam = 0;

	private readonly pillars: Group;
	private readonly motes: ParticleField;
	private readonly light: PointLight;
	private readonly emitter = new Vector3( 0, 0.08, 0 );

	constructor( renderer: WebGPURenderer, scene: Scene, private readonly rune: RuneTarget, private readonly chime: Chime ) {

		// One geometry and one material shared by every pillar; the group carries
		// the same rotation as the carving, so the light stands *on* the ring.
		const geometry = new CylinderGeometry( 0.035, 0.13, PILLAR_HEIGHT, 14, 1, true );
		const material = this.buildPillarMaterial();

		this.pillars = new Group();
		this.pillars.visible = false;

		for ( let i = 0; i < PILLARS; i ++ ) {

			const angle = ( i / PILLARS ) * Math.PI * 2;
			const pillar = new Mesh( geometry, material );
			pillar.position.set( Math.cos( angle ) * PILLAR_RING, PILLAR_HEIGHT / 2, Math.sin( angle ) * PILLAR_RING );
			this.pillars.add( pillar );

		}

		this.motes = new ParticleField( renderer, scene, {
			// Half what this used to carry, and the reason is the links: every mote
			// walks the whole pool each frame looking for its two nearest neighbours,
			// so the cost of the web is the square of this number. Two thousand over a
			// 3.3 m ring still leaves them about a hand's width apart, which is inside
			// the reach below — the web reads as dense long before the pool does.
			count: 2048,
			palette: [ 0x120726, 0x6a30d8, 0xc79bff ],
			turbulent: true,
			links: {
				// Measured, not guessed: with the pool full, a mote's nearest neighbour
				// sits about 9 cm away and nine in ten are inside 15 cm. A reach much
				// past that does not add links, it just lets the rare isolated mote
				// throw a half-metre strand across the ring, which is what turns a web
				// into a scattering of shards.
				width: 0.0025,
				reach: 0.22,
				palette: [ 0x2a1250, 0xc79bff ],
			},
		} );
		this.motes.teleport( this.emitter );

		this.light = new PointLight( 0x8a5cff, 0, 6.5, 2 );
		this.light.position.set( 0, 0.7, 0 );
		this.light.visible = false;

		scene.add( this.pillars, this.light );

	}

	get active(): boolean {

		return this.awake;

	}

	awaken(): void {

		this.elapsed = 0;
		this.awake = true;
		this.pillars.visible = true;
		this.light.visible = true;
		this.motes.teleport( this.emitter );

		// Only here, and deliberately not in `setAmbient`: a fireball crossing the
		// room stirs the circle without waking it, and that is not this spell being
		// cast. The sound belongs to the awakening, not to the glow.
		this.chime.play( RUNE_SOUND, 0.5 );

	}

	/** A passing spell stirs the circle without fully waking it. */
	setAmbient( amount: number ): void {

		this.ambient = amount;

	}

	/**
	 * Runs every frame, awake or not.
	 *
	 * The carving turns only for its own spell; a passing fireball or bolt reaches
	 * it through {@link setAmbient}, which lights the ring without moving it.
	 */
	update( dt: number ): void {

		if ( this.awake ) {

			this.elapsed += dt;
			this.charge = envelope( this.elapsed );

			if ( this.elapsed > ATTACK + HOLD + DECAY ) {

				this.awake = false;
				this.light.visible = false;

				// The pillars are *not* hidden here any more. The charge is spent, but
				// the fire on them is not — `beam` is still letting go, and hiding the
				// mesh underneath it is exactly the cut this was meant to remove.

				// Motes only move while the field is stepped; keep going long enough
				// for the last of them to burn out instead of freezing mid-air.
				this.drain = 3;

			}

		} else {

			this.charge = 0;

		}

		const level = Math.max( this.charge, this.ambient );

		// Dead still until *this* spell wakes it, and `charge` rather than `level` is
		// the whole point: `ambient` is a passing fireball or bolt stirring the
		// circle, and that should light it, not turn it. Driving the spin off the
		// combined level meant the floor rotated for every spell in the game, which
		// spends the one gesture that belongs to the rune on the two that do not.
		// It still comes to rest on its own as the charge decays rather than
		// stopping dead.
		this.phase += this.charge * 1.25 * dt;

		this.pillars.rotation.y = this.phase;
		this.rune.setPhase( this.phase );
		this.rune.setCharge( level );

		// The beams' own level. Fast up, slow down: `BEAM_RELEASE` is a rate per
		// second, so at 1.05 the fire takes about two and a half seconds to go out
		// against the charge's 1.6 — and it keeps burning into the drain, after the
		// circle itself has gone quiet, which is when a fire would actually die.
		const rate = level > this.beam ? BEAM_ATTACK : BEAM_RELEASE;

		this.beam += ( level - this.beam ) * Math.min( 1, dt * rate );

		// …and how far up it got. Monotonic while awake, so the exit is the sweep
		// below rather than the rise running backwards.
		this.reach = this.awake ? Math.max( this.reach, level ) : this.reach;

		// Only on the way out. The beam starts at zero and climbs, so testing this
		// while the circle is awake hides the pillars on the first frame of the
		// attack and never shows them again — which is what raising the threshold
		// from 0.004 to 0.015 did, since the beam passes 0.01 on frame one.
		if ( ! this.awake && this.beam < BEAM_GONE ) {

			this.beam = 0;
			this.reach = 0;
			this.pillars.visible = false;

		}

		this.uReach.value = this.reach;
		this.uBeam.value = this.beam;
		this.light.intensity = 2.8 * level ** 1.4;

		if ( this.awake ) {

			this.motes.configure( {
				position: this.emitter,
				shape: 1,
				spawnRate: 0.14 * this.charge,
				radius: RUNE_RADIUS,
				speed: 0.85,
				lifeSpan: 2.4,
				attract: 0,
				drift: new Vector3( 0, 0.15, 0 ),
				size: 0.035,
				buoyancy: 0.12,
				damping: 0.35,

				// Rides the charge, so the circle's motes come up as it wakes rather
				// than arriving already lit.
				glow: 1.5 + 4.5 * this.charge,

				// The turbulence is what the links need to look alive: without it the
				// motes rise in parallel and the web between them barely changes shape.
				turbulence: 0.6,
				turbulenceScale: 0.55,
				turbulenceFriction: 1.6,
			} );

			this.motes.step( dt );

		} else if ( this.drain > 0 ) {

			this.drain -= dt;
			this.motes.extinguish();
			this.motes.step( dt );

		}

	}

	/**
	 * The pillars.
	 *
	 * They used to be twelve identical columns of noise whose only move was to
	 * fade up and fade down: the fractal shimmer scrolled slowly through them and
	 * nothing else about them ever changed, so a spell that spins a six-metre
	 * carving up out of the floor was surrounded by twelve pieces of static haze.
	 * Everything below is the same twelve cylinders and the same one material —
	 * what makes them move is that all of it is a function of *where* on the ring
	 * the fragment is, and the ring turns.
	 *
	 * Nothing here needs a per-pillar attribute for that, which is the trick worth
	 * writing down. `positionWorld` gives the fragment's angle about the room's
	 * axis, and the pillars sweep through world space as the group rotates — so a
	 * wave written as a function of that angle stands still in the *room* while
	 * the pillars travel through it, and every pillar brightens and dims as it
	 * passes. One draw's worth of uniforms, twelve pillars behaving differently.
	 */
	private buildPillarMaterial(): MeshBasicNodeMaterial {

		const material = new MeshBasicNodeMaterial();

		const height = positionLocal.y.div( PILLAR_HEIGHT ).add( 0.5 ).clamp( 0, 1 );

		// Sampled in *world* space, so the field is a property of the room rather
		// than of the mesh: the twelve pillars are cut out of one body of fire
		// instead of each wearing the same copy of it, and they turn through it as
		// the carving spins.
		const p = positionWorld.mul( FLAME_SCALE );
		const rise = time.mul( FLAME_RISE );

		// The warp, and then the flame read through it.
		const warp = mx_fractal_noise_vec3(
			p.mul( 0.55 ).sub( vec3( 0, rise.mul( 0.6 ), 0 ) ), 2, 2, 0.5, FLAME_WARP,
		);
		const raw = mx_fractal_noise_float(
			p.add( warp ).sub( vec3( 0, rise, 0 ) ), 3,
		).mul( 0.5 ).add( 0.5 );

		// …stretched to the full range, because the noise never uses it — see above.
		const field = smoothstep( float( FLAME_STRETCH[ 0 ] ), float( FLAME_STRETCH[ 1 ] ), raw );

		// **Going out, from the bottom up.** The line where the fire stops travels
		// upwards as `beam` lets go, so the base darkens first and what is left rises
		// off the floor and comes apart — a flame cut off at its fuel rather than one
		// pulled back into the ground. It overruns the top so the last wisp leaves
		// the column entirely instead of parking at its rim.
		const out = this.uBeam.oneMinus().mul( BEAM_OUT_OVERRUN );
		const alive = smoothstep( out.sub( BEAM_OUT_WIDTH ), out.add( 0.06 ), height );

		// **…and the fire that is left is measured from that line, not from the
		// floor.** This is the whole difference between fading out and vanishing.
		//
		// Everything below about the flame's shape — how dense it is, how far it
		// tapers — is a function of how high up the column a fragment sits, because
		// fire is fed from below and thins as it rises. Sweep the extinction upward
		// against that and the two compound: the only part still alight is the part
		// that was already almost nothing, so the last second of a two-second fade
		// had no fire in it at all and the beams appeared to blink out.
		//
		// Rebasing fixes it exactly. `above` is height measured from the extinction
		// line and renormalised over whatever is left, so the surviving band always
		// has its own dense root at the cut and its own wisps above — a flame
		// lifting off a burner, which is what this is. While the fire is whole
		// (`out` = 0) it is identical to `height`, so nothing about the burning
		// state changes.
		const left = float( 1 ).sub( out ).max( 0.15 );
		const above = height.sub( out ).div( left ).clamp( 0, 1 );

		// The break. Threshold rising with height: a pool at the foot, tongues in the
		// body, and only the densest parts of the field surviving at the top — which
		// is what tears the column into wisps instead of fading it out.
		const cut = mix( float( FLAME_BREAK[ 0 ] ), float( FLAME_BREAK[ 1 ] ), above );
		const flame = smoothstep( cut, cut.add( FLAME_EDGE ), field );

		// Where this fragment sits around the room. The pillars sweep through world
		// space as the ring turns, so a swell written in this angle stands still in
		// the room while they travel through it and each brightens as it passes — no
		// per-pillar attribute for twelve pillars behaving differently.
		const around = atan( positionWorld.z, positionWorld.x );
		const swell = sin( around.mul( 3 ).sub( time.mul( 1.5 ) ) ).mul( 0.5 ).add( 0.5 ).mul( 0.5 ).add( 0.5 );

		// The climb. The fire stands *up* out of the carving as the charge comes in,
		// so the arrival is in the envelope rather than in an alpha ramp — and it
		// stays up once it is up, because `reach` does not run backwards. The exit is
		// the sweep below, not this in reverse.
		const climb = this.uReach.mul( 1.35 );
		const front = smoothstep( climb, climb.sub( 0.4 ), height );
		const crest = smoothstep( 0.14, 0, height.sub( climb ).abs() ).mul( this.uReach.oneMinus().max( 0.12 ) );

		// Thickest at the carving and thinning as it goes, which is the other half of
		// why a flame is a flame: fire is fed from below. The taper reaches past the
		// top of the mesh on purpose — at 0.9 the column still had a *height* it
		// stopped at, and a flame does not have one of those.
		const body = smoothstep( 1.15, 0.0, above ).mul( smoothstep( 0.0, 0.04, height ) );

		// The ring passes within a metre of the seated camera; without this the
		// nearest pillars fill the whole frame.
		const near = smoothstep( 0.7, 2.6, positionWorld.distance( cameraPosition ) );

		// **The silhouette, faded rather than cut.** The flame is shaded on a
		// cylinder, so without this its outline *is* the cylinder's: a hard vertical
		// edge down both sides of every column, which is the one line in the whole
		// effect that could not have been drawn by fire. Weighting by how squarely
		// the surface faces the camera takes the alpha to nothing exactly where the
		// mesh turns away, so the column thins out into the room instead of ending
		// at its own geometry.
		//
		// It is the opposite weighting to the one a *beam* wants — a tube of light is
		// brightest at its silhouette, where the sight line runs along it — and that
		// difference is most of what separates the two readings.
		const rim = normalView.z.abs();

		// Violet through magenta to white at the core of a tongue. The hottest part
		// of a flame has no colour left, and the bloom threshold is 1.15, so only
		// that core haloes — a column that blooms along its whole length is the fog
		// this started as.
		const heat = flame.mul( body );
		const shade = mix(
			mix( color( 0x3a0d7a ), color( 0x9b4dff ), smoothstep( 0.0, 0.5, heat ) ),
			color( 0xf3e6ff ),
			pow( heat, 4.0 ),
		);

		material.colorNode = shade.mul( heat.mul( 2.6 ).add( crest.mul( 2.2 ) ).add( 0.3 ) );

		material.opacityNode = heat.mul( 0.95 ).add( crest.mul( 0.5 ) )
			.mul( near ).mul( front ).mul( swell ).mul( rim ).mul( alive )

			// …and dimmer overall as it goes, so the part still burning is losing its
			// heat rather than holding full brightness up to the moment it vanishes.
			.mul( pow( this.uBeam, 0.5 ).mul( 0.75 ).add( 0.25 ) )
			.clamp( 0, 1 );

		material.transparent = true;
		material.depthWrite = false;
		material.side = DoubleSide;
		material.blending = AdditiveBlending;

		// The MRT marker, without which this writes a *real* normal into the buffer
		// SSGI reads — and a two-and-a-half-metre cylinder standing on the floor is
		// a very convincing surface to write. The AO pass then shades the flame as
		// though it were a pillar of stone, which is the hard-edged shadow at the
		// top of the column: the shading is soft and the geometry's silhouette is
		// not, so what shows through is the shape of the mesh rather than of the
		// fire on it. See `scene/gbuffer.ts`.
		material.mrtNode = transparentMRT();

		return material;

	}
}

/** Attack, hold, decay — 0 → 1 → 0 over the life of the spell. */
function envelope( elapsed: number ): number {

	if ( elapsed < ATTACK ) {

		const t = elapsed / ATTACK;
		return t * t * ( 3 - 2 * t );

	}

	if ( elapsed < ATTACK + HOLD ) return 1;

	return Math.max( 0, 1 - ( elapsed - ATTACK - HOLD ) / DECAY ) ** 1.4;

}
