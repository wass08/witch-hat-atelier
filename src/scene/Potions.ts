import { Color, DoubleSide, FrontSide, Mesh, MeshPhysicalNodeMaterial, type Object3D } from 'three/webgpu';
import { buildGlass, vapourOf } from './GlassMaterial';
import type { MeshStandardNodeMaterial } from 'three/webgpu';

/**
 * The left shelf's bottles, filled with smoke.
 *
 * They arrived as unlit glass three metres out in a room lit entirely by small
 * contained pools, readable only as silhouettes. The first attempt gave them an
 * `emissive` so they could be seen at all, which worked and was the wrong answer:
 * a lit solid has no interior, and these are bottles.
 *
 * Glass with something slowly turning inside it solves both problems at once. The
 * smoke is what makes them visible — it is brighter than the dark behind them and
 * it moves, which the eye finds on its own — and it is also the reason they read
 * as vessels rather than as coloured shapes. See `GlassMaterial.ts` for the march.
 *
 * The colours are kept muted and close together on purpose. These are three
 * metres away behind the desk potions; a shelf of saturated smokes would compete
 * with the two hero bottles and with the sigil, which is the fault the original
 * glow had.
 */
interface ShelfBottle {
	mesh: string;
	/** The draught. The vapour above it is derived from this, never picked. */
	liquid: number;
	/** Local Y of the liquid surface, and of the top of the airspace above it. */
	fill: number;
	ceiling: number;
	/** Local radius, for the containment falloff. */
	radius: number;
	/** How hard the draught burns from within. */
	glow: number;
	/** Noise frequency. Scaled per bottle so the billows stay in proportion. */
	scale: number;
	depth: number;
	/**
	 * Whether anything turns in the headspace above the liquid — and, with it,
	 * which of two entirely different materials the bottle gets.
	 *
	 * On is `buildGlass`: screen-space refraction off `viewportSharedTexture`, with
	 * the volumetric march running in the airspace. Off is `referenceGlass()` — real
	 * `transmission`, matched to the round green bottle on the desk. See there for
	 * why the two are not interchangeable.
	 *
	 * **Every bottle on this shelf is now `false`**, so the smoke branch below is
	 * currently unreachable. It is kept rather than deleted because it is one flag
	 * per bottle away and the tuning behind it took a while to find; the march
	 * itself is still live and exercised by the desk pair in `glassPotions`, so
	 * this is not untested code, only unused code.
	 *
	 * `fill`, `ceiling`, `radius`, `scale` and `depth` only feed that branch and
	 * are likewise dormant. They are measured off each mesh and are the expensive
	 * part to reconstruct, which is the other reason none of this was cut.
	 *
	 * The smoke was doing two jobs on this shelf: it was the effect, and it was
	 * most of the light. Drop it and the light has to be replaced or the bottles
	 * simply go dark — hence `light_shelfUpper` and `light_shelfLower`.
	 */
	wisps: boolean;
}

/**
 * The shelf, deliberately drained of colour.
 *
 * It was green, blue, purple and pink: five saturated hues three metres behind
 * the two bottles that are supposed to carry the frame, which is four too many.
 * Smoky brown, pale sage and near-clear now, with a single teal at `Bottle006` as
 * an echo of the hero and nothing else competing. The shelf's job is to be a lit
 * surface with things on it, not a second focal point.
 *
 * `fill` and `ceiling` are read off each mesh's own bounding box — the bottles run
 * roughly -0.095 to 0.173 in local Y and every one is different, so a shared
 * fraction would put the liquid line in a different place on each.
 */
