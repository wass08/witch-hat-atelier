/**
 * The sound of the page: the quill scratching as it writes, and the paper
 * burning as the fade eats the line and the recognised sigil goes up.
 *
 * All of it synthesised, for the same reason as `Chime`'s bell and for one more:
 * these are *continuous* sounds steered by the hand, and a recording can only be
 * started and stopped. A scratch has to get brighter and denser as the nib
 * speeds up and vanish the instant it stops, and the burn has to swell with
 * however much line the fade is eating this frame. Noise through filters whose
 * every knob is a frame-rate parameter is exactly that, and a few kilobytes of
 * code instead of a sample library.
 *
 * It rides `Chime`'s context and master rather than making its own, so the
 * welcome gate's one click unlocks it with everything else and it sits in the
 * same mix as the spells. Nothing is built until that context exists.
 *
 * **Every level here is a smoothed target, re-set each frame, with a dead-man's
 * switch behind it.** Each update schedules the gain towards where it should be
 * *and* a fall to silence a quarter of a second later, which the next update
 * cancels. The frame loop is what keeps the sound alive: a tab sent to the
 * background stops `requestAnimationFrame` but not the audio thread, and without
 * the switch the last frame's scratch would hiss on, unattended, until the
 * player came back.
 */

/** Anything with a clock and somewhere to send sound — `Chime.bus`, or an offline render. */
export interface AudioBus {
	context: BaseAudioContext;
	output: AudioNode;
}

/** A point in world space; only the three numbers are read. */
interface Nib {
	x: number;
	y: number;
	z: number;
}

/**
 * One trim for everything this module makes, on top of the individual levels
 * below. The place to turn the page up or down against the rest of the room
 * without upsetting the balance inside it.
 */
export const INK_SFX_LEVEL = 1;

/*
 * ---- The quill -------------------------------------------------------------
 *
 * Levels are gains on RMS-normalised noise (0.25 RMS), after `Chime`'s 0.9
 * master. Measured offline, a fast stroke peaks around -35 LUFS momentary and
 * a slow one sits some 7 dB lower — under the ambient loop (about -30 as the
 * room plays it: -13 LUFS at 0.15) and 11–20 dB under the spell one-shots
 * (fireball -15, ward -24, as `play` levels them). That is where a desk sound
 * belongs: heard because it is bright and because it moves with the hand, not
 * because it is loud.
 */

/** The fine paper hiss under the nib. */
const HISS_GAIN = 0.035;

/**
 * The grain: tiny ticks of the nib catching fibres. This is most of what makes
 * it read as a *quill on paper* rather than as a hiss that happens to follow
 * the mouse — take it out and the scratch turns into radio static.
 */
const GRAIN_GAIN = 0.09;

/**
 * Nib speed, in metres a second on the page, at which the scratch is at full
 * level and brightness. The sheet is about half a metre across; `demo`'s
 * pentagram runs at ~2 m/s, a careful hand-drawn stroke at a few tenths.
 * Anything faster is allowed a little over full, up to `SCRATCH_CEILING`.
 */
const SCRATCH_SPEED = 1.1;
const SCRATCH_CEILING = 1.3;

/**
 * Below this share of `SCRATCH_SPEED` the nib is resting, not writing. Pointer
 * jitter on a held mouse is a few millimetres a frame, which is enough to
 * whisper if nothing gates it.
 */
const SCRATCH_FLOOR = 0.03;

/**
 * How the speed is followed. Pointer events and frames do not arrive in step,
 * so the raw per-frame distance alternates between nothing and double; rising
 * fast and falling slower bridges those empty frames without blurring the start
 * of a stroke, and a real stop still lets go within about a tenth of a second.
 */
const SPEED_RISE = 0.02;
const SPEED_FALL = 0.07;

/** Gain time constants: the nib is heard at once and gone almost at once. */
const SCRATCH_ATTACK = 0.008;
const SCRATCH_RELEASE = 0.035;

/** The nib touching down on a new stroke — a soft tick, barely there. */
const TOUCH_GAIN = 0.12;

