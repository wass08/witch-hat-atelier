import {
	AmbientLight,
	Color,
	FogExp2,
	Group,
	LinearSRGBColorSpace,
	Material,
	Mesh,
	MeshPhysicalNodeMaterial,
	MeshStandardNodeMaterial,
	NodeMaterial,
	Object3D,
	PMREMGenerator,
	Raycaster,
	RepeatWrapping,
	SRGBColorSpace,
	Scene,
	type Texture,
	TextureLoader,
	Vector3,
	type WebGPURenderer,
} from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
	color,
	mix,
	float,
	luminance,
	mx_noise_float,
	positionLocal,
	positionWorld,
	rotateUV,
	sin,
	step,
	texture,
	time,
	uniform,
	uv,
	vec2,
	vec3,
} from 'three/tsl';
import { NODE } from '../config';
import { FOREST, OXBLOOD, bindBookCover } from './BookCovers';
import { clayJars, glassPotions, shelfBottles, unifyCorks } from './Potions';
import { blenderNoise, blenderRamp } from './blenderNoise';
import { kindle } from './Flames';
import { buildHaze, buildSky } from './Sky';
import { SpookyOrbs } from './SpookyOrbs';
import { WORLD_AMBIENT, WORLD_STRENGTH, buildRig } from './lightRig';
import type { FloatUniform } from '../tsl-types';

/** Handles on the floor sigil, driven by the rune spell. */
export interface RuneControls {
	/** 0..1 — how awake the carving looks. */
	setCharge( amount: number ): void;
	/** Absolute rotation of the carving, in radians. */
	setPhase( radians: number ): void;
}

export interface Atelier {
	root: Group;
	paper: Mesh;
	pen: Object3D;
	dummy: Object3D;
	/** The centre of the target painted on the dummy, on its surface. */
	bullseye: Vector3;
	rune: RuneControls;
	/** The floating lights; they wander and twinkle, so they need stepping. */
	orbs: SpookyOrbs;
}

