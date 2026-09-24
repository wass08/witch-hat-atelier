/**
 * The room's audio device.
 *
 * Mostly synthesised rather than loaded: a struck bell is a handful of
 * inharmonic partials over an exponential decay, so a few oscillators cost less
 * than shipping a wav. Where a sound is genuinely a recording — the fireball —
 * it is decoded into a buffer here rather than played from an `<audio>` element,
 * because one-shots want to overlap, want no start latency, and want to share
 * this master gain instead of drifting against it. The ambient loop is the one
 * thing that stays outside; see `Ambience`.
 *
 * The context is created lazily and only ever after the player has clicked
 * something, which is what browsers require before they will let a page make
 * noise.
 */

/**
 * Peak level of the arrival whoosh, and now the only level the arrival has.
 *
 * Measured rather than judged: this is the RMS peak of a brown-noise bed, which
 * is far quieter per unit of gain than a tone at the same figure. 0.09 was
 * inaudible under the ambient loop. Check it against `Ambience`'s 0.15 rather
 * than against the spell one-shots.
 */
const WHOOSH_GAIN = 0.17;

export class Chime {

	private context: AudioContext | null = null;
	private master: GainNode | null = null;
	private failed = false;

	/** Decoded one-shots, by the name they were loaded under. */
	private readonly samples = new Map<string, AudioBuffer>();

	/** Call from an input handler so the context exists before a spell needs it. */
	prime(): void {

		this.ensure();

	}

	/**
	 * The context and the master gain, for another voice that wants to share them
	 * — or null until {@link prime} has made them.
	 *
	 * Never creates the context, unlike everything else here. It is read every
	 * frame by `InkSfx`, including the frames before the welcome gate, and a
	 * context made outside a gesture is born suspended and costs a console warning
	 * in every browser. Waiting for the gate's own `prime` means the continuous
	 * sounds are unlocked by the same click as the one-shots, on the same clock,
	 * through the same master: one device, not two drifting against each other.
	 */
	get bus(): { context: AudioContext; output: GainNode } | null {

		if ( this.context === null || this.master === null ) return null;

		return { context: this.context, output: this.master };

	}

	/**
	 * Fetches and decodes a one-shot, ready for {@link play}.
	 *
	 * Call it after {@link prime}, from the same gesture: decoding needs the
	 * context, and the context does not exist until the page has been clicked.
	 * A failure here is a missing sound and nothing worse, so it is swallowed —
	 * `play` simply does nothing for a name that never arrived.
	 */
	async load( name: string, url: string ): Promise<void> {

		const context = this.ensure();

		if ( context === null || this.samples.has( name ) ) return;

		try {

			const response = await fetch( url );

			this.samples.set( name, await context.decodeAudioData( await response.arrayBuffer() ) );

		} catch ( error ) {

			console.warn( `Chime: could not load "${ name }"`, error );

		}

	}

	/** How long a loaded one-shot runs for, or null if it never arrived. */
	duration( name: string ): number | null {

		return this.samples.get( name )?.duration ?? null;

	}

	/**
	 * Fires a loaded one-shot. Each call gets its own source node — they are
	 * single-use by specification — so casting twice in quick succession overlaps
	 * rather than cutting the first off.
	 */
	play( name: string, gain = 1 ): void {

		const context = this.ensure();
		const buffer = this.samples.get( name );

		if ( context === null || buffer === undefined || this.master === null ) return;

		const source = context.createBufferSource();
		const level = context.createGain();

		source.buffer = buffer;
		level.gain.value = gain;

		source.connect( level ).connect( this.master );
		source.start();

	}

	/** Soft struck bell — the ward going up. */
	ring( root = 784, gain = 0.16 ): void {

		const context = this.ensure();

		if ( context === null ) return;

		// Bell partials: not harmonic, which is what stops it sounding like an organ.
		const partials = [ 1, 2.01, 2.76, 3.94, 5.41 ];
		const now = context.currentTime;

		partials.forEach( ( ratio, index ) => {

			const decay = 2.6 / ( 1 + index * 0.7 );
			this.strike( root * ratio, now + index * 0.006, decay, ( gain / ( index + 1.6 ) ), 'sine' );

		} );

	}

	/** Glass giving way — an impact on the ward. */
	crack( intensity = 1 ): void {

		const context = this.ensure();

		if ( context === null || this.master === null ) return;

		const now = context.currentTime;

		// A short burst of filtered noise reads as the shatter…
		const length = Math.floor( context.sampleRate * 0.18 );
		const buffer = context.createBuffer( 1, length, context.sampleRate );
		const data = buffer.getChannelData( 0 );

		for ( let i = 0; i < length; i ++ ) {

			data[ i ] = ( Math.random() * 2 - 1 ) * ( 1 - i / length ) ** 3;

		}

		const noise = context.createBufferSource();
		noise.buffer = buffer;

		const band = context.createBiquadFilter();
		band.type = 'bandpass';
		band.frequency.value = 2600;
		band.Q.value = 0.8;

		const level = context.createGain();
		level.gain.value = 0.22 * intensity;

		noise.connect( band ).connect( level ).connect( this.master );
		noise.start( now );

		// …and a high partial gives it a pitched "tink".
		this.strike( 2100 + Math.random() * 700, now, 0.35, 0.06 * intensity, 'triangle' );

	}

