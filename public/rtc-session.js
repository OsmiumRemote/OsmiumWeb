import { t } from "./i18n.js";
import {
    APP_PKT,
    AUDIO_FLAG,
    VIDEO_CODEC,
    DOM_CODE_TO_VK,
    OsmiumWireCipher,
    OsmiumAuxClipboard,
    bytesToHex,
    bytesToBase64,
    base64ToBytes,
    randomBytes,
    generateClientEcdh,
    deriveSessionAesKey,
    deriveAudioAesKey,
    computeAccessAuthTag,
    buildAuthRequest,
    buildPing,
    buildAudioPing,
    buildAudioControl,
    buildDisconnect,
    buildVideoIdrRequest,
    buildInputKey,
    buildInputMouseMove,
    buildInputMouseButton,
    buildInputMouseWheel,
    buildInputUnicodeText,
    buildInputGamepad,
    buildControlSwitchDisplay,
    buildControlVideoParams,
    buildControlMouseMode,
    buildControlSystemAction,
    buildAuxPacket,
    parseAuthResponse,
    parsePong,
    parseAudioPong,
    parseVideoChunk,
    parseAudioFrame,
    parseHostStatusJson
} from "./protocol.js";

const WEB_CLIENT_VERSION = "1.1.1";
const WORKLET_SCRIPT_URL = (typeof document !== "undefined" && document.currentScript && document.currentScript.src)
    ? new URL(document.currentScript.src).pathname
    : "/audio-worklet.js";

function isPeerVersionSupported(raw) {
    if (typeof raw !== "string") return false;
    const m = raw.trim().replace(/^[vV]/, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return false;
    const maj = Number(m[1]);
    const min = Number(m[2]);
    const pat = Number(m[3] || 0);
    if (maj !== 1) return maj > 1;
    if (min !== 1) return min > 1;
    return pat >= 1;
}

export async function detectBrowserCapabilities() {
    const ua = navigator.userAgent || "";
    const isFirefox = /Firefox\//i.test(ua);
    const isSafari = /Safari\//i.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//i.test(ua);
    const isEdge = /Edg\//i.test(ua);
    const isOpera = /OPR\//i.test(ua);
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const hasTouch = Boolean(isMobile || (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window);
    const isChromium = /Chrome\/|Chromium\//i.test(ua) && !isFirefox && !isSafari;
    const isChromeDesktop = isChromium && !isMobile;

    const hasRtc = typeof RTCPeerConnection === "function";
    const hasVideoDecoder = typeof VideoDecoder === "function" && typeof EncodedVideoChunk === "function";
    const hasAudioDecoder = typeof AudioDecoder === "function" && typeof EncodedAudioChunk === "function" && typeof AudioWorkletNode === "function";
    const hasKeyboardLock = Boolean(isChromeDesktop && navigator.keyboard && typeof navigator.keyboard.lock === "function");
    const hasPointerLock = typeof document.documentElement.requestPointerLock === "function";
    const hasGamepad = Boolean(isChromeDesktop && typeof navigator.getGamepads === "function");
    const hasClipboard = Boolean(navigator.clipboard && typeof navigator.clipboard.readText === "function");

    const supportedCodecs = [];
    if (hasVideoDecoder) {
        const probes = [
            { id: VIDEO_CODEC.H264, name: "H.264", config: { codec: "avc1.640032", avc: { format: "annexb" }, optimizeForLatency: true } },
            { id: VIDEO_CODEC.HEVC, name: "HEVC", config: { codec: "hvc1.1.6.L120.90", hevc: { format: "annexb" }, optimizeForLatency: true } },
            { id: VIDEO_CODEC.AV1, name: "AV1", config: { codec: "av01.0.08M.08", optimizeForLatency: true } }
        ];
        for (const p of probes) {
            if (!isChromeDesktop && p.id !== VIDEO_CODEC.H264) continue;
            try {
                const res = await VideoDecoder.isConfigSupported(p.config);
                if (res && res.supported) {
                    supportedCodecs.push({ id: p.id, name: p.name });
                }
            } catch {}
        }
        if (supportedCodecs.length === 0) {
            try {
                const res = await VideoDecoder.isConfigSupported({ codec: "avc1.42E028", avc: { format: "annexb" } });
                if (res && res.supported) supportedCodecs.push({ id: VIDEO_CODEC.H264, name: "H.264" });
            } catch {}
        }
    }

    let canAudioDecode = false;
    if (hasAudioDecoder) {
        try {
            const res = await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
            canAudioDecode = Boolean(res && res.supported);
        } catch {}
    }

    let browserName = "other";
    if (isChromeDesktop && !isEdge && !isOpera) browserName = "chrome";
    else if (isEdge && !isMobile) browserName = "edge";
    else if (isFirefox) browserName = "firefox";
    else if (isSafari) browserName = "safari";
    else if (isChromeDesktop) browserName = "chromium";

    return {
        browserName,
        isChromeFull: isChromeDesktop && hasRtc && supportedCodecs.length > 0,
        isFirefox,
        isSafari,
        isMobile,
        hasTouch,
        canConnect: hasRtc && supportedCodecs.length > 0,
        supportedCodecs,
        canAudioDecode,
        hasKeyboardLock,
        hasPointerLock: hasPointerLock && !isMobile,
        hasGamepad,
        hasClipboard,
        allowHighFps: isChromeDesktop
    };
}

export class SignalingHubClient {
    constructor(handlers = {}) {
        this.handlers = handlers;
        this.ws = null;
        this.url = "";
        this.deviceId = "";
        this.ltoken = "";
        this.closed = false;
        this.registered = false;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.stunHost = "stun.cloudflare.com";
        this.stunPort = 3478;
    }

    connect(url, deviceId, ltoken) {
        this.url = url;
        this.deviceId = deviceId;
        this.ltoken = ltoken;
        this.closed = false;
        this._open();
    }

    updateToken(ltoken) {
        this.ltoken = ltoken || "";
        if (this.registered) {
            this.send({ type: "auth_update", ltoken: this.ltoken });
        }
    }

    _open() {
        this._cleanupSocket();
        if (this.closed || !this.url || !this.deviceId || !this.ltoken) return;
        let ws;
        try {
            ws = new WebSocket(this.url);
        } catch {
            this._scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            if (this.ws !== ws) return;
            this.send({
                type: "register",
                deviceId: this.deviceId,
                deviceName: "Osmium Web",
                osVersion: "Web",
                clientVersion: WEB_CLIENT_VERSION,
                allowRemote: false,
                ltoken: this.ltoken
            });
        };
        ws.onmessage = (event) => {
            if (this.ws !== ws || typeof event.data !== "string") return;
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }
            if (!msg || typeof msg.type !== "string") return;
            if (msg.type === "registered") {
                this.registered = true;
                if (typeof msg.stunHost === "string" && msg.stunHost) this.stunHost = msg.stunHost;
                if (typeof msg.stunPort === "number" && msg.stunPort > 0) this.stunPort = msg.stunPort;
                this._startHeartbeat();
                this._emit("registered", msg);
                return;
            }
            if (msg.type === "pong") return;
            if (msg.type === "replaced") {
                this.closed = true;
                this._emit("replaced");
                return;
            }
            if (msg.type === "account_revoked") {
                this._emit("revoked", msg);
                return;
            }
            if (msg.type === "account_devices_sync") {
                this._emit("devices", Array.isArray(msg.devices) ? msg.devices : []);
                return;
            }
            if (msg.type === "connect_cooldown") {
                this._emit("cooldown", Number(msg.remainingMs || msg.cooldownMs || 0));
                return;
            }
            this._emit("message", msg);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.registered = false;
            this._stopHeartbeat();
            if (!this.closed) this._scheduleReconnect();
        };
        ws.onerror = () => {};
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.send({ type: "ping" });
            }
        }, 15000);
    }

    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    _scheduleReconnect() {
        if (this.closed || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closed) this._open();
        }, 2500);
    }

    _cleanupSocket() {
        this._stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            const old = this.ws;
            this.ws = null;
            old.onopen = null;
            old.onmessage = null;
            old.onclose = null;
            old.onerror = null;
            try { old.close(1000); } catch {}
        }
        this.registered = false;
    }

    send(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
            this.ws.send(JSON.stringify(obj));
            return true;
        } catch {
            return false;
        }
    }

    disconnect() {
        this.closed = true;
        this._cleanupSocket();
    }

    _emit(name, payload) {
        const fn = this.handlers[name];
        if (typeof fn === "function") fn(payload);
    }
}