export async function loadAtelier(
	renderer: WebGPURenderer,
	scene: Scene,
	onProgress?: ( fraction: number ) => void,
): Promise<Atelier> {

	// The .blend's world colour, and only a whisper of fog — Cycles renders this
	// room with none, but a little keeps the far wall from flattening out.
	// The room has no ceiling, so this is composition rather than a clear colour —
	// see `Sky.ts`. The .blend's flat world colour is what it replaces, and its
	// gradient is built around the same magnitude.
	scene.backgroundNode = buildSky();

	// Softens the hard line where the wall's top course meets that sky.
	scene.fogNode = buildHaze();
	scene.fog = new FogExp2( 0x0a070f, 0.02 );

	const draco = new DRACOLoader().setDecoderPath( '/draco/' );
	const loader = new GLTFLoader().setDRACOLoader( draco );

	const gltf = await loader.loadAsync( '/Witch_Hat_Atelier_fixed.glb', ( event ) => {

		if ( event.total > 0 ) onProgress?.( event.loaded / event.total );

	} );

	draco.dispose();

	const root = gltf.scene;
	scene.add( root );

	// GLTFLoader hands back classic materials; converting them up front means
	// every material in the room is a real NodeMaterial we can graft TSL onto.
	const converted = new Map<Material, NodeMaterial>();
	const shrunk = new Set<Texture>();

	root.traverse( ( object ) => {

		const mesh = object as Mesh;

		if ( ! mesh.isMesh ) return;

		mesh.material = toNodeMaterial( renderer, converted, mesh.material as Material );
		mesh.frustumCulled = true;

		capTextures( mesh.material, shrunk );

		// One directional light casts, so the room gets real shadows under the
		// furniture rather than relying on screen-space occlusion alone. The shell
		// itself is excluded: the three hundred-odd brick instances and the floor
		// slab are what you would be casting *onto*, and making them casters as well
		// doubled the shadow pass for no visible gain.
		mesh.castShadow = ! SHELL.test( mesh.name );
		mesh.receiveShadow = true;

	} );

	const find = ( name: string ): Object3D => {

		const object = findNode( root, name );

		if ( object === undefined ) throw new Error( `Atelier: node "${ name }" missing from the GLB` );

		return object;

	};

	const smoke = findNode( root, NODE.cauldronSmoke );

	if ( smoke !== undefined ) hideVolumeProxy( smoke as Mesh );

	const pen = find( NODE.pen );

	// The quill used to wash the whole page out in bloom, and it was almost
	// entirely one property: the nib is the only material in the room carrying
	// KHR_materials_anisotropy, and it carries 0.25 of it on a fully rough metal.
	// That combination blows the anisotropic highlight out into a halo several
	// times the size of the 2.5 cm nib itself. Dropping it kills the glare
	// outright; the albedo trim is only to stop a white feather and white metal
	// catching quite so much of the desk light.
	//
	// All three of the quill's materials belong to this object alone, so none of
	// this touches anything else in the room.
	pen.traverse( ( part ) => {

		const material = ( part as Mesh ).material as MeshPhysicalNodeMaterial | undefined;

		if ( material === undefined ) return;

		material.anisotropy = 0;

		// The turned parts, in walnut: the 22 cm shaft and the 66 mm ferrule above it.
		//
		// They share one grain because they are one piece of timber, and the noise is
		// read in each mesh's *own* local space — both are cylinders along their local
		// Y, so the same frequencies land the same way on both without either needing
		// its own numbers.
		//
		// The colour is the floor's, linear and exact: `Wood Floor Dark Walnut` is
		// already in this file and there is no reason for two walnuts in one room to
		// disagree. The grain is procedural rather than a map, the way the tomes'
		// leather is, and it is stretched deliberately — high frequency across the
		// shaft, low along it — because the grain of a turned rod runs with the axis.
		// Isotropic noise on a cylinder reads as dirt.
		if ( QUILL_WOODEN.has( material.name ) ) {

			material.metalness = 0;
			material.roughness = QUILL_WOOD_ROUGHNESS;

			const grain = mx_noise_float( vec3(
				positionLocal.x.mul( QUILL_GRAIN_ACROSS ),
				positionLocal.y.mul( QUILL_GRAIN_ALONG ),
				positionLocal.z.mul( QUILL_GRAIN_ACROSS ),
			) ).mul( 0.5 ).add( 0.5 );

			material.colorNode = vec3( ...QUILL_WOOD ).mul( mix( float( 0.72 ), float( 1.24 ), grain ) );

			return;

		}

		// Everything else is brass. See `QUILL_METALS`.
		//
		// These return before the trim below. That factor exists to stop white metal
		// catching quite so much of the desk light; applied to a colour chosen
		// deliberately it would only darken it by 30%, which is two dials arguing
		// about the same job.
		const finish = QUILL_METALS[ material.name ];

		if ( finish !== undefined ) {

			material.metalness = 1;
			material.roughness = finish;

			// The blade carries the only textures on the quill — base colour, normal,
			// roughness and metalness maps, all authored for steel. Assigning
			// `material.color` would do nothing against a base-colour map, so the brass
			// has to go through the node graph.
			//
			// Modulated *around* the brass rather than multiplied by the map: the steel
			// albedo is a mid grey, and `brass × grey` is neither brass nor grey, just
			// dark — which is exactly how the blade came out, near black. Remapping the
			// map into a narrow band around 1 keeps the forging detail it carries and
			// lets the brass set the level.
			if ( material.map ) {

				const forged = texture( material.map, uv() ).r;

				material.colorNode = color( QUILL_BRASS ).mul( mix( float( 0.8 ), float( 1.15 ), forged ) );

				// …and its metalness and roughness maps have to be overridden too, not
				// just the scalars. Those maps are authored for steel and they *win*
				// against a scalar, so the blade kept steel's response — patches of it
				// reading as a rough dielectric — and came out near black next to the
				// brass it was supposed to match. Node assignments take precedence over
				// the maps, which leaves the normal map doing the only job worth keeping.
				material.metalnessNode = float( 1 );
				material.roughnessNode = float( finish );

			} else {

				material.color = new Color( QUILL_BRASS );

			}

			return;

		}

		material.color?.multiplyScalar( QUILL_ALBEDO );

	} );

	root.updateMatrixWorld( true );

	const paper = find( NODE.paper ) as Mesh;

	// Fails loudly here rather than silently doing nothing when the rune spell fires.
	find( NODE.rune );

	paper.renderOrder = 1;

	const runeCharge = uniform( 0 );
	const runePhase = uniform( 0 );

	// The one texture the room needs that the GLB does not carry: the exporter
	// dropped the training dummy's cloth albedo outright — see `enchant`. Unpacked
	// from the source .blend and halved to 1k, which is more than a prop three
	// metres downrange asks for.
	const cloth = await new TextureLoader().loadAsync( '/textures/fabric01_diffuse.jpg' );

	// glTF puts v = 0 at the *top* of the image, which is why GLTFLoader unflips
	// everything it loads; this has to agree with the mesh it lands on.
	cloth.flipY = false;
	cloth.wrapS = cloth.wrapT = RepeatWrapping;
	cloth.colorSpace = SRGBColorSpace;

	// The floor sigil's carving, taken back to the .blend's own source — see
	// `enchant`. Loaded here so the material dispatch below stays synchronous.
	const runeMap = await new TextureLoader().loadAsync( '/textures/MagicCircleRune.png' );

	runeMap.flipY = false;
	runeMap.colorSpace = SRGBColorSpace;
	runeMap.wrapS = runeMap.wrapT = RepeatWrapping;

	// A floor decal is seen almost edge-on from the desk, which is exactly the
	// case trilinear filtering handles worst: the near edge of the ring is a metre
	// away and the far edge is six, so the mip level chosen for the far half
	// smears the engraving into a band. Sixteen taps on one decal costs nothing.
	//
	// This is the *sampler's* anisotropy, not `material.anisotropy` — the BRDF
	// extension the quill's nib carries and which had to be turned off. Same word,
	// unrelated setting, and only one of them affects shading.
	runeMap.anisotropy = 16;

	enchant( converted, runeCharge, runePhase, cloth, runeMap );
	light( scene );

	// Every flame in the room is a hidden mesh with a billboarded sprite standing
	// in its place — see `Flames.ts`. Traversal happens inside, so the group is
	// only added once the meshes have been found.
	root.add( kindle( root ) );

	// The floating lights are re-authored in place — the asset's emissive spheres
	// read as bulbs — and paired with the point lights the rig already gave them.
	const orbs = new SpookyOrbs( root, scene );

	// The left shelf's bottles are re-authored as real transmissive glass, matched
	// to the round green bottle on the desk. They used to carry smoke turning
	// inside them, which was what made them visible in that dark corner; the two
	// shelf lamps in `lightRig.ts` do that job now. The three jars on its middle
	// board are clay, and were rendering as metal. See `Potions.ts`.
	shelfBottles( root );
	clayJars( root );

	// …and the two on the desk are re-authored as actual glass. They were pure
	// emissive — black base, metalness 1 — which is fine across the room and falls
	// apart at the distance the leaned-in framing puts them at.
	glassPotions( root );

	// Every cap in the room is one material; a single warm brown stops the violet
	// ambient reading it as pink where it is lit and grey where it is not.
	unifyCorks( root );

	const dummy = find( NODE.dummy );

	return {
		root,
		paper,
		pen,
		dummy,
		orbs,
		bullseye: findBullseye( dummy ),
		rune: {
			setCharge: ( amount: number ) => {

				runeCharge.value = amount;

			},
			setPhase: ( radians: number ) => {

				runePhase.value = radians;

			},
		},
	};

}