	/**
	 * The way in: a low whoosh under the camera's travel.
	 *
	 * The whoosh is *motion*. It has to swell where the camera is actually moving
	 * fastest, or it reads as a sound effect laid over a shot rather than as the
	 * shot itself — `CameraRig` eases the arrival on a smootherstep, so its speed
	 * peaks at the midpoint and that is where this peaks too, both in the filter's
	 * opening and in the gain.
	 *
	 * It was layered with a pentatonic chime tail resolving as the camera settled,
	 * which is the usual move for this transition and is not what the room wanted:
	 * against a scene whose whole soundtrack is one ambient bed and a struck bell
	 * per spell, chimes on the *door* spent the room's most distinctive sound on
	 * something that is not an event. The whoosh alone says the same thing about
	 * the camera and leaves the bell meaning what it meant.
	 *
	 * **A cold `AudioContext` does not start on the wall clock.** Measured on the
	 * real gesture: the context reports `running` immediately and `currentTime` is
	 * still 0.000, and it then settles about 0.28 s behind `performance.now()` and
	 * stays there. Everything here is scheduled against `currentTime`, so it cannot
	 * be scheduled any earlier than that — the compensation is in the envelope,
	 * which starts at level and peaks ahead of the camera's midpoint rather than on
	 * it. Anything timed to the picture on this first sound has to allow for it.
	 *
	 * @param seconds The camera's own arrival time. Pass `ARRIVAL`; if the two
	 * drift apart the sound stops describing the picture, which is the whole point
	 * of it.
	 */
	arrive( seconds = 2.2 ): void {

		const context = this.ensure();

		if ( context === null || this.master === null ) return;

		const now = context.currentTime;

		// Brown noise, not white. Integrating white noise weights it towards the low
		// end, which is what air moving past you sounds like; white is a hiss and
		// reads as static.
		const length = Math.ceil( context.sampleRate * seconds );
		const buffer = context.createBuffer( 1, length, context.sampleRate );
		const data = buffer.getChannelData( 0 );

		let drift = 0;

		for ( let i = 0; i < length; i ++ ) {

			drift = ( drift + 0.02 * ( Math.random() * 2 - 1 ) ) / 1.02;
			data[ i ] = drift * 3.4;

		}

		const noise = context.createBufferSource();
		noise.buffer = buffer;

		// The filter opens as the camera gathers speed and closes as it lands, so the
		// whoosh brightens through the middle of the move. A static filter over a
		// moving camera is the thing that reads as canned.
		const air = context.createBiquadFilter();
		air.type = 'lowpass';
		air.Q.value = 0.7;
		air.frequency.setValueAtTime( 420, now );
		air.frequency.exponentialRampToValueAtTime( 1100, now + seconds * 0.32 );
		air.frequency.exponentialRampToValueAtTime( 170, now + seconds );

		// **It starts at half level, not at zero.** The camera is already moving on
		// the frame this is called, so a swell that fades *in* is a swell that starts
		// late — and an exponential ramp from near-silence is far slower off the mark
		// than it looks written down: from 0.0001 it is still at a twentieth of its
		// peak a third of the way through. Measured against the wall clock the old
		// envelope peaked at 1.46 s of a 2.2 s move, a good third of a second after
		// the camera's own fastest moment. Presence has to be there on the first
		// frame; the ramp is only the difference between moving and moving fast.
		//
		// The peak sits early for the same reason, and for one more: a freshly
		// created `AudioContext` runs about 0.28 s behind the wall clock the camera
		// is on (see `arrive`'s note), and nothing scheduled at `currentTime` can
		// make that back. Aiming ahead of the camera's midpoint is what lands on it.
		//
		// The tail then decays *past* the end of the move rather than to it. A sound
		// that stops before the picture does is the one you notice.
		const swell = context.createGain();
		swell.gain.setValueAtTime( WHOOSH_GAIN * 0.5, now );
		swell.gain.linearRampToValueAtTime( WHOOSH_GAIN, now + seconds * 0.3 );
		swell.gain.linearRampToValueAtTime( WHOOSH_GAIN * 0.5, now + seconds * 0.8 );
		swell.gain.exponentialRampToValueAtTime( 0.0001, now + seconds * 1.15 );

		noise.connect( air ).connect( swell ).connect( this.master );
		noise.start( now );

	}

	private strike( frequency: number, at: number, decay: number, gain: number, type: OscillatorType ): void {

		const context = this.context;

		if ( context === null || this.master === null ) return;

		const oscillator = context.createOscillator();
		oscillator.type = type;
		oscillator.frequency.value = frequency;

		const envelope = context.createGain();
		envelope.gain.setValueAtTime( 0, at );
		envelope.gain.linearRampToValueAtTime( gain, at + 0.006 );
		envelope.gain.exponentialRampToValueAtTime( 0.0001, at + decay );

		oscillator.connect( envelope ).connect( this.master );
		oscillator.start( at );
		oscillator.stop( at + decay + 0.05 );

	}

	private ensure(): AudioContext | null {

		if ( this.failed ) return null;

		if ( this.context === null ) {

			try {

				this.context = new AudioContext();
				this.master = this.context.createGain();
				this.master.gain.value = 0.9;
				this.master.connect( this.context.destination );

			} catch ( error ) {

				console.warn( 'Chime: no audio available', error );
				this.failed = true;
				return null;

			}

		}

		// Autoplay policy parks the context until the page has been interacted with.
		if ( this.context.state === 'suspended' ) void this.context.resume();

		return this.context;

	}

}