export class OsmiumRemoteSession {
    constructor({ signaling, canvas, caps, settings, callbacks }) {
        this.signaling = signaling;
        this.canvas = canvas;
        this.ctx2d = canvas.getContext("2d", { alpha: false, desynchronized: true });
        this.caps = caps;
        this.settings = settings;
        this.callbacks = callbacks || {};

        this.sessionId = "";
        this.sessionToken = null;
        this.targetDeviceId = "";
        this.hostName = "";
        this.viewOnly = false;
        this.accessCode = "";
        this.sameAccount = false;
        this.hostWebRtcSupported = false;
        this.transportMode = "";

        this.ecdh = null;
        this.authTag = null;
        this.cipher = null;
        this.audioCipher = null;
        this.pc = null;
        this.ctrlDc = null;
        this.mediaDc = null;
        this.audioDc = null;
        this.relayWs = null;
        this.relayReady = false;
        this.relayKeepaliveTimer = null;
        this.audioRelayWs = null;
        this.audioRelayReady = false;
        this.audioRelayKeepaliveTimer = null;
        this.auxClipboard = null;
        this.pendingIce = [];
        this.remoteDescApplied = false;
        this.channelOpened = false;

        this.videoDecoder = null;
        this.activeCodecId = 0;
        this.waitingKeyframe = true;
        this.frameBuffers = new Map();
        this.lastCompletedFrameId = 0;
        this.decodedFramesWindow = 0;
        this.rxBytesWindow = 0;
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.rttMs = 0;

        this.audioCtx = null;
        this.audioWorklet = null;
        this.audioDecoder = null;
        this.audioMuted = !settings.audioEnabled;
        this.audioPingTimer = null;
        this.audioJitterTimer = null;
        this.audioJitterMap = new Map();
        this.audioExpectedSeq = 0;
        this.audioHasExpectedSeq = false;
        this.audioPriming = true;
        this.audioFirstArrivalUs = 0;
        this.audioLastPopUs = 0;
        this.audioNeedFadeIn = true;
        this.audioWorkletBufferedFrames = 0;
        this.audioJitterUs = 8000;
        this.audioHasLastArrival = false;
        this.audioLastArrivalUs = 0;
        this.audioLastCaptureUs = 0;
        this.audioStatsExpected = 0;
        this.audioStatsLost = 0;
        this.audioStatsWinStartMs = 0;
        this.audioLossPermille = 0;
        this.clockOffsetUs = 0;
        this.bestClockRttUs = 0;
        this.lastBestRttResetUs = 0;
        this.hasClockOffset = false;
        this.videoPresentOffsetUs = 0;
        this.hasVideoOffset = false;
        this.lastVideoRenderUs = 0;
        this.audioPlaybackRate = 1.0;

        this.mouseRelative = false;
        this.keyboardLocked = false;
        this.heldKeys = new Set();
        this.heldButtons = new Set();
        this.touchLongPressTimer = null;
        this.gamepadRaf = 0;
        this.lastGamepadSig = "";

        this.pingTimer = null;
        this.statsTimer = null;
        this.connectTimer = null;
        this.idrTimer = null;
        this.established = false;
        this.authAccepted = false;
        this.disposed = false;
        this.hostStatus = null;

        this._boundEvents = [];
    }

    async start({ targetDeviceId, accessCode, sameAccount, viewOnly, hostName }) {
        this.targetDeviceId = String(targetDeviceId || "").replace(/\D/g, "");
        this.accessCode = String(accessCode || "");
        this.sameAccount = Boolean(sameAccount);
        this.viewOnly = Boolean(viewOnly);
        this.hostName = hostName || this.targetDeviceId;
        this.sessionToken = randomBytes(16);
        this.sessionId = bytesToHex(this.sessionToken);
        this.ecdh = await generateClientEcdh();
        this.waitingKeyframe = true;

        this._emit("stage", t("stage_connecting_target"));
        this.connectTimer = setTimeout(() => {
            if (!this.established && !this.disposed) {
                this._fail(t("rtc_err_timeout"));
            }
        }, 28000);

        const ok = this.signaling.send({
            type: "connect_request",
            sessionId: this.sessionId,
            targetDeviceId: this.targetDeviceId,
            clientName: "Osmium Web",
            clientPublicKey: this.ecdh.publicKeyBase64,
            enableEncryption: true,
            sameAccountConnect: this.sameAccount,
            viewOnly: this.viewOnly,
            webrtc: true,
            ltoken: this.signaling.ltoken,
            candidates: []
        });
        if (!ok) {
            this._fail(t("rtc_err_no_service"));
        }
    }

    async handleSignalingMessage(msg) {
        if (this.disposed || !msg) return;
        if (msg.sessionId && msg.sessionId !== this.sessionId) return;

        switch (msg.type) {
            case "connect_challenge": {
                this.hostWebRtcSupported = msg.webrtcSupported === true;
                this.hostName = msg.hostName || this.hostName;
                this._emit("hostName", this.hostName);
                this._emit("stage", t("stage_verifying_creds"));
                try {
                    const hostPub = base64ToBytes(msg.hostPublicKey);
                    const nonce = base64ToBytes(msg.hostChallengeNonce);
                    const codeToUse = this.sameAccount && msg.sameAccountAuthSecret
                        ? msg.sameAccountAuthSecret
                        : this.accessCode;
                    this.authTag = await computeAccessAuthTag(
                        codeToUse,
                        this.sessionToken,
                        nonce,
                        this.ecdh.publicKeyBytes,
                        hostPub
                    );
                    const aesKey = await deriveSessionAesKey(this.ecdh.privateKey, hostPub, this.sessionToken);
                    const audioAesKey = await deriveAudioAesKey(aesKey);
                    const encEnabled = msg.enableEncryption !== false;
                    this.cipher = new OsmiumWireCipher(encEnabled);
                    this.audioCipher = new OsmiumWireCipher(encEnabled);
                    if (encEnabled) {
                        await this.cipher.initKeys(aesKey);
                        await this.audioCipher.initKeys(audioAesKey);
                    }
                    aesKey.fill(0);
                    audioAesKey.fill(0);
                    this.signaling.send({
                        type: "connect_auth",
                        sessionId: this.sessionId,
                        targetDeviceId: this.targetDeviceId,
                        authTag: bytesToBase64(this.authTag)
                    });
                } catch {
                    this._fail(t("rtc_err_crypto_init"));
                }
                break;
            }
            case "connect_auth_verified": {
                this._emit("stage", t("stage_negotiating"));
                this.signaling.send({
                    type: "session_version_report",
                    sessionId: this.sessionId,
                    version: WEB_CLIENT_VERSION
                });
                break;
            }
            case "version_check_result": {
                if (!msg.compatible || (typeof msg.hostVersion === "string" && !isPeerVersionSupported(msg.hostVersion))) {
                    this._fail(t("rtc_err_version_incompatible"));
                    return;
                }
                if (msg.webrtc === true && this.hostWebRtcSupported) {
                    await this._startPeerConnection(
                        msg.stunHost || this.signaling.stunHost,
                        msg.stunPort || this.signaling.stunPort
                    );
                } else {
                    this._emit("stage", t("stage_establishing_relay"));
                    this.signaling.send({
                        type: "bridge_candidates",
                        sessionId: this.sessionId,
                        candidates: [],
                        audioCandidates: [],
                        transportCaps: ["audio-sep-v2"]
                    });
                }
                break;
            }
            case "bridge_ready": {
                const audioRelayToken = typeof msg.audioRelayToken === "string" ? msg.audioRelayToken : "";
                const audioRelayPath = typeof msg.audioRelayPath === "string" && msg.audioRelayPath ? msg.audioRelayPath : "/relay-audio";
                if (!this.transportMode) {
                    const relayToken = typeof msg.relayToken === "string" ? msg.relayToken : "";
                    const relayPath = typeof msg.relayPath === "string" && msg.relayPath ? msg.relayPath : "/relay";
                    if (!relayToken) {
                        this._fail(t("rtc_err_no_channel"));
                        return;
                    }
                    this.signaling.send({ type: "relay_fallback", sessionId: this.sessionId, channel: "video" });
                    this._startRelayTransport(relayPath, relayToken);
                }
                if (audioRelayToken && !this.audioRelayWs && this.transportMode !== "p2p") {
                    this.signaling.send({ type: "relay_fallback", sessionId: this.sessionId, channel: "audio" });
                    this._startAudioRelayTransport(audioRelayPath, audioRelayToken);
                }
                break;
            }
            case "relay_fallback": {
                const channel = msg.channel === "audio" ? "audio" : "video";
                if (channel !== "audio" && !this.transportMode && msg.relayToken) {
                    const relayPath = typeof msg.relayPath === "string" && msg.relayPath ? msg.relayPath : "/relay";
                    this._startRelayTransport(relayPath, msg.relayToken);
                }
                if (msg.audioRelayToken && !this.audioRelayWs && this.transportMode !== "p2p") {
                    const audioRelayPath = typeof msg.audioRelayPath === "string" && msg.audioRelayPath ? msg.audioRelayPath : "/relay-audio";
                    this._startAudioRelayTransport(audioRelayPath, msg.audioRelayToken);
                }
                break;
            }
            case "webrtc_answer": {
                if (!this.pc || !msg.sdp) return;
                try {
                    await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
                    this.remoteDescApplied = true;
                    const queued = this.pendingIce.splice(0, this.pendingIce.length);
                    for (const c of queued) {
                        try { await this.pc.addIceCandidate(c); } catch {}
                    }
                } catch {
                    this._fail(t("rtc_err_p2p_answer"));
                }
                break;
            }
            case "webrtc_ice": {
                if (!msg.candidate) return;
                const cand = {
                    candidate: msg.candidate,
                    sdpMid: msg.sdpMid || "0",
                    sdpMLineIndex: typeof msg.sdpMLineIndex === "number" ? msg.sdpMLineIndex : 0
                };
                if (this.pc && this.remoteDescApplied) {
                    try { await this.pc.addIceCandidate(cand); } catch {}
                } else {
                    this.pendingIce.push(cand);
                }
                break;
            }
            case "session_established": {
                this.established = true;
                if (this.connectTimer) {
                    clearTimeout(this.connectTimer);
                    this.connectTimer = null;
                }
                this._emit("established", { hostName: this.hostName });
                break;
            }
            case "connect_reject": {
                if (Number(msg.code) === 100 && msg.challenge && msg.challenge.captcha_url) {
                    this._emit("captchaRequired", msg.challenge);
                    this.close(false, false);
                    return;
                }
                this._fail(this._mapRejectReason(msg.code, msg.remainingMs || msg.cooldownMs || 0));
                break;
            }
            case "session_end": {
                this._emit("ended", t("rtc_end_peer_disconnected"));
                this.close(false, false);
                break;
            }
            case "error": {
                this._fail(this._mapRejectReason(msg.code, 0));
                break;
            }
        }
    }

