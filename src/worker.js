const SESSION_COOKIE = "osmium_web_sid";
const DEVICE_COOKIE = "osmium_web_did";
const CHALLENGE_COOKIE = "osmium_web_ch";
const OAUTH_COOKIE = "osmium_web_oa";
const QR_COOKIE = "osmium_web_qr";
const TWO_FA_COOKIE = "osmium_web_2fa";
const WEB_CLIENT_VERSION = "1.0.1";
const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;
const DEVICE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const PENDING_MAX_AGE_SEC = 10 * 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

let cachedKeySecret = "";
let cachedAesKey = null;

function baseSecurityHeaders(signalingOrigin) {
    let wsOrigin = "wss://osmium.fufu.skin";
    let httpsOrigin = "https://osmium.fufu.skin";
    try {
        const u = new URL(signalingOrigin || "https://osmium.fufu.skin");
        httpsOrigin = u.origin;
        wsOrigin = (u.protocol === "http:" ? "ws://" : "wss://") + u.host;
    } catch {}
    const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        `img-src 'self' data: blob: ${httpsOrigin}`,
        `connect-src 'self' ${wsOrigin}`,
        "worker-src 'self' blob:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'"
    ].join("; ");
    return {
        "Content-Security-Policy": csp,
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        "Permissions-Policy": "camera=(), geolocation=(), payment=(), usb=()"
    };
}

function toBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(str) {
    if (typeof str !== "string" || !str || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
    const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
    try {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

function randomBase64Url(len) {
    const buf = new Uint8Array(len);
    crypto.getRandomValues(buf);
    return toBase64Url(buf);
}

function generateNumericDeviceId() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const num = 100000000 + (buf[0] % 900000000);
    return String(num);
}

function timingSafeEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ba = enc.encode(a);
    const bb = enc.encode(b);
    if (ba.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
    return diff === 0;
}

async function getCookieAesKey(env) {
    const secret = String(env.WEB_COOKIE_SECRET || "").trim();
    if (secret.length < 32) return null;
    if (cachedAesKey && cachedKeySecret === secret) return cachedAesKey;
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(`osmium-web-cookie-v1:${secret}`));
    cachedAesKey = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    cachedKeySecret = secret;
    return cachedAesKey;
}

async function sealCookie(env, name, payloadObj) {
    const key = await getCookieAesKey(env);
    if (!key) return null;
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const plain = enc.encode(JSON.stringify(payloadObj));
    const cipher = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: enc.encode(name) },
            key,
            plain
        )
    );
    const combined = new Uint8Array(12 + cipher.length);
    combined.set(iv, 0);
    combined.set(cipher, 12);
    return toBase64Url(combined);
}

async function openCookie(env, name, rawValue) {
    const key = await getCookieAesKey(env);
    if (!key || !rawValue) return null;
    const combined = fromBase64Url(rawValue);
    if (!combined || combined.length <= 28) return null;
    const iv = combined.subarray(0, 12);
    const cipher = combined.subarray(12);
    try {
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv, additionalData: enc.encode(name) },
            key,
            cipher
        );
        const obj = JSON.parse(dec.decode(plain));
        if (!obj || typeof obj !== "object") return null;
        if (typeof obj.exp === "number" && obj.exp <= Date.now()) return null;
        return obj;
    } catch {
        return null;
    }
}

function parseCookies(request) {
    const raw = request.headers.get("Cookie") || "";
    const map = Object.create(null);
    if (!raw) return map;
    for (const part of raw.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) map[k] = v;
    }
    return map;
}

function formatSetCookie(name, value, maxAgeSec, isSecure) {
    const parts = [
        `${name}=${value}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`
    ];
    if (isSecure) parts.push("Secure");
    return parts.join("; ");
}

function clearCookie(name, isSecure) {
    return formatSetCookie(name, "", 0, isSecure);
}

function jsonResponse(body, status, signalingOrigin, extraCookies = []) {
    const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "Pragma": "no-cache",
        ...baseSecurityHeaders(signalingOrigin)
    });
    for (const c of extraCookies) {
        if (c) headers.append("Set-Cookie", c);
    }
    return new Response(JSON.stringify(body), { status, headers });
}

function isSameOriginPost(request, url) {
    const origin = (request.headers.get("Origin") || "").trim();
    const fetchSite = (request.headers.get("Sec-Fetch-Site") || "").trim().toLowerCase();
    if (origin) {
        return origin === url.origin;
    }
    return fetchSite === "same-origin";
}

async function readJsonPayload(request, maxBytes = 16384) {
    const ct = (request.headers.get("Content-Type") || "").toLowerCase();
    if (!ct.includes("application/json")) return null;
    const text = await request.text();
    if (!text || text.length > maxBytes) return null;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function sanitizeAvatarData(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 262144) return null;
    if (/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
        return trimmed;
    }
    return null;
}

function extractPublicUser(src) {
    if (!src || typeof src !== "object") return null;
    return {
        user_id: String(src.user_id || ""),
        username: String(src.username || "Osmium"),
        email: String(src.email || ""),
        avatar_data: sanitizeAvatarData(src.avatar_data),
        account_status: String(src.account_status || (src.locked ? "locked" : "active")),
        locked: Boolean(src.locked),
        has_email: src.has_email !== false,
        has_password: src.has_password !== false,
        two_fa_enabled: Boolean(src.two_fa_enabled),
        profile_complete: src.profile_complete !== false
    };
}

function getSignalingOrigin(env) {
    return String(env.SIGNALING_ORIGIN || "https://osmium.fufu.skin").replace(/\/+$/, "");
}

function getWsOrigin(signalingOrigin) {
    try {
        const u = new URL(signalingOrigin);
        return (u.protocol === "http:" ? "ws://" : "wss://") + u.host;
    } catch {
        return "wss://osmium.fufu.skin";
    }
}

