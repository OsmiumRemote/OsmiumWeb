const MAGIC = new Uint8Array([0x4f, 0x53, 0x4d, 0x31]);
const WIRE_VERSION = 2;
const WIRE_ENCRYPTED = 0x10;
const WIRE_PLAIN = 0x11;
const ROLE_CLIENT = 1;
const ROLE_HOST = 2;
const FRAME_HEADER_LEN = 40;

export const APP_PKT = Object.freeze({
    AUTH_REQUEST: 0x10,
    AUTH_RESPONSE: 0x11,
    PING: 0x12,
    PONG: 0x13,
    DISCONNECT: 0x14,
    VIDEO_CHUNK: 0x20,
    VIDEO_IDR_REQUEST: 0x21,
    AUDIO_FRAME: 0x22,
    CLIENT_MIC_AUDIO_FRAME: 0x23,
    AUDIO_PING: 0x24,
    AUDIO_PONG: 0x25,
    AUDIO_CONTROL: 0x26,
    INPUT_KEY: 0x30,
    INPUT_MOUSE_MOVE: 0x31,
    INPUT_MOUSE_BUTTON: 0x32,
    INPUT_MOUSE_WHEEL: 0x33,
    INPUT_UNICODE_TEXT: 0x34,
    INPUT_GAMEPAD: 0x35,
    CONTROL_SWITCH_DISPLAY: 0x38,
    CONTROL_VIDEO_PARAMS: 0x39,
    CONTROL_MOUSE_MODE: 0x3a,
    CONTROL_SYSTEM_ACTION: 0x3d,
    HOST_STATUS_JSON: 0x3f,
    AUX_DATA: 0x40
});

export const AUDIO_FLAG = Object.freeze({
    STREAM_START: 0x01,
    SILENCE_END: 0x02,
    HAS_PREV_REDUNDANT: 0x04
});

export const AUDIO_PING_FLAG_TELEMETRY = 0x01;

export const VIDEO_CODEC = Object.freeze({
    H264: 1,
    HEVC: 2,
    AV1: 3
});

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

export function bytesToHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i].toString(16).padStart(2, "0");
    }
    return s.toUpperCase();
}

export function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

export function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function randomBytes(len) {
    const out = new Uint8Array(len);
    crypto.getRandomValues(out);
    return out;
}

export async function generateClientEcdh() {
    const kp = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"]
    );
    const spkiBuf = await crypto.subtle.exportKey("spki", kp.publicKey);
    const spkiBytes = new Uint8Array(spkiBuf);
    return {
        privateKey: kp.privateKey,
        publicKeyBytes: spkiBytes,
        publicKeyBase64: bytesToBase64(spkiBytes)
    };
}

export async function deriveSessionAesKey(localPrivateKey, peerSpkiBytes, sessionToken16) {
    const peerPub = await crypto.subtle.importKey(
        "spki",
        peerSpkiBytes,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
    );
    const sharedBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: peerPub },
        localPrivateKey,
        256
    );
    const ikm = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
    const aesBits = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: sessionToken16,
            info: textEnc.encode("OSM1-SESSION-KEY-V1")
        },
        ikm,
        256
    );
    return new Uint8Array(aesBits);
}

async function hmacSha256(keyBytes, dataBytes) {
    const k = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", k, dataBytes);
    return new Uint8Array(sig);
}

export async function deriveAudioAesKey(sessionAesKey32) {
    return hmacSha256(sessionAesKey32, textEnc.encode("OSM2-AUDIO-KEY"));
}

export async function computeAccessAuthTag(accessCode, sessionToken16, challengeNonce, clientPub, hostPub) {
    const codeBytes = textEnc.encode(String(accessCode || "").trim().toUpperCase());
    const codeHash = new Uint8Array(await crypto.subtle.digest("SHA-256", codeBytes));
    const total = sessionToken16.length + challengeNonce.length + clientPub.length + hostPub.length;
    const msg = new Uint8Array(total);
    let pos = 0;
    msg.set(sessionToken16, pos); pos += sessionToken16.length;
    msg.set(challengeNonce, pos); pos += challengeNonce.length;
    msg.set(clientPub, pos); pos += clientPub.length;
    msg.set(hostPub, pos);
    return hmacSha256(codeHash, msg);
}