/**
 * Halves oversized maps in place, once each. Textures are shared between
 * materials, so the set is what stops a 4096² atlas being resampled five times.
 */
function capTextures( material: Material, done: Set<Texture> ): void {

	const slots = [ 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap' ] as const;
	const source = material as unknown as Record<string, Texture | null>;

	for ( const slot of slots ) {

		const texture = source[ slot ];

		if ( texture === null || texture === undefined || done.has( texture ) ) continue;

		done.add( texture );

		const image = texture.image as { width?: number; height?: number } | undefined;
		const width = image?.width ?? 0;
		const height = image?.height ?? 0;
		const longest = Math.max( width, height );

		if ( longest <= TEXTURE_CAP ) continue;

		const scale = TEXTURE_CAP / longest;
		const canvas = document.createElement( 'canvas' );

		canvas.width = Math.round( width * scale );
		canvas.height = Math.round( height * scale );

		const context = canvas.getContext( '2d' );

		if ( context === null ) continue;

		context.drawImage( image as CanvasImageSource, 0, 0, canvas.width, canvas.height );

		texture.image = canvas;
		texture.needsUpdate = true;

	}

}

/**
 * Where the target painted on the training dummy actually is, in world space.
 *
 * The centre of the decal is `u = v = 0.5` by definition, which runs back through
 * the same Mapping the shader uses to a point on the cloth's own axis; the
 * surface that point sits on is then one raycast away. Deriving it beats writing
 * the coordinate down: the decal and the thing the spells aim at cannot drift
 * apart, and moving the target in Blender moves the aim with it.
 *
 * The alternative — the dummy's bounding-box centre — is what this replaces, and
 * it was half a metre low, because the box contains the post and the crossbar as
 * well as the body. Spells were hitting the stand.
 */
function findBullseye( dummy: Object3D ): Vector3 {

	const centre = new Vector3(
		( 0.5 - TARGET_DECAL.x ) / TARGET_DECAL.scale,
		( 0.5 - TARGET_DECAL.y ) / TARGET_DECAL.scale,
		0,
	);

	let cloth: Mesh | undefined;

	dummy.traverse( ( object ) => {

		const mesh = object as Mesh;

		if ( mesh.isMesh && ( mesh.material as { name?: string } ).name === CLOTH_MATERIAL ) cloth = mesh;

	} );

	if ( cloth === undefined ) return centre;

	const axis = centre.applyMatrix4( cloth.matrixWorld );

	// The decal is projected along the cloth's local z, which is why the target
	// faces the desk at all. Come back down that axis onto the cloth itself, so a
	// fireball bursts on the surface rather than inside the dummy.
	const ray = new Raycaster( new Vector3( axis.x, axis.y, axis.z + 3 ), new Vector3( 0, 0, - 1 ) );
	const hit = ray.intersectObject( cloth, false )[ 0 ];

	return hit === undefined ? axis : hit.point;

}

/**
 * The easel's canvas, in its own local frame: the bbox of `prop_easel_wooden_1`,
 * which is what the sketch is laid out against. Its UVs are a trim-atlas sub-rect
 * (u 0.34–0.53, v 0.26–0.40), so they are no use for placing anything — the local
 * frame is, exactly as with the dummy's decal.
 */
const CANVAS_FRAME = { x: - 0.26, y: 0.5194, width: 0.52, height: 0.671 } as const;

/** Aged linen, and the ink on it. Linear. */
const CANVAS_LINEN = [ 0.245, 0.219, 0.172 ] as const;
const CANVAS_INK = [ 0.055, 0.042, 0.035 ] as const;

/** How dark the sketch sits on the cloth. 1 is full-strength ink. */
const CANVAS_SKETCH = 0.72;

/** Width of the sigil as a fraction of the canvas, and where its middle sits. */
const SKETCH_SIZE = 0.78;
const SKETCH_CENTRE = [ 0.5, 0.54 ] as const;

/** The dummy's body, and the only thing in the room wearing the target decal. */
const CLOTH_MATERIAL = 'Old fabric';

/**
 * GLTFLoader runs node names through `PropertyBinding.sanitizeNodeName`, which
 * strips the dots Blender puts in duplicate names — "Torch.002" arrives as
 * "Torch002". Try both spellings.
 */
function findNode( root: Object3D, name: string ): Object3D | undefined {

	return root.getObjectByName( name ) ?? root.getObjectByName( name.replace( /[.:/[\]]/g, '' ) );

}

function toNodeMaterial( renderer: WebGPURenderer, cache: Map<Material, NodeMaterial>, material: Material ): NodeMaterial {

	const existing = cache.get( material );

	if ( existing !== undefined ) return existing;

	// `library.fromMaterial` is what the renderer itself uses internally; it is
	// simply not part of the published type surface.
	const library = renderer.library as unknown as { fromMaterial( material: Material ): NodeMaterial | null };
	const node = library.fromMaterial( material ) ?? new MeshStandardNodeMaterial();

	cache.set( material, node );

	return node;

}

/**
 * Blender's Mapping node on the dummy's target decal: a uniform scale, then a
 * location. Named because two things read it — the shader that draws the decal,
 * and `findBullseye`, which inverts it to work out what the spells should aim at.
 *
 * **Tightened from the authored values, deliberately.** The .blend has this at
 * scale 2.5, location ( 0.5, -3.45 ), and the port carried that across exactly;
 * checked against the live file, so this is a look decision and not a drift.
 *
 * At 2.5 the rings span local y 1.380 to 1.780 and the dummy's neck is at 1.72 —
 * measured off the mesh, where the silhouette pinches from a radius of 0.226 at
 * the belly to 0.090 — so the outermost ring climbed sixty millimetres up onto
 * the head. At 3.2 it spans 1.364 to 1.676 and clears the neck by forty-four,
 * and its width comes down from 400 mm to 313 on a body 452 across, which gives
 * the rings a margin at the sides they did not have either.
 *
 * `y` follows from the scale rather than being dialled separately: the decal is
 * centred on local y 1.52, near the widest part of the belly, and
 * `y = 0.5 - centre * scale` puts it there. Nothing else needs touching —
 * `findBullseye` inverts this same pair, so the aim point moves with the rings
 * on its own, which is the whole reason it was written to derive rather than to
 * remember.
 */
const TARGET_DECAL = { scale: 3.2, x: 0.5, y: - 4.364 } as const;

/**
 * Largest texture the room is allowed to keep, per side.
 *
 * The GLB ships two 4096² maps — the parchment's paper noise and the nature
 * atlas the three mushrooms share — and at RGBA8 with mips each of those is
 * **85 MB** of texture memory on its own. The room's 62 distinct maps come to
 * about 1.2 GB between them, which is a great deal of residency for a scene you
 * can see all of at once, and the sort of pressure that shows up as an
 * occasional dropped frame rather than as a lower frame rate.
 *
 * 2048 costs these two nothing anyone can see: one is *noise*, and the other is
 * shared by three props a hand's breadth across. It takes 170 MB back. Every
 * other map in the room is already at or under this, so nothing else is touched
 * — deliberately, because the desk and the page are close enough to the camera
 * to show it.
 */
const TEXTURE_CAP = 2048;

/** How far the quill's albedo is taken down; 1 is the asset as authored. */
const QUILL_ALBEDO = 0.7;

/**
 * Antique gold brass, for the quill's body.
 *
 * Brass rather than gold: a copper-zinc alloy is duller and greener than gold at
 * the same brightness, which is what "antique" is doing here — a pen barrel is a
 * turned fitting, not bullion, and pure gold's chroma under the warm desk lamps
 * reads as a prop.
 */
const QUILL_BRASS = 0xb8935a;

/**
 * The quill's metal, by the material name each part carries in the GLB.
 *
 * Two of the pen's four materials: the blade at the tip and the 37 mm collar
 * behind it. The other two are wood — see `QUILL_WOODEN` — which leaves the metal
 * confined to the writing end, where a pen's metal actually belongs.
 *
 * `metalness` 1 is the part that does the work: with it the base colour stops
 * being an albedo and becomes the tint of the *reflection*, which is the only way
 * a metal gets its colour. It also leaves each part with no diffuse to fall back
 * on, so what they show is entirely what the room gives them — the warm desk
 * lamps and the candle read as brass, the violet ambient as the shadowed side.
 *
 * **Only the roughness varies.** One colour is what makes the two read as a
 * single machined fitting; the blade is the writing edge and polished hardest,
 * the collar behind it sits closest to the ink and is duller for it.
 *
 */
const QUILL_METALS: Record<string, number> = {
	// The blade at the tip. Polished hardest of the four: it is the writing edge and
	// in the source art it is gold, not steel.
	'Stainless Steel': 0.3,
	Pen_Nib_Color: 0.58,
};

/**
 * The quill's wooden parts — the 22 cm shaft and the 66 mm ferrule above it.
 *
 * A set rather than a name, because which parts are timber is the kind of thing
 * that moves: this started as the shaft alone, with the ferrule brass.
 */
const QUILL_WOODEN = new Set( [ 'Pen_Handle_Color', 'Pen_Ferrule_Color' ] );

/**
 * Walnut, linear, and darker than the floor's despite being the same timber.
 *
 * The floor's `Wood Floor Dark Walnut` sits at ( 0.263, 0.181, 0.139 ) and reads
 * correctly there — but the floor is metres from any lamp and the quill lies on
 * the desk directly under `bounce_deskWarm` and a candle. At the floor's value the
 * shaft washed out to pale cream under that light, which is not a wood colour at
 * all. This is the same hue taken down until it survives the desk.
 *
 * It is a reminder that an albedo is only half of what a surface looks like: the
 * other half is what is shining on it, and a value picked in one part of a room
 * is not transferable to another.
 */
const QUILL_WOOD: [ number, number, number ] = [ 0.105, 0.068, 0.048 ];

const QUILL_WOOD_ROUGHNESS = 0.58;

/**
 * Grain frequency across the shaft and along it.
 *
 * The ratio is the whole point. Wood grain on a turned rod runs *with* the axis,
 * so the noise has to be stretched hard along it — sampled isotropically the
 * shaft comes out mottled, which reads as dirt on a pen rather than as timber.
 */
const QUILL_GRAIN_ACROSS = 240;
const QUILL_GRAIN_ALONG = 20;

/**
 * How far the two wall tapestries are lifted out of the dark. **This is the one
 * deliberate departure from the .blend in this file** — everything else here is
 * recovering what the exporter lost, and both of these materials came through
 * perfectly correct. The cloth textures are dark navy prints with fine gold line
 * work, they hang on the far wall a good four metres from the nearest candle,
 * and screen-space GI cannot gather the bounce that lifts them in Cycles. Left
 * at the authored albedo they read as two black rectangles and the art on them
 * is invisible from the desk.
 *
 * The border is lifted less than the cloth on purpose: matching them flattens
 * the banner into one panel, and the frame reading darker than its print is what
 * keeps it looking like cloth hung on a rod.
 */
const TAPESTRY_CLOTH = 4;
const TAPESTRY_BORDER = 3;

/** The border's authored base colour, in linear — the gain above is relative to it. */
const TAPESTRY_BORDER_COLOUR = [ 0.0672, 0.03513, 0.0835 ] as const;

/**
 * The plant pot's terracotta, straight off the Color Ramp inside the .blend's
 * `Mud Pot` group — its three lit stops, darkest to warmest, in linear.
 *
 * Not the group's `Color` socket, which is the obvious thing to reach for and is
 * wrong: that is a pale sand, and feeding it through gave a cream pot. It tints
 * something further down the chain. The colour the pot actually *is* comes from
 * this ramp.
 */
const MUD_POT_CLAY = [
	[ 0.1218, 0.0379, 0.0112 ],
	[ 0.3422, 0.1064, 0.0314 ],
	[ 0.342, 0.1574, 0.0808 ],
] as const;

/** The group's own `Scale` input, which drives every texture inside it. */
const MUD_POT_SCALE = 16.58;

/** Scales the two glowing potions. 1 is the .blend's own emission, rebuilt. */
const POTION_GLOW = 1;

/**
 * How much of the liquid's glow the neck above it keeps.
 *
 * The .blend's Color Ramp is a hard edge — four centimetres of a thirty-three
 * centimetre bottle — and Cycles can afford that, because both sides of it are
 * refractive glass and you are looking *through* the neck at the liquid behind
 * it. Ours is an opaque surface, so the same edge cuts the bottle in half and
 * welds two materials together at the seam. Carrying the glow up through the
 * neck instead is not what the .blend says, but it is what the .blend looks
 * like: one bottle, brightest at the bottom.
 */
const POTION_NECK = 0.35;

/**
 * How much of its authored glass colour a potion bottle keeps. Blender puts a
 * real Glass BSDF above the liquid line; a rasteriser cannot do that justice,
 * but it must at least not draw a hole, and thin dark glass at a fraction of the
 * authored colour reads far closer than either black or clear.
 */
const POTION_GLASS = 0.12;

/**
 * Stands in for a volume's optical depth. A `Principled Volume` of density 6
 * across six centimetres scatters only a fraction of the light that passes
 * through it, so painting its albedo straight onto a surface — which is all a
 * rasteriser can do with it — comes out far brighter than the volume ever looks.
 */
const VOLUME_SCATTER = 0.3;

/** The room's own shell — floor slab, wall core and every brick instance. */
const SHELL = /^(inst_brick|env_floor|env_wall)/;

/**
 * `fx_cauldron_smoke` is not a surface. In the .blend it is a box with **no
 * Surface shader at all** — only a `Principled Volume` on the Volume socket, and
 * `display_type: WIRE`, so Blender draws it as a wireframe cage and Cycles renders
 * it by marching the volume inside.
 *
 * glTF cannot express that, so the exporter handed it a default surface material
 * and it arrived as an opaque grey slab leaning over the cauldron. Every attempt
 * to fix that by tinting or fading it was really an attempt to make a box look
 * like something it was never meant to be drawn as. Faking the volume properly
 * means raymarching it; until then the honest thing is not to draw it. The pot
 * still reads: its liquid is emissive and it has a lamp of its own.
 */
function hideVolumeProxy( mesh: Mesh ): void {

	mesh.visible = false;

}


/** Hangs TSL on the handful of materials that should not sit still. */
function enchant( materials: Map<Material, NodeMaterial>, runeCharge: FloatUniform, runePhase: FloatUniform, cloth: Texture, runeMap: Texture ): void {

	for ( const material of materials.values() ) {

		const physical = material as MeshPhysicalNodeMaterial;
		const name = material.name;

		if ( name === 'Cauldron_Liquid_Emission' ) {

			const boil = mx_noise_float( vec3( positionWorld.xz.mul( 22 ), time.mul( 0.9 ) ) ).mul( 0.5 ).add( 0.5 );

			// Blender: white emission at strength 11.
			physical.emissiveNode = mix( color( 0x1f7a4d ), color( 0x7dffb0 ), boil ).mul( boil.mul( 6 ).add( 5 ) );

		} else if ( name === 'MagicCircleRune_Material' ) {

			// The decal carries no colour map at all — the carving lives entirely in
			// its emissive map, so that texture doubles as the pattern *and* the
			// cut-out mask. Driven by an integrated phase rather than `time` directly,
			// so the spell can change the spin rate without the carving jumping.
			// The GLB's own copy of this map is not used. The .blend stores the
			// carving as a 1536² 32-bit EXR, and the exporter re-encoded it as *lossy*
			// WebP at 125 KB — the same pixel count, but the engraving is nothing but
			// one-pixel lines and lossy compression eats exactly those, so the rings
			// came through broken and the runes furred. `MagicCircleRune.png` is the
			// same EXR written out losslessly at 8 bits, which the values allow: the
			// brightest texel in the file is 0.95, so nothing is clipped by leaving
			// float behind.
			// Hand the material the new map as well, and let go of the exporter's: it
			// is 1536² of RGBA nobody samples any more, which is nine megabytes of
			// texture memory for a file that was replaced.
			physical.emissiveMap?.dispose();
			physical.emissiveMap = runeMap;

			const spin = rotateUV( uv(), runePhase, vec2( 0.5, 0.5 ) );
			const carving = texture( runeMap, spin );

			// Blender mixes a Transparent BSDF with an Emission using the texture's
			// *alpha*, so the carving is pure glow over the floor and nothing else.
			// Masking on luminance instead, as this did, quietly eats the dimmer
			// parts of the engraving.
			const mask = carving.a;

			// Blender emits this one *white* at strength 2.2 and lets the carving's
			// own map supply the colour — which is the warm gold in the reference.
			// Tinting it violet, as this used to, threw that away.
			const pulse = sin( time.mul( 1.6 ) ).mul( 0.5 ).add( 0.5 ).mul( 0.25 ).add( 0.9 );
			const heat = pulse.mul( 2.2 ).add( runeCharge.mul( 3 ) );

			physical.colorNode = vec3( 0 );
			physical.emissiveNode = carving.rgb
				.mul( mix( vec3( 1 ), vec3( 0.75, 0.6, 1 ), runeCharge ) )
				.mul( heat );
			physical.opacityNode = mask.mul( runeCharge.mul( 0.45 ).add( 0.55 ) ).clamp( 0, 1 );

			physical.transparent = true;
			physical.depthWrite = false;

		} else if ( name === 'Wood Floor Dark Walnut' ) {

			// glTF could not bake this one. In Blender the floor's base colour is a
			// Mix of two wood textures whose *factor* is `floorboards_displacement`,
			// and the exporter wrote that factor — a pale height map — out as the
			// albedo. That is why the middle of the room, which is bare slab out to
			// 3.5 m before the stone tiles begin, came through as pale grey instead
			// of dark walnut. Both wood textures average to the same linear brown, so
			// the floor is that colour and the exported map is kept only as grain.
			const grain = physical.map ? texture( physical.map, uv() ).r : float( 1 );

			physical.colorNode = vec3( 0.263, 0.181, 0.139 ).mul( mix( float( 0.82 ), float( 1.15 ), grain ) );
			physical.roughnessNode = float( 0.55 );

		} else if ( name === CLOTH_MATERIAL ) {

			// The training dummy's cloth, and the fourth thing in the room the exporter
			// could not carry. In the .blend its base colour is a Mix of `fabric01_diffuse`
			// with a bullseye decal projected in *object space* — Texture Coordinate →
			// Object, X and Z through a Mapping node — and glTF can express neither the
			// mix nor a projection that is not a UV lookup.
			//
			// So the exporter collapsed the chain to one texture, kept the wrong branch,
			// left `fabric01_diffuse` out of the file entirely, and wrote the decal's
			// object-space Mapping out as a UV transform on the mesh's own UVs — offset
			// ( 0.5, 1.95 ), scale 2.5. Those land wholly outside [ 0, 1 ], clamp to the
			// decal's transparent border, and the dummy renders **flat black** with the
			// weave still legible in the normal map, which is what makes it read as a
			// lighting fault rather than a missing texture. Both halves are rebuilt here.
			//
			// `positionLocal` is safe to reach for despite this being a per-material
			// pass: "Old fabric" is on the dummy's torso and nothing else in the room.

			// The exporter's own axis conversion is three = ( bx, bz, -by ), so Blender's
			// local X and Z are three's local X and Y. v is negated because three samples
			// the image's first row at v = 0 and Blender samples it at v = 1. The scale
			// and location are `TARGET_DECAL`, and are tightened from Blender's — see
			// the note there.
			const decalUV = vec2(
				positionLocal.x.mul( TARGET_DECAL.scale ).add( TARGET_DECAL.x ),
				positionLocal.y.mul( - TARGET_DECAL.scale ).add( 1 - TARGET_DECAL.y ),
			);

			// The decal itself is still on the material — it is what the exporter left as
			// the albedo — so it only needs that bogus transform cleared. Its sampler is
			// already clamped and the image's border is transparent, which is exactly what
			// Blender's CLIP extension does with the same coordinates.
			const decal = physical.map;

			decal?.offset.set( 0, 0 );
			decal?.repeat.set( 1, 1 );

			const weave = texture( cloth, uv() ).rgb;

			// Blender masks the mix on the decal's *colour*, which blends the red rings in
			// at about a third strength. Its alpha is the mask that was meant: the rings
			// are opaque red on transparent black, so the cloth reads between them.
			const rings = decal !== null ? texture( decal, decalUV ) : null;

			physical.colorNode = rings !== null ? mix( weave, rings.rgb, rings.a ) : weave;

		} else if ( name === 'VintageWitchy_Book03_Cover' || name === 'VintageWitchy_Book08_Cover' ) {

			// The only two materials in the room built entirely out of procedural
			// nodes, and the only two the exporter gave up on completely — they
			// arrived as a name and nothing else. See `BookCovers.ts`.
			bindBookCover( physical, name === 'VintageWitchy_Book03_Cover' ? OXBLOOD : FOREST );

		} else if ( name === 'Easel_Canvas' ) {

			// The one thing on this list that is *not* a repair. `Easel_Canvas` came
			// through the exporter intact — base colour, metallic-roughness and normal
			// maps all present — and what it carries is a blank primed board, because
			// that is what the asset is. It reads as a bright white rectangle in the
			// corner of the room, which is the complaint, so this paints on it.
			//
			// The sigil is the floor rune's own texture, already loaded for the carving
			// and reused here rather than shipping a second image: the witch's study
			// for the circle cut into her floor, pinned up where she was working it
			// out. Nothing new is fetched and the two cannot fall out of step.
			const linen = texture( physical.map ?? runeMap, uv() ).r;

			// The canvas's own local frame, mapped to 0..1 across the face. Its UVs are
			// a trim-atlas sub-rect and would put the sketch somewhere else entirely.
			const face = vec2(
				positionLocal.x.sub( CANVAS_FRAME.x ).div( CANVAS_FRAME.width ),
				positionLocal.y.sub( CANVAS_FRAME.y ).div( CANVAS_FRAME.height ),
			);

			// Square, so the sigil is not stretched by a canvas that is taller than it
			// is wide, and inset so there is board around it.
			const tall = SKETCH_SIZE * CANVAS_FRAME.width / CANVAS_FRAME.height;
			const sketchUV = vec2(
				face.x.sub( SKETCH_CENTRE[ 0 ] ).div( SKETCH_SIZE ).add( 0.5 ),
				face.y.sub( SKETCH_CENTRE[ 1 ] ).div( tall ).add( 0.5 ),
			).toVar();

			// The rune map repeats, so anything outside the square would tile across
			// the whole board.
			const within = step( float( 0 ), sketchUV.x ).mul( step( sketchUV.x, float( 1 ) ) )
				.mul( step( float( 0 ), sketchUV.y ) ).mul( step( sketchUV.y, float( 1 ) ) );

			const drawn = texture( runeMap, sketchUV ).a.mul( within ).mul( CANVAS_SKETCH );

			// The map's own value is kept purely as weave, the way the walnut floor
			// keeps its exported map as grain.
			physical.colorNode = mix(
				vec3( ...CANVAS_LINEN ).mul( mix( float( 0.88 ), float( 1.1 ), linen ) ),
				vec3( ...CANVAS_INK ),
				drawn,
			);

		} else if ( name === 'Procedural Mud Pot' ) {

			// The plant pot by the desk, and another material the exporter wrote as a
			// name and nothing else — so it arrived at the glTF defaults: white.
			//
			// This one is *not* rebuilt, and it is worth being clear about why. In the
			// .blend it is a single node group, and inside that group are seven Voronoi
			// textures, four noise textures, two wave textures, twenty colour ramps and
			// eight chained bumps — driven in part by an `Ambient Occlusion` node and
			// by `Geometry → Pointiness`, neither of which a rasteriser has. Porting it
			// faithfully is not a shader translation, it is a bake.
			//
			// What is recoverable is the thing that actually reads at this size: the
			// clay's colour, which is one socket on the group, and a little of the
			// grain, which is the group's own Scale through the noise the rest of the
			// room already uses. A pot 28 cm across, three metres away in candlelight,
			// asks for very little more than that.
			const clay = vec3( positionLocal.x, positionLocal.z.negate(), positionLocal.y );
			const grit = blenderNoise( clay, MUD_POT_SCALE, 4, 0.8 ).toVar();

			// The ramp's own shape, with the noise standing in for the gradient and
			// crack masks that drove it: dark in the low band, terracotta across the
			// middle, warmest where the clay is most exposed.
			physical.colorNode = mix(
				mix( vec3( ...MUD_POT_CLAY[ 0 ] ), vec3( ...MUD_POT_CLAY[ 1 ] ), blenderRamp( grit, 0.25, 0.5 ) ),
				vec3( ...MUD_POT_CLAY[ 2 ] ),
				blenderRamp( grit, 0.5, 0.8 ),
			);

			physical.roughnessNode = float( 0.95 );
			physical.metalnessNode = float( 0 );

		} else if ( name === 'MagicPotion_Bottle_Teal' || name === 'MagicPotion_Bottle010_Magenta' ) {

			// Blender mixes a clear Glass BSDF with a glowing one, and the factor is a
			// Color Ramp on the bottle's *own Z* — so the light comes off the liquid in
			// the bottom of the bottle and the neck above it is plain glass. glTF has
			// one flat `emissiveFactor` per material and nowhere to put the mask, so the
			// exporter lit the whole bottle end to end: a bar of light, not a potion.
			const teal = name === 'MagicPotion_Bottle_Teal';

			// `three = ( bx, bz, -by )`, so Blender's object Z is three's local Y. The
			// first figure is the .blend's own liquid line — the middle of its ramp —
			// and the second is the top of the bottle, measured off the geometry.
			const [ line, top ] = teal ? [ 0.196, 0.3462 ] : [ 0.128, 0.2318 ];

			// Full strength in the liquid, easing off across the whole neck to
			// `POTION_NECK` rather than stopping dead at the line.
			const fill = blenderRamp( positionLocal.y, top, line ).mul( 1 - POTION_NECK ).add( POTION_NECK );

			// Emission colour times strength times the 0.55 the Mix Shader gives it,
			// every figure the .blend's own. That comes out a little under half what the
			// exporter wrote, before the mask takes the neck out as well.
			const lit = teal
				? vec3( 0.05, 0.85, 0.75 ).mul( 2.5 * 0.55 )
				: vec3( 0.62, 0.12, 0.92 ).mul( 2.8 * 0.55 );

			physical.emissiveNode = lit.mul( fill ).mul( POTION_GLOW );

			// Above the liquid line the .blend has plain glass. The GLB left this
			// material black *and fully metallic*, which nothing revealed while the
			// exporter's flat emission lit the whole bottle — mask that off and the
			// necks turn into silhouettes. Black metal is not glass in any renderer.
			const glass = teal ? vec3( 0.92, 0.95, 0.95 ) : vec3( 0.62, 0.12, 0.92 );

			physical.colorNode = glass.mul( POTION_GLASS );
			physical.roughnessNode = float( 0.08 );
			physical.metalnessNode = float( 0 );

		} else if ( name === 'Material.003' ) {

			// The potion in the bottle on the desk: the room's second `Principled
			// Volume` after the cauldron's smoke, density 6, with no surface shader at
			// all. The exporter cannot write a volume, so it handed this one a default
			// surface and it arrived white and fully metallic — a bright bead sitting
			// inside a dark purple bottle. The smoke is simply not drawn; this one is
			// small and enclosed enough to be worth faking.
			const coord = vec3( positionLocal.x, positionLocal.z.negate(), positionLocal.y );
			const murk = blenderNoise( coord, 2.5, 6, 0.75 ).toVar();

			// The volume's own three-stop ramp: near-black green, dark green, and a
			// yellow-green that only the brightest wisps ever reach.
			const brew = mix(
				mix( vec3( 0.011, 0.0185, 0.008 ), vec3( 0.0343, 0.0578, 0.0232 ), blenderRamp( murk, 0.15, 0.35 ) ),
				vec3( 0.624, 0.807, 0.2542 ),
				blenderRamp( murk, 0.35, 0.75 ),
			);

			physical.colorNode = brew.mul( VOLUME_SCATTER );
			physical.roughnessNode = float( 0.35 );
			physical.metalnessNode = float( 0 );

		} else if ( name.startsWith( 'Tapestry_Cloth_Color' ) ) {

			// Note this cannot be done with `material.color`, the way the quill's trim
			// is: a colour factor above 1 is clamped on its way to the GPU, so that
			// dial can only ever take a surface down. Multiplying the map in the node
			// graph is the only way up.
			physical.colorNode = ( physical.map ? texture( physical.map, uv() ).rgb : vec3( 1 ) ).mul( TAPESTRY_CLOTH );

		} else if ( name === 'Tapestry_Gold_Color' ) {

			physical.colorNode = vec3( ...TAPESTRY_BORDER_COLOUR ).mul( TAPESTRY_BORDER );

		} else if ( name.startsWith( 'Explorer_MAT' ) ) {

			// The glowing mushrooms. In the .blend an Emission shader is *added* over
			// the Principled, and its strength is the albedo's own luminance through a
			// ramp — 0 below 0.35, 1 above 0.75 — so the light comes off the pale caps
			// and their spots while the darker stems stay the colour the atlas painted
			// them. The mint is the emission's colour, in linear, exactly as authored.
			//
			// glTF has one flat `emissiveFactor` per material and no way to mask it, so
			// the exporter wrote that mint at full strength across the whole mushroom.
			// At an emissive of ( 0.3, 1, 0.55 ) against a room lit by candles, that
			// buries the texture completely: cap, spots and stem all came out the same
			// washed pale green. Only the mask was lost — the colour was already right.
			const skin = physical.map ? texture( physical.map, uv() ) : null;

			const glow = skin !== null
				? luminance( skin.rgb ).sub( 0.35 ).div( 0.75 - 0.35 ).clamp( 0, 1 )
				: float( 1 );

			physical.emissiveNode = vec3( 0.3, 1, 0.55 ).mul( glow );

		} else if ( name.startsWith( 'SpookyOrb' ) ) {

			const bob = sin( time.mul( 1.1 ).add( positionWorld.x.mul( 3 ) ) ).mul( 0.5 ).add( 0.5 );

			// Blender: green orbs at strength 7, purple at 8, in linear colour.
			const orb = name.endsWith( 'Green' )
				? vec3( 0.3, 1.0, 0.5 ).mul( 7 )
				: vec3( 0.55, 0.15, 0.95 ).mul( 8 );

			physical.emissiveNode = orb.mul( bob.mul( 0.45 ).add( 0.75 ) );

		}

	}

}

/**
 * The room's lighting is the source .blend's own rig — see `lightRig.ts`. Nothing
 * here is invented any more; the only decisions left are which single lamp casts
 * shadows and how much ambient the near-black world colour is worth.
 */
/**
 * How much of Blender's world strength survives being put into an `AmbientLight`.
 *
 * The colour and the 1.1 are the .blend's and stay the .blend's — what does not
 * carry across is *occlusion*. Cycles treats the world as light arriving from
 * outside, so a brick deep in a closed round room barely sees any of it: the room
 * is in the way. An `AmbientLight` has no such notion. It adds the same amount to
 * every surface in the scene whatever is around it, so the authored value arrives
 * some three times too strong and lands as an even wash that lifts every brick off
 * black together — which is exactly what flattens a room lit by small lamps, since
 * the shadow side of everything is held up to the same floor.
 *
 * A third is roughly the fraction of the sky an interior surface here can actually
 * see, and by eye it is where the wall starts falling away into the corners again
 * instead of sitting at one value across its whole span. SSGI's ambient occlusion
 * does attenuate this in the composite, but AO is a short-range screen-space
 * estimate, not enclosure — it darkens a crease, not a whole room.
 */
const ENCLOSURE = 0.33;

function light( scene: Scene ): void {

	scene.add( buildRig() );

	// Blender's world: a very dark violet at 1.1 strength, and no environment
	// texture at all. It is the only ambient the room gets.
	const ambient = new Color().setRGB( WORLD_AMBIENT[ 0 ], WORLD_AMBIENT[ 1 ], WORLD_AMBIENT[ 2 ], LinearSRGBColorSpace );

	scene.add( new AmbientLight( ambient, WORLD_STRENGTH * ENCLOSURE ) );

}

/** Room-scale IBL so the metal and glass in the room have something to reflect. */
export function buildEnvironment( renderer: WebGPURenderer, scene: Scene ): void {

	try {

		const pmrem = new PMREMGenerator( renderer );
		scene.environment = pmrem.fromScene( new RoomEnvironment(), 0.04 ).texture;

		// Barely there. The source scene has no environment texture, and now that
		// SSGI supplies the bounce this only needs to give metal and glass
		// *something* to reflect rather than acting as fill light.
		scene.environmentIntensity = 0.05;

	} catch ( error ) {

		console.warn( 'Atelier: environment map unavailable, falling back to lights only', error );

	}

}
