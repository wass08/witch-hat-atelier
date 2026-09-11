/** Where the loop lives, and how loud it settles. */
const TRACK = '/moonlit-spellroom.mp3';

/**
 * Where the track settles. One constant, read by both the first fade-in and the
 * resume after a mute, so the two cannot end up at different levels.
 *
 * Low on purpose. This is a bed the room sits on, not something being played to
 * anyone: it has to stay under `Chime`'s bell and crack, and under the spells,
 * without either of those having to be pushed up to clear it.
 *
 * 0.15, down from 0.3 — an amplitude halving, so about 6 dB, which is roughly
 * the point at which a listener calls something "half as loud". It was sitting
 * too far forward for a bed: the track is a full stereo mix and the spells it has
 * to stay under are single short hits, so at 0.3 it was the loudest sustained
 * thing in the room and the fireball had to compete with it rather than land on
 * top of it.
 */
const VOLUME = 0.15;

/** Seconds the track takes to come up, and to go back down. */
const FADE_IN = 3.5;
const FADE_OUT = 0.8;

/** How often the fade is stepped. Audio does not need a frame rate. */
const STEP_MS = 40;

/**
 * The room's ambient track.
 *
 * Deliberately an `<audio>` element rather than anything routed through the Web
 * Audio graph the spells use: this is one long stereo loop that wants decoding
 * off the main thread and nothing else, and `Chime` builds its own context
 * lazily for synthesis. Two independent things, kept independent.
 *
 * It only ever starts from {@link start}, which is called out of the click on the
 * welcome gate. That is not a detail — every browser refuses to play audio until
 * the page has been interacted with, and a gate whose whole purpose is to collect
 * that one gesture is the reason the experience opens with a click rather than
 * with a silent room and a console warning.
 */
export class Ambience {

	private readonly audio: HTMLAudioElement;
	private timer: number | null = null;
	private started = false;

	constructor() {

		this.audio = new Audio( TRACK );
		this.audio.loop = true;
		this.audio.preload = 'auto';

		// Starts silent whatever happens, so a browser that grants playback
		// instantly does not open with the track at full level.
		this.audio.volume = 0;

	}

	/** True once the browser has actually agreed to play it. */
	get playing(): boolean {

		return this.started && ! this.audio.paused;

	}

	/**
	 * Must be called synchronously from a user gesture. Resolves either way —
	 * a refused autoplay is a quiet room, not a broken one, and nothing else in
	 * the experience depends on this.
	 */
	async start(): Promise<boolean> {

		if ( this.started ) return true;

		try {

			await this.audio.play();

		} catch {

			return false;

		}

		this.started = true;
		this.ramp( VOLUME, FADE_IN );

		return true;

	}

	/**
	 * Silences the loop or brings it back, and reports where it ended up.
	 *
	 * Muting fades out and then pauses, rather than dropping the volume and
	 * leaving it running: paused is the honest state for a track nobody is
	 * listening to, and it also stops the decode. Coming back has to call `play`
	 * again, which is only allowed because the welcome gate already spent a
	 * gesture on this element — the browser remembers that per element, so
	 * un-muting does not need one of its own.
	 */
	toggle(): boolean {

		if ( this.playing ) {

			this.ramp( 0, FADE_OUT, () => this.audio.pause() );
			return false;

		}

		// Also the recovery path when the gate's own `start` was refused: the click
		// on the button is a fresh gesture, so this may be the first time the track
		// is allowed to run at all.
		this.started = true;

		void this.audio.play().catch( () => undefined );
		this.ramp( VOLUME, FADE_IN * 0.4 );

		return true;

	}

	stop(): void {

		this.ramp( 0, FADE_OUT, () => this.audio.pause() );

	}

	setVolume( level: number ): void {

		this.ramp( Math.min( 1, Math.max( 0, level ) ), 0.4 );

	}

	/** Eases the level towards `target`, replacing any ramp already running. */
	private ramp( target: number, seconds: number, done?: () => void ): void {

		if ( this.timer !== null ) clearInterval( this.timer );

		const from = this.audio.volume;
		const steps = Math.max( 1, Math.round( ( seconds * 1000 ) / STEP_MS ) );
		let step = 0;

		this.timer = window.setInterval( () => {

			step ++;

			const t = Math.min( 1, step / steps );

			// Eased rather than linear: a straight ramp on a volume reads as a fader
			// being pushed, which is exactly the thing a room's ambience should not
			// sound like.
			this.audio.volume = from + ( target - from ) * ( t * t * ( 3 - 2 * t ) );

			if ( t < 1 ) return;

			clearInterval( this.timer! );
			this.timer = null;
			done?.();

		}, STEP_MS );

	}

}