export class OsmiumWireCipher {
    constructor(enableEncryption) {
        this.enableEncryption = Boolean(enableEncryption);
        this.noncePrefix = randomBytes(4);
        this.sendSeq = 1n;
        this.encKey = null;
        this.decKey = null;
    }

    async initKeys(sessionAesKey32) {
        const c2hRaw = await hmacSha256(sessionAesKey32, textEnc.encode("OSM1-C2H-AES256-GCM"));
        const h2cRaw = await hmacSha256(sessionAesKey32, textEnc.encode("OSM1-H2C-AES256-GCM"));
        this.encKey = await crypto.subtle.importKey("raw", c2hRaw, { name: "AES-GCM" }, false, ["encrypt"]);
        this.decKey = await crypto.subtle.importKey("raw", h2cRaw, { name: "AES-GCM" }, false, ["decrypt"]);
    }

    async encodePacket(plainBytes) {
        const seq = this.sendSeq++;
        const wire = new Uint8Array(FRAME_HEADER_LEN + plainBytes.length);
        const dv = new DataView(wire.buffer);
        wire.set(MAGIC, 0);
        wire[4] = WIRE_VERSION;
        wire[5] = this.enableEncryption ? WIRE_ENCRYPTED : WIRE_PLAIN;
        dv.setUint16(6, Number((seq >> 32n) & 0xffffn), true);
        dv.setUint32(8, Number(seq & 0xffffffffn), true);
        if (this.enableEncryption) {
            wire.set(this.noncePrefix, 12);
        }
        wire[16] = ROLE_CLIENT;
        for (let i = 0; i < 7; i++) {
            wire[17 + i] = Number((seq >> BigInt(i * 8)) & 0xffn);
        }
        if (!this.enableEncryption) {
            wire.set(plainBytes, FRAME_HEADER_LEN);
            return wire;
        }
        const nonce = wire.subarray(12, 24);
        const aad = wire.subarray(0, 12);
        const outBuf = new Uint8Array(
            await crypto.subtle.encrypt(
                { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
                this.encKey,
                plainBytes
            )
        );
        const cipherLen = plainBytes.length;
        wire.set(outBuf.subarray(cipherLen, cipherLen + 16), 24);
        wire.set(outBuf.subarray(0, cipherLen), FRAME_HEADER_LEN);
        return wire;
    }

    async decodePacket(wireBytes) {
        if (!wireBytes || wireBytes.length < FRAME_HEADER_LEN) return null;
        if (
            wireBytes[0] !== MAGIC[0] ||
            wireBytes[1] !== MAGIC[1] ||
            wireBytes[2] !== MAGIC[2] ||
            wireBytes[3] !== MAGIC[3] ||
            wireBytes[4] !== WIRE_VERSION
        ) {
            return null;
        }
        const msgType = wireBytes[5];
        if (wireBytes[16] !== ROLE_HOST) return null;
        const dv = new DataView(wireBytes.buffer, wireBytes.byteOffset, wireBytes.byteLength);
        const hi = BigInt(dv.getUint16(6, true));
        const lo = BigInt(dv.getUint32(8, true));
        const seq = (hi << 32n) | lo;
        if (seq === 0n) return null;
        for (let i = 0; i < 6; i++) {
            if (wireBytes[17 + i] !== Number((seq >> BigInt(i * 8)) & 0xffn)) return null;
        }
        if (!this.enableEncryption) {
            if (msgType !== WIRE_PLAIN) return null;
            return wireBytes.subarray(FRAME_HEADER_LEN);
        }
        if (msgType !== WIRE_ENCRYPTED || !this.decKey) return null;
        const cipherLen = wireBytes.length - FRAME_HEADER_LEN;
        const combined = new Uint8Array(cipherLen + 16);
        combined.set(wireBytes.subarray(FRAME_HEADER_LEN), 0);
        combined.set(wireBytes.subarray(24, 40), cipherLen);
        try {
            const plainBuf = await crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: wireBytes.subarray(12, 24),
                    additionalData: wireBytes.subarray(0, 12),
                    tagLength: 128
                },
                this.decKey,
                combined
            );
            return new Uint8Array(plainBuf);
        } catch {
            return null;
        }
    }
}