/*
 * ---- The burn --------------------------------------------------------------
 *
 * Driven entirely by `InkMotes.burn`: ~0.3 while an ordinary fade walks a
 * stroke, ~1 through a recognised sigil's burn and flare. Every curve below is
 * steeper than linear on purpose, so the ordinary fade is a quiet smoulder and
 * only the flare gets the room's attention.
 */

/** The low roar of the flame bed, a lowpassed brown noise that opens with the heat. */
const BED_GAIN = 0.2;

/** The fine sizzle of the burning edge, high and thin. */
const SIZZLE_GAIN = 0.02;

/** Pops a second at full burn; an ordinary fade at 0.3 gets about a quarter of it. */
const CRACKLE_RATE = 60;

/** Level of an average pop at full burn, before its random spread. */
const CRACKLE_GAIN = 0.17;

/**
 * The recognised sigil going up: a one-shot whoosh laid over the bed's own
 * swell when the burn crosses `FLARE_ON`, re-armed once it falls below
 * `FLARE_REARM`. An ordinary fade sits around 0.3 and would have to eat more
 * than a page-width a second to get there, so in practice this is the flare's
 * sound alone.
 *
 * Aimed under the spells. Measured offline the flare peaks around -25 LUFS
 * momentary, just under the ward and the rune and ten below the fireball that
 * follows it; the ordinary fade's smoulder is about -38, under the ambience,
 * where it is heard as crackle more than as level.
 */
const WHOOSH_GAIN = 0.17;
const FLARE_ON = 0.72;
const FLARE_REARM = 0.35;

/*
 * ---- Housekeeping ----------------------------------------------------------
 */

/** How far ahead of the frame one-shots are placed, so they are never late. */
const LOOKAHEAD = 0.03;

/** Seconds of silence before a layer's sources are stopped outright. */
const IDLE_STOP = 0.6;

/** How long a level may go unrefreshed before it falls silent on its own. */
const WATCHDOG = 0.25;

/** Most pops in flight at once — a hard ceiling on nodes, not a creative limit. */
const MAX_POPS = 28;

export class InkSfx {

	private context: BaseAudioContext | null = null;
	private out: GainNode | null = null;

	// Baked once, played looped at random offsets so no two strokes start alike.
	private noiseBuffer: AudioBuffer | null = null;
	private grainBuffer: AudioBuffer | null = null;
	private brownBuffer: AudioBuffer | null = null;
	private pops: AudioBuffer[] = [];

	/** Where the hiss loop plugs in: the highpass ahead of `hissFilter`. */
	private hissInput: BiquadFilterNode | null = null;
	private hissFilter: BiquadFilterNode | null = null;
	private hissLevel: GainNode | null = null;
	private grainFilter: BiquadFilterNode | null = null;
	private grainLevel: GainNode | null = null;
	private hiss: AudioBufferSourceNode | null = null;
	private grain: AudioBufferSourceNode | null = null;

	private bedFilter: BiquadFilterNode | null = null;
	private bedLevel: GainNode | null = null;
	private sizzleFilter: BiquadFilterNode | null = null;
	private sizzleLevel: GainNode | null = null;
	private crackleBus: GainNode | null = null;
	private bed: AudioBufferSourceNode | null = null;
	private sizzle: AudioBufferSourceNode | null = null;

	private speed = 0;
	private scratchLevel = 0;
	private readonly last = { x: 0, y: 0, z: 0 };
	private hasLast = false;
	private lastStroke = - 1;
	private scratchQuiet = IDLE_STOP;
	private burnQuiet = IDLE_STOP;
	private flared = false;
	private popsLive = 0;

	/**
	 * @param bus Asked every frame until it answers; after that the answer is
	 * kept. Pass `() => chime.bus`, which stays null until the welcome gate.
	 */
	constructor( private readonly bus: () => AudioBus | null ) {}

	/**
	 * Once a frame, after the ink and the motes.
	 *
	 * @param nib Where the nib is, or null unless it is on the paper and laying
	 * ink — `recorder.inking ? recorder.activePoint : null`. A hovering quill is
	 * silent; so is a stroke that has run off the sheet.
	 * @param stroke `recorder.stroke`, so a jump between strokes is not heard as
	 * a flick of the pen.
	 * @param burn `motes.burn`.
	 */
	update( dt: number, nib: Nib | null, stroke: number, burn: number ): void {

		const context = this.connect();

		if ( context === null || dt <= 0 ) return;

		const now = context.currentTime;

		this.updateScratch( context, now, dt, nib, stroke );
		this.updateBurn( context, now, dt, burn );

	}

