import { Color, DirectionalLight, LinearSRGBColorSpace, Object3D, PointLight, Vector3 } from 'three/webgpu';

/**
 * The atelier's lighting, ported straight out of the source .blend rather than
 * invented. The GLB carries no lights at all — it has no `KHR_lights_punctual`
 * — so the room arrived flat and every light here was originally a guess. These
 * are the real ones: 26 lamps, read out of the Blender scene over MCP, with
 * their authored positions, linear colours and relative powers intact.
 *
 * Blender is Z-up, so positions and directions are converted the same way the
 * glTF exporter converts the meshes: three = ( bx, bz, -by ).
 */
export interface RigLight {
	name: string;
	kind: 'point' | 'sun' | 'area';
	/** Already converted to three's Y-up space. */
	position: [ number, number, number ];
	/** Linear RGB, exactly as Blender stores it. */
	colour: [ number, number, number ];
	/** Blender power: watts for lamps, W/m² for the sun. Relative values matter. */
	energy: number;
	radius?: number;
	direction?: [ number, number, number ];
	size?: [ number, number ];
	/**
	 * A deliberate departure from the authored energy, applied on top of the class
	 * scale. Kept separate from `energy` so the number Blender holds stays visible
	 * and the disagreement stays legible; any light carrying one should say why.
	 */
	trim?: number;
}