export function buildAuthRequest(authTag32, width, height, fps, bitrateKbps, codecPref, enableHdr = 0) {
    const buf = new Uint8Array(60);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.AUTH_REQUEST;
    buf.set(authTag32.subarray(0, 32), 4);
    dv.setInt32(36, width | 0, true);
    dv.setInt32(40, height | 0, true);
    dv.setInt32(44, fps | 0, true);
    dv.setInt32(48, bitrateKbps | 0, true);
    dv.setInt32(52, codecPref | 0, true);
    dv.setInt32(56, enableHdr ? 1 : 0, true);
    return buf;
}

export function buildPing(timestampUs) {
    const buf = new Uint8Array(20);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.PING;
    dv.setBigUint64(4, BigInt(Math.max(0, Math.floor(timestampUs))), true);
    dv.setBigUint64(12, 0n, true);
    return buf;
}

export function buildAudioPing(clientTimeUs, lossPermille = 0, playoutBufferMs = 0, jitterMs = 0) {
    const buf = new Uint8Array(24);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.AUDIO_PING;
    buf[1] = AUDIO_PING_FLAG_TELEMETRY;
    dv.setUint16(2, Math.max(0, Math.min(65535, Math.round(jitterMs))), true);
    dv.setBigUint64(4, BigInt(Math.max(0, Math.floor(clientTimeUs))), true);
    dv.setBigUint64(12, 0n, true);
    dv.setUint16(20, Math.max(0, Math.min(1000, Math.round(lossPermille))), true);
    dv.setUint16(22, Math.max(0, Math.min(65535, Math.round(playoutBufferMs))), true);
    return buf;
}

export function buildAudioControl(muted, qualityPreset = 0, targetBitrateKbps = 0) {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.AUDIO_CONTROL;
    buf[4] = muted ? 1 : 0;
    buf[5] = qualityPreset & 0xff;
    dv.setUint16(6, Math.max(0, Math.min(65535, targetBitrateKbps | 0)), true);
    return buf;
}

export function buildDisconnect() {
    const buf = new Uint8Array(4);
    buf[0] = APP_PKT.DISCONNECT;
    return buf;
}

export function buildVideoIdrRequest() {
    const buf = new Uint8Array(4);
    buf[0] = APP_PKT.VIDEO_IDR_REQUEST;
    return buf;
}

export function buildInputKey(vkCode, scanCode, isDown, isExtended) {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.INPUT_KEY;
    dv.setUint16(4, vkCode & 0xffff, true);
    dv.setUint16(6, scanCode & 0xffff, true);
    buf[8] = isDown ? 1 : 0;
    buf[9] = isExtended ? 1 : 0;
    return buf;
}

export function buildInputMouseMove(isAbsolute, xOrDeltaX, yOrDeltaY) {
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.INPUT_MOUSE_MOVE;
    buf[4] = isAbsolute ? 1 : 0;
    dv.setFloat32(8, xOrDeltaX, true);
    dv.setFloat32(12, yOrDeltaY, true);
    return buf;
}

export function buildInputMouseButton(button, isDown) {
    const buf = new Uint8Array(8);
    buf[0] = APP_PKT.INPUT_MOUSE_BUTTON;
    buf[4] = button & 0xff;
    buf[5] = isDown ? 1 : 0;
    return buf;
}

export function buildInputMouseWheel(deltaX, deltaY) {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.INPUT_MOUSE_WHEEL;
    dv.setInt16(4, Math.max(-32767, Math.min(32767, Math.round(deltaX))), true);
    dv.setInt16(6, Math.max(-32767, Math.min(32767, Math.round(deltaY))), true);
    return buf;
}

export function buildInputUnicodeText(text) {
    const utf8 = textEnc.encode(text);
    const buf = new Uint8Array(4 + utf8.length);
    buf[0] = APP_PKT.INPUT_UNICODE_TEXT;
    buf.set(utf8, 4);
    return buf;
}