	private updateScratch( context: BaseAudioContext, now: number, dt: number, nib: Nib | null, stroke: number ): void {

		let raw = 0;

		if ( nib !== null ) {

			const continuing = this.hasLast && stroke === this.lastStroke;

			if ( continuing ) {

				raw = Math.hypot( nib.x - this.last.x, nib.y - this.last.y, nib.z - this.last.z ) / dt;

			} else {

				// The nib has just met the paper. Heard as the faintest tick, which is
				// what lets a slow careful stroke *begin* audibly instead of fading up
				// out of nothing as the hand gets going.
				this.touch( context, now );

			}

			this.last.x = nib.x;
			this.last.y = nib.y;
			this.last.z = nib.z;

		}

		this.hasLast = nib !== null;
		this.lastStroke = stroke;

		// A lifted pen lets go at the fast rate: the scratch should stop *with* the
		// hand, and the bridging that `SPEED_FALL` does is only for the gaps between
		// pointer events inside a stroke.
		const tau = nib === null ? SCRATCH_ATTACK * 3 : raw > this.speed ? SPEED_RISE : SPEED_FALL;

		this.speed += ( raw - this.speed ) * ( 1 - Math.exp( - dt / tau ) );

		const pace = Math.min( SCRATCH_CEILING, this.speed / SCRATCH_SPEED );

		// Past the floor, on a gentle power curve: loudness is heard roughly
		// logarithmically, so a slow stroke at a third of full speed still wants
		// well over a third of the level or it simply disappears.
		const level = pace <= SCRATCH_FLOOR ? 0 : ( ( pace - SCRATCH_FLOOR ) / ( 1 - SCRATCH_FLOOR ) ) ** 0.6;

		if ( level > 0 ) {

			this.scratchQuiet = 0;
			this.startScratch( context, now );

		} else {

			this.scratchQuiet += dt;

		}

		if ( this.hiss === null || this.grain === null ) return;

		if ( this.scratchQuiet > IDLE_STOP ) {

			this.hiss.stop( now + 0.05 );
			this.grain.stop( now + 0.05 );
			this.hiss = null;
			this.grain = null;
			return;

		}

		const brightness = Math.min( 1, pace );

		// Faster is higher and denser, which is what a quicker nib actually does:
		// the same fibres, crossed more of them per second. Playback rate does both
		// at once — it lifts the hiss's spectrum and packs the baked ticks closer.
		this.hiss.playbackRate.setTargetAtTime( 0.85 + 0.4 * brightness, now, 0.03 );
		this.grain.playbackRate.setTargetAtTime( 0.55 + 0.9 * pace, now, 0.03 );
		this.hissFilter!.frequency.setTargetAtTime( 1900 + 2800 * brightness, now, 0.03 );

		const tauGain = level > this.scratchLevel ? SCRATCH_ATTACK : SCRATCH_RELEASE;

		this.scratchLevel = level;

		drive( this.hissLevel!.gain, HISS_GAIN * level, now, tauGain );
		drive( this.grainLevel!.gain, GRAIN_GAIN * level, now, tauGain );

	}