    _mapRejectReason(code, cooldownMs) {
        const s = String(code || "");
        if (s === "INVALID_ACCESS_CODE") return t("reject_invalid_code");
        if (s === "USER_DECLINED") return t("reject_declined");
        if (s === "HOST_BUSY") return t("reject_busy");
        if (s === "REMOTE_DISABLED" || s === "4007") return t("reject_disabled");
        if (s === "DEVICE_OFFLINE" || s === "4006") return t("reject_offline");
        if (s === "SELF_CONNECT" || s === "4008") return t("reject_self");
        if (s === "ENCRYPTION_MISMATCH") return t("reject_enc_mismatch");
        if (s === "2011" || s === "BLACKLISTED_BY_HOST") return t("reject_blacklisted");
        if (s === "4005" || s === "CONNECT_COOLDOWN") {
            const sec = Math.max(1, Math.ceil((cooldownMs || 2000) / 1000));
            return t("reject_cooldown", { sec });
        }
        if (s === "2010" || s === "ACCOUNT_AUTH_REQUIRED") return t("reject_auth_expired");
        if (s === "2005" || s === "ACCOUNT_LOCKED") return t("reject_locked");
        if (s === "4001" || s === "RATE_LIMITED") return t("reject_rate_limited");
        return t("reject_default");
    }

    _buildRelayWsUrl(relayPath, relayToken, defaultPath = "/relay") {
        const raw = typeof relayPath === "string" && relayPath.trim() ? relayPath.trim() : defaultPath;
        const qs = `sessionId=${encodeURIComponent(this.sessionId)}&role=client&token=${encodeURIComponent(relayToken)}`;
        if (/^(wss?|https?):\/\//i.test(raw)) {
            try {
                const u = new URL(raw);
                u.protocol = (u.protocol === "http:" || u.protocol === "ws:") ? "ws:" : "wss:";
                if (!u.pathname || u.pathname === "/") u.pathname = defaultPath;
                u.search = qs;
                return u.toString();
            } catch {}
        }
        const base = this.signaling.url.replace(/\/+$/, "");
        const path = raw.startsWith("/") ? raw : `/${raw}`;
        return `${base}${path}?${qs}`;
    }