export const RIG: RigLight[] = [
	{ name: "FlameLight_candle", kind: "point", position: [ 0.629, 1.204, 2.419 ], colour: [ 1, 0.55, 0.15 ], energy: 3.5, radius: 0.03 },
	{ name: "FlameLight_candle.001", kind: "point", position: [ 0.811, 1.057, 2.498 ], colour: [ 1, 0.55, 0.15 ], energy: 3.5, radius: 0.03 },
	{ name: "FlameLight_candle.002", kind: "point", position: [ 1.91, 2.251, -3.334 ], colour: [ 1, 0.55, 0.15 ], energy: 3.5, radius: 0.03 },
	{ name: "FlameLight_candle.003", kind: "point", position: [ 0.723, 1.348, 2.507 ], colour: [ 1, 0.55, 0.15 ], energy: 3.5, radius: 0.03 },
	{ name: "FlameLight_candle.004", kind: "point", position: [ -3.379, 0.331, -0.143 ], colour: [ 1, 0.55, 0.15 ], energy: 3.5, radius: 0.03 },
	{ name: "FlameLight_candle.005", kind: "point", position: [ -1.192, 2.545, -3.644 ], colour: [ 1, 0.55, 0.15 ], energy: 3.5, radius: 0.03 },
	{ name: "FlameLight_candle.006", kind: "point", position: [ -1.279, 2.408, -3.606 ], colour: [ 1, 0.55, 0.15 ], energy: 3.5, radius: 0.03 },
	{ name: "GreenAccent_Shelf", kind: "point", position: [ -3.4, 1.6, -0.3 ], colour: [ 0.25, 1, 0.5 ], energy: 6, radius: 0.3 },
	// Trimmed to three tenths, and unlike `BOUNCE` or `ENCLOSURE` this one is not a
	// correction — the fill arrives exactly as authored. It is a look decision.
	//
	// It is a six-metre soft source hung over the middle of the room pointing down,
	// which makes it by some way the largest thing lighting the walls, and a broad
	// source at that distance falls off across the room barely at all. So it held
	// every brick at much the same value and the room read as evenly lit rather than
	// as lit by the lamps standing in it. At 0.3 the shelf lamp, the orbs and the
	// wall wash read as pools again. Below about 0.15 the returns stop and the
	// violet cast the .blend gets from this light starts going with it.
	{ name: "light_area_warmFill", kind: "area", position: [ 0, 2.6, 0 ], colour: [ 0.75, 0.55, 0.85 ], energy: 140, direction: [ 0, -1, 0 ], size: [ 6, 0.25 ], trim: 0.3 },
	{ name: "light_point_cauldronGlow", kind: "point", position: [ -0.84, 1.4, 2.914 ], colour: [ 0.55, 0.32, 1 ], energy: 12, radius: 0.09 },
	{ name: "light_sun_key", kind: "sun", position: [ 0, 0, 0 ], colour: [ 0.55, 0.45, 0.95 ], energy: 1.4, direction: [ 0.383, -0.643, -0.663 ] },
	{ name: "MagicCircleGlow", kind: "point", position: [ 0, 0.15, 0 ], colour: [ 0.95, 0.78, 0.4 ], energy: 2.5, radius: 2 },
	{ name: "MushroomLight_04", kind: "point", position: [ 3.712, 0.225, -0.238 ], colour: [ 0.3, 1, 0.55 ], energy: 2, radius: 0.08 },
	{ name: "MushroomLight_06", kind: "point", position: [ -3.632, 0.136, -0.215 ], colour: [ 0.3, 1, 0.55 ], energy: 2, radius: 0.08 },
	{ name: "MushroomLight_Group_05", kind: "point", position: [ -3.54, 0.306, -0.579 ], colour: [ 0.3, 1, 0.55 ], energy: 4, radius: 0.18 },
	{ name: "MushroomLight_Group_05b", kind: "point", position: [ 3.566, 0.306, 0.091 ], colour: [ 0.3, 1, 0.55 ], energy: 4, radius: 0.18 },
	{ name: "PotionGlow_Bottle", kind: "point", position: [ -0.676, 0.89, 2.451 ], colour: [ 0.1, 0.9, 0.8 ], energy: 1.2, radius: 0.02 },
	// Recoloured with the bottle it belongs to. This is the lamp the .blend put
	// inside `Bottle010`, and it stayed violet after the draught went amber — so the
	// bottle glowed gold and cast purple on the desk under it, which reads as two
	// different objects occupying one space.
	{ name: "PotionGlow_Bottle010", kind: "point", position: [ -0.553, 0.923, 2.433 ], colour: [ 1, 0.66, 0.24 ], energy: 1.6, radius: 0.02 },
	{ name: "PurpleWash_Wall", kind: "area", position: [ 0, 2, -3.2 ], colour: [ 0.55, 0.2, 0.95 ], energy: 60, direction: [ 0, 0, -1 ], size: [ 2.5, 0.25 ] },
	{ name: "SpookyOrbLight_0", kind: "point", position: [ -1.5, 2.4, -1.2 ], colour: [ 0.55, 0.15, 0.95 ], energy: 2, radius: 0.11 },
	{ name: "SpookyOrbLight_1", kind: "point", position: [ -0.5, 2.65, -1.05 ], colour: [ 0.55, 0.15, 0.95 ], energy: 1, radius: 0.06 },
	{ name: "SpookyOrbLight_2", kind: "point", position: [ 0.8, 2.5, -1.3 ], colour: [ 0.3, 1, 0.5 ], energy: 1, radius: 0.056 },
	{ name: "SpookyOrbLight_3", kind: "point", position: [ 1.6, 2.05, -0.75 ], colour: [ 0.3, 1, 0.5 ], energy: 2, radius: 0.1 },
	{ name: "SpookyOrbLight_4", kind: "point", position: [ 2.7, 1.85, 0.6 ], colour: [ 0.3, 1, 0.5 ], energy: 1, radius: 0.064 },
	{ name: "SpookyOrbLight_5", kind: "point", position: [ -2.8, 1.95, -0.35 ], colour: [ 0.55, 0.15, 0.95 ], energy: 1, radius: 0.07 },
	{ name: "SpookyOrbLight_6", kind: "point", position: [ 0.15, 2.75, 0.7 ], colour: [ 0.55, 0.15, 0.95 ], energy: 1, radius: 0.05 },
];

/**
 * Light Cycles computes and this renderer cannot.
 *
 * Everything in `RIG` is authored; nothing here is. These stand in for the second
 * bounce, and the training dummy is the object that proves they are needed: it
 * stands in the middle of the floor, metres from anything, and every authored
 * lamp that reaches it is above it or in front of it. So it came out evenly lit
 * from the front with no edge against the wall behind — a flat grey shape pasted
 * onto a moody room.
 *
 * The light that should separate it is in the .blend and does not arrive.
 * `PurpleWash_Wall` is a cool blue-violet area light sitting *behind* the dummy at
 * z -3.2, aimed `[0,0,-1]` — straight into the back wall. Cycles bounces it off
 * the stone and back onto the dummy's shoulders; here it points away from the
 * subject into a wall further off than SSGI's two-metre radius, so every watt of
 * it lands on the wall and none of it returns. Same story underneath: the candles
 * and the cauldron pour warm light onto the desk and floor, and in Cycles that
 * floor throws it back up. Three's screen-space GI cannot carry it the three
 * metres from the desk to the dummy.
 *
 * The desk does the same thing to the floor. It is a slab of warm red-brown wood
 * filling the bottom of the frame and the sigil beyond it is cool grey-violet, so
 * with nothing carrying the wood's colour onto the boards the two met on a hard
 * tonal line and read as separate pictures.
 *
 * Hence three lights that are not lights so much as answers: the wall's return,
 * the floor's, and the desk's. All are dim, all are wide, and all are named
 * `bounce_` so the next person can tell at a glance which of these came out of
 * Blender and which did not.
 */