	private updateBurn( context: BaseAudioContext, now: number, dt: number, burn: number ): void {

		const heat = burn < 0.005 ? 0 : Math.min( 1, burn );

		if ( heat > 0 ) {

			this.burnQuiet = 0;
			this.startBurn( context, now );

		} else {

			this.burnQuiet += dt;

		}

		// Crossing up is the sigil igniting — nothing else takes the burn this high.
		if ( ! this.flared && heat > FLARE_ON ) {

			this.flared = true;
			this.whoosh( context, now );

		} else if ( this.flared && heat < FLARE_REARM ) {

			this.flared = false;

		}

		if ( this.bed === null || this.sizzle === null ) return;

		if ( this.burnQuiet > IDLE_STOP ) {

			this.bed.stop( now + 0.05 );
			this.sizzle.stop( now + 0.05 );
			this.bed = null;
			this.sizzle = null;
			return;

		}

		// `burn` is already smoothed at the source, so these only need to be glued
		// to it, not to hide steps in it.
		this.bedFilter!.frequency.setTargetAtTime( 260 + 1500 * heat ** 1.3, now, 0.05 );

		drive( this.bedLevel!.gain, BED_GAIN * heat ** 1.4, now, 0.05 );
		drive( this.sizzleLevel!.gain, SIZZLE_GAIN * heat ** 1.3, now, 0.05 );

		// Crackle as a Poisson process, scattered across the frame just gone plus
		// the lookahead, so its rhythm belongs to the fire and not to the frame rate.
		const count = poisson( CRACKLE_RATE * heat ** 1.1 * dt );

		for ( let i = 0; i < count; i ++ ) {

			this.pop( context, now + LOOKAHEAD + Math.random() * dt, heat );

		}

	}

	/** One ember snapping: a baked burst through a bandpass with its own centre. */
	private pop( context: BaseAudioContext, at: number, heat: number ): void {

		if ( this.popsLive >= MAX_POPS || this.crackleBus === null ) return;

		const source = context.createBufferSource();
		source.buffer = this.pops[ Math.floor( Math.random() * this.pops.length ) ];

		// Random centre, spread logarithmically: most pops sit in the bright
		// 1.5–4 kHz band where paper crackle lives, a few drop low enough to read
		// as something heavier giving way.
		const band = context.createBiquadFilter();
		band.type = 'bandpass';
		band.frequency.value = 900 * 6.5 ** Math.random();
		band.Q.value = 0.7 + Math.random() * 1.8;

		// Heavy-tailed: nearly all small, the odd one standing out. Evenly sized
		// pops are what makes synthesised crackle sound like rain on a window. The
		// Q term puts back roughly what a narrower band takes away.
		const size = Math.random() ** 2.4 * ( Math.random() < 0.06 ? 2.2 : 1 );
		const level = context.createGain();
		level.gain.value = CRACKLE_GAIN * ( 0.5 + 0.5 * heat ) * ( 0.25 + size ) * ( 0.6 + 0.35 * band.Q.value );

		// Scattered a little across the stereo field: a sheet of paper burning is
		// not a point, and it is the cheapest width there is.
		const pan = context.createStereoPanner();
		pan.pan.value = ( Math.random() * 2 - 1 ) * 0.4;

		source.connect( band ).connect( level ).connect( pan ).connect( this.crackleBus );
		source.onended = () => {

			this.popsLive --;
			source.disconnect();
			pan.disconnect();

		};

		this.popsLive ++;
		source.start( at );

	}

	/**
	 * The sigil going up. Brown noise through a band that opens as the flame
	 * catches and closes as it dies, the same shape as `Chime.arrive` in
	 * miniature — and a handful of pops right on the ignition, because the bed
	 * rises on the burn's own smoothing and a flare wants its first moment sharp.
	 */
	private whoosh( context: BaseAudioContext, now: number ): void {

		if ( this.brownBuffer === null || this.out === null ) return;

		const at = now + LOOKAHEAD;
		const length = 1.5;

		const source = context.createBufferSource();
		source.buffer = this.brownBuffer;

		const band = context.createBiquadFilter();
		band.type = 'bandpass';
		band.Q.value = 0.7;
		band.frequency.setValueAtTime( 320, at );
		band.frequency.exponentialRampToValueAtTime( 1500, at + 0.22 );
		band.frequency.exponentialRampToValueAtTime( 380, at + length );

		const level = context.createGain();
		level.gain.setValueAtTime( 0, at );
		level.gain.linearRampToValueAtTime( WHOOSH_GAIN, at + 0.08 );
		level.gain.setTargetAtTime( WHOOSH_GAIN * 0.55, at + 0.08, 0.18 );
		level.gain.setTargetAtTime( 0, at + 0.5, 0.25 );

		source.connect( band ).connect( level ).connect( this.out );
		source.onended = () => source.disconnect();
		source.start( at, Math.random() * ( this.brownBuffer.duration - length ) );
		source.stop( at + length + 0.2 );

		for ( let i = 0; i < 6; i ++ ) this.pop( context, at + Math.random() * 0.15, 1 );

	}

