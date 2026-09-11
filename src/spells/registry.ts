import { MathUtils, Vector3 } from 'three/webgpu';
import type { Fireball } from './Fireball';
import type { Lightning } from './Lightning';
import type { RuneAwakening } from './RuneAwakening';
import type { ScreenFlash } from './ScreenFlash';
import type { Recoil } from './Recoil';
import { LIGHTNING_JOLT, RUNE_JOLT } from './Recoil';
import type { Ward } from './Ward';
import type { SigilShape } from '../ink/StrokeRecorder';

export interface SpellEffects {
	fireball: Fireball;
	lightning: Lightning;
	rune: RuneAwakening;
	ward: Ward;
	flash: ScreenFlash;
	recoil: Recoil;
}

export interface CastContext {
	/** Where on the page the sigil was drawn. */
	origin: Vector3;
	/**
	 * What the spell is aimed at: the centre of the target painted on the training
	 * dummy, on its surface, worked out from the decal's own mapping at load.
	 */
	target: Vector3;
	/**
	 * The middle of the dummy's *body*, and the radius that encloses it — measured
	 * from its own vertices at load rather than written down here.
	 *
	 * `target` is a point on the surface, which is what you aim at; this is what
	 * you would have to put a box around, which is what the ward needs. The two are
	 * 47 cm apart.
	 */
	body: Vector3;
	bodyRadius: number;
	/** Size, roundness and position of the sigil, for spells that read the line. */
	shape: SigilShape;
	effects: SpellEffects;
	/**
	 * Knocks the camera: where it landed, and metres of displacement at the source.
	 *
	 * Here rather than on `SpellEffects` because it is something a spell *does*,
	 * not something the room owns — and only for the spells that land at the
	 * moment they are cast. The fireball has to wait for its shot to arrive, so it
	 * shakes from its own `onImpact` instead.
	 */
	shake( at: Vector3, energy: number ): void;
}

export interface Spell {
	id: string;
	/** Glyph name from `recognize/glyphs.ts`. */
	glyph: string;
	title: string;
	/** Compact label for the HUD grimoire, where space is tight. */
	short: string;
	/** Colour the ink glows while the page is reading this sigil. */
	ink: number;
	hint: string;
	/** Optionally returns a line for the HUD in place of the usual certainty read-out. */
	cast( context: CastContext ): string | void;
}

/**
 * Glyph → spell bindings. Every glyph the recognizer knows is legible; only the
 * bound ones actually do anything, which is what makes a near-miss feel like a
 * misdrawn sigil rather than a broken program.
 */