export function buildInputGamepad(index, connected, buttonsMask, lt, rt, lx, ly, rx, ry) {
    const buf = new Uint8Array(18);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.INPUT_GAMEPAD;
    buf[4] = index & 0xff;
    buf[5] = connected ? 1 : 0;
    dv.setUint16(6, buttonsMask & 0xffff, true);
    buf[8] = Math.max(0, Math.min(255, lt | 0));
    buf[9] = Math.max(0, Math.min(255, rt | 0));
    dv.setInt16(10, Math.max(-32768, Math.min(32767, lx | 0)), true);
    dv.setInt16(12, Math.max(-32768, Math.min(32767, ly | 0)), true);
    dv.setInt16(14, Math.max(-32768, Math.min(32767, rx | 0)), true);
    dv.setInt16(16, Math.max(-32768, Math.min(32767, ry | 0)), true);
    return buf;
}

export function buildControlSwitchDisplay(displayIndex) {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.CONTROL_SWITCH_DISPLAY;
    dv.setInt32(4, displayIndex | 0, true);
    return buf;
}

export function buildControlVideoParams(width, height, fps, bitrateKbps, hdr = 0, yuv444 = 0) {
    const buf = new Uint8Array(28);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.CONTROL_VIDEO_PARAMS;
    dv.setInt32(4, width | 0, true);
    dv.setInt32(8, height | 0, true);
    dv.setInt32(12, fps | 0, true);
    dv.setInt32(16, bitrateKbps | 0, true);
    dv.setInt32(20, hdr ? 1 : 0, true);
    dv.setInt32(24, yuv444 ? 1 : 0, true);
    return buf;
}

export function buildControlMouseMode(mouseMode, hideHostCursor) {
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.CONTROL_MOUSE_MODE;
    dv.setInt32(4, mouseMode | 0, true);
    dv.setInt32(8, hideHostCursor ? 1 : 0, true);
    dv.setInt32(12, 0, true);
    return buf;
}

export function buildControlSystemAction(actionId) {
    const buf = new Uint8Array(8);
    const dv = new DataView(buf.buffer);
    buf[0] = APP_PKT.CONTROL_SYSTEM_ACTION;
    dv.setInt32(4, actionId | 0, true);
    return buf;
}

export function buildAuxPacket(auxPayload) {
    const buf = new Uint8Array(4 + auxPayload.length);
    buf[0] = APP_PKT.AUX_DATA;
    buf.set(auxPayload, 4);
    return buf;
}

export function parseAuthResponse(plain) {
    if (!plain || plain.length < 108) return null;
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const accepted = dv.getInt32(4, true) !== 0;
    const errorCode = dv.getInt32(8, true);
    let end = 12;
    while (end < 108 && plain[end] !== 0) end++;
    const message = textDec.decode(plain.subarray(12, end));
    return { accepted, errorCode, message };
}

export function parsePong(plain) {
    if (!plain || plain.length < 20) return null;
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    return {
        timestampUs: Number(dv.getBigUint64(4, true)),
        hostTimeUs: Number(dv.getBigUint64(12, true))
    };
}

export function parseAudioPong(plain) {
    if (!plain || plain.length < 24) return null;
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    return {
        clientTimeUs: Number(dv.getBigUint64(4, true)),
        hostTimeUs: Number(dv.getBigUint64(12, true))
    };
}

export function parseVideoChunk(plain) {
    if (!plain || plain.length < 28) return null;
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    return {
        frameId: dv.getUint32(4, true),
        chunkIndex: dv.getUint16(8, true),
        totalChunks: dv.getUint16(10, true),
        codecId: plain[12],
        isKeyFrame: plain[13] !== 0,
        width: dv.getUint16(14, true),
        height: dv.getUint16(16, true),
        colorFlags: plain[18],
        captureTimeUs: Number(dv.getBigUint64(20, true)),
        payload: plain.subarray(28)
    };
}