const LEFT_SHELF: ShelfBottle[] = [
	// Upper board. `Bottle004` runs a little hotter only because its hue is the
	// darkest of the five and needs it to stay visible at all.
	{ mesh: 'Bottle004', liquid: 0x6b5a4a, fill: - 0.010, ceiling: 0.088, radius: 0.047, glow: 0.16, scale: 20, depth: 0.10, wisps: false },
	{ mesh: 'Bottle005', liquid: 0x8a8f76, fill: - 0.018, ceiling: 0.110, radius: 0.063, glow: 0.13, scale: 17, depth: 0.13, wisps: false },

	// Lower board. `Bottle006` is the one saturated hue the shelf is allowed, and
	// it echoes the desk's amber hero rather than its teal one.
	//
	// Its value is picked, not its hue — and that ordering is the whole lesson from
	// two passes at this bottle. A hero tint dropped in raw reads as opaque plastic
	// among four pieces of glass, because a transmissive body needs a *dark*
	// interior for its highlight to sit against; both `HERO_TEAL` (0x2fd9c4, luma
	// 174) and `HERO_AMBER` (0xe8a93c, luma 175) sit far brighter than anything
	// beside them, so the lamp lands on a pale surface and there is nothing to read
	// through. Cutting the emissive barely moved it, which is what proved the tint
	// was doing it. 0xa06a1c is amber at luma 112, against `Bottle007`'s 113.
	{ mesh: 'Bottle006', liquid: 0xa06a1c, fill: - 0.006, ceiling: 0.080, radius: 0.043, glow: 0.13, scale: 23, depth: 0.09, wisps: false },
	{ mesh: 'Bottle007', liquid: 0x7d6f60, fill: - 0.024, ceiling: 0.122, radius: 0.071, glow: 0.13, scale: 16, depth: 0.14, wisps: false },
	{ mesh: 'Bottle008', liquid: 0x9aa088, fill: - 0.038, ceiling: 0.162, radius: 0.071, glow: 0.12, scale: 15, depth: 0.15, wisps: false },
];

/**
 * The glass the room already had, and the one it looks best in.
 *
 * Measured straight off `Bottle001` — the round green bottle sitting on the desk,
 * which is the only vessel in the scene we never re-authored. It is the untouched
 * glTF material, `Purple Potion`, and every number below was read out of the live
 * scene rather than picked: transmission 1, opacity 0.359, specular 1, IOR 1.45,
 * roughness 0.3, double-sided.
 *
 * Why this rather than `buildGlass`, which is more code and does more work: they
 * are solving different problems and only one of them is *glass*. `buildGlass`
 * fakes refraction by offsetting a lookup into the already-rendered frame, which
 * is what lets it carry a volumetric march and a tinted draught with a real fill
 * line — all of which the smoked bottles need. But a screen-space bend samples the
 * frame *behind* the bottle, so it cannot show the bottle's own far wall, and the
 * broad soft highlight that reads as thick glass has to be approximated with a
 * Fresnel rim. `transmission` runs an actual pass and gets both for free.
 *
 * It is also very nearly free here. Three bottles already use it — `Bottle001`,
 * `Bottle002`, `Bottle003` and `Bottle009` are all transmissive — so the
 * transmission pass is running whether or not these three join it, and what they
 * add is three more draws into a target that already exists.
 *
 * The cost is what `buildGlass` was bought for: no fill line, no draught tint,
 * nothing turning inside. That is the correct trade for a bottle with no smoke in
 * it and the wrong one for a bottle with smoke in it, which is why both survive.
 */
const REFERENCE = {
	roughness: 0.3,
	ior: 1.45,
	transmission: 1,
	opacity: 0.3593,
	specularIntensity: 1,

	// The one that actually decides whether this reads as glass, and the only
	// value here that is not a `MeshPhysicalNodeMaterial` default.
	//
	// Every other number was already right and the bottles still came out as flat
	// milky shapes. With `depthWrite` on, the front shell writes depth and then
	// occludes the back shell — so a double-sided bottle loses the far wall that
	// being double-sided was for, and what is left is one lit surface. Off, both
	// walls blend and the body has an inside. Diffing this material against the
	// reference one property at a time is what found it; nothing about the render
	// suggested depth was involved.
	depthWrite: false,
} as const;