async function upstreamFetch(env, signalingOrigin, path, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "application/json");
    headers.set("X-Client-Version", WEB_CLIENT_VERSION);
    headers.set("X-Osmium-Client-Scope", "web");
    const targetUrl = `${signalingOrigin}${path}`;
    const serviceBinding = env && typeof env.SIGNALING?.fetch === "function" ? env.SIGNALING : null;
    const resp = serviceBinding
        ? await serviceBinding.fetch(new Request(targetUrl, {
              method: init.method || "GET",
              headers,
              body: init.body
          }))
        : await fetch(targetUrl, {
              method: init.method || "GET",
              headers,
              body: init.body,
              signal: AbortSignal.timeout(15000)
          });
    let json = null;
    try {
        json = await resp.json();
    } catch {}
    return { status: resp.status, ok: resp.ok, json };
}

async function ensureDeviceId(env, cookies, isSecure) {
    const existing = await openCookie(env, DEVICE_COOKIE, cookies[DEVICE_COOKIE]);
    if (existing && typeof existing.deviceId === "string" && /^\d{6,12}$/.test(existing.deviceId)) {
        return { deviceId: existing.deviceId, setCookie: null };
    }
    const deviceId = generateNumericDeviceId();
    const sealed = await sealCookie(env, DEVICE_COOKIE, {
        deviceId,
        exp: Date.now() + DEVICE_MAX_AGE_SEC * 1000
    });
    return {
        deviceId,
        setCookie: sealed ? formatSetCookie(DEVICE_COOKIE, sealed, DEVICE_MAX_AGE_SEC, isSecure) : null
    };
}

async function createSessionFromUpstream(env, sessionData, deviceId, isSecure) {
    const stoken = typeof sessionData?.stoken === "string" ? sessionData.stoken.trim() : "";
    const ltoken = typeof sessionData?.ltoken === "string" ? sessionData.ltoken.trim() : "";
    const user = extractPublicUser(sessionData);
    if (!stoken.startsWith("wst_") || !ltoken.startsWith("wlt_") || !user || !user.user_id) return null;
    const expiresInSec = Math.max(60, Number(sessionData.ltoken_expires_in || sessionData.expires_in || 900));
    const stokenMaxAgeSec = Math.min(SESSION_MAX_AGE_SEC, Math.max(300, Number(sessionData.stoken_expires_in || SESSION_MAX_AGE_SEC)));
    const csrfToken = randomBase64Url(24);
    const payload = {
        stoken,
        ltoken,
        ltokenExp: Date.now() + Math.max(120, expiresInSec) * 1000,
        userId: user.user_id,
        deviceId,
        csrfToken,
        exp: Date.now() + stokenMaxAgeSec * 1000
    };
    const sealed = await sealCookie(env, SESSION_COOKIE, payload);
    if (!sealed) return null;
    return {
        cookie: formatSetCookie(SESSION_COOKIE, sealed, stokenMaxAgeSec, isSecure),
        user,
        csrfToken,
        wsToken: ltoken,
        wsExpiresIn: expiresInSec,
        deviceId
    };
}

async function resolveActiveSession(env, cookies, signalingOrigin, isSecure, forceRefresh = false) {
    const sess = await openCookie(env, SESSION_COOKIE, cookies[SESSION_COOKIE]);
    if (!sess || typeof sess.stoken !== "string" || !sess.stoken.startsWith("wst_") || !sess.userId || !sess.csrfToken) {
        return { ok: false, clearCookie: cookies[SESSION_COOKIE] ? clearCookie(SESSION_COOKIE, isSecure) : null };
    }
    const now = Date.now();
    const deviceId = /^\d{6,12}$/.test(String(sess.deviceId || "")) ? String(sess.deviceId) : generateNumericDeviceId();
    if (!forceRefresh && typeof sess.ltoken === "string" && sess.ltoken.startsWith("wlt_") && typeof sess.ltokenExp === "number" && now < sess.ltokenExp - 120000) {
        return {
            ok: true,
            sess: { ...sess, deviceId },
            ltoken: sess.ltoken,
            rotatedCookie: null,
            user: null
        };
    }
    const res = await upstreamFetch(env, signalingOrigin, "/api/auth/ltoken", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-SToken": sess.stoken
        },
        body: "{}"
    });
    if (!res.ok || !res.json?.ok || typeof res.json?.data?.ltoken !== "string" || !res.json.data.ltoken.startsWith("wlt_")) {
        if (res.status === 401 || res.status === 403) {
            return { ok: false, clearCookie: clearCookie(SESSION_COOKIE, isSecure) };
        }
        return { ok: false, upstreamError: true, status: res.status || 502, code: res.json?.code || 1020 };
    }
    const d = res.json.data;
    const expiresInSec = Number(d.expires_in || 900);
    const updated = {
        ...sess,
        deviceId,
        ltoken: d.ltoken,
        ltokenExp: now + Math.max(120, expiresInSec) * 1000,
        exp: now + SESSION_MAX_AGE_SEC * 1000
    };
    const sealed = await sealCookie(env, SESSION_COOKIE, updated);
    return {
        ok: true,
        sess: updated,
        ltoken: d.ltoken,
        wsExpiresIn: expiresInSec,
        rotatedCookie: sealed ? formatSetCookie(SESSION_COOKIE, sealed, SESSION_MAX_AGE_SEC, isSecure) : null,
        user: extractPublicUser(d)
    };
}

function appendWebModeToCaptchaUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return "";
    try {
        const u = new URL(rawUrl);
        u.searchParams.set("mode", "web");
        return u.toString();
    } catch {
        return rawUrl;
    }
}