export const BOUNCE: RigLight[] = [
	// Close to the dummy on purpose, and this is the whole trick to it. Sat back at
	// z -2.25 it was 1.8 m from the dummy and 2.2 m from the wall behind — near
	// enough the same distance, so at energy 210 it lit the wall about as hard as
	// the thing it was meant to rim, and put back exactly the flat even wash the
	// point lamps' tight falloff had just removed. Pulled in to 0.7 m from the
	// dummy and 3.3 m from the wall, the inverse square does the containing for
	// free: twenty-odd times as much light on the shoulders as on the stone, at a
	// sixth of the energy for the same rim.
	{ name: "bounce_wallRim", kind: "area", position: [ 0, 2.15, - 1.15 ], colour: [ 0.45, 0.22, 1 ], energy: 34, direction: [ 0, 0, 1 ], size: [ 1.8, 0.25 ] },
	// Sat at z 1.25 first, which is nearer the desk than the target it exists for —
	// so it warmed the parchment hardest and the dummy least, which is the bounce
	// running backwards. Pulled in to where the floor in front of the dummy is.
	//
	// A strip rather than a point, and not only to spread it along the floor: light
	// coming back off a floor is a broad source by nature, so it belongs on the
	// wash bound rather than being given a candle's tight pool.
	{ name: "bounce_deskWarm", kind: "area", position: [ 0, 0.5, 0.5 ], colour: [ 1, 0.6, 0.26 ], energy: 28, direction: [ 0, 1, 0 ], size: [ 1.8, 0.25 ] },

	// The desk's own return, onto the floor just past its far edge.
	//
	// The desk is a big slab of warm red-brown wood filling the bottom of the
	// frame, and the floor sigil beyond it is cool grey-violet, so the two met on a
	// hard tonal line with nothing in between — foreground and floor read as
	// separate pictures. In Cycles the wood throws its colour onto the boards in
	// front of it and that is the join; here the desk's far edge is at z 2.14 and
	// the ring runs out to 3.3, and nothing carries light across the gap.
	//
	// Sat past the desk rather than over it, aimed down, and deliberately dim: the
	// point is a warm cast along the ring's near arc, not a second light source.
	// The wash bound gives it about 1.3 m of reach, which keeps it on the near
	// boards and off the far wall.
	// Swept live against the seated framing: at nine the warm cast was there but
	// barely; at twenty-five it stops reading as a bounce and starts reading as a
	// second lamp pointed at the floor, with the ring's outer band lifting on its
	// own. Fifteen is where it ties the two without being noticed as a source.
	{ name: "bounce_deskSpill", kind: "area", position: [ 0, 0.45, 1.85 ], colour: [ 1, 0.45, 0.22 ], energy: 15, direction: [ 0, - 1, 0 ], size: [ 3.2, 0.25 ] },

	// A warm key on the potion cluster alone, and it exists to win an argument
	// about *value*, not about colour.
	//
	// Everything reaching that corner of the desk is the room's cool violet — the
	// area fill, the wall wash, the sun. A warm object under a cool ambient does not
	// stay warm: it converges on the same purple-grey value as the wall behind it,
	// and the bottles separate only by hue, which is the weakest cue there is at
	// that size. This sits 0.24 m in front of the two of them, so the inverse square
	// does the containing: it lifts the glass off the wall behind and reaches the
	// parchment barely at all.
	//
	// Small, and it has to stay small. Past about 6 it starts warming the desk top
	// and the sheet, and the page going warm is the one thing the room cannot have —
	// the ink is read against it.
	{ name: "bounce_potionKey", kind: "point", position: [ - 0.60, 1.14, 2.69 ], colour: [ 1, 0.74, 0.42 ], energy: 4, radius: 0.05 },

	// The lower shelf board, which until now had no light on it at all.
	//
	// It did not need one while the bottles there were lit from inside: the smoke
	// ran at `brightness` 1.5, deliberately over one, and *was* the board's light
	// source — it lit the clay jars above it through SSGI as well. Those three are
	// real transmissive glass now (see `referenceGlass`), and transmissive glass is
	// not a light. It is a lens, and a lens with nothing shining on it is a dark
	// shape. This is what it refracts.
	//
	// The energy is doing two jobs at once and cannot be read as brightness alone.
	// `range()` derives reach from intensity, so turning this up also pushes it
	// further back — and behind these bottles is the cabinet's rear panel, half a
	// metre away. Swept live at the seated framing: 5.6 (reach 1.7 m) and 3.1
	// (1.3 m) both flood that panel and the whole shelf goes orange, which reads as
	// a lamp hidden in the cupboard. 1.9 lands the reach at 1.0 m, just past the
	// bottles, so they catch it and the panel behind stays dark. That contrast is
	// the effect — the glass reads because it is bright against something that is
	// not.
	//
	// The colour is linear, like every other entry here — `linear()` builds it with
	// `LinearSRGBColorSpace` and no conversion happens. This is the sweep's warm
	// candle tone (sRGB #ffb877) converted, not the sRGB triple pasted in: dropped
	// in raw it is a far paler, brighter lamp, and the bottles came out milky.
	{ name: "light_shelfLower", kind: "point", position: [ - 2.68, 1.00, - 1.60 ], colour: [ 1, 0.479, 0.184 ], energy: 1.9, radius: 0.04 },

	// The upper board, for the same reason and on the same terms. Its two bottles
	// lost their smoke as well, so it lost its light with them.
	//
	// The placement is the lower lamp's offsets carried up rather than a second
	// guess: those bottles span y 1.78..1.96 against the lower board's 0.74..1.01,
	// so the lamp sits the same 0.13 above their middle and the same ~0.35 out in
	// front of them. Same energy, for the same reason — the rear panel is no
	// further away up here than it is down there.
	{ name: "light_shelfUpper", kind: "point", position: [ - 2.68, 2.00, - 1.68 ], colour: [ 1, 0.479, 0.184 ], energy: 1.9, radius: 0.04 },
];