export const SPELLS: Spell[] = [
	{
		id: 'fireball',
		glyph: 'pentagram',
		title: 'Fireball',
		short: 'Fireball',
		ink: 0xffa24a,
		hint: 'five-point star, one stroke',
		cast( { origin, target, effects } ) {

			// Ignites a hand's breadth above the parchment, then arcs downrange.
			effects.fireball.cast( origin.clone().setY( origin.y + 0.07 ), target );

		},
	},
	{
		id: 'lightning',
		glyph: 'bolt',
		title: 'Lightning',
		short: 'Lightning',
		ink: 0x8fc4ff,
		hint: 'a Z, one stroke',
		cast( { origin, target, effects, shake } ) {

			// No wind-up: the arc is already there when the page finishes burning.
			const from = origin.clone().setY( origin.y + 0.05 );

			// A ward standing over the target eats the bolt at its surface.
			const aim = effects.ward.deflect( from, target ) ?? target;

			effects.lightning.strike( from, aim );
			effects.flash.pulse( 0xcfe2ff, 0.22 );

			// A bolt is instantaneous, so the jolt belongs here with the strike. Sharp
			// and small next to the fireball's: this is a crack, not a detonation.
			shake( aim, LIGHTNING_SHAKE );

			// The bolt is instantaneous, so there is no impact to wait for the way
			// there is with the fireball. `aim` is the ward's shell when one deflected
			// it, and the recoil measures the distance itself rather than being told.
			effects.recoil.hit( aim, LIGHTNING_JOLT );

		},
	},
	{
		id: 'rune',
		glyph: 'triangle',

		// Named for the thing it wakes, like the other three, but *not* for the
		// shape of it: "The Circle" sat in the grimoire under a triangle and one
		// row along from the ward, which is the spell you really do draw a circle
		// for. The rest of the code has called this the rune all along.
		title: 'Awaken the Rune',
		short: 'The Rune',
		ink: 0xb98cff,
		hint: 'a triangle, one stroke',
		cast( { target, effects, shake } ) {

			// Aimed at nothing: this one wakes the sigil already cut into the floor.
			effects.rune.awaken();
			effects.flash.pulse( 0x8a5cff, 0.12 );

			// …but the room does not get to ignore it. Six metres of carving spinning
			// up in the flagstones is the only spell here that moves the *floor*, and
			// the dummy is standing on it: `RUNE_JOLT` is a slow sway rather than a
			// flinch, and it is still going while the pillars come up.
			//
			// `target` only to get inside `Recoil`'s reach — the dummy is what is
			// standing on the floor, not what was aimed at. Nothing is aimed at here.
			effects.recoil.hit( target, RUNE_JOLT );

			// And the seat is on the same floor. Gentle: this is the ground stirring,
			// not something landing on the desk.
			shake( target, RUNE_SHAKE );

		},
	},
	{
		id: 'ward',
		glyph: 'circle',
		title: 'Sigil of Protection',
		short: 'Ward',
		ink: 0x8fe4ff,
		hint: 'a ring — draw it round, and draw it where you want it',
		cast( { shape, body, bodyRadius, effects, shake } ) {

			// **On the dummy, not where the ring was drawn.**
			//
			// The page used to be a map of the room: a page width was 5 m of floor and
			// the shell stood wherever on it you put the ring. That worked while this
			// was a 2.35 m dome, because a dome that size swallows a placement error
			// and still covers what it was cast for.
			//
			// A cage cannot. It is 1.25 m around a body 1.14 m across, so its whole
			// margin is a hand's width — and a ring drawn a fifth of a page off centre
			// is a metre of floor, which puts the straw outside the shell entirely. A
			// ward that misses is not a smaller ward, it is a failed one, and the same
			// argument that set the size settles the placement: it goes on the body,
			// measured from the dummy's own vertices at load.
			//
			// What that costs is the one spell that read *where* on the page you drew,
			// and it is a real loss. It is only worth paying because the thing it was
			// spending — where the shell stands — is now the thing that decides
			// whether the shell works at all. `shape.radius` and `shape.roundness`
			// still read the line; the ward is not down to naming a glyph.
			const centre = body.clone();

			// Bigger ring, bigger cage — but never smaller than the thing it is for,
			// and what it is for is now the *body* rather than the room.
			//
			// The old dome was a hemisphere standing on the flagstones, so its radius
			// had to reach the dummy's farthest vertex from the floor's centre — the
			// top of its head, 2.192 m away, measured across 3,199 vertices rather
			// than off a bounding box, since the box's far corner sits at 2.37 and
			// holds no geometry at all. That is why the smallest ward that actually
			// warded was 2.35 m and swallowed the room.
			//
			// Measured from the body's own middle instead, the same dummy fits inside
			// **1.139 m**. The clearance and the range are both in those terms, so
			// this stays correct if the dummy is ever replaced: a badly drawn ring
			// gives a cage that clears the straw by a hand's width, a well drawn one
			// gives it half a metre of room, and neither is a dome.
			const radius = MathUtils.mapLinear(
				MathUtils.clamp( shape.radius, 0.1, 0.4 ), 0.1, 0.4,
				bodyRadius + CAGE_CLEARANCE, bodyRadius + CAGE_CLEARANCE + CAGE_RANGE,
			);

			// …and a rounder one used to hold longer. It no longer does: the ward now
			// runs for exactly the length of its sound, so this figure survives only
			// as the fallback `raise` uses if that sample has not decoded yet. The
			// band was narrow because the measure is — a neatly drawn ring comes out
			// around 96%, a visibly lumpy one still manages 90%.
			const fallback = MathUtils.lerp( 3.5, 11, MathUtils.smoothstep( shape.roundness, 0.86, 0.96 ) );

			// Reported rather than assumed: `raise` is the only thing that knows how
			// long the dome will actually stand, and it is not this number.
			const held = effects.ward.raise( centre, radius, fallback );

			effects.flash.pulse( 0x9fe4ff, 0.1 );

			// Softer than the offensive spells, and on purpose: a dome coming up is a
			// push rather than a hit.
			shake( centre, WARD_SHAKE );

			return `${ radius.toFixed( 1 ) } m · ${ held.toFixed( 1 ) } s · ${ Math.round( shape.roundness * 100 ) }% round`;

		},
	},
];

/**
 * Camera displacement at the source, in metres, for the spells that land the
 * instant they are cast. The rig applies the distance falloff itself.
 */
const LIGHTNING_SHAKE = 0.055;
const WARD_SHAKE = 0.022;
const RUNE_SHAKE = 0.03;

/**
 * How much room the cage leaves around the body it closes on, at the smallest
 * ring the recogniser will accept, and how much more the largest ring buys.
 *
 * Both are relative to the body's own enclosing radius, which is measured at load,
 * so neither is a number about *this* dummy. 11 cm is a hand's width of clearance
 * — enough that the shell reads as being around the straw rather than painted on
 * it — and 45 cm more at the top of the range is the difference between a cage
 * that fits and one you could walk into, which is as much expressive range as a
 * shape drawn on a page can honestly carry.
 */
const CAGE_CLEARANCE = 0.11;
const CAGE_RANGE = 0.45;

export function spellForGlyph( glyph: string | null ): Spell | undefined {

	if ( glyph === null ) return undefined;

	return SPELLS.find( ( spell ) => spell.glyph === glyph );

}