	/** The nib landing. A pop, but tiny, dull and dead centre. */
	private touch( context: BaseAudioContext, now: number ): void {

		if ( this.out === null || this.pops.length === 0 ) return;

		const source = context.createBufferSource();
		source.buffer = this.pops[ 0 ];

		const band = context.createBiquadFilter();
		band.type = 'bandpass';
		band.frequency.value = 2200 + Math.random() * 800;
		band.Q.value = 1.1;

		const level = context.createGain();
		level.gain.value = TOUCH_GAIN * ( 0.7 + Math.random() * 0.3 );

		source.connect( band ).connect( level ).connect( this.out );
		source.onended = () => source.disconnect();
		source.start( now + 0.005 );

	}

	private startScratch( context: BaseAudioContext, now: number ): void {

		if ( this.hiss !== null ) return;

		this.hiss = loop( context, this.noiseBuffer!, this.hissInput!, now );
		this.grain = loop( context, this.grainBuffer!, this.grainFilter!, now );

	}

	private startBurn( context: BaseAudioContext, now: number ): void {

		if ( this.bed !== null ) return;

		this.bed = loop( context, this.brownBuffer!, this.bedFilter!, now );

		// The same white noise the hiss uses, from wherever a random offset lands —
		// uncorrelated with the scratch even if both are running.
		this.sizzle = loop( context, this.noiseBuffer!, this.sizzleFilter!, now );

	}

	/** Builds the graph the first time the bus exists, and returns its clock. */
	private connect(): BaseAudioContext | null {

		if ( this.context !== null ) return this.context;

		const bus = this.bus();

		if ( bus === null ) return null;

		const context = bus.context;
		const rate = context.sampleRate;

		this.out = context.createGain();
		this.out.gain.value = INK_SFX_LEVEL;
		this.out.connect( bus.output );

		this.noiseBuffer = bakeNoise( context, rate );
		this.grainBuffer = bakeGrain( context, rate );
		this.brownBuffer = bakeBrown( context, rate );
		this.pops = bakePops( context, rate );

		// The quill. A highpass first takes the body out of the white noise so the
		// bandpass is only ever shaping *hiss* — a bandpass alone at this low a Q
		// leaves enough low-mid in it to sound like breath rather than paper.
		const hissLow = context.createBiquadFilter();
		hissLow.type = 'highpass';
		hissLow.frequency.value = 1400;
		hissLow.Q.value = 0.5;

		this.hissFilter = context.createBiquadFilter();
		this.hissFilter.type = 'bandpass';
		this.hissFilter.frequency.value = 2600;
		this.hissFilter.Q.value = 0.7;

		this.hissLevel = context.createGain();
		this.hissLevel.gain.value = 0;

		// Loops connect into the *first* filter of their chain; the hiss's is the
		// highpass, so `hissFilter` is reached through it.
		// Both layers meet in one gentle lowpass before the output. The first
		// offline render had the scratch's spectral centroid sitting at 6–7 kHz,
		// which is the sound of a pin on glass, not a nib on rag paper; real paper
		// scratch has its weight between 2 and 5 kHz and only air above that.
		const tone = context.createBiquadFilter();
		tone.type = 'lowpass';
		tone.frequency.value = 6000;
		tone.Q.value = 0.5;
		tone.connect( this.out );

		hissLow.connect( this.hissFilter ).connect( this.hissLevel ).connect( tone );

		this.grainFilter = context.createBiquadFilter();
		this.grainFilter.type = 'bandpass';
		this.grainFilter.frequency.value = 2800;
		this.grainFilter.Q.value = 1;

		this.grainLevel = context.createGain();
		this.grainLevel.gain.value = 0;

		this.grainFilter.connect( this.grainLevel ).connect( tone );

		// The burn. The highpass under the bed is for the brown noise, which is
		// nearly all sub-bass by construction: below 70 Hz it is rumble a laptop
		// cannot play and a pair of headphones makes into pressure on the ears.
		this.bedFilter = context.createBiquadFilter();
		this.bedFilter.type = 'lowpass';
		this.bedFilter.frequency.value = 300;
		this.bedFilter.Q.value = 0.5;

		const bedLow = context.createBiquadFilter();
		bedLow.type = 'highpass';
		bedLow.frequency.value = 70;
		bedLow.Q.value = 0.6;

		this.bedLevel = context.createGain();
		this.bedLevel.gain.value = 0;

		this.bedFilter.connect( bedLow ).connect( this.bedLevel ).connect( this.out );

		this.sizzleFilter = context.createBiquadFilter();
		this.sizzleFilter.type = 'highpass';
		this.sizzleFilter.frequency.value = 3800;
		this.sizzleFilter.Q.value = 0.5;

		this.sizzleLevel = context.createGain();
		this.sizzleLevel.gain.value = 0;

		this.sizzleFilter.connect( this.sizzleLevel ).connect( this.out );

		this.crackleBus = context.createGain();
		this.crackleBus.connect( this.out );

		this.hissInput = hissLow;
		this.context = context;

		return context;

	}

}