    _startRelayTransport(relayPath, relayToken) {
        if (this.disposed || this.relayWs) return;
        this.transportMode = "relay";
        const wsUrl = this._buildRelayWsUrl(relayPath, relayToken, "/relay");
        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch {
            this._fail(t("rtc_err_relay_open"));
            return;
        }
        ws.binaryType = "arraybuffer";
        this.relayWs = ws;
        ws.onopen = () => {
            if (this.disposed || this.relayWs !== ws) return;
            this.relayKeepaliveTimer = setInterval(() => {
                if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
                    try { this.relayWs.send('{"type":"ping"}'); } catch {}
                }
            }, 15000);
        };
        ws.onmessage = (ev) => {
            if (this.disposed || this.relayWs !== ws) return;
            if (typeof ev.data === "string") {
                try {
                    const obj = JSON.parse(ev.data);
                    if (obj && obj.type === "relay_peer_ready" && !this.relayReady) {
                        this.relayReady = true;
                        this._onChannelOpened();
                    }
                } catch {}
                return;
            }
            if (ev.data instanceof ArrayBuffer) {
                if (!this.relayReady) {
                    this.relayReady = true;
                    this._onChannelOpened();
                }
                const batch = new Uint8Array(ev.data);
                const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
                let pos = 0;
                while (pos + 2 <= batch.byteLength) {
                    const pktLen = dv.getUint16(pos, true);
                    pos += 2;
                    if (pktLen === 0 || pos + pktLen > batch.byteLength) break;
                    if (pktLen >= 8 && pktLen <= 32768) {
                        this._handleIncomingWire(batch.subarray(pos, pos + pktLen));
                    }
                    pos += pktLen;
                }
            }
        };
        ws.onclose = () => {
            if (this.disposed || this.relayWs !== ws) return;
            if (!this.established) {
                this._fail(t("rtc_err_relay_closed"));
            } else {
                this._emit("ended", t("rtc_end_network_lost"));
                this.close(false, false);
            }
        };
        ws.onerror = () => {};
    }

    _startAudioRelayTransport(relayPath, audioRelayToken) {
        if (this.disposed || this.audioRelayWs || !audioRelayToken) return;
        const wsUrl = this._buildRelayWsUrl(relayPath, audioRelayToken, "/relay-audio");
        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch {
            return;
        }
        ws.binaryType = "arraybuffer";
        this.audioRelayWs = ws;
        ws.onopen = () => {
            if (this.disposed || this.audioRelayWs !== ws) return;
            this.audioRelayKeepaliveTimer = setInterval(() => {
                if (this.audioRelayWs && this.audioRelayWs.readyState === WebSocket.OPEN) {
                    try { this.audioRelayWs.send('{"type":"ping"}'); } catch {}
                }
            }, 15000);
        };
        ws.onmessage = (ev) => {
            if (this.disposed || this.audioRelayWs !== ws) return;
            if (typeof ev.data === "string") {
                try {
                    const obj = JSON.parse(ev.data);
                    if (obj && obj.type === "relay_peer_ready" && !this.audioRelayReady) {
                        this.audioRelayReady = true;
                        this._sendAudioPacket(buildAudioControl(this.audioMuted));
                    }
                } catch {}
                return;
            }
            if (ev.data instanceof ArrayBuffer) {
                if (!this.audioRelayReady) {
                    this.audioRelayReady = true;
                }
                const batch = new Uint8Array(ev.data);
                const dv = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
                let pos = 0;
                while (pos + 2 <= batch.byteLength) {
                    const pktLen = dv.getUint16(pos, true);
                    pos += 2;
                    if (pktLen === 0 || pos + pktLen > batch.byteLength) break;
                    if (pktLen >= 8 && pktLen <= 32768) {
                        this._handleIncomingAudioWire(batch.subarray(pos, pos + pktLen));
                    }
                    pos += pktLen;
                }
            }
        };
        // Audio relay close/error is strictly isolated and MUST NEVER affect video or session.
        ws.onclose = () => {
            if (this.audioRelayWs === ws) {
                this.audioRelayWs = null;
                this.audioRelayReady = false;
            }
            if (this.audioRelayKeepaliveTimer) {
                clearInterval(this.audioRelayKeepaliveTimer);
                this.audioRelayKeepaliveTimer = null;
            }
        };
        ws.onerror = () => {};
    }

    async _startPeerConnection(stunHost, stunPort) {
        this.transportMode = "p2p";
        this._emit("stage", t("stage_establishing_p2p"));
        const urls = [];
        if (stunHost) urls.push(`stun:${stunHost}:${stunPort || 3478}`);
        urls.push("stun:stun.cloudflare.com:3478");
        urls.push("stun:stun.l.google.com:19302");

        const pc = new RTCPeerConnection({ iceServers: [{ urls }] });
        this.pc = pc;

        pc.onicecandidate = (e) => {
            if (this.disposed || !e.candidate || !e.candidate.candidate) return;
            this.signaling.send({
                type: "webrtc_ice",
                sessionId: this.sessionId,
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex
            });
        };

        pc.onconnectionstatechange = () => {
            if (this.disposed) return;
            const st = pc.connectionState;
            if (st === "failed" || st === "closed") {
                if (!this.established) {
                    this._fail(t("rtc_err_p2p_failed"));
                } else {
                    this._emit("ended", t("rtc_end_network_lost"));
                    this.close(false, true);
                }
            }
        };

        this.ctrlDc = pc.createDataChannel("ctrl", { ordered: true });
        this.ctrlDc.binaryType = "arraybuffer";
        this.mediaDc = pc.createDataChannel("media", { ordered: false, maxRetransmits: 0 });
        this.mediaDc.binaryType = "arraybuffer";
        this.audioDc = pc.createDataChannel("audio", { ordered: false, maxRetransmits: 0 });
        this.audioDc.binaryType = "arraybuffer";

        const onData = (ev) => {
            if (this.disposed) return;
            if (ev.data instanceof ArrayBuffer) {
                this._handleIncomingWire(new Uint8Array(ev.data));
            }
        };

        this.ctrlDc.onmessage = onData;
        this.mediaDc.onmessage = onData;
        this.audioDc.onmessage = (ev) => {
            if (this.disposed) return;
            if (ev.data instanceof ArrayBuffer) {
                this._handleIncomingAudioWire(new Uint8Array(ev.data));
            }
        };
        this.audioDc.onopen = () => {
            if (this.disposed) return;
            this._sendAudioPacket(buildAudioControl(this.audioMuted));
        };
        this.audioDc.onclose = () => {};
        this.audioDc.onerror = () => {};

        this.ctrlDc.onopen = () => {
            if (this.disposed) return;
            this._onChannelOpened();
        };

        this.ctrlDc.onclose = () => {
            if (!this.disposed && this.established) {
                this._emit("ended", t("rtc_end_closed"));
                this.close(false, false);
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signaling.send({
            type: "webrtc_offer",
            sessionId: this.sessionId,
            sdp: offer.sdp
        });
    }

    async _onChannelOpened() {
        if (this.channelOpened || this.disposed) return;
        this.channelOpened = true;
        this._emit("stage", t("stage_verifying_key"));
        this.auxClipboard = new OsmiumAuxClipboard(
            (auxPayload) => this._sendAppPacket(buildAuxPacket(auxPayload), true),
            (text) => this._emit("clipboardText", text)
        );
        const { width, height } = this._getDesiredResolution();
        const fps = this.caps.allowHighFps ? Number(this.settings.fps || 60) : Math.min(60, Number(this.settings.fps || 60));
        const bitrateKbps = Number(this.settings.bitrateKbps || 8000);
        const codecPref = this._resolveCodecPreference();
        await this._sendAppPacket(
            buildAuthRequest(this.authTag, width, height, fps, bitrateKbps, codecPref, 0),
            true
        );
    }

    _getDesiredResolution() {
        const preset = String(this.settings.resolution || "native");
        if (preset === "1080p") return { width: 1920, height: 1080 };
        if (preset === "720p") return { width: 1280, height: 720 };
        return { width: 0, height: 0 };
    }

    _resolveCodecPreference() {
        const pref = Number(this.settings.codec || 1);
        const supportedIds = new Set(this.caps.supportedCodecs.map((c) => c.id));
        if (supportedIds.has(pref)) return pref;
        if (supportedIds.has(VIDEO_CODEC.H264)) return VIDEO_CODEC.H264;
        return this.caps.supportedCodecs[0]?.id || VIDEO_CODEC.H264;
    }

    async _sendAppPacket(plainBytes, reliable = true) {
        if (this.disposed || !this.cipher) return false;
        if (this.transportMode === "relay") {
            if (!this.relayWs || this.relayWs.readyState !== WebSocket.OPEN) return false;
            try {
                const wire = await this.cipher.encodePacket(plainBytes);
                const framed = new Uint8Array(2 + wire.byteLength);
                new DataView(framed.buffer).setUint16(0, wire.byteLength, true);
                framed.set(wire, 2);
                if (this.relayWs.readyState === WebSocket.OPEN) {
                    this.relayWs.send(framed);
                    return true;
                }
            } catch {}
            return false;
        }
        const dc = reliable ? this.ctrlDc : (this.mediaDc && this.mediaDc.readyState === "open" ? this.mediaDc : this.ctrlDc);
        if (!dc || dc.readyState !== "open") return false;
        try {
            const wire = await this.cipher.encodePacket(plainBytes);
            if (dc.readyState === "open") {
                dc.send(wire);
                return true;
            }
        } catch {}
        return false;
    }

    async _sendAudioPacket(plainBytes) {
        if (this.disposed || !this.audioCipher) return false;
        if (this.transportMode === "relay") {
            if (!this.audioRelayWs || this.audioRelayWs.readyState !== WebSocket.OPEN) return false;
            try {
                const wire = await this.audioCipher.encodePacket(plainBytes);
                const framed = new Uint8Array(2 + wire.byteLength);
                new DataView(framed.buffer).setUint16(0, wire.byteLength, true);
                framed.set(wire, 2);
                if (this.audioRelayWs && this.audioRelayWs.readyState === WebSocket.OPEN) {
                    this.audioRelayWs.send(framed);
                    return true;
                }
            } catch {}
            return false;
        }
        if (!this.audioDc || this.audioDc.readyState !== "open") return false;
        try {
            const wire = await this.audioCipher.encodePacket(plainBytes);
            if (this.audioDc && this.audioDc.readyState === "open") {
                this.audioDc.send(wire);
                return true;
            }
        } catch {}
        return false;
    }

    async _handleIncomingAudioWire(wireBytes) {
        if (!this.audioCipher || this.disposed) return;
        const plain = await this.audioCipher.decodePacket(wireBytes);
        if (!plain || plain.length < 4) return;
        const pktType = plain[0];
        if (pktType === APP_PKT.AUDIO_FRAME) {
            this._enqueueAudioFrame(plain);
            return;
        }
        if (pktType === APP_PKT.AUDIO_PONG) {
            const p = parseAudioPong(plain);
            if (p && p.clientTimeUs > 0 && p.hostTimeUs > 0) {
                const nowUs = Math.floor(performance.now() * 1000);
                this._recordClockOffset(p.clientTimeUs, p.hostTimeUs, nowUs);
            }
        }
    }

    async _handleIncomingWire(wireBytes) {
        if (!this.cipher || this.disposed) return;
        this.rxBytesWindow += wireBytes.byteLength;
        const plain = await this.cipher.decodePacket(wireBytes);
        if (!plain || plain.length < 4) return;
        const pktType = plain[0];

        if (pktType === APP_PKT.VIDEO_CHUNK) {
            this._handleVideoChunk(plain);
            return;
        }
        if (pktType === APP_PKT.PONG) {
            const p = parsePong(plain);
            if (p && p.timestampUs > 0) {
                const nowUs = Math.floor(performance.now() * 1000);
                const rtt = (nowUs - p.timestampUs) / 1000;
                if (rtt >= 0 && rtt < 10000) {
                    this.rttMs = Math.round(rtt);
                }
                if (p.hostTimeUs > 0) {
                    this._recordClockOffset(p.timestampUs, p.hostTimeUs, nowUs);
                }
            }
            return;
        }
        if (pktType === APP_PKT.AUTH_RESPONSE) {
            if (this.authAccepted) return;
            const resp = parseAuthResponse(plain);
            if (!resp) return;
            if (!resp.accepted) {
                this._fail(resp.message || t("rtc_err_auth_denied"));
                return;
            }
            this.authAccepted = true;
            this.signaling.send({ type: "session_confirm", sessionId: this.sessionId });
            this._startLoopsAndInput();
            if (this.auxClipboard && this.settings.clipboardEnabled && !this.viewOnly) {
                this.auxClipboard.sendFeatureConfig(true);
            }
            return;
        }
        if (pktType === APP_PKT.HOST_STATUS_JSON) {
            const status = parseHostStatusJson(plain);
            if (status) {
                this.hostStatus = status;
                this._emit("hostStatus", status);
            }
            return;
        }
        if (pktType === APP_PKT.AUX_DATA) {
            if (this.auxClipboard && plain.length > 4) {
                this.auxClipboard.handleIncoming(plain.subarray(4));
            }
            return;
        }
        if (pktType === APP_PKT.DISCONNECT) {
            this._emit("ended", t("rtc_end_peer_ended"));
            this.close(false, false);
        }
    }

    _handleVideoChunk(plain) {
        const chunk = parseVideoChunk(plain);
        if (!chunk || chunk.totalChunks === 0 || chunk.chunkIndex >= chunk.totalChunks) return;
        if (chunk.frameId <= this.lastCompletedFrameId && this.lastCompletedFrameId - chunk.frameId < 10000) return;

        let entry = this.frameBuffers.get(chunk.frameId);
        if (!entry) {
            if (this.frameBuffers.size > 16) {
                const keys = Array.from(this.frameBuffers.keys()).sort((a, b) => a - b);
                while (keys.length > 8) {
                    this.frameBuffers.delete(keys.shift());
                }
            }
            entry = {
                frameId: chunk.frameId,
                totalChunks: chunk.totalChunks,
                codecId: chunk.codecId,
                isKeyFrame: chunk.isKeyFrame,
                width: chunk.width,
                height: chunk.height,
                captureTimeUs: chunk.captureTimeUs,
                parts: new Array(chunk.totalChunks),
                receivedCount: 0,
                totalBytes: 0
            };
            this.frameBuffers.set(chunk.frameId, entry);
        }

        if (!entry.parts[chunk.chunkIndex]) {
            entry.parts[chunk.chunkIndex] = new Uint8Array(chunk.payload);
            entry.receivedCount++;
            entry.totalBytes += chunk.payload.byteLength;
        }

        if (entry.receivedCount === entry.totalChunks) {
            const full = new Uint8Array(entry.totalBytes);
            let offset = 0;
            for (let i = 0; i < entry.totalChunks; i++) {
                full.set(entry.parts[i], offset);
                offset += entry.parts[i].byteLength;
            }
            this.frameBuffers.delete(chunk.frameId);
            for (const oldId of Array.from(this.frameBuffers.keys())) {
                if (oldId < chunk.frameId) this.frameBuffers.delete(oldId);
            }
            this.lastCompletedFrameId = chunk.frameId;
            this._decodeVideoFrame(entry, full);
        }
    }

    _ensureVideoDecoder(codecId, width, height) {
        if (this.videoDecoder && this.videoDecoder.state === "configured" && this.activeCodecId === codecId) {
            return true;
        }
        if (this.videoDecoder) {
            try { this.videoDecoder.close(); } catch {}
            this.videoDecoder = null;
        }
        let config;
        if (codecId === VIDEO_CODEC.HEVC) {
            config = { codec: "hvc1.1.6.L120.90", hevc: { format: "annexb" }, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true };
        } else if (codecId === VIDEO_CODEC.AV1) {
            config = { codec: "av01.0.08M.08", hardwareAcceleration: "prefer-hardware", optimizeForLatency: true };
        } else {
            config = { codec: "avc1.640032", avc: { format: "annexb" }, hardwareAcceleration: "prefer-hardware", optimizeForLatency: true };
        }
        if (width > 0 && height > 0) {
            config.codedWidth = width;
            config.codedHeight = height;
        }
        try {
            this.videoDecoder = new VideoDecoder({
                output: (frame) => {
                    try {
                        if (!this.disposed && this.ctx2d) {
                            const w = frame.displayWidth || frame.codedWidth;
                            const h = frame.displayHeight || frame.codedHeight;
                            if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
                                this.canvas.width = w;
                                this.canvas.height = h;
                                this.videoWidth = w;
                                this.videoHeight = h;
                            }
                            this.ctx2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
                            this.decodedFramesWindow++;
                            if (frame.timestamp > 0) {
                                this._notifyVideoFrameRendered(frame.timestamp, Math.floor(performance.now() * 1000));
                            }
                        }
                    } finally {
                        frame.close();
                    }
                },
                error: () => {
                    this.waitingKeyframe = true;
                    this.activeCodecId = 0;
                    this.requestKeyframe();
                }
            });
            this.videoDecoder.configure(config);
            this.activeCodecId = codecId;
            this.waitingKeyframe = true;
            return true;
        } catch {
            return false;
        }
    }

    _decodeVideoFrame(meta, data) {
        if (!this._ensureVideoDecoder(meta.codecId, meta.width, meta.height)) return;
        if (this.waitingKeyframe) {
            if (!meta.isKeyFrame) {
                this._scheduleIdrRequest();
                return;
            }
            this.waitingKeyframe = false;
        }
        if (this.videoDecoder.decodeQueueSize > 6 && !meta.isKeyFrame) {
            this.waitingKeyframe = true;
            this.requestKeyframe();
            return;
        }
        try {
            const chunk = new EncodedVideoChunk({
                type: meta.isKeyFrame ? "key" : "delta",
                timestamp: meta.captureTimeUs > 0 ? meta.captureTimeUs : 0,
                data
            });
            this.videoDecoder.decode(chunk);
        } catch {
            this.waitingKeyframe = true;
            this.requestKeyframe();
        }
    }

    _scheduleIdrRequest() {
        if (this.idrTimer) return;
        this.idrTimer = setTimeout(() => {
            this.idrTimer = null;
            if (!this.disposed && this.waitingKeyframe) {
                this.requestKeyframe();
            }
        }, 400);
    }

    requestKeyframe() {
        this._sendAppPacket(buildVideoIdrRequest(), true);
    }

    _recordClockOffset(clientSentUs, hostTimeUs, clientRecvUs) {
        const rttUs = clientRecvUs - clientSentUs;
        if (rttUs < 0 || rttUs > 2000000 || hostTimeUs <= 0) return;
        const sampleOffsetUs = clientRecvUs - (hostTimeUs + rttUs * 0.5);
        if (!this.hasClockOffset) {
            this.clockOffsetUs = sampleOffsetUs;
            this.bestClockRttUs = rttUs;
            this.lastBestRttResetUs = clientRecvUs;
            this.hasClockOffset = true;
            return;
        }
        if (clientRecvUs - this.lastBestRttResetUs > 15000000) {
            this.bestClockRttUs = rttUs;
            this.lastBestRttResetUs = clientRecvUs;
        }
        if (rttUs < this.bestClockRttUs) {
            this.bestClockRttUs = rttUs;
        }
        const diff = sampleOffsetUs - this.clockOffsetUs;
        if (Math.abs(diff) > 500000) {
            this.clockOffsetUs = sampleOffsetUs;
            return;
        }
        const alpha = (rttUs <= this.bestClockRttUs + 3000) ? 0.25 : 0.04;
        this.clockOffsetUs += diff * alpha;
    }

    _notifyVideoFrameRendered(videoCaptureTimeUs, localRenderUs) {
        if (videoCaptureTimeUs <= 0) return;
        const sampleOffset = localRenderUs - videoCaptureTimeUs;
        if (!this.hasVideoOffset || Math.abs(sampleOffset - this.videoPresentOffsetUs) > 500000) {
            this.videoPresentOffsetUs = sampleOffset;
            this.hasVideoOffset = true;
        } else {
            this.videoPresentOffsetUs += (sampleOffset - this.videoPresentOffsetUs) * 0.08;
        }
        this.lastVideoRenderUs = localRenderUs;
    }

    _computeAudioTargetBufferUs() {
        const jitterTarget = Math.min(90000, Math.max(28000, Math.round(this.audioJitterUs * 3.0 + 18000)));
        return jitterTarget;
    }

    _updateAvSyncRate(audioCaptureTimeUs) {
        if (!this.audioWorklet || audioCaptureTimeUs <= 0) return;
        const nowUs = Math.floor(performance.now() * 1000);
        const workletBufUs = (this.audioWorkletBufferedFrames / 48000) * 1e6;
        const rawDacSec = (this.audioCtx ? ((this.audioCtx.outputLatency || 0) + (this.audioCtx.baseLatency || 0.01)) : 0.015);
        const dacLatencyUs = Math.max(0, Math.min(250000, rawDacSec * 1e6));

        const audioPresentOffsetUs = (nowUs + workletBufUs + dacLatencyUs) - audioCaptureTimeUs;
        let targetOffsetUs = 0;
        let hasTarget = false;
        if (this.hasVideoOffset && (nowUs - this.lastVideoRenderUs) < 2000000) {
            targetOffsetUs = this.videoPresentOffsetUs;
            hasTarget = true;
        } else if (this.hasClockOffset) {
            targetOffsetUs = this.clockOffsetUs + this._computeAudioTargetBufferUs() + dacLatencyUs;
            hasTarget = true;
        }
        if (!hasTarget) return;

        const avDriftUs = audioPresentOffsetUs - targetOffsetUs;
        if (avDriftUs > 220000 && this.audioWorkletBufferedFrames > 4800) {
            const targetFrames = Math.max(1440, Math.min(4800, Math.round((this._computeAudioTargetBufferUs() / 1e6) * 48000)));
            this.audioWorklet.port.postMessage({ type: "trim", targetFrames });
            this.audioWorkletBufferedFrames = targetFrames;
            this.audioPlaybackRate = 1.0;
            this.audioWorklet.port.postMessage({ type: "rate", rate: 1.0 });
            return;
        }

        let desiredRate = 1.0;
        if (Math.abs(avDriftUs) > 8000) {
            desiredRate = 1.0 + (avDriftUs / 1000.0) * 0.00025;
            desiredRate = Math.max(0.985, Math.min(1.015, desiredRate));
        }

        // Buffer safety rails so A/V sync never starves or bloats the worklet ring
        if (this.audioWorkletBufferedFrames < 960 && desiredRate > 1.0) {
            desiredRate = 1.0;
        } else if (this.audioWorkletBufferedFrames > 7680 && desiredRate < 1.0) {
            desiredRate = 1.0;
        }

        this.audioPlaybackRate += (desiredRate - this.audioPlaybackRate) * 0.15;
        if (Math.abs(this.audioPlaybackRate - 1.0) < 0.0004) {
            this.audioPlaybackRate = 1.0;
        }
        this.audioWorklet.port.postMessage({ type: "rate", rate: this.audioPlaybackRate });
    }

    async _ensureAudioPipeline() {
        if (!this.caps.canAudioDecode || this.audioMuted || this.audioDecoder) return;
        try {
            this.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
            await this.audioCtx.audioWorklet.addModule(WORKLET_SCRIPT_URL);
            this.audioWorklet = new AudioWorkletNode(this.audioCtx, "osmium-pcm-player", {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });
            this.audioWorklet.port.onmessage = (ev) => {
                if (ev.data && ev.data.type === "stats") {
                    this.audioWorkletBufferedFrames = Number(ev.data.bufferedFrames) || 0;
                }
            };
            this.audioWorklet.connect(this.audioCtx.destination);
            this.audioDecoder = new AudioDecoder({
                output: (audioData) => {
                    try {
                        if (!this.audioWorklet || this.audioMuted) return;
                        const frames = audioData.numberOfFrames;
                        const left = new Float32Array(frames);
                        const right = new Float32Array(frames);
                        const fmt = audioData.format || "";
                        if (fmt.includes("planar")) {
                            audioData.copyTo(left, { planeIndex: 0, format: "f32-planar" });
                            if (audioData.numberOfChannels > 1) {
                                audioData.copyTo(right, { planeIndex: 1, format: "f32-planar" });
                            } else {
                                right.set(left);
                            }
                        } else {
                            const interleaved = new Float32Array(frames * Math.max(1, audioData.numberOfChannels));
                            audioData.copyTo(interleaved, { planeIndex: 0, format: "f32" });
                            if (audioData.numberOfChannels > 1) {
                                for (let i = 0; i < frames; i++) {
                                    left[i] = interleaved[i * 2];
                                    right[i] = interleaved[i * 2 + 1];
                                }
                            } else {
                                left.set(interleaved);
                                right.set(interleaved);
                            }
                        }
                        if (audioData.timestamp > 0) {
                            this._updateAvSyncRate(audioData.timestamp);
                        }
                        const fadeIn = this.audioNeedFadeIn;
                        this.audioNeedFadeIn = false;
                        this.audioWorkletBufferedFrames = Math.min(32768, this.audioWorkletBufferedFrames + frames);
                        this.audioWorklet.port.postMessage({ type: "pcm", left, right, fadeIn }, [left.buffer, right.buffer]);
                    } catch {} finally {
                        audioData.close();
                    }
                },
                error: () => {}
            });
            this.audioDecoder.configure({
                codec: "opus",
                sampleRate: 48000,
                numberOfChannels: 2
            });
        } catch {}
    }

    _enqueueAudioFrame(plain) {
        if (!this.caps.canAudioDecode || this.audioMuted) return;
        const frame = parseAudioFrame(plain);
        if (!frame || !frame.payload || frame.payload.byteLength === 0) return;

        if (!this.audioDecoder) {
            this._ensureAudioPipeline();
        }
        if (this.audioCtx && this.audioCtx.state === "suspended") {
            this.audioCtx.resume().catch(() => {});
        }

        const nowUs = Math.floor(performance.now() * 1000);
        if (this.audioHasLastArrival && frame.captureTimeUs > this.audioLastCaptureUs) {
            const dArrival = nowUs - this.audioLastArrivalUs;
            const dCapture = frame.captureTimeUs - this.audioLastCaptureUs;
            const d = Math.abs(dArrival - dCapture);
            if (d < 250000) {
                this.audioJitterUs += (d - this.audioJitterUs) / 16.0;
            }
        }
        this.audioHasLastArrival = true;
        this.audioLastArrivalUs = nowUs;
        this.audioLastCaptureUs = frame.captureTimeUs;

        const isStreamStart = (frame.flags & AUDIO_FLAG.STREAM_START) !== 0;
        if (isStreamStart || !this.audioHasExpectedSeq) {
            this.audioJitterMap.clear();
            this.audioExpectedSeq = frame.sequence;
            this.audioHasExpectedSeq = true;
            this.audioPriming = true;
            this.audioFirstArrivalUs = nowUs;
            this.audioNeedFadeIn = true;
        } else {
            const diff = (frame.sequence - this.audioExpectedSeq) | 0;
            if (diff < -2 || diff > 50) {
                // Big discontinuity or old late frame
                if (diff < -2) return;
                this.audioJitterMap.clear();
                this.audioExpectedSeq = frame.sequence;
                this.audioPriming = true;
                this.audioFirstArrivalUs = nowUs;
                this.audioNeedFadeIn = true;
            }
        }

        if (!this.audioJitterMap.has(frame.sequence)) {
            this.audioJitterMap.set(frame.sequence, {
                sequence: frame.sequence,
                captureTimeUs: frame.captureTimeUs,
                flags: frame.flags,
                payload: new Uint8Array(frame.payload),
                redundantPayload: frame.redundantPayload ? new Uint8Array(frame.redundantPayload) : null,
                arrivalUs: nowUs
            });
        }

        // Recover immediate predecessor from piggybacked redundancy if missing
        if (frame.redundantPayload && frame.redundantPayload.byteLength > 0 && frame.sequence > 0) {
            const prevSeq = (frame.sequence - 1) >>> 0;
            const prevDiff = (prevSeq - this.audioExpectedSeq) | 0;
            if (prevDiff >= 0 && !this.audioJitterMap.has(prevSeq)) {
                this.audioJitterMap.set(prevSeq, {
                    sequence: prevSeq,
                    captureTimeUs: frame.captureTimeUs > 20000 ? frame.captureTimeUs - 20000 : 0,
                    flags: 0,
                    payload: new Uint8Array(frame.redundantPayload),
                    redundantPayload: null,
                    arrivalUs: nowUs
                });
            }
        }

        while (this.audioJitterMap.size > 24) {
            let minSeq = Infinity;
            for (const k of this.audioJitterMap.keys()) {
                if (k < minSeq) minSeq = k;
            }
            if (minSeq === Infinity) break;
            this.audioJitterMap.delete(minSeq);
            if (((this.audioExpectedSeq - minSeq) | 0) <= 0) {
                this.audioExpectedSeq = (minSeq + 1) >>> 0;
            }
        }

        this._pumpAudioJitterBuffer();
    }

    _decodeOpusBytes(opusBytes, captureTimeUs) {
        if (!this.audioDecoder || this.audioDecoder.state !== "configured" || !opusBytes || opusBytes.byteLength === 0) {
            return;
        }
        try {
            const chunk = new EncodedAudioChunk({
                type: "key",
                timestamp: captureTimeUs > 0 ? captureTimeUs : 0,
                data: opusBytes
            });
            this.audioDecoder.decode(chunk);
        } catch {}
    }

    _pumpAudioJitterBuffer() {
        if (this.disposed || this.audioMuted || !this.audioHasExpectedSeq || this.audioJitterMap.size === 0) return;
        if (!this.audioDecoder || this.audioDecoder.state !== "configured") return;

        const nowUs = Math.floor(performance.now() * 1000);
        const nowMs = performance.now();
        if (this.audioStatsWinStartMs === 0) {
            this.audioStatsWinStartMs = nowMs;
        } else if (nowMs - this.audioStatsWinStartMs >= 2000) {
            if (this.audioStatsExpected > 0) {
                this.audioLossPermille = Math.min(1000, Math.round((this.audioStatsLost * 1000) / this.audioStatsExpected));
            } else {
                this.audioLossPermille = 0;
            }
            this.audioStatsExpected = 0;
            this.audioStatsLost = 0;
            this.audioStatsWinStartMs = nowMs;
        }

        if (this.audioPriming) {
            const waitedUs = nowUs - this.audioFirstArrivalUs;
            const primeDelayUs = Math.min(50000, Math.max(16000, Math.round(this.audioJitterUs * 1.5)));
            if (this.audioJitterMap.size < 2 && waitedUs < primeDelayUs) {
                return;
            }
            this.audioPriming = false;
            this.audioLastPopUs = nowUs;
        }

        const maxWaitUs = Math.min(70000, Math.max(24000, Math.round(this.audioJitterUs * 2.5 + 16000)));
        for (let iter = 0; iter < 6; iter++) {
            const exact = this.audioJitterMap.get(this.audioExpectedSeq);
            if (exact) {
                this.audioJitterMap.delete(this.audioExpectedSeq);
                this.audioExpectedSeq = (this.audioExpectedSeq + 1) >>> 0;
                this.audioLastPopUs = nowUs;
                this.audioStatsExpected++;
                this._decodeOpusBytes(exact.payload, exact.captureTimeUs);
                continue;
            }
            if (this.audioJitterMap.size === 0) break;

            // Find lowest queued sequence ahead of expected
            let nextSeq = -1;
            let nextDiff = Infinity;
            for (const seq of this.audioJitterMap.keys()) {
                const d = (seq - this.audioExpectedSeq) | 0;
                if (d > 0 && d < nextDiff) {
                    nextDiff = d;
                    nextSeq = seq;
                }
            }
            if (nextSeq < 0) break;
            const nextSlot = this.audioJitterMap.get(nextSeq);
            const waitedUs = nowUs - this.audioLastPopUs;
            if (waitedUs < maxWaitUs && this.audioJitterMap.size < 4) {
                break;
            }
            // Gap exceeded jitter budget: skip lost frame(s) and fade in next clean frame
            this.audioStatsExpected++;
            this.audioStatsLost++;
            this.audioNeedFadeIn = true;
            this.audioExpectedSeq = (this.audioExpectedSeq + 1) >>> 0;
            this.audioLastPopUs = nowUs;
            if (nextDiff > 4 && nextSlot) {
                this.audioStatsLost += Math.min(10, nextDiff - 1);
                this.audioStatsExpected += Math.min(10, nextDiff - 1);
                this.audioExpectedSeq = nextSeq;
            }
        }
    }

    setAudioMuted(muted) {
        this.audioMuted = Boolean(muted);
        this.audioJitterMap.clear();
        this.audioHasExpectedSeq = false;
        this.audioPriming = true;
        this.audioNeedFadeIn = true;
        if (this.audioWorklet) {
            this.audioWorklet.port.postMessage({ type: "mute", muted: this.audioMuted });
        }
        this._sendAudioPacket(buildAudioControl(this.audioMuted));
        if (!this.audioMuted && !this.audioDecoder) {
            this._ensureAudioPipeline();
        }
        if (!this.audioMuted && this.audioCtx && this.audioCtx.state === "suspended") {
            this.audioCtx.resume().catch(() => {});
        }
    }

    setRelativeMouse(enabled) {
        this.mouseRelative = Boolean(enabled && this.caps.hasPointerLock);
        if (!this.viewOnly) {
            this._sendAppPacket(buildControlMouseMode(this.mouseRelative ? 1 : 0, !this.mouseRelative), true);
        }
        if (this.mouseRelative && document.pointerLockElement !== this.canvas) {
            try { this.canvas.requestPointerLock(); } catch {}
        } else if (!this.mouseRelative && document.pointerLockElement === this.canvas) {
            try { document.exitPointerLock(); } catch {}
        }
    }

    async setKeyboardLock(enabled) {
        if (!this.caps.hasKeyboardLock) return false;
        this.keyboardLocked = Boolean(enabled);
        try {
            if (this.keyboardLocked) {
                await navigator.keyboard.lock();
                return true;
            }
            navigator.keyboard.unlock();
            return false;
        } catch {
            this.keyboardLocked = false;
            return false;
        }
    }

    switchDisplay(displayIndex) {
        this._sendAppPacket(buildControlSwitchDisplay(displayIndex), true);
        this.waitingKeyframe = true;
    }

    updateVideoParams({ resolution, fps, bitrateKbps }) {
        this.settings.resolution = resolution;
        this.settings.fps = fps;
        this.settings.bitrateKbps = bitrateKbps;
        const { width, height } = this._getDesiredResolution();
        const cappedFps = this.caps.allowHighFps ? Number(fps || 60) : Math.min(60, Number(fps || 60));
        this._sendAppPacket(buildControlVideoParams(width, height, cappedFps, Number(bitrateKbps || 8000), 0, 0), true);
    }

    sendSystemAction(actionId) {
        if (this.viewOnly) return;
        this._sendAppPacket(buildControlSystemAction(actionId), true);
    }

    sendClipboardText(text) {
        if (this.viewOnly || !this.auxClipboard) return false;
        return this.auxClipboard.sendClipboardText(text);
    }

    sendUnicodeText(text) {
        if (this.viewOnly || !text) return;
        this._sendAppPacket(buildInputUnicodeText(text), true);
    }

    sendVirtualKey(vk, down, ext = false) {
        if (this.viewOnly) return;
        this._sendAppPacket(buildInputKey(vk, 0, Boolean(down), Boolean(ext)), true);
    }

    sendKeyTap(vk, ext = false) {
        if (this.viewOnly) return;
        this._sendAppPacket(buildInputKey(vk, 0, true, Boolean(ext)), true);
        this._sendAppPacket(buildInputKey(vk, 0, false, Boolean(ext)), true);
    }

    _startLoopsAndInput() {
        this.pingTimer = setInterval(() => {
            if (!this.disposed) {
                this._sendAppPacket(buildPing(Math.floor(performance.now() * 1000)), false);
            }
        }, 1500);

        this.audioPingTimer = setInterval(() => {
            if (!this.disposed) {
                const bufMs = Math.round((this.audioWorkletBufferedFrames / 48000) * 1000);
                const jitterMs = Math.round(this.audioJitterUs / 1000);
                this._sendAudioPacket(
                    buildAudioPing(Math.floor(performance.now() * 1000), this.audioLossPermille, bufMs, jitterMs)
                );
            }
        }, 300);

        this.audioJitterTimer = setInterval(() => {
            if (!this.disposed) {
                this._pumpAudioJitterBuffer();
            }
        }, 10);

        this.statsTimer = setInterval(() => {
            if (this.disposed) return;
            const fps = this.decodedFramesWindow;
            const mbps = (this.rxBytesWindow * 8) / 1000000;
            this.decodedFramesWindow = 0;
            this.rxBytesWindow = 0;
            this._emit("stats", {
                fps,
                mbps: Number(mbps.toFixed(1)),
                width: this.videoWidth,
                height: this.videoHeight,
                rttMs: this.rttMs
            });
        }, 1000);

        if (!this.audioMuted && this.caps.canAudioDecode) {
            this._ensureAudioPipeline();
        }
        if (!this.viewOnly) {
            this._bindInputHandlers();
            if (this.caps.hasGamepad && this.settings.gamepadEnabled) {
                this._startGamepadLoop();
            }
        }
    }

    _addEvt(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        this._boundEvents.push({ target, type, fn, opts });
    }

    _canvasNormalizedCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const vidW = this.canvas.width || rect.width;
        const vidH = this.canvas.height || rect.height;
        const boxAspect = rect.width / rect.height;
        const vidAspect = vidW / vidH;
        let renderW = rect.width;
        let renderH = rect.height;
        let offX = 0;
        let offY = 0;
        if (boxAspect > vidAspect) {
            renderW = rect.height * vidAspect;
            offX = (rect.width - renderW) / 2;
        } else {
            renderH = rect.width / vidAspect;
            offY = (rect.height - renderH) / 2;
        }
        const x = (e.clientX - rect.left - offX) / renderW;
        const y = (e.clientY - rect.top - offY) / renderH;
        return {
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y))
        };
    }

    _bindInputHandlers() {
        const unlockAudio = () => {
            if (this.audioCtx && this.audioCtx.state === "suspended") {
                this.audioCtx.resume().catch(() => {});
            }
        };

        this._addEvt(this.canvas, "contextmenu", (e) => e.preventDefault());

        this._addEvt(this.canvas, "mousemove", (e) => {
            if (this.disposed || this.viewOnly) return;
            if (document.pointerLockElement === this.canvas) {
                const dx = e.movementX || 0;
                const dy = e.movementY || 0;
                if (dx !== 0 || dy !== 0) {
                    this._sendAppPacket(buildInputMouseMove(false, dx, dy), false);
                }
                return;
            }
            const pt = this._canvasNormalizedCoords(e);
            if (pt) {
                this._sendAppPacket(buildInputMouseMove(true, pt.x, pt.y), false);
            }
        });

        this._addEvt(this.canvas, "mousedown", (e) => {
            if (this.disposed || this.viewOnly) return;
            e.preventDefault();
            unlockAudio();
            if (this.mouseRelative && document.pointerLockElement !== this.canvas) {
                try { this.canvas.requestPointerLock(); } catch {}
            } else {
                const pt = this._canvasNormalizedCoords(e);
                if (pt) this._sendAppPacket(buildInputMouseMove(true, pt.x, pt.y), false);
            }
            const btn = e.button + 1;
            if (btn >= 1 && btn <= 5) {
                this.heldButtons.add(btn);
                this._sendAppPacket(buildInputMouseButton(btn, true), true);
            }
        });

        this._addEvt(window, "mouseup", (e) => {
            if (this.disposed || this.viewOnly) return;
            const btn = e.button + 1;
            if (this.heldButtons.has(btn)) {
                this.heldButtons.delete(btn);
                this._sendAppPacket(buildInputMouseButton(btn, false), true);
            }
        });

        this._addEvt(this.canvas, "wheel", (e) => {
            if (this.disposed || this.viewOnly) return;
            e.preventDefault();
            const scale = e.deltaMode === 1 ? 40 : (e.deltaMode === 2 ? 360 : 1.2);
            const dy = -Math.round(e.deltaY * scale);
            const dx = Math.round(e.deltaX * scale);
            if (dx !== 0 || dy !== 0) {
                this._sendAppPacket(buildInputMouseWheel(dx, dy), true);
            }
        }, { passive: false });

        this._addEvt(window, "keydown", (e) => {
            if (this.disposed || this.viewOnly) return;
            if (this._isUiInputFocused()) return;
            const mapped = DOM_CODE_TO_VK[e.code];
            if (!mapped) return;
            e.preventDefault();
            unlockAudio();
            this.heldKeys.add(e.code);
            this._sendAppPacket(buildInputKey(mapped.vk, 0, true, mapped.ext), true);
        });

        this._addEvt(window, "keyup", (e) => {
            if (this.disposed || this.viewOnly) return;
            if (!this.heldKeys.has(e.code) && this._isUiInputFocused()) return;
            const mapped = DOM_CODE_TO_VK[e.code];
            if (!mapped) return;
            e.preventDefault();
            this.heldKeys.delete(e.code);
            this._sendAppPacket(buildInputKey(mapped.vk, 0, false, mapped.ext), true);
        });

        this._addEvt(window, "blur", () => this._releaseAllHeldInputs());
        this._addEvt(document, "pointerlockchange", () => {
            const locked = document.pointerLockElement === this.canvas;
            this._emit("pointerLock", locked);
        });

        let touchMode = "none";
        let tStartX = 0;
        let tStartY = 0;
        let tStartPt = null;
        let tStartTime = 0;
        let tLastMidX = 0;
        let tLastMidY = 0;
        let tTwoMoved = 0;
        let tLongPressFired = false;

        const clearLongPress = () => {
            if (this.touchLongPressTimer) {
                clearTimeout(this.touchLongPressTimer);
                this.touchLongPressTimer = null;
            }
        };

        const sendClickAt = (pt, btn) => {
            if (!pt) return;
            this._sendAppPacket(buildInputMouseMove(true, pt.x, pt.y), false);
            this._sendAppPacket(buildInputMouseButton(btn, true), true);
            this._sendAppPacket(buildInputMouseButton(btn, false), true);
        };

        this._addEvt(this.canvas, "touchstart", (e) => {
            if (this.disposed || this.viewOnly) return;
            e.preventDefault();
            unlockAudio();
            const touches = e.touches;
            if (touches.length === 1) {
                clearLongPress();
                const tc = touches[0];
                tStartX = tc.clientX;
                tStartY = tc.clientY;
                tStartPt = this._canvasNormalizedCoords(tc);
                tStartTime = performance.now();
                tLongPressFired = false;
                touchMode = "one";
                if (tStartPt) {
                    this._sendAppPacket(buildInputMouseMove(true, tStartPt.x, tStartPt.y), false);
                }
                this.touchLongPressTimer = setTimeout(() => {
                    this.touchLongPressTimer = null;
                    if (touchMode === "one" && !this.disposed && !this.viewOnly) {
                        tLongPressFired = true;
                        touchMode = "longpress";
                        sendClickAt(tStartPt, 3);
                        try { navigator.vibrate?.(18); } catch {}
                    }
                }, 480);
            } else if (touches.length === 2) {
                clearLongPress();
                if (touchMode === "drag" && this.heldButtons.has(1)) {
                    this.heldButtons.delete(1);
                    this._sendAppPacket(buildInputMouseButton(1, false), true);
                }
                touchMode = "two";
                tStartTime = performance.now();
                tTwoMoved = 0;
                tLastMidX = (touches[0].clientX + touches[1].clientX) / 2;
                tLastMidY = (touches[0].clientY + touches[1].clientY) / 2;
                tStartPt = this._canvasNormalizedCoords({ clientX: tLastMidX, clientY: tLastMidY });
            }
        }, { passive: false });

        this._addEvt(this.canvas, "touchmove", (e) => {
            if (this.disposed || this.viewOnly) return;
            e.preventDefault();
            const touches = e.touches;
            if (touches.length === 1 && (touchMode === "one" || touchMode === "drag")) {
                const tc = touches[0];
                const dist = Math.hypot(tc.clientX - tStartX, tc.clientY - tStartY);
                const pt = this._canvasNormalizedCoords(tc);
                if (touchMode === "one" && dist > 10) {
                    clearLongPress();
                    touchMode = "drag";
                    if (tStartPt) {
                        this._sendAppPacket(buildInputMouseMove(true, tStartPt.x, tStartPt.y), false);
                    }
                    this.heldButtons.add(1);
                    this._sendAppPacket(buildInputMouseButton(1, true), true);
                }
                if (touchMode === "drag" && pt) {
                    this._sendAppPacket(buildInputMouseMove(true, pt.x, pt.y), false);
                }
            } else if (touches.length === 2 && touchMode === "two") {
                const midX = (touches[0].clientX + touches[1].clientX) / 2;
                const midY = (touches[0].clientY + touches[1].clientY) / 2;
                const dx = midX - tLastMidX;
                const dy = midY - tLastMidY;
                tLastMidX = midX;
                tLastMidY = midY;
                tTwoMoved += Math.hypot(dx, dy);
                if (tTwoMoved > 8) {
                    const wheelY = Math.round(dy * 3.2);
                    const wheelX = Math.round(-dx * 2.4);
                    if (wheelX !== 0 || wheelY !== 0) {
                        this._sendAppPacket(buildInputMouseWheel(wheelX, wheelY), true);
                    }
                }
            }
        }, { passive: false });

        this._addEvt(this.canvas, "touchend", (e) => {
            if (this.disposed || this.viewOnly) return;
            e.preventDefault();
            clearLongPress();
            if (touchMode === "drag") {
                if (this.heldButtons.has(1)) {
                    this.heldButtons.delete(1);
                    this._sendAppPacket(buildInputMouseButton(1, false), true);
                }
            } else if (touchMode === "one" && !tLongPressFired) {
                const tc = e.changedTouches[0];
                const pt = tc ? this._canvasNormalizedCoords(tc) : tStartPt;
                sendClickAt(pt || tStartPt, 1);
            } else if (touchMode === "two" && e.touches.length === 0) {
                if (tTwoMoved < 14 && (performance.now() - tStartTime) < 320) {
                    sendClickAt(tStartPt, 3);
                }
            }
            if (e.touches.length === 0) {
                touchMode = "none";
                tLongPressFired = false;
            }
        }, { passive: false });

        this._addEvt(this.canvas, "touchcancel", () => {
            clearLongPress();
            if (this.heldButtons.has(1)) {
                this.heldButtons.delete(1);
                this._sendAppPacket(buildInputMouseButton(1, false), true);
            }
            touchMode = "none";
            tLongPressFired = false;
        });
    }

    _isUiInputFocused() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = (el.tagName || "").toUpperCase();
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }

    _releaseAllHeldInputs() {
        for (const code of Array.from(this.heldKeys)) {
            const mapped = DOM_CODE_TO_VK[code];
            if (mapped) this._sendAppPacket(buildInputKey(mapped.vk, 0, false, mapped.ext), true);
        }
        this.heldKeys.clear();
        for (const btn of Array.from(this.heldButtons)) {
            this._sendAppPacket(buildInputMouseButton(btn, false), true);
        }
        this.heldButtons.clear();
    }

    _startGamepadLoop() {
        const poll = () => {
            if (this.disposed || this.viewOnly) return;
            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            const gp = pads && pads[0] ? pads[0] : null;
            if (gp && gp.connected) {
                const b = gp.buttons || [];
                const pressed = (i) => Boolean(b[i] && (b[i].pressed || b[i].value > 0.5));
                let mask = 0;
                if (pressed(12)) mask |= 0x0001;
                if (pressed(13)) mask |= 0x0002;
                if (pressed(14)) mask |= 0x0004;
                if (pressed(15)) mask |= 0x0008;
                if (pressed(9)) mask |= 0x0010;
                if (pressed(8)) mask |= 0x0020;
                if (pressed(10)) mask |= 0x0040;
                if (pressed(11)) mask |= 0x0080;
                if (pressed(4)) mask |= 0x0100;
                if (pressed(5)) mask |= 0x0200;
                if (pressed(16)) mask |= 0x0400;
                if (pressed(0)) mask |= 0x1000;
                if (pressed(1)) mask |= 0x2000;
                if (pressed(2)) mask |= 0x4000;
                if (pressed(3)) mask |= 0x8000;

                const lt = Math.round(((b[6]?.value) || 0) * 255);
                const rt = Math.round(((b[7]?.value) || 0) * 255);
                const axis = (v, inv = false) => {
                    const n = Math.abs(v || 0) < 0.06 ? 0 : (inv ? -v : v);
                    return Math.max(-32768, Math.min(32767, Math.round(n * 32767)));
                };
                const lx = axis(gp.axes[0], false);
                const ly = axis(gp.axes[1], true);
                const rx = axis(gp.axes[2], false);
                const ry = axis(gp.axes[3], true);
                const sig = `${mask},${lt},${rt},${lx},${ly},${rx},${ry}`;
                if (sig !== this.lastGamepadSig) {
                    this.lastGamepadSig = sig;
                    this._sendAppPacket(buildInputGamepad(0, true, mask, lt, rt, lx, ly, rx, ry), false);
                }
            }
            this.gamepadRaf = requestAnimationFrame(poll);
        };
        this.gamepadRaf = requestAnimationFrame(poll);
    }

    _fail(message) {
        this._emit("error", message);
        this.close(true, !this.established);
    }

    close(notifyPeer = true, failed = false) {
        if (this.disposed) return;
        this.disposed = true;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.audioPingTimer) clearInterval(this.audioPingTimer);
        if (this.audioJitterTimer) clearInterval(this.audioJitterTimer);
        if (this.statsTimer) clearInterval(this.statsTimer);
        if (this.idrTimer) clearTimeout(this.idrTimer);
        if (this.touchLongPressTimer) clearTimeout(this.touchLongPressTimer);
        if (this.relayKeepaliveTimer) clearInterval(this.relayKeepaliveTimer);
        if (this.audioRelayKeepaliveTimer) clearInterval(this.audioRelayKeepaliveTimer);
        if (this.gamepadRaf) cancelAnimationFrame(this.gamepadRaf);

        for (const item of this._boundEvents) {
            try { item.target.removeEventListener(item.type, item.fn, item.opts); } catch {}
        }
        this._boundEvents = [];

        if (document.pointerLockElement === this.canvas) {
            try { document.exitPointerLock(); } catch {}
        }
        if (this.keyboardLocked && navigator.keyboard && typeof navigator.keyboard.unlock === "function") {
            try { navigator.keyboard.unlock(); } catch {}
        }

        if (notifyPeer && this.sessionId) {
            if ((this.ctrlDc && this.ctrlDc.readyState === "open") || (this.relayWs && this.relayWs.readyState === WebSocket.OPEN)) {
                this._sendAppPacket(buildDisconnect(), true);
            }
            this.signaling.send({
                type: "session_end",
                sessionId: this.sessionId,
                targetDeviceId: this.targetDeviceId,
                role: "client",
                failed: Boolean(failed)
            });
        }

        try { this.relayWs?.close(1000); } catch {}
        try { this.audioRelayWs?.close(1000); } catch {}
        try { this.ctrlDc?.close(); } catch {}
        try { this.mediaDc?.close(); } catch {}
        try { this.audioDc?.close(); } catch {}
        try { this.pc?.close(); } catch {}
        try { this.videoDecoder?.close(); } catch {}
        try { this.audioDecoder?.close(); } catch {}
        try { this.audioWorklet?.disconnect(); } catch {}
        try { this.audioCtx?.close(); } catch {}
        this.frameBuffers.clear();
        this.audioJitterMap.clear();
    }

    _emit(name, data) {
        const fn = this.callbacks[name];
        if (typeof fn === "function") fn(data);
    }
}