async function handleWebApi(request, env, url) {
    const signalingOrigin = getSignalingOrigin(env);
    const isSecure = url.protocol === "https:";
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    const cookieKey = await getCookieAesKey(env);
    if (!cookieKey) {
        return jsonResponse({ ok: false, code: 5002 }, 503, signalingOrigin);
    }

    if (method === "POST" && !isSameOriginPost(request, url)) {
        return jsonResponse({ ok: false, code: 2001 }, 403, signalingOrigin);
    }

    const cookies = parseCookies(request);

    if (pathname === "/web-api/auth/providers" && method === "GET") {
        try {
            const res = await upstreamFetch(env, signalingOrigin, "/api/auth/oauth/providers?platform=web");
            if (!res.ok || !res.json?.ok) {
                return jsonResponse({ ok: false, code: res.json?.code || 5001 }, res.status || 502, signalingOrigin);
            }
            const data = res.json.data || {};
            return jsonResponse({
                ok: true,
                code: 0,
                data: {
                    google: Boolean(data.google),
                    qq: Boolean(data.qq),
                    wechat: Boolean(data.wechat),
                    providers: Array.isArray(data.providers) ? data.providers : []
                }
            }, 200, signalingOrigin);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin);
        }
    }

    if (pathname === "/web-api/auth/login" && method === "POST") {
        const body = await readJsonPayload(request, 8192);
        if (!body) return jsonResponse({ ok: false, code: 1001 }, 400, signalingOrigin);
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!email || !password || email.length > 254 || password.length > 128) {
            return jsonResponse({ ok: false, code: 1001 }, 400, signalingOrigin);
        }
        const dev = await ensureDeviceId(env, cookies, isSecure);
        const setCookies = dev.setCookie ? [dev.setCookie] : [];
        try {
            const res = await upstreamFetch(env, signalingOrigin, "/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email,
                    password,
                    device_id: dev.deviceId,
                    device_name: "Osmium Web",
                    os_version: "Web"
                })
            });
            if (res.status === 202 && res.json?.data?.challenge_id && res.json?.data?.challenge_secret) {
                const ch = res.json.data;
                const chSealed = await sealCookie(env, CHALLENGE_COOKIE, {
                    challengeId: String(ch.challenge_id),
                    challengeSecret: String(ch.challenge_secret),
                    deviceId: dev.deviceId,
                    kind: "login",
                    exp: Date.now() + PENDING_MAX_AGE_SEC * 1000
                });
                if (!chSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin);
                setCookies.push(formatSetCookie(CHALLENGE_COOKIE, chSealed, PENDING_MAX_AGE_SEC, isSecure));
                return jsonResponse({
                    ok: true,
                    code: res.json.code || 100,
                    data: {
                        challenge_id: String(ch.challenge_id),
                        captcha_url: appendWebModeToCaptchaUrl(ch.captcha_url),
                        expires_in: Number(ch.expires_in || 300)
                    }
                }, 202, signalingOrigin, setCookies);
            }
            if (res.ok && res.json?.ok && res.json?.data?.stoken) {
                const built = await createSessionFromUpstream(env, res.json.data, dev.deviceId, isSecure);
                if (!built) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin);
                setCookies.push(built.cookie, clearCookie(QR_COOKIE, isSecure), clearCookie(TWO_FA_COOKIE, isSecure));
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        user: built.user,
                        csrfToken: built.csrfToken,
                        wsToken: built.wsToken,
                        wsExpiresIn: built.wsExpiresIn,
                        deviceId: built.deviceId,
                        signalingUrl: getWsOrigin(signalingOrigin)
                    }
                }, 200, signalingOrigin, setCookies);
            }
            return jsonResponse({
                ok: false,
                code: res.json?.code || 2002,
                data: res.json?.data
            }, res.status || 400, signalingOrigin, setCookies);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin, setCookies);
        }
    }

    if (pathname === "/web-api/auth/login/2fa/verify" && method === "POST") {
        const twoFa = await openCookie(env, TWO_FA_COOKIE, cookies[TWO_FA_COOKIE]);
        if (!twoFa || !twoFa.twoFaToken) {
            return jsonResponse({ ok: false, code: 3020 }, 410, signalingOrigin, [clearCookie(TWO_FA_COOKIE, isSecure)]);
        }
        const body = await readJsonPayload(request, 4096);
        if (!body) return jsonResponse({ ok: false, code: 1001 }, 400, signalingOrigin);
        const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
        if (!/^\d{6}$/.test(code)) {
            return jsonResponse({ ok: false, code: 1006 }, 400, signalingOrigin);
        }
        try {
            const res = await upstreamFetch(env, signalingOrigin, "/api/auth/login/2fa/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    two_fa_token: twoFa.twoFaToken,
                    code
                })
            });
            if (res.status === 202 && res.json?.data?.challenge_id && res.json?.data?.challenge_secret) {
                const ch = res.json.data;
                const chSealed = await sealCookie(env, CHALLENGE_COOKIE, {
                    challengeId: String(ch.challenge_id),
                    challengeSecret: String(ch.challenge_secret),
                    deviceId: twoFa.deviceId,
                    kind: "login_2fa",
                    exp: Date.now() + PENDING_MAX_AGE_SEC * 1000
                });
                if (!chSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin);
                return jsonResponse({
                    ok: true,
                    code: res.json.code || 100,
                    data: {
                        challenge_id: String(ch.challenge_id),
                        captcha_url: appendWebModeToCaptchaUrl(ch.captcha_url),
                        expires_in: Number(ch.expires_in || 300)
                    }
                }, 202, signalingOrigin, [formatSetCookie(CHALLENGE_COOKIE, chSealed, PENDING_MAX_AGE_SEC, isSecure)]);
            }
            if (res.ok && res.json?.ok && res.json?.data?.stoken) {
                const built = await createSessionFromUpstream(env, res.json.data, twoFa.deviceId, isSecure);
                if (!built) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin);
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        user: built.user,
                        csrfToken: built.csrfToken,
                        wsToken: built.wsToken,
                        wsExpiresIn: built.wsExpiresIn,
                        deviceId: built.deviceId,
                        signalingUrl: getWsOrigin(signalingOrigin)
                    }
                }, 200, signalingOrigin, [
                    built.cookie,
                    clearCookie(TWO_FA_COOKIE, isSecure),
                    clearCookie(QR_COOKIE, isSecure),
                    clearCookie(CHALLENGE_COOKIE, isSecure)
                ]);
            }
            const errCode = res.json?.code || 3019;
            const outCookies = errCode === 3020 || res.status === 410 ? [clearCookie(TWO_FA_COOKIE, isSecure)] : [];
            return jsonResponse({
                ok: false,
                code: errCode,
                data: res.json?.data
            }, res.status || 400, signalingOrigin, outCookies);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin);
        }
    }

    if (pathname === "/web-api/auth/login/key" && method === "POST") {
        const body = await readJsonPayload(request, 4096);
        if (!body) return jsonResponse({ ok: false, code: 1001 }, 400, signalingOrigin);
        const loginKey = typeof body.login_key === "string" ? body.login_key.trim() : "";
        if (!loginKey || loginKey.length > 128) {
            return jsonResponse({ ok: false, code: 2019 }, 400, signalingOrigin);
        }
        const dev = await ensureDeviceId(env, cookies, isSecure);
        const setCookies = dev.setCookie ? [dev.setCookie] : [];
        try {
            const res = await upstreamFetch(env, signalingOrigin, "/api/auth/login/key", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    login_key: loginKey,
                    device_id: dev.deviceId,
                    device_name: "Osmium Web",
                    os_version: "Web"
                })
            });
            if (res.status === 202 && res.json?.data?.challenge_id && res.json?.data?.challenge_secret) {
                const ch = res.json.data;
                const chSealed = await sealCookie(env, CHALLENGE_COOKIE, {
                    challengeId: String(ch.challenge_id),
                    challengeSecret: String(ch.challenge_secret),
                    deviceId: dev.deviceId,
                    kind: "login_key",
                    exp: Date.now() + PENDING_MAX_AGE_SEC * 1000
                });
                if (!chSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, setCookies);
                setCookies.push(formatSetCookie(CHALLENGE_COOKIE, chSealed, PENDING_MAX_AGE_SEC, isSecure));
                return jsonResponse({
                    ok: true,
                    code: res.json.code || 100,
                    data: {
                        challenge_id: String(ch.challenge_id),
                        captcha_url: appendWebModeToCaptchaUrl(ch.captcha_url),
                        expires_in: Number(ch.expires_in || 300)
                    }
                }, 202, signalingOrigin, setCookies);
            }
            if (res.ok && res.json?.ok && res.json?.data?.stoken) {
                const built = await createSessionFromUpstream(env, res.json.data, dev.deviceId, isSecure);
                if (!built) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, setCookies);
                setCookies.push(built.cookie, clearCookie(QR_COOKIE, isSecure), clearCookie(TWO_FA_COOKIE, isSecure));
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        user: built.user,
                        csrfToken: built.csrfToken,
                        wsToken: built.wsToken,
                        wsExpiresIn: built.wsExpiresIn,
                        deviceId: built.deviceId,
                        signalingUrl: getWsOrigin(signalingOrigin)
                    }
                }, 200, signalingOrigin, setCookies);
            }
            return jsonResponse({
                ok: false,
                code: res.json?.code || 2019,
                data: res.json?.data
            }, res.status || 400, signalingOrigin, setCookies);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin, setCookies);
        }
    }

    if (pathname === "/web-api/auth/qr/create" && method === "POST") {
        const dev = await ensureDeviceId(env, cookies, isSecure);
        const setCookies = dev.setCookie ? [dev.setCookie] : [];
        const prevQr = await openCookie(env, QR_COOKIE, cookies[QR_COOKIE]);
        if (prevQr && prevQr.qrId && prevQr.pollSecret) {
            try {
                await upstreamFetch(env, signalingOrigin, "/api/auth/qr/cancel", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-QR-Poll-Secret": prevQr.pollSecret
                    },
                    body: JSON.stringify({ qid: prevQr.qrId })
                });
            } catch {}
        }
        try {
            const res = await upstreamFetch(env, signalingOrigin, "/api/auth/qr/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    device_id: dev.deviceId,
                    device_name: "Osmium Web",
                    os_version: "Web"
                })
            });
            if (res.status === 202 && res.json?.data?.challenge_id && res.json?.data?.challenge_secret) {
                const ch = res.json.data;
                const chSealed = await sealCookie(env, CHALLENGE_COOKIE, {
                    challengeId: String(ch.challenge_id),
                    challengeSecret: String(ch.challenge_secret),
                    deviceId: dev.deviceId,
                    kind: "qr_create",
                    exp: Date.now() + PENDING_MAX_AGE_SEC * 1000
                });
                if (!chSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, setCookies);
                setCookies.push(formatSetCookie(CHALLENGE_COOKIE, chSealed, PENDING_MAX_AGE_SEC, isSecure));
                return jsonResponse({
                    ok: true,
                    code: res.json.code || 100,
                    data: {
                        challenge_id: String(ch.challenge_id),
                        captcha_url: appendWebModeToCaptchaUrl(ch.captcha_url),
                        expires_in: Number(ch.expires_in || 300)
                    }
                }, 202, signalingOrigin, setCookies);
            }
            if (res.ok && res.json?.ok && res.json?.data?.qr_id && res.json?.data?.poll_secret) {
                const d = res.json.data;
                const ttlSec = Math.max(30, Number(d.expires_in || 180));
                const qrSealed = await sealCookie(env, QR_COOKIE, {
                    qrId: String(d.qr_id),
                    pollSecret: String(d.poll_secret),
                    deviceId: dev.deviceId,
                    exp: Number(d.expires_at || Date.now() + ttlSec * 1000)
                });
                if (!qrSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, setCookies);
                setCookies.push(formatSetCookie(QR_COOKIE, qrSealed, ttlSec + 30, isSecure));
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        qr_url: String(d.qr_url || ""),
                        expires_in: ttlSec,
                        expires_at: Number(d.expires_at || Date.now() + ttlSec * 1000),
                        poll_interval_ms: Number(d.poll_interval_ms || 1500)
                    }
                }, 200, signalingOrigin, setCookies);
            }
            return jsonResponse({
                ok: false,
                code: res.json?.code || 5001
            }, res.status || 502, signalingOrigin, setCookies);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin, setCookies);
        }
    }

    if (pathname === "/web-api/auth/qr/status" && method === "GET") {
        const qr = await openCookie(env, QR_COOKIE, cookies[QR_COOKIE]);
        if (!qr || !qr.qrId || !qr.pollSecret) {
            return jsonResponse({ ok: true, code: 0, data: { state: "expired", expires_in: 0 } }, 200, signalingOrigin, [clearCookie(QR_COOKIE, isSecure)]);
        }
        try {
            const res = await upstreamFetch(
                env,
                signalingOrigin,
                `/api/auth/qr/status?qid=${encodeURIComponent(qr.qrId)}`,
                {
                    method: "GET",
                    headers: { "X-QR-Poll-Secret": qr.pollSecret }
                }
            );
            if (!res.ok || !res.json?.ok) {
                const stCode = res.json?.code;
                if (stCode === 3016) {
                    return jsonResponse({ ok: true, code: 0, data: { state: "cancelled", expires_in: 0 } }, 200, signalingOrigin, [clearCookie(QR_COOKIE, isSecure)]);
                }
                if (res.status === 404 || res.status === 410 || stCode === 3011 || stCode === 3012) {
                    return jsonResponse({ ok: true, code: 0, data: { state: "expired", expires_in: 0 } }, 200, signalingOrigin, [clearCookie(QR_COOKIE, isSecure)]);
                }
                return jsonResponse({ ok: false, code: stCode || 5001 }, res.status || 502, signalingOrigin);
            }
            const d = res.json.data || {};
            const st = String(d.state || "expired");
            if (st === "confirmed" && d.session?.stoken) {
                const built = await createSessionFromUpstream(env, d.session, qr.deviceId, isSecure);
                if (!built) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, [clearCookie(QR_COOKIE, isSecure)]);
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        state: "confirmed",
                        user: built.user,
                        csrfToken: built.csrfToken,
                        wsToken: built.wsToken,
                        wsExpiresIn: built.wsExpiresIn,
                        deviceId: built.deviceId,
                        signalingUrl: getWsOrigin(signalingOrigin)
                    }
                }, 200, signalingOrigin, [built.cookie, clearCookie(QR_COOKIE, isSecure), clearCookie(TWO_FA_COOKIE, isSecure)]);
            }
            if (st === "expired" || st === "cancelled") {
                return jsonResponse({ ok: true, code: 0, data: { state: st, expires_in: 0 } }, 200, signalingOrigin, [clearCookie(QR_COOKIE, isSecure)]);
            }
            if (st === "awaiting_confirm") {
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        state: "awaiting_confirm",
                        username: String(d.username || ""),
                        avatar_data: sanitizeAvatarData(d.avatar_data),
                        expires_in: Number(d.expires_in || 0)
                    }
                }, 200, signalingOrigin);
            }
            return jsonResponse({
                ok: true,
                code: 0,
                data: {
                    state: st === "scanned" ? "scanned" : "pending",
                    expires_in: Number(d.expires_in || 0)
                }
            }, 200, signalingOrigin);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin);
        }
    }

    if (pathname === "/web-api/auth/qr/cancel" && method === "POST") {
        const qr = await openCookie(env, QR_COOKIE, cookies[QR_COOKIE]);
        const clr = clearCookie(QR_COOKIE, isSecure);
        if (qr && qr.qrId && qr.pollSecret) {
            try {
                await upstreamFetch(env, signalingOrigin, "/api/auth/qr/cancel", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-QR-Poll-Secret": qr.pollSecret
                    },
                    body: JSON.stringify({ qid: qr.qrId })
                });
            } catch {}
        }
        return jsonResponse({ ok: true, code: 0 }, 200, signalingOrigin, [clr]);
    }

    if (pathname === "/web-api/auth/challenge/status" && method === "GET") {
        const ch = await openCookie(env, CHALLENGE_COOKIE, cookies[CHALLENGE_COOKIE]);
        if (!ch || !ch.challengeId || !ch.challengeSecret) {
            return jsonResponse({ ok: false, code: 3001 }, 410, signalingOrigin, [clearCookie(CHALLENGE_COOKIE, isSecure)]);
        }
        try {
            const res = await upstreamFetch(
                env,
                signalingOrigin,
                `/api/auth/challenge/status?challenge_id=${encodeURIComponent(ch.challengeId)}`,
                {
                    method: "GET",
                    headers: { "X-Challenge-Secret": ch.challengeSecret }
                }
            );
            if (res.json?.code === 101 || res.json?.data?.state === "pending") {
                return jsonResponse({ ok: true, code: 101, data: { state: "pending" } }, 200, signalingOrigin);
            }
            const clearCh = clearCookie(CHALLENGE_COOKIE, isSecure);
            if (res.json?.code === 102 && res.json?.data?.two_fa_token) {
                const ttlSec = Math.max(60, Number(res.json.data.expires_in || 300));
                const twoFaSealed = await sealCookie(env, TWO_FA_COOKIE, {
                    twoFaToken: String(res.json.data.two_fa_token),
                    deviceId: ch.deviceId,
                    exp: Date.now() + ttlSec * 1000
                });
                if (!twoFaSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, [clearCh]);
                return jsonResponse({
                    ok: true,
                    code: 102,
                    data: {
                        state: "two_fa_required",
                        expires_in: ttlSec
                    }
                }, 200, signalingOrigin, [clearCh, formatSetCookie(TWO_FA_COOKIE, twoFaSealed, ttlSec, isSecure)]);
            }
            if (ch.kind === "qr_create" && res.ok && res.json?.ok && res.json?.data?.qr_id && res.json?.data?.poll_secret) {
                const d = res.json.data;
                const ttlSec = Math.max(30, Number(d.expires_in || 180));
                const qrSealed = await sealCookie(env, QR_COOKIE, {
                    qrId: String(d.qr_id),
                    pollSecret: String(d.poll_secret),
                    deviceId: ch.deviceId,
                    exp: Number(d.expires_at || Date.now() + ttlSec * 1000)
                });
                if (!qrSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, [clearCh]);
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        state: "qr_created",
                        qr_url: String(d.qr_url || ""),
                        expires_in: ttlSec,
                        expires_at: Number(d.expires_at || Date.now() + ttlSec * 1000),
                        poll_interval_ms: Number(d.poll_interval_ms || 1500)
                    }
                }, 200, signalingOrigin, [clearCh, formatSetCookie(QR_COOKIE, qrSealed, ttlSec + 30, isSecure)]);
            }
            if (res.ok && res.json?.ok && res.json?.data?.stoken) {
                const built = await createSessionFromUpstream(env, res.json.data, ch.deviceId, isSecure);
                if (!built) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, [clearCh]);
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        state: "completed",
                        user: built.user,
                        csrfToken: built.csrfToken,
                        wsToken: built.wsToken,
                        wsExpiresIn: built.wsExpiresIn,
                        deviceId: built.deviceId,
                        signalingUrl: getWsOrigin(signalingOrigin)
                    }
                }, 200, signalingOrigin, [clearCh, clearCookie(TWO_FA_COOKIE, isSecure), clearCookie(QR_COOKIE, isSecure), built.cookie]);
            }
            const errCode = res.json?.code || 2002;
            const outCookies = [clearCh];
            if (errCode === 3020) outCookies.push(clearCookie(TWO_FA_COOKIE, isSecure));
            return jsonResponse({
                ok: false,
                code: errCode,
                data: res.json?.data
            }, res.status || 400, signalingOrigin, outCookies);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin);
        }
    }

    if (pathname === "/web-api/auth/oauth/start" && method === "POST") {
        const body = await readJsonPayload(request, 4096);
        if (!body) return jsonResponse({ ok: false, code: 1001 }, 400, signalingOrigin);
        const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
        if (provider !== "google" && provider !== "qq" && provider !== "wechat") {
            return jsonResponse({ ok: false, code: 1014 }, 400, signalingOrigin);
        }
        const dev = await ensureDeviceId(env, cookies, isSecure);
        const setCookies = dev.setCookie ? [dev.setCookie] : [];
        try {
            const res = await upstreamFetch(env, signalingOrigin, "/api/auth/oauth/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    provider,
                    platform: "web",
                    device_id: dev.deviceId,
                    device_name: "Osmium Web",
                    os_version: "Web"
                })
            });
            if (!res.ok || !res.json?.ok || !res.json?.data?.state || !res.json?.data?.poll_secret) {
                return jsonResponse({ ok: false, code: res.json?.code || 5001 }, res.status || 502, signalingOrigin, setCookies);
            }
            const d = res.json.data;
            const oaSealed = await sealCookie(env, OAUTH_COOKIE, {
                state: String(d.state),
                pollSecret: String(d.poll_secret),
                provider,
                deviceId: dev.deviceId,
                exp: Date.now() + PENDING_MAX_AGE_SEC * 1000
            });
            if (!oaSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, setCookies);
            setCookies.push(formatSetCookie(OAUTH_COOKIE, oaSealed, PENDING_MAX_AGE_SEC, isSecure));
            return jsonResponse({
                ok: true,
                code: 0,
                data: {
                    provider,
                    authorize_url: String(d.authorize_url || ""),
                    expires_in: Number(d.expires_in || 300),
                    poll_interval_ms: Number(d.poll_interval_ms || 1200)
                }
            }, 200, signalingOrigin, setCookies);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin, setCookies);
        }
    }

    if (pathname === "/web-api/auth/oauth/callback" && method === "GET") {
        const state = (url.searchParams.get("state") || "").trim();
        const fc = (url.searchParams.get("fc") || "").trim();
        const oa = await openCookie(env, OAUTH_COOKIE, cookies[OAUTH_COOKIE]);
        const valid = Boolean(
            oa &&
            typeof oa.state === "string" &&
            oa.state === state &&
            fc.length >= 16 &&
            fc.length <= 128 &&
            /^[a-zA-Z0-9_-]+$/.test(fc)
        );
        const nonce = randomBase64Url(16);
        const headers = new Headers({
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, private",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`
        });
        if (!valid) {
            const errHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权失败 - Osmium Web</title><style nonce="${nonce}">body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111315;color:#f3f5f8;text-align:center;padding:24px}</style></head><body><main><h2>授权会话不匹配</h2><p>请关闭此窗口并返回原 Osmium Web 页面重新发起登录。</p></main></body></html>`;
            return new Response(errHtml, { status: 403, headers });
        }
        const remainingMs = typeof oa.exp === "number" ? Math.max(60000, oa.exp - Date.now()) : 300000;
        const sealed = await sealCookie(env, OAUTH_COOKIE, {
            ...oa,
            finishCode: fc
        });
        if (sealed) {
            headers.append("Set-Cookie", formatSetCookie(OAUTH_COOKIE, sealed, Math.floor(remainingMs / 1000), isSecure));
        }
        const safePayload = JSON.stringify({ type: "osmium-oauth-done", state, ok: true }).replace(/</g, "\\u003c");
        const okHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功 - Osmium Web</title><style nonce="${nonce}">body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111315;color:#f3f5f8;text-align:center;padding:24px}</style></head><body><main><h2>授权成功</h2><p>正在返回 Osmium Web…</p></main><script nonce="${nonce}">(function(){try{if(window.opener){window.opener.postMessage(${safePayload},window.location.origin);}}catch(_){}setTimeout(function(){try{window.close();}catch(_){}},350);})();</script></body></html>`;
        return new Response(okHtml, { status: 200, headers });
    }

    if (pathname === "/web-api/auth/oauth/status" && method === "GET") {
        const oa = await openCookie(env, OAUTH_COOKIE, cookies[OAUTH_COOKIE]);
        if (!oa || !oa.state || !oa.pollSecret) {
            return jsonResponse({ ok: false, code: 3017 }, 410, signalingOrigin, [clearCookie(OAUTH_COOKIE, isSecure)]);
        }
        try {
            const oauthHeaders = { "X-OAuth-Secret": oa.pollSecret };
            if (typeof oa.finishCode === "string" && oa.finishCode) {
                oauthHeaders["X-OAuth-Finish-Code"] = oa.finishCode;
            }
            const res = await upstreamFetch(
                env,
                signalingOrigin,
                `/api/auth/oauth/status?state=${encodeURIComponent(oa.state)}`,
                {
                    method: "GET",
                    headers: oauthHeaders
                }
            );
            if (res.ok && res.json?.ok && res.json?.data?.state === "pending") {
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: { state: "pending", expires_in: Number(res.json.data.expires_in || 60) }
                }, 200, signalingOrigin);
            }
            const clearOa = clearCookie(OAUTH_COOKIE, isSecure);
            if (
                res.ok &&
                res.json?.ok &&
                (res.json?.code === 102 || res.json?.data?.state === "two_fa_required") &&
                res.json?.data?.two_fa_token
            ) {
                const ttlSec = Math.max(60, Number(res.json.data.expires_in || 300));
                const twoFaSealed = await sealCookie(env, TWO_FA_COOKIE, {
                    twoFaToken: String(res.json.data.two_fa_token),
                    deviceId: oa.deviceId,
                    exp: Date.now() + ttlSec * 1000
                });
                if (!twoFaSealed) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, [clearOa]);
                return jsonResponse({
                    ok: true,
                    code: 102,
                    data: {
                        state: "two_fa_required",
                        expires_in: ttlSec
                    }
                }, 200, signalingOrigin, [clearOa, formatSetCookie(TWO_FA_COOKIE, twoFaSealed, ttlSec, isSecure)]);
            }
            if (res.ok && res.json?.ok && res.json?.data?.state === "completed" && res.json?.data?.session?.stoken) {
                const built = await createSessionFromUpstream(env, res.json.data.session, oa.deviceId, isSecure);
                if (!built) return jsonResponse({ ok: false, code: 5001 }, 500, signalingOrigin, [clearOa]);
                return jsonResponse({
                    ok: true,
                    code: 0,
                    data: {
                        state: "completed",
                        user: built.user,
                        csrfToken: built.csrfToken,
                        wsToken: built.wsToken,
                        wsExpiresIn: built.wsExpiresIn,
                        deviceId: built.deviceId,
                        signalingUrl: getWsOrigin(signalingOrigin)
                    }
                }, 200, signalingOrigin, [clearOa, clearCookie(TWO_FA_COOKIE, isSecure), clearCookie(QR_COOKIE, isSecure), built.cookie]);
            }
            return jsonResponse({
                ok: false,
                code: res.json?.code || 3018
            }, res.status || 400, signalingOrigin, [clearOa]);
        } catch {
            return jsonResponse({ ok: false, code: 5001 }, 502, signalingOrigin);
        }
    }

    if (pathname === "/web-api/auth/oauth/cancel" && method === "POST") {
        const oa = await openCookie(env, OAUTH_COOKIE, cookies[OAUTH_COOKIE]);
        const clearOa = clearCookie(OAUTH_COOKIE, isSecure);
        if (oa && oa.state && oa.pollSecret) {
            try {
                await upstreamFetch(env, signalingOrigin, "/api/auth/oauth/cancel", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-OAuth-Secret": oa.pollSecret
                    },
                    body: JSON.stringify({ state: oa.state })
                });
            } catch {}
        }
        return jsonResponse({ ok: true, code: 0 }, 200, signalingOrigin, [clearOa]);
    }

    if (pathname === "/web-api/session" && method === "GET") {
        const force = url.searchParams.get("refresh") === "1";
        const active = await resolveActiveSession(env, cookies, signalingOrigin, isSecure, force);
        if (!active.ok) {
            if (active.upstreamError) {
                return jsonResponse({ ok: false, code: active.code || 5001 }, active.status || 502, signalingOrigin);
            }
            return jsonResponse({ ok: false, code: 2001 }, 401, signalingOrigin, active.clearCookie ? [active.clearCookie] : []);
        }
        const outCookies = active.rotatedCookie ? [active.rotatedCookie] : [];
        let user = active.user;
        let wsToken = active.ltoken;
        let wsExpiresIn = active.wsExpiresIn || Math.max(60, Math.floor((active.sess.ltokenExp - Date.now()) / 1000));
        if (!user) {
            const stRes = await upstreamFetch(env, signalingOrigin, "/api/account/status", {
                method: "GET",
                headers: { "X-LToken": wsToken }
            });
            if (stRes.ok && stRes.json?.ok && stRes.json?.data) {
                user = extractPublicUser(stRes.json.data);
            } else {
                const refreshed = await resolveActiveSession(env, cookies, signalingOrigin, isSecure, true);
                if (!refreshed.ok) {
                    return jsonResponse({ ok: false, code: 2001 }, 401, signalingOrigin, refreshed.clearCookie ? [refreshed.clearCookie] : []);
                }
                user = refreshed.user;
                wsToken = refreshed.ltoken;
                wsExpiresIn = refreshed.wsExpiresIn || 900;
                if (refreshed.rotatedCookie) outCookies.push(refreshed.rotatedCookie);
            }
        }
        return jsonResponse({
            ok: true,
            code: 0,
            data: {
                user,
                csrfToken: active.sess.csrfToken,
                wsToken,
                wsExpiresIn,
                deviceId: active.sess.deviceId,
                signalingUrl: getWsOrigin(signalingOrigin)
            }
        }, 200, signalingOrigin, outCookies);
    }

    if (pathname === "/web-api/auth/logout" && method === "POST") {
        const active = await resolveActiveSession(env, cookies, signalingOrigin, isSecure, false);
        const clearAll = [
            clearCookie(SESSION_COOKIE, isSecure),
            clearCookie(CHALLENGE_COOKIE, isSecure),
            clearCookie(OAUTH_COOKIE, isSecure),
            clearCookie(QR_COOKIE, isSecure),
            clearCookie(TWO_FA_COOKIE, isSecure)
        ];
        if (!active.ok) {
            return jsonResponse({ ok: true, code: 0 }, 200, signalingOrigin, clearAll);
        }
        const csrfHeader = (request.headers.get("X-CSRF-Token") || "").trim();
        if (!timingSafeEqual(csrfHeader, active.sess.csrfToken)) {
            return jsonResponse({ ok: false, code: 2001 }, 403, signalingOrigin);
        }
        try {
            await upstreamFetch(env, signalingOrigin, "/api/auth/logout", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-LToken": active.ltoken
                },
                body: JSON.stringify({
                    revoke_stoken: false,
                    device_id: active.sess.deviceId
                })
            });
        } catch {}
        return jsonResponse({ ok: true, code: 0 }, 200, signalingOrigin, clearAll);
    }

    if (pathname === "/web-api/devices" && method === "GET") {
        const active = await resolveActiveSession(env, cookies, signalingOrigin, isSecure, false);
        if (!active.ok) {
            return jsonResponse({ ok: false, code: 2001 }, 401, signalingOrigin, active.clearCookie ? [active.clearCookie] : []);
        }
        const outCookies = active.rotatedCookie ? [active.rotatedCookie] : [];
        let res = await upstreamFetch(env, signalingOrigin, "/api/account/devices", {
            method: "GET",
            headers: { "X-LToken": active.ltoken }
        });
        if (res.status === 401 || res.status === 403) {
            const refreshed = await resolveActiveSession(env, cookies, signalingOrigin, isSecure, true);
            if (!refreshed.ok) {
                return jsonResponse({ ok: false, code: 2001 }, 401, signalingOrigin, refreshed.clearCookie ? [refreshed.clearCookie] : []);
            }
            if (refreshed.rotatedCookie) outCookies.push(refreshed.rotatedCookie);
            res = await upstreamFetch(env, signalingOrigin, "/api/account/devices", {
                method: "GET",
                headers: { "X-LToken": refreshed.ltoken }
            });
        }
        if (!res.ok || !res.json?.ok) {
            return jsonResponse({ ok: false, code: res.json?.code || 5001 }, res.status || 502, signalingOrigin, outCookies);
        }
        return jsonResponse({
            ok: true,
            code: 0,
            data: res.json.data
        }, 200, signalingOrigin, outCookies);
    }

    if (pathname === "/web-api/devices/power" && method === "POST") {
        const active = await resolveActiveSession(env, cookies, signalingOrigin, isSecure, false);
        if (!active.ok) {
            return jsonResponse({ ok: false, code: 2001 }, 401, signalingOrigin, active.clearCookie ? [active.clearCookie] : []);
        }
        const csrfHeader = (request.headers.get("X-CSRF-Token") || "").trim();
        if (!timingSafeEqual(csrfHeader, active.sess.csrfToken)) {
            return jsonResponse({ ok: false, code: 2001 }, 403, signalingOrigin);
        }
        const body = await readJsonPayload(request, 4096);
        if (!body) return jsonResponse({ ok: false, code: 1001 }, 400, signalingOrigin);
        const targetId = typeof body.device_id === "string" ? body.device_id.replace(/\s+/g, "") : "";
        const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
        if (!/^\d{6,12}$/.test(targetId) || (action !== "wake" && action !== "shutdown" && action !== "restart")) {
            return jsonResponse({ ok: false, code: 1001 }, 400, signalingOrigin);
        }
        const outCookies = active.rotatedCookie ? [active.rotatedCookie] : [];
        let res = await upstreamFetch(env, signalingOrigin, "/api/account/devices/power", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-LToken": active.ltoken
            },
            body: JSON.stringify({ device_id: targetId, action })
        });
        if (res.status === 401 || res.status === 403) {
            if (res.json?.code === 2001) {
                const refreshed = await resolveActiveSession(env, cookies, signalingOrigin, isSecure, true);
                if (refreshed.ok) {
                    if (refreshed.rotatedCookie) outCookies.push(refreshed.rotatedCookie);
                    res = await upstreamFetch(env, signalingOrigin, "/api/account/devices/power", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-LToken": refreshed.ltoken
                        },
                        body: JSON.stringify({ device_id: targetId, action })
                    });
                }
            }
        }
        return jsonResponse(
            res.json || { ok: false, code: 5001 },
            res.status || 502,
            signalingOrigin,
            outCookies
        );
    }

    return jsonResponse({ ok: false, code: 1013 }, 404, signalingOrigin);
}