function referenceGlass( tint: number, glow: number ): MeshPhysicalNodeMaterial {

	const material = new MeshPhysicalNodeMaterial();

	material.color = new Color( tint );
	material.metalness = 0;
	material.transparent = true;

	// Both walls. On a single-shell bottle this is the whole effect: the front
	// face refracts towards the back one, and without it the body is a hollow
	// shape with the room showing through where its own far wall should be.
	material.side = DoubleSide;

	Object.assign( material, REFERENCE );

	// A draught that burns very slightly from within — and it has to stay very
	// slight. The reference bottle has no emissive at all and does not need one,
	// because it sits on a lit desk against a bright rune floor. This shelf has
	// neither, so without *some* internal light these read as three dark blobs.
	//
	// Swept live: at 0.4 and up the body fills in evenly and the bottle turns to
	// frosted plastic — the reference look depends on a dark interior with one
	// bright highlight across it, and an emissive is exactly the thing that
	// destroys that contrast. Everything here is under 0.2. The lamp does the
	// seeing; this only keeps the hue from washing to grey.
	material.emissive = new Color( tint );
	material.emissiveIntensity = glow;

	return material;

}

/** Re-authors the left shelf's bottles as glass. Returns how many were found. */
export function shelfBottles( root: Object3D ): number {

	const wanted = new Map( LEFT_SHELF.map( ( bottle ) => [ bottle.mesh, bottle ] ) );

	let filled = 0;

	root.traverse( ( object ) => {

		const recipe = wanted.get( object.name );

		if ( recipe === undefined || ! ( object instanceof Mesh ) ) return;

		if ( ! recipe.wisps ) {

			object.material = referenceGlass( recipe.liquid, recipe.glow );
			filled ++;
			return;

		}

		object.material = buildGlass( {
			tint: recipe.liquid,
			density: 0.4,
			fill: recipe.fill,
			fillGlow: recipe.glow,

			// Gentle. At three metres a hard chromatic fringe is noise, not glass —
			// and at 1.1 it was the fringe that split the floor rune into coloured
			// threads through the body of every bottle.
			strength: 0.028,
			dispersion: 0,
			rim: 0.6,
			smoke: {
				colour: vapourOf( recipe.liquid ),
				depth: recipe.depth,
				scale: recipe.scale,
				radius: recipe.radius,
				fill: recipe.fill,
				ceiling: recipe.ceiling,
				density: 0.75,

				// High threshold with a wide soft edge: only the top of the noise
				// survives, so what is left is two or three billows rather than a
				// bottle filled wall to wall.
				clearing: 0.62,
				softness: 0.32,

				// Over 1, so the smoke is the shelf's light. There is no lamp on these
				// boards; the clay jars on the middle one are lit by the bottles above
				// and below them, through SSGI.
				brightness: 1.5,
			},
		} );

		// Front faces only, and only the smoked bottles reach this line. The march
		// runs once from whatever fragment is shaded, so a back face would walk the
		// same volume a second time and double the smoke. The plain ones returned
		// above and are deliberately the opposite — double-sided, because with no
		// march to double, the far wall is the whole point.
		object.material.side = FrontSide;

		filled ++;

	} );

	return filled;

}

/**
 * The three jars on the middle board, returned to clay.
 *
 * They are not potions — in the source scene they are terracotta with dark lids —
 * and they were rendering as metal. `MI_Trim_Props_Vertex.004` came through the
 * exporter carrying **`metalness: 1`**, which is glTF's default when the material
 * has no `pbrMetallicRoughness` block, and it is the same trap the two book covers
 * fell into: see `BookCovers.ts` for that one. A metal jar in a dark room is a
 * black jar, because a conductor has no diffuse response to give back.
 *
 * The fix is one number. Everything else the asset needs is already there — base
 * colour, normal and roughness maps all came through intact — so this does not
 * author a clay look so much as stop overriding the one that shipped.
 */
const CLAY = 'SmallBottles_1';