export function parseAudioFrame(plain) {
    if (!plain || plain.length < 28) return null;
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const flags = plain[1];
    const sequence = dv.getUint32(4, true);
    const captureTimeUs = Number(dv.getBigUint64(8, true));
    const sampleRate = dv.getUint16(16, true);
    const channels = plain[18];
    const codecFlags = plain[19];
    const sampleCount = dv.getUint16(20, true);
    const payloadBytes = dv.getUint16(22, true);
    const redundantBytes = dv.getUint16(24, true);
    if (plain.length < 28 + payloadBytes + redundantBytes) return null;
    const payload = plain.subarray(28, 28 + payloadBytes);
    const redundantPayload = (redundantBytes > 0 && (flags & AUDIO_FLAG.HAS_PREV_REDUNDANT) !== 0)
        ? plain.subarray(28 + payloadBytes, 28 + payloadBytes + redundantBytes)
        : null;
    return {
        flags,
        sequence,
        captureTimeUs,
        sampleRate,
        channels,
        codecFlags,
        sampleCount,
        payload,
        redundantPayload
    };
}

export function parseHostStatusJson(plain) {
    if (!plain || plain.length <= 4) return null;
    try {
        return JSON.parse(textDec.decode(plain.subarray(4)));
    } catch {
        return null;
    }
}