export default {
    async fetch(request, env) {
        const tlsVer = request.cf?.tlsVersion;
        if (typeof tlsVer === "string" && tlsVer && tlsVer !== "TLSv1.2" && tlsVer !== "TLSv1.3") {
            return new Response("TLS 1.2 or higher is required.", {
                status: 426,
                headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        }
        const url = new URL(request.url);
        const signalingOrigin = getSignalingOrigin(env);

        if (url.pathname.startsWith("/web-api/")) {
            return handleWebApi(request, env, url);
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
            return new Response(null, {
                status: 405,
                headers: baseSecurityHeaders(signalingOrigin)
            });
        }

        const assetResp = await env.ASSETS.fetch(request);
        const headers = new Headers(assetResp.headers);
        const sec = baseSecurityHeaders(signalingOrigin);
        for (const [k, v] of Object.entries(sec)) {
            headers.set(k, v);
        }
        if (/^\/app\.[a-f0-9]{10}\.(?:js|css)$/.test(url.pathname)) {
            headers.set("Cache-Control", "public, max-age=31536000, immutable");
        } else if (
            url.pathname === "/" ||
            url.pathname.endsWith(".html") ||
            url.pathname.endsWith(".js") ||
            url.pathname.endsWith(".css")
        ) {
            headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
            headers.set("Pragma", "no-cache");
        } else {
            headers.set("Cache-Control", "public, max-age=86400");
        }
        return new Response(assetResp.body, {
            status: assetResp.status,
            statusText: assetResp.statusText,
            headers
        });
    }
};
