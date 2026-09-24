import { Box3, Mesh, Object3D, AgXToneMapping, Scene, Timer, Vector3, WebGPURenderer, type Light, type LightsNode } from 'three/webgpu';
import { clusteredLights } from 'three/addons/tsl/lighting/ClusteredLightsNode.js';

import { CameraRig } from './scene/CameraRig';
import { LookAround } from './scene/LookAround';
import { Post } from './scene/Post';
import { Quill } from './scene/Quill';
import { buildEnvironment, loadAtelier } from './scene/Atelier';
import { InkSurface } from './ink/InkSurface';
import { InkMotes } from './ink/InkMotes';
import { StrokeRecorder } from './ink/StrokeRecorder';
import { buildRecognizer, sampleGlyph } from './recognize/glyphs';
import * as pdollar from './recognize/pdollar';
import { FIREBALL_SOUND, Fireball } from './spells/Fireball';
import { LIGHTNING_SOUND, Lightning } from './spells/Lightning';
import { RUNE_SOUND, RuneAwakening } from './spells/RuneAwakening';
import { FIREBALL_JOLT, Recoil } from './spells/Recoil';
import { ScreenFlash } from './spells/ScreenFlash';
import { WARD_SOUND, Ward } from './spells/Ward';
import { Ambience } from './audio/Ambience';
import { Chime } from './audio/Chime';
import { InkSfx } from './audio/InkSfx';
import { spellForGlyph, type SpellEffects } from './spells/registry';
import { IDLE_GLOW, INK_BURN_SECONDS, RECOGNITION_THRESHOLD } from './config';
import { Hud } from './ui/Hud';
import { Resolution } from './scene/Resolution';
import { observeViewport } from './ui/viewport';