/**
 * Blender's watts do not map onto three's candela through any constant that also
 * preserves the *look*, because the two renderers tone-map differently — Cycles
 * is on AgX here. So the authored ratios are kept exactly and a single scale per
 * light class is tuned by eye against the reference render. One dial, not 26.
 */
const POINT_SCALE = 0.08;
const SUN_SCALE = 0.1;

/**
 * Area lamps are rebuilt as a row of points. `RectAreaLight` is exported by
 * three/webgpu but does not survive this renderer's node lighting path — adding
 * one turns *every* surface in the room black, which took a while to pin on the
 * light rather than on the exposure. A strip of points keeps the authored
 * position, colour and total power, and behaves.
 */
const AREA_SEGMENTS = 5;

/**
 * Area lamps need their own scale. Blender spreads their power over a surface
 * emitting into a hemisphere; a point light of the same wattage throws it in
 * every direction from nothing, and at this rig's scale the 140 W ceiling strip
 * alone was putting more light on the floor than every candle in the room.
 */
const AREA_SCALE = 0.02;

/**
 * Blender lamps have a physical radius; three's point lights are infinitesimal.
 * Below this it makes no visible difference, but `MagicCircleGlow` is a two-metre
 * sphere lying on the floor, and as a true point it becomes a searing hotspot at
 * the centre of the room instead of a soft wash across the whole circle. Anything
 * this big is spread into a ring.
 */
const SOFT_RADIUS = 0.5;
const SOFT_SEGMENTS = 7;

/**
 * Illuminance at which a lamp stops being worth evaluating, and therefore where
 * three's falloff window closes. Blender lamps fall off forever; clustered
 * shading has to bound them, because with `distance = 0` the clusterer cannot
 * decide which cells a light reaches and the room fills with rectangular patches
 * of missing light.
 *
 * There are two of these because a bound placed for the clusterer and a bound
 * placed for the look are not the same number.
 *
 * `POINT` is tight, and it is a *look* decision. A candle is a small hot source
 * and should burn a contained pool into the wall it stands against; at 0.02 its
 * window did not close until 3.7 m, by which point seven candles, four mushrooms
 * and seven orbs overlapped into one even wash and the wall between them never
 * got dark. Pulling it in to 0.15 puts a candle's reach at about 1.4 m. The core
 * of the pool is untouched — three's window is `(1-(d/cutoff)^4)^2`, which is
 * 0.97 at a third of the way out — so this costs no brightness where the light
 * actually is and takes almost all of it away by the edge: at 1 m a candle now
 * gives half what it did, and at 1.2 m a sixth.
 *
 * `WASH` stays where it was, and is still only the clusterer's bound. The strips
 * are broad soft sources whose whole job is to cover evenly; giving them a pool's
 * falloff would just be wrong about what they are.
 */