/**
 * Roughness floor for unglazed earthenware.
 *
 * Multiplied onto the map rather than replacing it, so the throwing rings and
 * fingermarks the texture carries still vary across the surface. Full 1 is bone
 * dry and reads dusty; a shade under leaves the faint sheen fired clay keeps.
 */
const CLAY_ROUGHNESS = 0.92;

export function clayJars( root: Object3D ): number {

	let fixed = 0;

	root.traverse( ( object ) => {

		if ( object.name !== CLAY || ! ( object instanceof Mesh ) ) return;

		const clay = ( object.material as MeshStandardNodeMaterial ).clone();

		// The whole repair.
		clay.metalness = 0;
		clay.roughness = CLAY_ROUGHNESS;

		// And no glow: an earlier pass lit these along with the bottles, back when
		// they were taken for potions.
		clay.emissive = new Color( 0x000000 );
		clay.emissiveIntensity = 0;

		object.material = clay;
		fixed ++;

	} );

	return fixed;

}


/**
 * The two potions on the desk, re-authored as real glass.
 *
 * **What these were.** Not glass at all: base colour pure black, metalness 1,
 * roughness 1, and an `emissive` — a lamp in the shape of a bottle. That reads
 * from across the room and falls apart at the distance the leaned-in framing
 * actually puts them at, because a lit shape has no thickness, no rim and no
 * refraction. There is nothing to preserve in swapping them; they carry no maps.
 *
 * **What this is.** `buildGlass` from `GlassMaterial.ts` — screen-space
 * refraction through `viewportSharedTexture`, with a three-tap chromatic split.
 * `MeshPhysical.transmission` was tried first and abandoned: it renders its own
 * pass, that pass does not contain transmissive objects, and so glass cannot see
 * other glass. The backdrop route reads the frame as already drawn, which is both
 * cheaper and the thing the reference is actually built on — its own credits name
 * three's `webgpu_backdrop` examples.
 *
 * Measured cost of the two bottles, four alternating rounds to cancel the drift
 * this browser pane has: **0.58 ms a frame** (9.30 ms against 8.72). A single
 * unalternated pair had read 3.4 ms, which was the pane moving rather than the
 * glass — alternate anything measured in here.
 *
 * **What is still not faked.** Real-time caustics. Not a material feature at all
 * but light transport this pipeline has no path for; if they are ever wanted they
 * are a projected pattern driven from the bottle, their own piece of work.
 *
 * **Why they still glow.** `emissive` is kept, at well under half what it was.
 * Physically pure glass in this room is a dark shape: the atelier is lit by small
 * contained pools, there is nothing bright behind these bottles to refract, and
 * dropping the emission entirely turns the two most-looked-at objects on the desk
 * into silhouettes. Keeping a lit core reads as a potion that is itself luminous,
 * which is both the fiction and the thing that survives the room's darkness — and
 * the glass is now doing the shaping around it rather than being the whole story.
 */
interface Glass {
	mesh: string;
	/** The draught. Everything else about the bottle is derived from it. */
	liquid: number;
	/** Local Y of the liquid surface, and of the airspace above it. */
	fill: number;
	ceiling: number;
	radius: number;
	/**
	 * How hard the draught burns from within.
	 *
	 * The room's ambient is a cool violet, and a merely *tinted* bottle settles
	 * into the same purple-grey value as the wall behind it — the tint survives and
	 * the separation does not. The amber runs hotter than the teal for exactly this
	 * reason: it is the one hue the ambient actively fights, so it needs more to
	 * push back with, and matching the two numbers would leave it the duller of the
	 * pair despite being the warmer colour.
	 */
	glow: number;
	scale: number;
	depth: number;
}

/** Primary hero, and the one hue the shelf is allowed to echo. */
const HERO_TEAL = 0x2fd9c4;

/** Second hero: warm, and set against a cool room on purpose. */
const HERO_AMBER = 0xe8a93c;