const CRC32_TABLE = (() => {
    const tbl = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        tbl[i] = c >>> 0;
    }
    return tbl;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

export class OsmiumAuxClipboard {
    constructor(sendAuxFn, onClipboardText) {
        this.sendAuxFn = sendAuxFn;
        this.onClipboardText = onClipboardText;
        this.nextId = 1;
        this.configSeq = 1;
        this.outgoing = new Map();
        this.incoming = new Map();
    }

    sendFeatureConfig(sharedClipboardEnabled) {
        const buf = new Uint8Array(12);
        const dv = new DataView(buf.buffer);
        buf[0] = 1;
        dv.setUint32(1, this.configSeq++, true);
        buf[5] = sharedClipboardEnabled ? 1 : 0;
        buf[6] = 0;
        buf[7] = 0;
        dv.setUint16(8, 16, true);
        dv.setUint16(10, 4, true);
        this.sendAuxFn(buf);
    }

    sendClipboardText(text) {
        if (typeof text !== "string") return false;
        const payload = textEnc.encode(text);
        if (payload.length === 0 || payload.length > 2 * 1024 * 1024) return false;
        const chunkSize = 1160;
        const totalChunks = Math.ceil(payload.length / chunkSize);
        const id = this.nextId;
        this.nextId += 2;
        const summary = textEnc.encode("Clipboard");
        const start = new Uint8Array(24 + summary.length);
        const dv = new DataView(start.buffer);
        start[0] = 10;
        dv.setUint32(1, id, true);
        start[5] = 1;
        dv.setBigInt64(6, BigInt(payload.length), true);
        dv.setUint32(14, totalChunks, true);
        dv.setInt32(18, 1, true);
        dv.setUint16(22, summary.length, true);
        start.set(summary, 24);
        this.outgoing.set(id, { payload, chunkSize, totalChunks });
        this.sendAuxFn(start);
        return true;
    }

    handleIncoming(data) {
        if (!data || data.length < 2) return;
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const kind = data[0];
        if (kind === 11 && data.length >= 7) {
            const id = dv.getUint32(1, true);
            const accepted = data[5] !== 0;
            const tr = this.outgoing.get(id);
            if (!tr) return;
            if (!accepted) {
                this.outgoing.delete(id);
                return;
            }
            for (let ci = 0; ci < tr.totalChunks; ci++) {
                const start = ci * tr.chunkSize;
                const slice = tr.payload.subarray(start, Math.min(tr.payload.length, start + tr.chunkSize));
                const pkt = new Uint8Array(13 + slice.length);
                const pdv = new DataView(pkt.buffer);
                pkt[0] = 12;
                pdv.setUint32(1, id, true);
                pdv.setUint32(5, ci, true);
                pdv.setUint32(9, crc32(slice), true);
                pkt.set(slice, 13);
                this.sendAuxFn(pkt);
            }
            return;
        }
        if (kind === 13 && data.length >= 18) {
            const id = dv.getUint32(1, true);
            const complete = (data[17] & 1) !== 0;
            if (complete) this.outgoing.delete(id);
            return;
        }
        if (kind === 14 && data.length >= 6) {
            const id = dv.getUint32(1, true);
            this.outgoing.delete(id);
            this.incoming.delete(id);
            return;
        }
        if (kind === 10 && data.length >= 24) {
            const id = dv.getUint32(1, true);
            const type = data[5];
            const totalBytes = Number(dv.getBigInt64(6, true));
            const totalChunks = dv.getUint32(14, true);
            const ack = new Uint8Array(7);
            const adv = new DataView(ack.buffer);
            ack[0] = 11;
            adv.setUint32(1, id, true);
            if (type === 1 && totalBytes > 0 && totalBytes <= 2 * 1024 * 1024 && totalChunks > 0 && totalChunks <= 2048) {
                this.incoming.set(id, { totalBytes, totalChunks, chunks: new Map() });
                ack[5] = 1;
                ack[6] = 0;
            } else {
                ack[5] = 0;
                ack[6] = 1;
            }
            this.sendAuxFn(ack);
            return;
        }
        if (kind === 12 && data.length >= 13) {
            const id = dv.getUint32(1, true);
            const chunkIdx = dv.getUint32(5, true);
            const expectedCrc = dv.getUint32(9, true);
            const inc = this.incoming.get(id);
            if (!inc) return;
            const slice = data.subarray(13);
            if (crc32(slice) !== expectedCrc) return;
            if (!inc.chunks.has(chunkIdx)) {
                inc.chunks.set(chunkIdx, new Uint8Array(slice));
            }
            if (inc.chunks.size >= inc.totalChunks) {
                const full = new Uint8Array(inc.totalBytes);
                let pos = 0;
                for (let i = 0; i < inc.totalChunks; i++) {
                    const part = inc.chunks.get(i);
                    if (!part) return;
                    full.set(part, pos);
                    pos += part.length;
                }
                this.incoming.delete(id);
                const ack = new Uint8Array(18);
                const adv = new DataView(ack.buffer);
                ack[0] = 13;
                adv.setUint32(1, id, true);
                adv.setUint32(5, inc.totalChunks, true);
                adv.setBigUint64(9, 0n, true);
                ack[17] = 1;
                this.sendAuxFn(ack);
                if (typeof this.onClipboardText === "function") {
                    this.onClipboardText(textDec.decode(full.subarray(0, pos)));
                }
            }
        }
    }
}

export const DOM_CODE_TO_VK = Object.freeze({
    Backspace: { vk: 0x08, ext: 0 },
    Tab: { vk: 0x09, ext: 0 },
    Enter: { vk: 0x0d, ext: 0 },
    NumpadEnter: { vk: 0x0d, ext: 1 },
    ShiftLeft: { vk: 0xa0, ext: 0 },
    ShiftRight: { vk: 0xa1, ext: 1 },
    ControlLeft: { vk: 0xa2, ext: 0 },
    ControlRight: { vk: 0xa3, ext: 1 },
    AltLeft: { vk: 0xa4, ext: 0 },
    AltRight: { vk: 0xa5, ext: 1 },
    Pause: { vk: 0x13, ext: 0 },
    CapsLock: { vk: 0x14, ext: 0 },
    Escape: { vk: 0x1b, ext: 0 },
    Space: { vk: 0x20, ext: 0 },
    PageUp: { vk: 0x21, ext: 1 },
    PageDown: { vk: 0x22, ext: 1 },
    End: { vk: 0x23, ext: 1 },
    Home: { vk: 0x24, ext: 1 },
    ArrowLeft: { vk: 0x25, ext: 1 },
    ArrowUp: { vk: 0x26, ext: 1 },
    ArrowRight: { vk: 0x27, ext: 1 },
    ArrowDown: { vk: 0x28, ext: 1 },
    PrintScreen: { vk: 0x2c, ext: 1 },
    Insert: { vk: 0x2d, ext: 1 },
    Delete: { vk: 0x2e, ext: 1 },
    Digit0: { vk: 0x30, ext: 0 },
    Digit1: { vk: 0x31, ext: 0 },
    Digit2: { vk: 0x32, ext: 0 },
    Digit3: { vk: 0x33, ext: 0 },
    Digit4: { vk: 0x34, ext: 0 },
    Digit5: { vk: 0x35, ext: 0 },
    Digit6: { vk: 0x36, ext: 0 },
    Digit7: { vk: 0x37, ext: 0 },
    Digit8: { vk: 0x38, ext: 0 },
    Digit9: { vk: 0x39, ext: 0 },
    KeyA: { vk: 0x41, ext: 0 },
    KeyB: { vk: 0x42, ext: 0 },
    KeyC: { vk: 0x43, ext: 0 },
    KeyD: { vk: 0x44, ext: 0 },
    KeyE: { vk: 0x45, ext: 0 },
    KeyF: { vk: 0x46, ext: 0 },
    KeyG: { vk: 0x47, ext: 0 },
    KeyH: { vk: 0x48, ext: 0 },
    KeyI: { vk: 0x49, ext: 0 },
    KeyJ: { vk: 0x4a, ext: 0 },
    KeyK: { vk: 0x4b, ext: 0 },
    KeyL: { vk: 0x4c, ext: 0 },
    KeyM: { vk: 0x4d, ext: 0 },
    KeyN: { vk: 0x4e, ext: 0 },
    KeyO: { vk: 0x4f, ext: 0 },
    KeyP: { vk: 0x50, ext: 0 },
    KeyQ: { vk: 0x51, ext: 0 },
    KeyR: { vk: 0x52, ext: 0 },
    KeyS: { vk: 0x53, ext: 0 },
    KeyT: { vk: 0x54, ext: 0 },
    KeyU: { vk: 0x55, ext: 0 },
    KeyV: { vk: 0x56, ext: 0 },
    KeyW: { vk: 0x57, ext: 0 },
    KeyX: { vk: 0x58, ext: 0 },
    KeyY: { vk: 0x59, ext: 0 },
    KeyZ: { vk: 0x5a, ext: 0 },
    MetaLeft: { vk: 0x5b, ext: 1 },
    MetaRight: { vk: 0x5c, ext: 1 },
    ContextMenu: { vk: 0x5d, ext: 1 },
    Numpad0: { vk: 0x60, ext: 0 },
    Numpad1: { vk: 0x61, ext: 0 },
    Numpad2: { vk: 0x62, ext: 0 },
    Numpad3: { vk: 0x63, ext: 0 },
    Numpad4: { vk: 0x64, ext: 0 },
    Numpad5: { vk: 0x65, ext: 0 },
    Numpad6: { vk: 0x66, ext: 0 },
    Numpad7: { vk: 0x67, ext: 0 },
    Numpad8: { vk: 0x68, ext: 0 },
    Numpad9: { vk: 0x69, ext: 0 },
    NumpadMultiply: { vk: 0x6a, ext: 0 },
    NumpadAdd: { vk: 0x6b, ext: 0 },
    NumpadSubtract: { vk: 0x6d, ext: 0 },
    NumpadDecimal: { vk: 0x6e, ext: 0 },
    NumpadDivide: { vk: 0x6f, ext: 1 },
    F1: { vk: 0x70, ext: 0 },
    F2: { vk: 0x71, ext: 0 },
    F3: { vk: 0x72, ext: 0 },
    F4: { vk: 0x73, ext: 0 },
    F5: { vk: 0x74, ext: 0 },
    F6: { vk: 0x75, ext: 0 },
    F7: { vk: 0x76, ext: 0 },
    F8: { vk: 0x77, ext: 0 },
    F9: { vk: 0x78, ext: 0 },
    F10: { vk: 0x79, ext: 0 },
    F11: { vk: 0x7a, ext: 0 },
    F12: { vk: 0x7b, ext: 0 },
    NumLock: { vk: 0x90, ext: 1 },
    ScrollLock: { vk: 0x91, ext: 0 },
    Semicolon: { vk: 0xba, ext: 0 },
    Equal: { vk: 0xbb, ext: 0 },
    Comma: { vk: 0xbc, ext: 0 },
    Minus: { vk: 0xbd, ext: 0 },
    Period: { vk: 0xbe, ext: 0 },
    Slash: { vk: 0xbf, ext: 0 },
    Backquote: { vk: 0xc0, ext: 0 },
    BracketLeft: { vk: 0xdb, ext: 0 },
    Backslash: { vk: 0xdc, ext: 0 },
    BracketRight: { vk: 0xdd, ext: 0 },
    Quote: { vk: 0xde, ext: 0 }
});