const CUTOFF_POINT = 0.15;
const CUTOFF_WASH = 0.02;

/**
 * Floor on the range. Low enough now that the dimmest orbs and potions can have
 * the small reach their brightness implies rather than being held open to 1.5 m.
 */
const MIN_RANGE = 0.7;
const MAX_RANGE = 9;

function range( intensity: number, cutoff: number ): number {

	return Math.min( MAX_RANGE, Math.max( MIN_RANGE, Math.sqrt( intensity / cutoff ) ) );

}

/** The world background: a very dark violet, which is the room's only ambient. */
export const WORLD_AMBIENT: [ number, number, number ] = [ 0.018, 0.008, 0.035 ];
export const WORLD_STRENGTH = 1.1;

const linear = ( c: [ number, number, number ] ): Color =>
	new Color().setRGB( c[ 0 ], c[ 1 ], c[ 2 ], LinearSRGBColorSpace );

/** Builds the rig into a parent object, ready to add to the scene. */
export function buildRig( shadowCaster = 'light_sun_key' ): Object3D {

	const group = new Object3D();
	group.name = 'BlenderLightRig';

	for ( const light of [ ...RIG, ...BOUNCE ] ) {

		if ( light.kind === 'point' ) {

			const radius = light.radius ?? 0;
			const count = radius > SOFT_RADIUS ? SOFT_SEGMENTS : 1;

			for ( let i = 0; i < count; i ++ ) {

				const strength = light.energy / count * POINT_SCALE * ( light.trim ?? 1 );
				const lamp = new PointLight( linear( light.colour ), strength, range( strength, CUTOFF_POINT ), 2 );

				lamp.position.set( ...light.position );

				if ( count > 1 ) {

					const angle = ( i / count ) * Math.PI * 2;
					lamp.position.x += Math.cos( angle ) * radius * 0.7;
					lamp.position.z += Math.sin( angle ) * radius * 0.7;

				}

				lamp.name = count > 1 ? `${ light.name }_${ i }` : light.name;
				group.add( lamp );

			}

		} else if ( light.kind === 'sun' ) {

			const sun = new DirectionalLight( linear( light.colour ), light.energy * SUN_SCALE * ( light.trim ?? 1 ) );
			const direction = new Vector3( ...( light.direction ?? [ 0, - 1, 0 ] ) );

			// Directional lights are aimed by where they sit relative to their target.
			sun.position.copy( direction ).multiplyScalar( - 8 );
			sun.name = light.name;

			if ( light.name === shadowCaster ) {

				// The only shadow caster in the room. Twenty-six cube maps is not a
				// trade worth making; SSGI's ambient occlusion carries the contacts.
				sun.castShadow = true;
				sun.shadow.mapSize.set( 2048, 2048 );
				sun.shadow.bias = - 0.0015;
				sun.shadow.camera.near = 0.5;
				sun.shadow.camera.far = 24;
				sun.shadow.camera.left = - 6;
				sun.shadow.camera.right = 6;
				sun.shadow.camera.top = 6;
				sun.shadow.camera.bottom = - 6;

			}

			group.add( sun, sun.target );

		} else {

			const [ width ] = light.size ?? [ 1, 1 ];
			const direction = new Vector3( ...( light.direction ?? [ 0, - 1, 0 ] ) );
			const share = light.energy / AREA_SEGMENTS * AREA_SCALE * ( light.trim ?? 1 );

			// Both strips in this scene run along world X, so that is the axis the
			// segments spread along. Each sits a little way along the lamp's aim, so
			// a wall wash still favours the wall rather than spilling equally both
			// ways the way a bare point would.
			for ( let i = 0; i < AREA_SEGMENTS; i ++ ) {

				const offset = ( i / ( AREA_SEGMENTS - 1 ) - 0.5 ) * width;
				const segment = new PointLight( linear( light.colour ), share, range( share, CUTOFF_WASH ), 2 );

				segment.position.set( ...light.position );
				segment.position.x += offset;
				segment.position.addScaledVector( direction, 0.35 );
				segment.name = `${ light.name }_${ i }`;

				group.add( segment );

			}

		}

	}

	return group;

}