const DESK_GLASS: Glass[] = [
	{ mesh: 'Bottle', liquid: HERO_TEAL, fill: 0.196, ceiling: 0.330, radius: 0.0415, glow: 0.72, scale: 15, depth: 0.10 },
	{ mesh: 'Bottle010', liquid: HERO_AMBER, fill: 0.140, ceiling: 0.222, radius: 0.033, glow: 0.95, scale: 19, depth: 0.08 },
];

/**
 * Every cork in the room, unified.
 *
 * They already shared one material — `Potion cap`, on all seven caps across the
 * desk and the shelf — so the mixed pink/tan look was not seven different corks
 * disagreeing. It was one olive-tan (`0x997d51`) sitting under a violet ambient
 * that pushed it pink wherever the light reached and grey wherever it did not.
 * A warmer, browner base holds its hue against that tint instead of taking it.
 */
const CORK_MATERIAL = 'Potion cap';
const CORK = 0x8c6f52;

export function unifyCorks( root: Object3D ): number {

	let done = 0;

	root.traverse( ( object ) => {

		if ( ! ( object instanceof Mesh ) ) return;

		const material = object.material as MeshStandardNodeMaterial;

		if ( material?.name !== CORK_MATERIAL ) return;

		material.color = new Color( CORK );
		done ++;

	} );

	return done;

}

export function glassPotions( root: Object3D ): number {

	const wanted = new Map( DESK_GLASS.map( ( glass ) => [ glass.mesh, glass ] ) );

	let made = 0;

	root.traverse( ( object ) => {

		const recipe = wanted.get( object.name );

		if ( recipe === undefined || ! ( object instanceof Mesh ) ) return;

		const was = object.material as MeshStandardNodeMaterial;
		const glass = buildGlass( {
			tint: recipe.liquid,
			density: 0.78,
			fill: recipe.fill,
			fillGlow: recipe.glow,

			// Pulled back from the 0.45 default. The Fresnel lift multiplies whatever
			// the body already is, so on a lit draught it pushes the silhouette past
			// the AgX knee and the hue goes with it — the amber read ivory before this
			// came down. On the unlit shelf bottles it is free and stays at 0.6.
			rim: 0.28,

			// No dispersion. It survived every reduction — at 0.1 there were still red
			// and cyan edges along the cork thread and the highlight rim, and this is
			// the only surface in the room that splits colour, so it read as a fault
			// rather than as glass. See `GlassMaterial.ts`.
			strength: 0.05,
			dispersion: 0,
			smoke: {
				colour: vapourOf( recipe.liquid ),
				depth: recipe.depth,
				scale: recipe.scale,
				radius: recipe.radius,
				fill: recipe.fill,
				ceiling: recipe.ceiling,
				// Thinner over a lit draught than over a dark one: the vapour sits in
				// front of the brightest thing in the bottle, so at the shelf's density
				// it washed the liquid's hue out from in front rather than from within.
				//
				// Thinner again now, and higher-thresholded. The headspace is the
				// narrowest part of these bottles, so a wisp that would read as one
				// billow in a wide body fills the whole neck and arrives as a soft white
				// patch — an emissive smudge rather than anything optical.
				density: 0.4,
				clearing: 0.7,
				softness: 0.3,

				// Under the knee. At 2.4 the vapour blew through AgX to white and lost
				// the hue `vapourOf` had just derived for it, which defeats the point of
				// deriving it — and at the neck's scale it is also what made the blob
				// read as a light rather than as vapour.
				brightness: 0.7,

				// Currents in the draught itself. Coarse and slow: a handful of slow
				// bodies of colour turning over, at a fraction of the vapour's
				// frequency, or it reads as grit suspended in the potion.
				currents: 0.5,
				currentScale: 9,
			},
		} );

		// The asset authored these double-sided, and for a single-shell bottle that
		// is right: the back wall is what the front refracts towards.
		glass.side = was.side;

		object.material = glass;
		made ++;

	} );

	return made;

}
