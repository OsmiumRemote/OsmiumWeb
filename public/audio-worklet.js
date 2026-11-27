function softLimit(v) {
    const a = Math.abs(v);
    if (a <= 0.94) return v;
    const excess = a - 0.94;
    const limited = 0.94 + 0.055 * (excess / (excess + 0.055));
    return v < 0 ? -limited : limited;
}

class OsmiumPcmPlayer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.capacity = 32768; // power of 2 (~682ms @ 48kHz)
        this.mask = this.capacity - 1;
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.readPos = 0;
        this.fracPos = 0;
        this.writePos = 0;
        this.buffered = 0;
        this.muted = false;
        this.priming = true;
        this.primeFrames = 1728; // 36ms @ 48kHz
        this.playbackRate = 1.0;
        this.fadeInTotal = 240; // 5ms @ 48kHz
        this.fadeInRemaining = 0;
        this.lastL = 0;
        this.lastR = 0;
        this.statsTick = 0;

        this.port.onmessage = (event) => {
            const msg = event.data;
            if (!msg) return;
            if (msg.type === "mute") {
                this.muted = Boolean(msg.muted);
                if (this.muted) {
                    this.resetRing();
                } else {
                    this.priming = true;
                    this.primeFrames = 1728;
                    this.fadeInRemaining = this.fadeInTotal;
                }
                return;
            }
            if (msg.type === "reset") {
                this.resetRing();
                return;
            }
            if (msg.type === "rate") {
                const r = Number(msg.rate);
                if (Number.isFinite(r)) {
                    this.playbackRate = Math.max(0.985, Math.min(1.015, r));
                }
                return;
            }
            if (msg.type === "trim") {
                const target = Math.max(960, Math.min(9600, Math.floor(Number(msg.targetFrames) || 2304)));
                this.trimWithCrossfade(target);
                return;
            }
            if (msg.type === "pcm" && msg.left && msg.right) {
                if (this.muted) return;
                const l = msg.left;
                const r = msg.right;
                const count = Math.min(l.length, r.length);
                if (count <= 0) return;

                if (msg.fadeIn && this.buffered === 0) {
                    this.fadeInRemaining = this.fadeInTotal;
                }

                // Overflow protection with click-free 4ms crossfade trim
                if (this.buffered + count > 14400) {
                    this.trimWithCrossfade(2400);
                }

                const free = this.capacity - 1 - this.buffered;
                const toWrite = Math.min(count, free);
                const startOffset = count - toWrite;
                for (let i = startOffset; i < count; i++) {
                    this.left[this.writePos] = l[i];
                    this.right[this.writePos] = r[i];
                    this.writePos = (this.writePos + 1) & this.mask;
                }
                this.buffered += toWrite;
            }
        };
    }

    resetRing() {
        this.readPos = 0;
        this.fracPos = 0;
        this.writePos = 0;
        this.buffered = 0;
        this.priming = true;
        this.primeFrames = 1728;
        this.playbackRate = 1.0;
        this.fadeInRemaining = this.fadeInTotal;
    }

    trimWithCrossfade(targetFrames) {
        if (this.buffered <= targetFrames + 256) return;
        const drop = this.buffered - targetFrames;
        const xfade = Math.min(192, targetFrames); // 4ms crossfade
        const oldPos = this.readPos;
        const newPos = (this.readPos + drop) & this.mask;
        for (let i = 0; i < xfade; i++) {
            const alpha = i / xfade;
            const oi = (oldPos + i) & this.mask;
            const ni = (newPos + i) & this.mask;
            this.left[ni] = this.left[oi] * (1 - alpha) + this.left[ni] * alpha;
            this.right[ni] = this.right[oi] * (1 - alpha) + this.right[ni] * alpha;
        }
        this.readPos = newPos;
        this.fracPos = 0;
        this.buffered -= drop;
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        const outL = output[0];
        const outR = output.length > 1 ? output[1] : null;
        const frames = outL.length;

        this.statsTick++;
        if (this.statsTick >= 24) {
            this.statsTick = 0;
            this.port.postMessage({ type: "stats", bufferedFrames: this.buffered });
        }

        if (this.muted) {
            for (let i = 0; i < frames; i++) {
                this.lastL *= 0.965;
                this.lastR *= 0.965;
                if (Math.abs(this.lastL) < 1e-6) this.lastL = 0;
                if (Math.abs(this.lastR) < 1e-6) this.lastR = 0;
                outL[i] = this.lastL;
                if (outR) outR[i] = this.lastR;
            }
            return true;
        }

        if (this.priming) {
            if (this.buffered >= this.primeFrames) {
                this.priming = false;
                this.fadeInRemaining = this.fadeInTotal;
            } else {
                for (let i = 0; i < frames; i++) {
                    this.lastL *= 0.965;
                    this.lastR *= 0.965;
                    if (Math.abs(this.lastL) < 1e-6) this.lastL = 0;
                    if (Math.abs(this.lastR) < 1e-6) this.lastR = 0;
                    outL[i] = this.lastL;
                    if (outR) outR[i] = this.lastR;
                }
                return true;
            }
        }

        for (let i = 0; i < frames; i++) {
            if (this.buffered <= 0) {
                this.priming = true;
                this.primeFrames = 1440; // 30ms recovery prime
                this.lastL *= 0.965;
                this.lastR *= 0.965;
                if (Math.abs(this.lastL) < 1e-6) this.lastL = 0;
                if (Math.abs(this.lastR) < 1e-6) this.lastR = 0;
                outL[i] = this.lastL;
                if (outR) outR[i] = this.lastR;
                continue;
            }

            const idx0 = this.readPos;
            const idx1 = this.buffered > 1 ? ((idx0 + 1) & this.mask) : idx0;
            const frac = this.fracPos;

            let sL = this.left[idx0] + (this.left[idx1] - this.left[idx0]) * frac;
            let sR = this.right[idx0] + (this.right[idx1] - this.right[idx0]) * frac;

            sL = softLimit(sL);
            sR = softLimit(sR);

            if (this.fadeInRemaining > 0) {
                const gain = 1.0 - (this.fadeInRemaining / this.fadeInTotal);
                sL *= gain;
                sR *= gain;
                this.fadeInRemaining--;
            }

            outL[i] = sL;
            if (outR) outR[i] = sR;
            this.lastL = sL;
            this.lastR = sR;

            this.fracPos += this.playbackRate;
            const step = Math.floor(this.fracPos);
            if (step > 0) {
                this.fracPos -= step;
                const adv = Math.min(step, this.buffered);
                this.readPos = (this.readPos + adv) & this.mask;
                this.buffered -= adv;
            }
        }

        return true;
    }
}

registerProcessor("osmium-pcm-player", OsmiumPcmPlayer);