/**
 * Moves a gain towards `target` and arms the dead-man's switch — see the note at
 * the top. Cancelling first is what lets the next frame's call replace the
 * pending fall to silence rather than queue behind it.
 */
function drive( param: AudioParam, target: number, now: number, tau: number ): void {

	param.cancelScheduledValues( now );
	param.setTargetAtTime( target, now, tau );

	if ( target > 0 ) param.setTargetAtTime( 0, now + WATCHDOG, 0.05 );

}

/** Starts a looped buffer into `into`, from a random point so no two starts match. */
function loop( context: BaseAudioContext, buffer: AudioBuffer, into: AudioNode, now: number ): AudioBufferSourceNode {

	const source = context.createBufferSource();
	source.buffer = buffer;
	source.loop = true;
	source.connect( into );
	source.onended = () => source.disconnect();
	source.start( now, Math.random() * buffer.duration );

	return source;

}

/** Knuth's method — the rates here are tiny per frame, where it is exact and cheap. */
function poisson( mean: number ): number {

	if ( mean <= 0 ) return 0;

	const limit = Math.exp( - mean );
	let product = Math.random();
	let count = 0;

	while ( product > limit ) {

		count ++;
		product *= Math.random();

	}

	return count;

}

/**
 * A buffer that loops without a seam: baked `fade` samples long, then the
 * overhang is crossfaded into the start. Equal-power, because the two ends are
 * uncorrelated noise — a linear crossfade of uncorrelated signals dips 3 dB in
 * the middle, and a dip that recurs every couple of seconds is a pulse you hear.
 */
function seamless( context: BaseAudioContext, rate: number, seconds: number, fill: ( data: Float32Array ) => void ): AudioBuffer {

	const length = Math.floor( rate * seconds );
	const fade = Math.floor( rate * 0.05 );
	const raw = new Float32Array( length + fade );

	fill( raw );

	const buffer = context.createBuffer( 1, length, rate );
	const data = buffer.getChannelData( 0 );

	data.set( raw.subarray( 0, length ) );

	for ( let i = 0; i < fade; i ++ ) {

		const t = i / fade;

		data[ i ] = raw[ i ] * Math.sin( t * Math.PI / 2 ) + raw[ length + i ] * Math.cos( t * Math.PI / 2 );

	}

	return buffer;

}

/** Scales to a given RMS and takes out any DC, so every gain above means the same thing. */
function normalise( data: Float32Array, rms: number ): void {

	let mean = 0;

	for ( let i = 0; i < data.length; i ++ ) mean += data[ i ];

	mean /= data.length;

	let power = 0;

	for ( let i = 0; i < data.length; i ++ ) {

		data[ i ] -= mean;
		power += data[ i ] * data[ i ];

	}

	const scale = rms / Math.max( 1e-9, Math.sqrt( power / data.length ) );

	for ( let i = 0; i < data.length; i ++ ) data[ i ] *= scale;

}

/**
 * White noise with a ragged amplitude: a fresh random level every 25 ms, eased
 * between. A pen does not press evenly and paper is not evenly toothed, and a
 * perfectly steady hiss is the thing that gives synthesis away.
 */