async function main(): Promise<void> {

	const canvas = document.getElementById( 'stage' ) as HTMLCanvasElement;
	const hud = new Hud( document.getElementById( 'hud' ) as HTMLElement );

	// The room's ambient loop, and the welcome gate that lets it play at all.
	// Opened straight away so the whole load runs behind it; `await`ed at the very
	// end, after the shaders are warm, so what the door opens onto is a finished
	// room rather than a first frame that still has compiling left to do.
	const ambience = new Ambience();
	const chime = new Chime();

	// The page's own sounds — the quill and the burn — on `Chime`'s context, so
	// the gate's `prime` below unlocks them too. Until then `bus` is null and this
	// does nothing, every frame, for free.
	const inkSfx = new InkSfx( () => chime.bus );

	const gate = hud.gate( () => {

		void ambience.start();

		// The same gesture buys the spell audio too — `Chime` builds its context
		// lazily and would otherwise wait for the first stroke to be allowed one.
		chime.prime();

		// Decoding needs the context, and the context needs this gesture — so the
		// spell's sample is fetched here rather than at load, where there would be
		// nothing to decode it into.
		void chime.load( FIREBALL_SOUND, '/spell-fireball.mp3' );
		void chime.load( LIGHTNING_SOUND, '/spell-lightning.mp3' );
		void chime.load( RUNE_SOUND, '/spell-rune.mp3' );
		void chime.load( WARD_SOUND, '/spell-ward.mp3' );

	} );

	if ( navigator.gpu === undefined ) {

		hud.fatal( 'This atelier needs WebGPU. Try Chrome, Edge or Safari 26+ on a machine with a GPU.' );
		return;

	}

	hud.progress( 0.05, 'Waking the GPU…' );

	// No MSAA: the pipeline's temporal AA supersedes it, and a multisampled depth
	// buffer cannot be copied, which is exactly what SSGI and TRAA need to do.
	const renderer = new WebGPURenderer( { canvas, antialias: false } );
	// Capped below the display's native ratio on purpose: screen-space GI costs per
	// pixel, and the pipeline's temporal AA already resolves the edges that a
	// higher ratio would be buying.
	// Starts at the 1.5 cap and gives pixels back only if frames are actually being
	// dropped — see `Resolution`, which carries the measurements behind it.
	const resolution = new Resolution( renderer );
	// AgX, because that is what the source scene is graded with — Cycles is set to
	// "AgX / Medium High Contrast" here, and ACES rolls highlights off differently
	// enough that the candles and the rune never matched the reference under it.
	renderer.toneMapping = AgXToneMapping;
	renderer.toneMappingExposure = 1;
	renderer.shadowMap.enabled = true;

	// Forward+ clustered shading. The ported rig is 40-odd lamps once the soft and
	// area lights are expanded into points, and shading every fragment against all
	// of them costs more than the shadow pass and SSGI put together. Clustering
	// bins them into a 3D grid so each fragment only loops over the handful that
	// can actually reach it.
	const lighting = renderer.lighting as unknown as { createNode( lights?: Light[] ): LightsNode };
	lighting.createNode = ( lights = [] ) => clusteredLights().setLights( lights );

	await renderer.init();

	const scene = new Scene();
	const rig = new CameraRig( canvas );

	hud.progress( 0.15, 'Unrolling the atelier…' );

	buildEnvironment( renderer, scene );

	const atelier = await loadAtelier( renderer, scene, ( fraction ) => {

		hud.progress( 0.15 + fraction * 0.7, 'Unrolling the atelier…' );

	} );

	hud.progress( 0.9, 'Grinding the ink…' );

	const ink = new InkSurface( renderer, atelier.paper );

	// The ink is written to fade, and this is where it goes: motes shed from the
	// point the fade has reached, which walks the player's own line a lifetime
	// behind the quill.
	const motes = new InkMotes( renderer, scene, ink );

	const quill = new Quill( atelier.pen );

	// The centre of the target painted on the dummy, on its surface — derived from
	// the decal's own mapping at load, not copied out of the asset. This used to be
	// the dummy's bounding-box centre, which sits half a metre lower because the box
	// contains the post and the crossbar too, so both spells hit the stand.
	const castTarget = atelier.bullseye;

	// …and the middle of the body behind it, with the radius that encloses it.
	//
	// Derived at load for the same reason the bullseye is: replace the asset and
	// the ward still fits it. On this dummy the centre comes out 47 cm below the
	// painted target, and the radius **1.14 m** — against the 2.19 m the same
	// dummy measures from the *floor's* centre, which is the whole of why a cage
	// can be half the size of the dome it replaces.
	//
	// The radius is measured across the vertices rather than taken from the box,
	// and this scene has been caught by that difference before: the box's diagonal
	// gives 1.30 m here, 14 cm of it corners that hold no geometry at all. A cage
	// sized off the box is a cage that visibly does not fit.
	const bodyBounds = new Box3().setFromObject( atelier.dummy );
	const castBody = bodyBounds.getCenter( new Vector3() );
	const castBodyRadius = ( () => {

		const vertex = new Vector3();

		let furthest = 0;

		atelier.dummy.updateWorldMatrix( true, true );
		atelier.dummy.traverse( ( object ) => {

			const mesh = object as Mesh;

			if ( mesh.isMesh !== true ) return;

			const position = mesh.geometry.attributes.position;

			for ( let i = 0; i < position.count; i ++ ) {

				furthest = Math.max( furthest, vertex.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld ).distanceTo( castBody ) );

			}

		} );

		return furthest;

	} )();

	const effects: SpellEffects = {
		fireball: new Fireball( renderer, scene, chime ),
		lightning: new Lightning( renderer, scene, chime ),
		rune: new RuneAwakening( renderer, scene, atelier.rune, chime ),
		ward: new Ward( scene, chime ),
		flash: new ScreenFlash(),

		// Rocks the dummy when something lands on it. It reads the impact point, so
		// a shot the ward swallowed leaves the straw alone.
		recoil: new Recoil( atelier.dummy, castTarget ),
	};

	// The fireball has to fly before it lands; the lightning reports its own hit
	// from the registry, where it already knows whether the ward deflected it.
	effects.fireball.onImpact = ( at ) => {

		effects.recoil.hit( at, FIREBALL_JOLT );

		// The shot's own jolt, fired from where it actually went off — which is the
		// ward's shell when one ate it, not the dummy it was aimed at.
		rig.shake( at, FIREBALL_SHAKE );

	};

	// While a spell is in the air the camera belongs to the spell, not the quill.
	let castLock = false;

	/** Seconds left of the beat a cast holds the camera for, whatever else is going on. */
	let castWatch = 0;

	/**
	 * A resolved sigil is a sequence, not an instant.
	 *
	 * Everything used to happen on one frame: the ink lit up, the spell went off
	 * and the camera left for the seat, all at once. So the one moment the whole
	 * interaction is built towards — *your* line, finished, catching light — played
	 * out on a page that was already sliding out of frame. You never saw the sigil
	 * you drew do anything.
	 *
	 * Three beats now. The sigil lights up while the camera is still over it; then
	 * the camera leaves; then the spell goes off, timed to land as the camera
	 * arrives.
	 *
	 * `SIGIL_FLARE` is not a taste, it is `INK_BURN_SECONDS`: a cast puts the ink
	 * into a burn that runs the fade at `INK_BURN_RATE`, which drags the front along
	 * every remaining stroke in exactly that long. Holding the page for it means
	 * holding it for precisely as long as there is something happening on it — the
	 * whole sigil going up — and not one frame more.
	 *
	 * `CAMERA_LEAD` then covers most of the lean-out, which eases at 4.5 and so is
	 * about two thirds done by 0.3 s. The spell fires into a camera that has
	 * essentially arrived, which is what makes the fireball read as launching
	 * *from* the page you are leaving rather than as something already in the air.
	 */
	const SIGIL_FLARE = INK_BURN_SECONDS;
	const CAMERA_LEAD = 0.3;

	/**
	 * How long the sigil's own light-up lasts and how far over full it starts.
	 *
	 * The page has an emissive term that the *countdown* drives: as the quill holds
	 * still, `recorder.charge` ramps 0 → 1 and the ink lights in the spell's colour,
	 * which is how you can tell a sigil is about to take. And then it resolves —
	 * `charge` drops to zero, and with it the glow. So the page went **dark** on the
	 * exact frame it was supposed to catch light, and what was left of the "flare"
	 * was a fade front eating an unlit line.
	 *
	 * This is that glow, driven from the cast instead of from the countdown: full
	 * and then some, decaying over the length of the burn, so the finished sigil
	 * flashes and burns down rather than merely disappearing. 1.2 s is `burnAway`'s
	 * own figure — the light goes out as the last of the line does.
	 */
	const FLARE_GLOW = 1.2;
	const FLARE_PEAK = 1.2;

	let flareLeft = 0;
	let flareGlow = 0;
	let launchLeft = 0;
	let launch: ( () => void ) | null = null;

	/**
	 * The shortest a cast may keep the camera sat back, in seconds.
	 *
	 * A floor under the spells' own `active` flags, and in practice the bolt's
	 * number alone: the fireball reports itself running for 3.2 s, the ward 3.8 and
	 * the rune 4.1, all of them well past this. The bolt is over in 0.45 s and
	 * stops reporting itself at 1.15, which is where a 1.2 s floor left the camera
	 * turning for the page **while the spell's own sound was still playing** — the
	 * sample runs 1.5 s. The crack, the flash, the light draining off the walls and
	 * the dummy ringing for another 0.7 s were all still going on behind it.
	 *
	 * 2.4 s carries the sound and leaves a beat of quiet room after it. It is still
	 * the shortest of the four, which is right — a bolt is a sharp thing and should
	 * not be held as long as a dome standing in the middle of the floor.
	 */
	const CAST_WATCH = 2.4;

	/** Camera displacement at the source when the fireball goes off, in metres. */
	const FIREBALL_SHAKE = 0.075;

	/**
	 * Seconds the camera takes to walk in from behind the seat.
	 *
	 * Longer than the 1.1 s the title screen takes to fly past, so the move you
	 * watch it settle into is the room's and not the overlay's. Much under two
	 * seconds and the wide shot is gone before it has been read; much over three
	 * and you are waiting to be allowed to touch the page.
	 */
	const ARRIVAL = 2.2;

	const recorder = new StrokeRecorder( canvas, rig.camera, ink, buildRecognizer(), {

		onHover: ( overPage ) => {

			// Leaning in on hover rather than on click means the camera has already
			// settled by the time the first stroke lands.
			if ( ! rig.isFree && ! castLock ) rig.lean( overPage ? 1 : 0 );

			// Reaching for the page is the clearest statement that you are done
			// looking around, so it doubles as "face the desk again".
			if ( overPage ) rig.recentre();

			canvas.style.cursor = overPage ? 'crosshair' : 'grab';

		},

		onDrawStart: () => {

			// Starting a stroke takes the camera back from whatever had it — a
			// lean-out hover began on the way to the page, a spell still in the air,
			// the arrival itself. It is the most deliberate statement the player can
			// make about where they want to be looking.
			//
			// And it is not only about the shot. **The sigil is matched in screen
			// space, so the framing it is drawn in is part of its shape.** Measured
			// by projecting the sheet's own corners: leaned in it is 1.04 times wider
			// than tall on screen, and from the seat it is 2.03 — so a Z drawn to
			// fill the page from back there arrives at the recogniser twice as wide
			// as tall, outside the widest exemplar the bolt has. The same traced Z
			// casts Lightning at 61% leaned in and comes back *"Illegible — closest
			// was pentagram"* from the seat. Whatever else it is doing, this line is
			// what keeps the page the shape the templates were drawn for.
			castLock = false;

			if ( ! rig.isFree ) rig.lean( 1, true );

			// Hold the framing until the sigil resolves.
			rig.setLocked( true );

			// Browsers only allow audio once the page has been interacted with.
			chime.prime();
			hud.reading( null, 'the quill is wet…', 0, false );

		},

		// The page reads along as you write: the ink takes on the spell's colour
		// and the grimoire lights the matching sigil, well before it casts.
		onPreview: ( match ) => {

			const spell = match === null ? undefined : spellForGlyph( match.name );

			hud.highlight( spell?.glyph ?? null );
			ink.setGlowColor( spell?.ink ?? IDLE_GLOW );
			motes.setColor( spell?.ink ?? IDLE_GLOW );

			if ( match === null ) hud.reading( null, 'reading the sigil…', 0, false );
			else if ( spell !== undefined ) hud.reading( spell.title, 'hold still to cast', match.score, true );
			else hud.reading( match.name, `${ match.name } — bound to nothing`, match.score, false );

		},

		onCast: ( { match, accepted, origin, shape } ) => {

			rig.setLocked( false );
			rig.recentre();

			const spell = accepted ? spellForGlyph( match.name ) : undefined;

			if ( spell !== undefined ) {

				ink.setGlowColor( spell.ink );
				motes.setColor( spell.ink );

				// The two halves of the same moment. `burnAway` runs the fade at
				// `INK_BURN_RATE`, which drags the fade front along every remaining
				// stroke inside `INK_BURN_SECONDS` — so the emitter is already being
				// hauled over the whole sigil. `flare` supplies what the drawing phase
				// deliberately withholds: the line goes up as a sheet rather than being
				// eaten a few centimetres at a time.
				//
				// This is the beat the camera used to talk over, and it is now the
				// first of the three — see `SIGIL_FLARE`.
				ink.burnAway( 1.2 );
				motes.flare();

				// The camera is the spell's from here, but it does not move yet.
				castLock = true;

				flareGlow = FLARE_GLOW;
				flareLeft = SIGIL_FLARE;
				launchLeft = SIGIL_FLARE + CAMERA_LEAD;
				launch = () => {

					const detail = spell.cast( {
						origin,
						target: castTarget.clone(),
						body: castBody.clone(),
						bodyRadius: castBodyRadius,
						shape,
						effects,
						shake: ( at, energy ) => rig.shake( at, energy ),
					} );

					// Only now does the watch beat start; it is about how long the *spell*
					// keeps the camera, and none of it should be spent on the flare.
					castWatch = CAST_WATCH;

					// The ward is the only spell that reports anything, and it cannot
					// report it until it exists: how wide the dome came out and how long
					// it will stand are decided inside `cast`.
					if ( detail !== undefined ) hud.report( spell.title, detail, match.score, true );

				};

				// Named as the sigil lights up, not when the spell lands. The page has
				// just told you what you drew; that is the moment it is worth saying.
				hud.report( spell.title, `${ match.name } · ${ ( match.score * 100 ).toFixed( 0 ) }% certain`, match.score, true );

			} else if ( accepted ) {

				ink.burnAway( 0.8 );
				hud.report( 'The sigil sputters', `${ match.name } is legible, but bound to nothing`, match.score, false );

			} else {

				ink.burnAway( 0.8 );
				hud.report( 'Illegible', `closest was ${ match.name ?? 'nothing' } at ${ ( match.score * 100 ).toFixed( 0 ) }%`, match.score, false );

			}

		},

		onClear: () => {

			rig.setLocked( false );
			hud.status( 'the page is blank' );

		},

	} );

	/**
	 * True while a spell still has the room.
	 *
	 * The ward is in here for the same reason the other three are, and it took
	 * being wrong once to see it: a dome is not over when it has finished going
	 * up. Released on the watch beat alone the camera left for the page 1.2 s in,
	 * with the shell still standing and the light still on the floor — the cast
	 * you wait longest for and the one you got to look at least. It reports itself
	 * active through the rise, the hold and the collapse, which is exactly as long
	 * as there is something to see.
	 *
	 * The fireball is asked a narrower question — `airborne` rather than `active` —
	 * because its ash goes on falling for three seconds after the fire is out, and
	 * the camera should not wait for that. It keeps being *stepped* the whole time,
	 * since particles only move while their field is stepped; it just stops being
	 * something the cast sequence waits on. Flakes still coming down behind you as
	 * you turn back to the page is the point of having them.
	 */
	const spellRunning = (): boolean =>
		effects.fireball.airborne || effects.lightning.active || effects.rune.active || effects.ward.active;

	/**
	 * Hands the page back when the spell is done with the camera.
	 *
	 * The cast sat the camera back to watch, and where it goes next is a question
	 * about the hand, not about the spell: a quill still resting over the
	 * parchment is someone waiting to write the next sigil, so the camera leans
	 * back in and they can simply draw. Before this they had to *click* the page
	 * to get it back — hover only fires on a crossing and the pointer had not
	 * moved — and that click was a pointerdown on the parchment, so it started a
	 * stroke and left a blot of ink under the cursor every time.
	 *
	 * A quill that is somewhere else gets nothing: it lays itself back down on the
	 * desk on its own, and the camera stays sat back where the spell left it,
	 * because leaning in over a page nobody is holding a pen to is the room moving
	 * for its own reasons.
	 */
	const releasePage = (): void => {

		// Not while something else owns the view: the free camera answers to nobody,
		// and a look-around drag is a turn in progress that leaning in would undo.
		// A stroke already begun needs no help — starting one forces the framing and
		// locks it, which makes the `lean` below a no-op anyway.
		if ( rig.isFree || recorder.hoverSuspended ) return;
		if ( ! recorder.overParchment ) return;

		rig.returnToPage();

	};

	// Drag off the page to look around; the recorder gets first refusal on the
	// pointer, so a drag that starts on the parchment still draws.
	new LookAround(
		canvas,
		rig,
		() => recorder.activePoint !== null,
		( turning ) => {

			recorder.hoverSuspended = turning;

		},
	);

	// The room is lit almost entirely by small emissive sources, which is the case
	// direct lighting handles worst — so the pipeline carries screen-space GI as
	// well as bloom.
	const post = new Post( renderer, scene, rig.camera, effects.flash.node );

	observeViewport( canvas, ( width, height ) => {

		// The pixel ratio first, because it is chosen *from* this size — see
		// `Resolution`, which spends a budget of pixels rather than trusting a ratio
		// to mean the same thing in a small window and a large one.
		resolution.fit( width, height );

		// `false` leaves the canvas' CSS box alone: the stylesheet stretches it to
		// the window, and three writing inline px sizes would freeze it at whatever
		// size it happened to have when the page loaded.
		renderer.setSize( width, height, false );
		rig.setViewport( width, height );

	} );

	window.addEventListener( 'keydown', ( event ) => {

		const key = event.key.toLowerCase();

		if ( key === 'x' ) recorder.wipe();
		if ( key === 'escape' ) {

			rig.recentre();
			rig.lean( 0, true );

		}
		if ( key === 'g' ) hud.status( `lighting: ${ post.cycle() }` );
		if ( key === 'm' ) {

			const playing = ambience.toggle();

			hud.setMusic( playing );
			hud.status( playing ? 'music on' : 'music off' );

		}
		if ( key === 'c' ) {

			const free = rig.toggleFree();
			recorder.enabled = ! free;
			hud.status( free ? 'free camera — drag to orbit, C to sit back down' : 'seated at the desk' );

		}

	} );

	/** See the frame loop: a fixed simulation step for frame-exact captures. */
	const debugClock = { fixedStep: 0, frames: 0 };

	if ( import.meta.env.DEV ) {

		Object.assign( window, {
			atelierDebug: {
				clock: debugClock,
				renderer, scene, rig, ink, motes, atelier, recorder, effects, quill, post, resolution, ambience, chime, inkSfx,
				/** The matcher's internals, for tuning experiments. */
				pdollar,
				/**
				 * `await atelierDebug.profile()` — frame times over the next few
				 * seconds, as percentiles, plus how many frames ran long.
				 *
				 * Here because a dropped frame is not the same problem as a low frame
				 * rate and the two feel alike: a stutter you can see is often a p99 of
				 * 60 ms sitting behind a perfectly good median. Run it *while* the
				 * thing that stutters is happening — the numbers say which it is, and
				 * `renderMs` says whether the time is going into this scene at all or
				 * into something else on the machine.
				 */
				/**
				 * `atelierDebug.watch()` — leave it running and play normally; every
				 * frame that overruns is logged with where its time went. Returns a
				 * function that stops it.
				 *
				 * `profile()` needs you to catch the stutter inside a fixed window,
				 * which is hard when it happens once in ten seconds. This just waits
				 * for it. A long frame with every stage near zero is the GPU or the
				 * machine; a long frame with one stage large is ours, and it names it.
				 */
				watch: ( threshold = 25 ) => {

					const step = post.render.bind( post );

					let spent = 0;

					post.render = () => {

						const started = performance.now();
						step();
						spent = performance.now() - started;

					};

					profiling = true;

					let running = true;
					let last = performance.now();
					let previous = { ...stage };
					let seen = 0;

					const tick = (): void => {

						if ( ! running ) return;

						const now = performance.now();
						const elapsed = now - last;

						last = now;

						const keys = Object.keys( stage ) as ( keyof typeof stage )[];
						const delta: Record<string, number> = { render: Math.round( spent * 100 ) / 100 };

						for ( const key of keys ) {

							delta[ key ] = Math.round( ( stage[ key ] - previous[ key ] ) * 100 ) / 100;

						}

						previous = { ...stage };

						if ( elapsed > threshold ) {

							seen ++;
							console.warn( `[atelier] long frame ${ elapsed.toFixed( 1 ) } ms (#${ seen })`, delta );

						}

						requestAnimationFrame( tick );

					};

					requestAnimationFrame( tick );

					console.info( `[atelier] watching for frames over ${ threshold } ms — play normally, then call the returned function to stop.` );

					return (): number => {

						running = false;
						profiling = false;
						post.render = step;

						return seen;

					};

				},
				profile: ( seconds = 6 ) => new Promise( ( resolve ) => {

					const frames: number[] = [];
					const render: number[] = [];
					const step = post.render.bind( post );

					let spent = 0;

					post.render = () => {

						const started = performance.now();
						step();
						spent = performance.now() - started;

					};

					for ( const key of Object.keys( stage ) as ( keyof typeof stage )[] ) stage[ key ] = 0;

					profiling = true;

					let last = performance.now();
					const started = last;

					const tick = (): void => {

						const now = performance.now();

						frames.push( now - last );
						render.push( spent );
						stage.render += spent;
						last = now;

						if ( now - started < seconds * 1000 ) {

							requestAnimationFrame( tick );
							return;

						}

						profiling = false;
						post.render = step;

						const sorted = frames.slice().sort( ( a, b ) => a - b );
						const at = ( p: number ): number => Math.round( sorted[ Math.floor( sorted.length * p ) ] * 10 ) / 10;
						const per = ( total: number ): number => Math.round( ( total / frames.length ) * 100 ) / 100;

						resolve( {
							frames: frames.length,
							fps: Math.round( frames.length / ( ( now - started ) / 1000 ) ),
							p50: at( 0.5 ),
							p90: at( 0.9 ),
							p99: at( 0.99 ),
							worst: Math.round( Math.max( ...frames ) * 10 ) / 10,
							longFrames: frames.filter( ( f ) => f > 25 ).length,

							// Average milliseconds a stage costs per frame. These are CPU
							// only: `render` is the time spent *queueing* the pipeline, not
							// the GPU's time executing it, so a large gap between the frame
							// time and the sum of these means the wait is on the GPU.
							msPerFrame: {
								rig: per( stage.rig ),
								recorder: per( stage.recorder ),
								quill: per( stage.quill ),
								ink: per( stage.ink ),
								spells: per( stage.spells ),
								render: per( stage.render ),
							},

							canvas: [ renderer.domElement.width, renderer.domElement.height ],
						} );

					};

					requestAnimationFrame( tick );

				} ),
				/**
				 * `atelierDebug.demo( 'pentagram' )` — draw a sigil without a mouse,
				 * at writing speed. `demo( 'bolt', 0.34, 0 )` stamps it instantly.
				 */
				demo: ( glyph = 'pentagram', scale = 0.34, seconds = 1.4 ) => {

					// Straight to the writing framing: the trace locks the camera where
					// it finds it, and half-leaned is an odd place to watch from.
					rig.snap( 1 );
					recorder.trace( sampleGlyph( glyph, scale ), seconds );

				},
			},
		} );

	}

	/**
	 * Per-stage frame timing, off unless `atelierDebug.profile()` turns it on.
	 *
	 * A frame that runs long says nothing about *which* part ran long, and the
	 * candidates behave very differently: the ink is a million-thread dispatch that
	 * keeps going for about a second after the page stops changing, recognition
	 * re-reads a growing stroke ten times a second, and `render` is the whole
	 * post pipeline. Timed separately, one run names the culprit.
	 */
	const stage = { rig: 0, recorder: 0, quill: 0, ink: 0, spells: 0, render: 0 };
	let profiling = false;

	const timer = new Timer();

	// Compile every pipeline before the first frame rather than on first use.
	//
	// WebGPU builds a render pipeline the first time a material is actually drawn,
	// and most of this room is not drawn at startup: a fireball's core, the
	// lightning ribbons, the ward's shell and the circle's pillars only reach the
	// screen the first time that spell is cast. So the first cast of each paid for
	// its own compilation, mid-animation, as a stall — which is exactly when it is
	// least welcome and hardest to attribute, because the thing that stutters is
	// the animation rather than the frame that triggered it.
	//
	// `compileAsync` walks what would be rendered, so anything hidden is skipped;
	// everything is shown for the length of the call and put back afterwards.
	// Nothing is drawn in between, so there is no frame where the spells appear.
	// Put the camera where the experience actually opens *before* anything is
	// compiled or drawn, because both are camera-dependent and this one is 2.2 m
	// further back than the seat.
	//
	// `compileAsync` walks the render list for the camera it is given, and a render
	// list is frustum-culled — so warming from the seated framing warmed the seated
	// framing, and the wide shot the door opens on contains geometry that was never
	// in it. Measured: the click handler itself ran in 5.2 ms and the first frame
	// after it took **331 ms**, compiling the shelves and bookcases that only the
	// wide shot can see.
	//
	// It does not cover *everything*. Looking around still builds two pipelines the
	// first time, at about 40 ms each, and they are not frustum-related: warming
	// from a 100°-lens sweep through four right angles was tried and compiled two
	// pipelines that turned out to be different ones, leaving the same two to be
	// built at runtime anyway. It was reverted. Two one-time hitches on the first
	// look are the residue; anything sustained while turning is the frame cost, not
	// compilation.
	//
	// It also stays here. `arrive` sets the offset and applies it immediately, and
	// nothing advances it until `update` runs — which is after the gate — so the
	// camera simply waits at the top of the move.
	rig.arrive( ARRIVAL );

	hud.progress( 0.95, 'Warming the shaders…' );

	const hidden: Object3D[] = [];

	scene.traverse( ( object ) => {

		if ( object.visible ) return;

		hidden.push( object );
		object.visible = true;

	} );

	await renderer.compileAsync( scene, rig.camera );

	for ( const object of hidden ) object.visible = false;

	// …and then draw one frame, because `compileAsync` does not cover the half of
	// the pipeline that costs the most to build.
	//
	// It walks the *scene*, so it warms the room's materials — but everything in
	// `Post` is built inside `RenderPipeline` the first time `render()` is called:
	// the MRT scene pass, SSGI's two node materials, the bloom mip chain, FXAA.
	// Measured, that first call took **820 ms**, and it landed on the frame right
	// after the door opened — the reader pressed "Enter the atelier", the boot
	// screen went, and the room froze for the better part of a second before it
	// moved. The HUD said "Ready." while the most expensive part of the load had
	// not started.
	//
	// One render here pays it behind the boot screen instead, where the wait is
	// already understood. Nothing is visible: `#boot` is opaque and still up.
	hud.progress( 0.97, 'Warming the shaders…' );

	// Twice, and the waits are the point. `post.render()` only *records* the work;
	// the 820 ms is the GPU building the pipelines, and it is spent between one
	// frame and the next rather than inside the call — so the stall only actually
	// happens if we sit through a frame boundary here. The second pass confirms a
	// warm frame costs what a warm frame should.
	for ( let i = 0; i < 2; i ++ ) {

		post.render();

		await new Promise( ( resolve ) => requestAnimationFrame( () => resolve( undefined ) ) );

	}

	hud.progress( 1, 'Ready.' );
	hud.ready();

	// Nothing runs until the door is opened. The press is also the one user
	// gesture the page is guaranteed to get, so both audio paths are unlocked
	// inside the handler rather than after the await — by then it is a promise
	// continuation and no longer counts as a gesture to any browser.
	await gate;

	// The camera has been waiting at the top of the arrival since before the
	// shaders were warmed; the first `update` below is what starts it moving.

	// …and the sound of it, started on the same line so the two cannot drift. The
	// whoosh swells where the camera is fastest and the chimes resolve as it lands,
	// which only works while both are reading the same `ARRIVAL`.
	chime.arrive( ARRIVAL );

	// Both routes to the music go through the HUD, so the button always shows what
	// the track is actually doing rather than what was last asked of it.
	hud.onMusic( () => ambience.toggle() );

	renderer.setAnimationLoop( ( time ) => {

		timer.update( time );

		// Clamped at both ends. The ceiling is the usual one — a tab coming back
		// after a minute must not advance the simulation by a minute — and the floor
		// is for a delta that arrives *negative*, which normal play does not produce
		// but which costs far more than the guard does when it happens.
		//
		// One backwards frame is not a glitch you ride out. `shakeAmount` decays by
		// `exp( -dt * DECAY )`, so a negative dt makes it grow instead: at dt = -490
		// it went to `Infinity` and every camera position after it was `NaN`, which
		// is a black screen for the rest of the session. The spells fare no better —
		// their phase clocks run backwards and the state machines stop advancing, so
		// a fireball sits in `charge` for ever, `castLock` never clears and the page
		// is never handed back. Both were seen while instrumenting this scene, which
		// is where a clock can be fed by hand; three's own `Timer` guards the same
		// class of thing with the Page Visibility API.
		const real = Math.max( 0, Math.min( timer.getDelta(), 1 / 20 ) );

		// Dev only: `atelierDebug.fixedStep = 1 / 60` runs the simulation on exactly
		// that step per rendered frame, whatever the real frame rate. A headless
		// capture at ten frames a second then sees every 60 fps frame in turn —
		// slow motion, frame-exact — which is the only way to judge something that
		// is out of step by a frame or two. `frames` counts them.
		const dt = import.meta.env.DEV && debugClock.fixedStep > 0 ? debugClock.fixedStep : real;

		if ( import.meta.env.DEV ) debugClock.frames ++;

		// The cast sequence: the sigil lights up, then the camera goes, then the
		// spell. Advanced before `rig.update` so the lean-out starts on the very
		// frame the flare finishes rather than the one after it.
		if ( flareLeft > 0 ) {

			flareLeft -= dt;

			// Forced, but still refused while a stroke is under way — someone who has
			// started the next sigil during the flare has taken the page back, and the
			// pending spell can go off without the camera leaving them.
			if ( flareLeft <= 0 && ! rig.isFree ) rig.lean( 0, true );

		}

		if ( launch !== null ) {

			launchLeft -= dt;

			if ( launchLeft <= 0 ) {

				const fire = launch;

				launch = null;
				fire();

			}

		}

		const markRig = profiling ? performance.now() : 0;

		rig.update( dt );

		if ( profiling ) stage.rig += performance.now() - markRig;

		const markRecorder = profiling ? performance.now() : 0;

		recorder.update( dt );

		if ( profiling ) stage.recorder += performance.now() - markRecorder;

		const markQuill = profiling ? performance.now() : 0;

		quill.update( recorder.activePoint, dt, recorder.writing );

		if ( profiling ) stage.quill += performance.now() - markQuill;

		// Half-drawn but already legible: glow enough to read, but keep the full
		// blaze for the moment the sigil actually resolves.
		const preview = recorder.preview;
		const hint = preview === null
			? 0
			: 0.5 * Math.min( 1, Math.max( 0, ( preview.score - RECOGNITION_THRESHOLD ) / ( 1 - RECOGNITION_THRESHOLD ) ) );

		// …and this is that blaze. Past 1 at the start, which the emissive term is
		// happy to take — it multiplies by 6.5, so the peak lands well over the
		// bloom threshold and the finished sigil haloes off the page.
		if ( flareGlow > 0 ) flareGlow -= dt;

		const lit = flareGlow > 0 ? ( flareGlow / FLARE_GLOW ) ** 0.7 * ( 1 + FLARE_PEAK ) : 0;

		ink.setGlow( Math.max( recorder.charge, hint, lit ) );

		const markInk = profiling ? performance.now() : 0;

		ink.update( dt );

		// After the ink, so the front the motes read is this frame's.
		motes.update( dt );

		// …and after the motes, so the burn it hears is this frame's too. The nib
		// only counts while it is on the paper: a hovering quill and a stroke that
		// has run off the sheet are both silent.
		inkSfx.update( dt, recorder.inking ? recorder.activePoint : null, recorder.stroke, motes.burn );

		if ( profiling ) stage.ink += performance.now() - markInk;

		const markSpells = profiling ? performance.now() : 0;

		if ( effects.fireball.active ) effects.fireball.update( dt );
		if ( effects.lightning.active ) effects.lightning.update( dt );

		// The ward is the one thing in the room the player's own spells can hit.
		if ( effects.fireball.active && effects.ward.active ) {

			const impact = effects.ward.intercept( effects.fireball.position );

			if ( impact !== null ) effects.fireball.detonateAt( impact );

		}

		effects.ward.update( dt );
		effects.recoil.update( dt );

		// The circle answers whatever is in the air above it, and keeps turning
		// even when nothing is, so it updates unconditionally.
		// The floating lights wander and breathe whatever else is happening.
		atelier.orbs.update( dt );

		effects.rune.setAmbient( effects.fireball.active || effects.lightning.active ? 0.28 : 0 );
		effects.rune.update( dt );
		effects.flash.update( dt );

		if ( profiling ) stage.spells += performance.now() - markSpells;

		if ( castLock ) {

			castWatch -= dt;

			// `launch !== null` covers the flare, where no effect is running yet and
			// the watch beat has not started: without it the page would be handed
			// straight back on the first frame after the sigil resolved.
			if ( launch === null && castWatch <= 0 && ! spellRunning() ) {

				// Cleared first: handing the page back goes through the same hover
				// handler the pointer uses, and that one defers to `castLock`.
				castLock = false;
				releasePage();

			}

		}

		post.render();

	} );

}

main().catch( ( error ) => {

	console.error( error );

	const hud = document.getElementById( 'boot-msg' );

	if ( hud !== null ) hud.innerHTML = `<span class="fatal">${ error instanceof Error ? error.message : String( error ) }</span>`;

} );
