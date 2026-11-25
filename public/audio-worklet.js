class OsmiumPcmPlayer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.capacity = 48000;
        this.left = new Float32Array(this.capacity);
        this.right = new Float32Array(this.capacity);
        this.readPos = 0;
        this.writePos = 0;
        this.buffered = 0;
        this.muted = false;
        this.port.onmessage = (event) => {
            const msg = event.data;
            if (!msg) return;
            if (msg.type === "mute") {
                this.muted = Boolean(msg.muted);
                if (this.muted) {
                    this.readPos = 0;
                    this.writePos = 0;
                    this.buffered = 0;
                }
                return;
            }
            if (msg.type === "pcm" && msg.left && msg.right) {
                if (this.muted) return;
                const l = msg.left;
                const r = msg.right;
                const count = Math.min(l.length, r.length);
                if (count <= 0) return;
                if (this.buffered + count > 5760) {
                    const drop = Math.min(this.buffered, (this.buffered + count) - 2400);
                    this.readPos = (this.readPos + drop) % this.capacity;
                    this.buffered -= drop;
                }
                for (let i = 0; i < count; i++) {
                    this.left[this.writePos] = l[i];
                    this.right[this.writePos] = r[i];
                    this.writePos = (this.writePos + 1) % this.capacity;
                }
                this.buffered = Math.min(this.capacity, this.buffered + count);
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        const outL = output[0];
        const outR = output.length > 1 ? output[1] : null;
        const frames = outL.length;
        if (this.muted || this.buffered < frames) {
            outL.fill(0);
            if (outR) outR.fill(0);
            return true;
        }
        for (let i = 0; i < frames; i++) {
            outL[i] = this.left[this.readPos];
            if (outR) outR[i] = this.right[this.readPos];
            this.readPos = (this.readPos + 1) % this.capacity;
        }
        this.buffered -= frames;
        return true;
    }
}

registerProcessor("osmium-pcm-player", OsmiumPcmPlayer);