function bakeNoise( context: BaseAudioContext, rate: number ): AudioBuffer {

	return seamless( context, rate, 2.3, ( data ) => {

		const step = Math.floor( rate * 0.025 );
		let from = 0.7;
		let to = 0.7;

		for ( let i = 0; i < data.length; i ++ ) {

			if ( i % step === 0 ) {

				from = to;
				to = 0.45 + 0.55 * Math.random();

			}

			const t = ( i % step ) / step;
			const envelope = from + ( to - from ) * t * t * ( 3 - 2 * t );

			data[ i ] = ( Math.random() * 2 - 1 ) * envelope;

		}

		normalise( data, 0.25 );

	} );

}

/**
 * The fibres: sparse clicks, each a fraction of a millisecond of decaying noise,
 * about 110 a second at a playback rate of 1. Sized on a steep curve so most are
 * a whisper and a few catch.
 */
function bakeGrain( context: BaseAudioContext, rate: number ): AudioBuffer {

	return seamless( context, rate, 3.1, ( data ) => {

		let next = 0;

		while ( next < data.length ) {

			const length = Math.floor( rate * ( 0.0004 + Math.random() * 0.0026 ) );
			const decay = length / 3;
			const size = ( 0.15 + 0.85 * Math.random() ** 3 ) * ( Math.random() < 0.5 ? - 1 : 1 );

			for ( let i = 0; i < length && next + i < data.length; i ++ ) {

				data[ next + i ] += size * ( Math.random() * 2 - 1 ) * Math.exp( - i / decay );

			}

			next += Math.floor( - Math.log( 1 - Math.random() ) * rate / 110 ) + 1;

		}

		normalise( data, 0.25 );

	} );

}

/** Brown noise, as `Chime.arrive` makes it: air, not static. */
function bakeBrown( context: BaseAudioContext, rate: number ): AudioBuffer {

	return seamless( context, rate, 3.7, ( data ) => {

		let drift = 0;

		for ( let i = 0; i < data.length; i ++ ) {

			drift = ( drift + 0.02 * ( Math.random() * 2 - 1 ) ) / 1.02;
			data[ i ] = drift;

		}

		normalise( data, 0.25 );

	} );

}

/**
 * Eight embers. The first is always the shortest, a clean tick — `touch` uses
 * it for the nib landing. The rest range from ticks to split cracks (two or
 * three impulses a few milliseconds apart, the way a fibre gives in stages) to
 * short snaps, each normalised to a peak of 1.
 */
function bakePops( context: BaseAudioContext, rate: number ): AudioBuffer[] {

	const pops: AudioBuffer[] = [];

	for ( let n = 0; n < 8; n ++ ) {

		const kind = n === 0 ? 0 : n % 3;
		const seconds = kind === 0 ? 0.004 : kind === 1 ? 0.012 : 0.03;
		const buffer = context.createBuffer( 1, Math.floor( rate * seconds ), rate );
		const data = buffer.getChannelData( 0 );

		const bursts = kind === 1 ? 2 + Math.floor( Math.random() * 2 ) : 1;
		const decay = rate * ( kind === 0 ? 0.0006 : kind === 1 ? 0.0012 : 0.004 );

		for ( let b = 0; b < bursts; b ++ ) {

			const start = b === 0 ? 0 : Math.floor( rate * ( 0.002 + Math.random() * 0.005 ) );
			const size = b === 0 ? 1 : 0.4 + Math.random() * 0.5;

			for ( let i = start; i < data.length; i ++ ) {

				data[ i ] += size * ( Math.random() * 2 - 1 ) * Math.exp( - ( i - start ) / decay );

			}

		}

		let peak = 0;

		for ( let i = 0; i < data.length; i ++ ) peak = Math.max( peak, Math.abs( data[ i ] ) );

		// Faded out over the last millisecond or so, whatever the decay left, so no
		// pop ever ends on a step.
		const tail = Math.min( data.length, Math.floor( rate * 0.001 ) );

		for ( let i = 0; i < data.length; i ++ ) {

			const end = Math.min( 1, ( data.length - 1 - i ) / tail );

			data[ i ] = data[ i ] / Math.max( 1e-9, peak ) * end;

		}

		pops.push( buffer );

	}

	return pops;

}
