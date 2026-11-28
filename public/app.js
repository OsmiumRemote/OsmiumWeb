import {
    setLocale,
    getLocale,
    t,
    applyI18nToDom
} from "./i18n.js";
import {
    detectBrowserCapabilities,
    SignalingHubClient,
    OsmiumRemoteSession
} from "./rtc-session.js";
import { renderQrToCanvas } from "./qr.js";

const SETTINGS_KEY = "osmium_web_prefs_v1";
const RECENT_KEY = "osmium_web_recent_ids_v1";

const DEFAULT_SETTINGS = {
    resolution: "native",
    fps: 60,
    bitrateKbps: 8000,
    codec: 1,
    audioEnabled: true,
    relativeMouse: false,
    keyboardLock: true,
    gamepadEnabled: true,
    clipboardEnabled: true,
    theme: "light",
    language: "auto",
    deviceGrid: true
};

const state = {
    caps: null,
    settings: loadSettings(),
    recentIds: loadRecentIds(),
    providersAvailable: false,
    providers: [],
    user: null,
    csrfToken: "",
    wsToken: "",
    deviceId: "",
    signalingUrl: "wss://osmium.fufu.skin",
    signaling: null,
    devices: [],
    activeTab: "devices",
    activeTabIndex: 0,
    activeSubTab: "video",
    activeSubIndex: 0,
    cooldownUntilMs: 0,
    cooldownTimer: null,
    tokenRefreshTimer: null,
    authPollTimer: null,
    authPopup: null,
    authChallengeKind: "",
    authChallengeId: "",
    authChallengeGen: 0,
    authChallengeQrGen: null,
    authChallengeInFlight: false,
    authChallengeQueued: false,
    authMode: "password",
    inTwoFa: false,
    inRecovery: false,
    recoveryStep: 0,
    recoveryChannels: [],
    recoveryCooldownUntil: 0,
    recoveryCooldownTimer: null,
    recoveryPendingAdvance: false,
    qrPollTimer: null,
    qrCountdownTimer: null,
    qrExpiresAtMs: 0,
    qrVisualState: "idle",
    qrGeneration: 0,
    qrScannedUser: "",
    qrScannedAvatar: null,
    pendingCaptchaContext: null,
    session: null,
    lastClipboardFromHost: "",
    powerBusy: false
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
        merged.theme = merged.theme === "dark" ? "dark" : "light";
        if (merged.language !== "zh-CN" && merged.language !== "en-US") {
            merged.language = "auto";
        }
        return merged;
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch {}
}

function loadRecentIds() {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        const arr = JSON.parse(raw || "[]");
        return Array.isArray(arr) ? arr.filter((x) => /^\d{6,12}$/.test(String(x))).slice(0, 8) : [];
    } catch {
        return [];
    }
}

function saveRecentId(id) {
    const clean = String(id || "").replace(/\D/g, "");
    if (!/^\d{6,12}$/.test(clean)) return;
    state.recentIds = [clean, ...state.recentIds.filter((x) => x !== clean)].slice(0, 8);
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentIds));
    } catch {}
    renderRecentList();
}

function removeRecentId(id) {
    state.recentIds = state.recentIds.filter((x) => x !== id);
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(state.recentIds));
    } catch {}
    renderRecentList();
}

function isDarkThemeActive() {
    return state.settings.theme === "dark";
}

function applyTheme(theme) {
    const normalized = theme === "dark" ? "dark" : "light";
    if (normalized === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
    } else {
        document.documentElement.removeAttribute("data-theme");
    }
    const metaTheme = $("meta-theme-color");
    if (metaTheme) {
        metaTheme.setAttribute("content", normalized === "dark" ? "#000000" : "#ffffff");
    }
    const sel = $("set-theme");
    if (sel) {
        sel.value = normalized;
        syncWinSelect(sel);
    }
    if (state.devices.length > 0) renderDevices();
}

function renderOAuthButtons() {
    const wrap = $("oauth-buttons");
    if (!wrap) return;
    wrap.textContent = "";
    const labels = {
        google: t("oauth_google"),
        qq: t("oauth_qq"),
        wechat: t("oauth_wechat")
    };
    for (const p of state.providers) {
        if (!labels[p]) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ms-oauth-btn";
        btn.innerHTML = `${providerIconSvg(p)}<span>${labels[p]}</span>`;
        btn.onclick = () => startOAuthLogin(p);
        wrap.appendChild(btn);
    }
    $("oauth-section").classList.toggle("hidden", wrap.children.length === 0);
}

function applyLanguage(pref) {
    setLocale(pref);
    applyI18nToDom();
    const authLangBtn = $("btn-auth-lang");
    if (authLangBtn) {
        authLangBtn.textContent = getLocale() === "en-US" ? "简体中文" : "English";
    }
    const langSel = $("set-language");
    if (langSel) {
        langSel.value = state.settings.language;
    }
    document.querySelectorAll("select.win-select, select.tb-select").forEach((sel) => {
        syncWinSelect(sel);
    });
    if (state.providers.length > 0) renderOAuthButtons();
    if (!state.user) {
        refreshWebQrLocalization();
        if (state.inRecovery) {
            refreshRecoveryLocalization();
        }
    }
    if (state.user) {
        renderProfile();
        applyCapabilitiesToUi();
        renderRecentList();
        renderDevices();
        requestAnimationFrame(() => {
            positionNavIndicator();
            positionSubTabIndicator();
        });
    }
}

let toastTimer = null;
function showToast(message, durationMs = 3200) {
    const el = $("toast");
    el.textContent = message;
    el.classList.remove("hidden");
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.classList.add("hidden");
    }, durationMs);
}

function formatDeviceId(raw) {
    const d = String(raw || "").replace(/\D/g, "");
    if (d.length === 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
    return d;
}

function mapApiError(code) {
    const c = Number(code);
    if (c === 1004) return t("api_1004");
    if (c === 1005) return t("api_1005");
    if (c === 1006) return t("api_1006");
    if (c === 2001 || c === 2010) return t("api_2001");
    if (c === 2002 || c === 2004) return t("api_2002");
    if (c === 2005) return t("api_2005");
    if (c === 2008) return t("api_2008");
    if (c === 2009) return t("api_2009");
    if (c === 2012) return t("api_2012");
    if (c === 2019) return t("api_2019");
    if (c === 2020) return t("api_2020");
    if (c === 2021) return t("api_2021");
    if (c === 2022) return t("api_2022");
    if (c === 3001 || c === 3002 || c === 3006 || c === 3017) return t("api_3001");
    if (c === 3004 || c === 3005) return t("api_3004");
    if (c === 3007) return t("api_3007");
    if (c === 3008) return t("api_3008");
    if (c === 3009) return t("api_3009");
    if (c === 3010) return t("api_3010");
    if (c === 3018) return t("api_3018");
    if (c === 3019) return t("api_3019");
    if (c === 3020) return t("api_3020");
    if (c === 3021) return t("api_3021");
    if (c === 3022) return t("api_3022");
    if (c === 4001 || c === 4002 || c === 4003) return t("api_4001");
    if (c === 4006) return t("api_4006");
    if (c === 4011) return t("api_4011");
    if (c === 4012) return t("api_4012");
    if (c === 4013) return t("api_4013");
    if (c === 4017) return t("api_4017");
    if (c === 4023) return t("api_4023");
    if (c === 4025) return t("api_4025");
    if (c === 5001 || c === 5002 || c === 5003 || c === 5007) return t("api_5001");
    return t("api_default");
}

function renderAvatar(container, user) {
    container.textContent = "";
    const data = user && typeof user.avatar_data === "string" ? user.avatar_data : "";
    if (/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
        const img = document.createElement("img");
        img.src = data;
        img.alt = user.username || "头像";
        container.appendChild(img);
        return;
    }
    const ch = (user?.username || "O").trim().slice(0, 1).toUpperCase();
    container.textContent = ch || "O";
}

async function apiRequest(path, { method = "GET", body = null, csrf = false } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== null) headers["Content-Type"] = "application/json";
    if (csrf && state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;
    const resp = await fetch(path, {
        method,
        credentials: "same-origin",
        headers,
        body: body !== null ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await resp.json(); } catch {}
    return { status: resp.status, ok: resp.ok, json };
}

function openDialog({ title, bodyNode, actions = [] }) {
    $("modal-title").textContent = title;
    const bodyEl = $("modal-body");
    bodyEl.textContent = "";
    if (typeof bodyNode === "string") {
        const p = document.createElement("p");
        p.style.margin = "0";
        p.textContent = bodyNode;
        bodyEl.appendChild(p);
    } else if (bodyNode) {
        bodyEl.appendChild(bodyNode);
    }
    const actionsEl = $("modal-actions");
    actionsEl.textContent = "";
    for (const act of actions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = act.className || "win-btn";
        btn.textContent = act.label;
        btn.onclick = () => {
            if (act.keepOpen !== true) closeDialog();
            if (typeof act.onClick === "function") act.onClick();
        };
        actionsEl.appendChild(btn);
    }
    $("modal-backdrop").classList.remove("hidden");
}

function closeDialog() {
    closeComboPopup();
    $("modal-backdrop").classList.add("hidden");
}

function hideFlyout() {
    $("flyout-menu").classList.add("hidden");
}

let activeComboSelect = null;
let activeComboFocusIdx = -1;

function closeComboPopup() {
    const popup = $("win-combo-popup");
    if (popup) {
        popup.classList.add("hidden");
        popup.classList.remove("open-down", "open-up", "dark-surface");
        popup.textContent = "";
    }
    if (activeComboSelect && activeComboSelect._winTrigger) {
        activeComboSelect._winTrigger.classList.remove("open");
        activeComboSelect._winTrigger.setAttribute("aria-expanded", "false");
    }
    activeComboSelect = null;
    activeComboFocusIdx = -1;
}

function getVisibleSelectOptions(selectEl) {
    return Array.from(selectEl.options).filter((opt) => !opt.hidden && !opt.disabled);
}

function syncWinSelect(selectEl) {
    if (!selectEl) return;
    const trigger = selectEl._winTrigger;
    if (!trigger) return;
    const label = trigger.querySelector(".win-combo-label");
    const visibleOpts = getVisibleSelectOptions(selectEl);
    let chosen = visibleOpts.find((o) => o.value === selectEl.value) || selectEl.options[selectEl.selectedIndex] || visibleOpts[0] || null;
    if (label) {
        label.textContent = chosen ? chosen.textContent : "";
    }
    trigger.disabled = Boolean(selectEl.disabled);
    trigger.classList.toggle("hidden", selectEl.classList.contains("hidden"));
}

function updateComboFocusHighlight() {
    const popup = $("win-combo-popup");
    if (!popup) return;
    const items = Array.from(popup.querySelectorAll(".win-combo-item"));
    items.forEach((btn, idx) => {
        btn.classList.toggle("focused", idx === activeComboFocusIdx);
        if (idx === activeComboFocusIdx) {
            btn.scrollIntoView({ block: "nearest" });
        }
    });
}

function openComboPopup(selectEl) {
    if (!selectEl || selectEl.disabled) return;
    const trigger = selectEl._winTrigger;
    if (!trigger) return;
    if (activeComboSelect === selectEl) {
        closeComboPopup();
        return;
    }
    hideFlyout();
    closeComboPopup();

    const visibleOpts = getVisibleSelectOptions(selectEl);
    if (visibleOpts.length === 0) return;

    const popup = $("win-combo-popup");
    const hostRoot = document.fullscreenElement || document.body;
    if (popup.parentNode !== hostRoot) {
        hostRoot.appendChild(popup);
    }

    const isDarkSurface = selectEl.classList.contains("tb-select");
    popup.classList.toggle("dark-surface", isDarkSurface);
    popup.textContent = "";

    let selectedIdx = 0;
    visibleOpts.forEach((opt, idx) => {
        const item = document.createElement("button");
        item.type = "button";
        item.setAttribute("role", "option");
        const isSel = opt.value === selectEl.value;
        if (isSel) selectedIdx = idx;
        item.className = `win-combo-item${isSel ? " selected" : ""}`;
        item.setAttribute("aria-selected", isSel ? "true" : "false");
        item.textContent = opt.textContent;
        item.onclick = (e) => {
            e.stopPropagation();
            const changed = selectEl.value !== opt.value;
            selectEl.value = opt.value;
            syncWinSelect(selectEl);
            closeComboPopup();
            trigger.focus();
            if (changed) {
                selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            }
        };
        popup.appendChild(item);
    });

    activeComboSelect = selectEl;
    activeComboFocusIdx = selectedIdx;
    trigger.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");

    const rect = trigger.getBoundingClientRect();
    popup.style.minWidth = `${Math.max(Math.round(rect.width), 120)}px`;
    popup.style.left = "0px";
    popup.style.top = "0px";
    popup.classList.remove("hidden", "open-down", "open-up");

    const mw = popup.offsetWidth || Math.max(rect.width, 120);
    const mh = popup.offsetHeight || 120;
    const left = Math.max(8, Math.min(window.innerWidth - mw - 8, rect.left));
    const openUp = rect.bottom + mh + 8 > window.innerHeight && rect.top - mh - 8 > 0;
    const top = openUp
        ? Math.max(8, rect.top - mh - 4)
        : Math.min(window.innerHeight - mh - 8, rect.bottom + 4);

    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.classList.add(openUp ? "open-up" : "open-down");
    updateComboFocusHighlight();
}

function enhanceWinSelect(selectEl) {
    if (!selectEl || selectEl._winTrigger) {
        syncWinSelect(selectEl);
        return selectEl?._winTrigger || null;
    }
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "win-combo-trigger";
    if (selectEl.classList.contains("compact")) trigger.classList.add("compact");
    if (selectEl.classList.contains("full")) trigger.classList.add("full");
    if (selectEl.classList.contains("tb-select")) trigger.classList.add("dark-surface");
    const ariaLabel = selectEl.getAttribute("aria-label");
    if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "win-combo-label";
    trigger.appendChild(label);

    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("class", "win-combo-chevron");
    chev.setAttribute("viewBox", "0 0 16 16");
    chev.setAttribute("width", "12");
    chev.setAttribute("height", "12");
    chev.setAttribute("fill", "none");
    chev.setAttribute("stroke", "currentColor");
    chev.setAttribute("stroke-width", "1.8");
    chev.setAttribute("stroke-linecap", "round");
    chev.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3.5 6L8 10.5L12.5 6");
    chev.appendChild(path);
    trigger.appendChild(chev);

    trigger.onclick = (e) => {
        e.stopPropagation();
        openComboPopup(selectEl);
    };
    trigger.onkeydown = (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            if (activeComboSelect !== selectEl) {
                e.preventDefault();
                openComboPopup(selectEl);
            }
        }
    };

    selectEl._winTrigger = trigger;
    selectEl.classList.add("win-select-native");
    selectEl.parentNode.insertBefore(trigger, selectEl.nextSibling);
    syncWinSelect(selectEl);
    return trigger;
}

function enhanceAllStaticSelects() {
    document.querySelectorAll("select.win-select, select.tb-select").forEach((sel) => {
        enhanceWinSelect(sel);
    });
}

function openFlyout(anchorEl, items) {
    closeComboPopup();
    const menu = $("flyout-menu");
    menu.textContent = "";
    for (const item of items) {
        if (item.separator) {
            const sep = document.createElement("div");
            sep.className = "flyout-sep";
            menu.appendChild(sep);
            continue;
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `flyout-item${item.danger ? " danger" : ""}`;
        btn.disabled = Boolean(item.disabled);
        btn.textContent = item.label;
        btn.onclick = (e) => {
            e.stopPropagation();
            hideFlyout();
            if (typeof item.onClick === "function") item.onClick();
        };
        menu.appendChild(btn);
    }
    menu.classList.remove("hidden");
    const rect = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth || 176;
    const mh = menu.offsetHeight || 140;
    const left = Math.max(8, Math.min(window.innerWidth - mw - 8, rect.right - mw));
    const top = rect.bottom + mh + 8 > window.innerHeight
        ? Math.max(8, rect.top - mh - 4)
        : rect.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function openPopupCentered(url, name, w = 520, h = 640) {
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
    return window.open(url, name, `width=${w},height=${h},left=${left},top=${top},noopener=no`);
}

function stopAuthPolling() {
    state.authChallengeGen += 1;
    if (state.authPollTimer) {
        clearInterval(state.authPollTimer);
        state.authPollTimer = null;
    }
    state.authChallengeKind = "";
    state.authChallengeId = "";
    state.authChallengeQrGen = null;
    state.authChallengeQueued = false;
}

function setAuthError(msg) {
    const el = $("auth-error");
    if (!msg) {
        el.textContent = "";
        el.classList.add("hidden");
    } else {
        el.textContent = msg;
        el.classList.remove("hidden");
    }
}

function setTwoFaError(msg) {
    const el = $("twofa-error");
    if (!msg) {
        el.textContent = "";
        el.classList.add("hidden");
    } else {
        el.textContent = msg;
        el.classList.remove("hidden");
    }
}

function setLoginKeyError(msg) {
    const el = $("loginkey-error");
    if (!msg) {
        el.textContent = "";
        el.classList.add("hidden");
    } else {
        el.textContent = msg;
        el.classList.remove("hidden");
    }
}

function setRecoveryError(msg) {
    const el = $("recovery-error");
    if (!msg) {
        el.textContent = "";
        el.classList.add("hidden");
    } else {
        el.textContent = msg;
        el.classList.remove("hidden");
    }
}

function setLoginFormDisabled(disabled) {
    $("login-email").disabled = disabled;
    $("login-password").disabled = disabled;
    $("btn-login-submit").disabled = disabled;
    $("btn-open-recovery").disabled = disabled;
    $("login-2fa-code").disabled = disabled;
    $("btn-twofa-submit").disabled = disabled;
    $("btn-twofa-back").disabled = disabled;
    $("login-key-input").disabled = disabled;
    $("btn-loginkey-submit").disabled = disabled;
    $("recovery-lookup-email").disabled = disabled;
    $("recovery-confirm-email").disabled = disabled;
    $("recovery-otp").disabled = disabled;
    $("recovery-new-password").disabled = disabled;
    $("recovery-confirm-password").disabled = disabled;
    $("btn-recovery-submit").disabled = disabled;
    $("btn-recovery-back").disabled = disabled;
    $("tab-auth-password").disabled = disabled;
    $("tab-auth-key").disabled = disabled;
    $("oauth-buttons").querySelectorAll("button").forEach((b) => {
        b.disabled = disabled;
    });
    if (!disabled && state.inRecovery) {
        updateRecoveryCooldownUi();
    } else {
        $("btn-recovery-resend").disabled = true;
    }
}

function setAuthMode(mode) {
    const next = mode === "key" ? "key" : "password";
    state.authMode = next;
    state.inTwoFa = false;
    state.inRecovery = false;
    setAuthError("");
    setTwoFaError("");
    setLoginKeyError("");
    setRecoveryError("");
    $("auth-mode-tabs").classList.remove("hidden");
    $("tab-auth-password").classList.toggle("active", next === "password");
    $("tab-auth-password").setAttribute("aria-selected", next === "password" ? "true" : "false");
    $("tab-auth-key").classList.toggle("active", next === "key");
    $("tab-auth-key").setAttribute("aria-selected", next === "key" ? "true" : "false");
    $("login-form").classList.toggle("hidden", next !== "password");
    $("twofa-form").classList.add("hidden");
    $("recovery-form").classList.add("hidden");
    $("loginkey-form").classList.toggle("hidden", next !== "key");
}

function enterTwoFaStep() {
    state.inTwoFa = true;
    state.inRecovery = false;
    setAuthError("");
    setTwoFaError("");
    setRecoveryError("");
    $("auth-mode-tabs").classList.add("hidden");
    $("login-form").classList.add("hidden");
    $("loginkey-form").classList.add("hidden");
    $("recovery-form").classList.add("hidden");
    $("twofa-form").classList.remove("hidden");
    $("login-2fa-code").value = "";
    setLoginFormDisabled(false);
    setTimeout(() => $("login-2fa-code").focus(), 40);
}

function exitTwoFaStep() {
    state.inTwoFa = false;
    $("login-2fa-code").value = "";
    setTwoFaError("");
    setAuthMode("password");
}

function getSelectedRecoveryChannel() {
    if (!Array.isArray(state.recoveryChannels) || state.recoveryChannels.length === 0) return null;
    const idx = Number($("recovery-channel").value || 0);
    return state.recoveryChannels[idx] || state.recoveryChannels[0];
}

function isRecoveryLoginAction() {
    const ch = getSelectedRecoveryChannel();
    return Boolean(ch && ch.channel === "recovery" && $("recovery-action").value === "login");
}

function updateRecoveryCooldownUi() {
    const rem = Math.max(0, Math.ceil((state.recoveryCooldownUntil - Date.now()) / 1000));
    const resendBtn = $("btn-recovery-resend");
    const submitBtn = $("btn-recovery-submit");
    if (rem > 0) {
        resendBtn.disabled = true;
        resendBtn.textContent = `${rem}s`;
        if (state.inRecovery && state.recoveryStep === 1) {
            submitBtn.disabled = true;
            submitBtn.textContent = `${rem}s`;
        }
        return;
    }
    if (state.recoveryCooldownTimer) {
        clearInterval(state.recoveryCooldownTimer);
        state.recoveryCooldownTimer = null;
    }
    resendBtn.disabled = false;
    resendBtn.textContent = t("btn_resend_code");
    if (state.inRecovery && state.recoveryStep === 1) {
        submitBtn.disabled = false;
        submitBtn.textContent = t("rec_btn_send");
    }
}

function startRecoveryCooldown(sec = 60) {
    state.recoveryCooldownUntil = Date.now() + Math.max(1, sec) * 1000;
    updateRecoveryCooldownUi();
    if (state.recoveryCooldownTimer) clearInterval(state.recoveryCooldownTimer);
    state.recoveryCooldownTimer = setInterval(updateRecoveryCooldownUi, 500);
}

function populateRecoveryChannelOptions() {
    const sel = $("recovery-channel");
    const prev = sel.value;
    sel.textContent = "";
    state.recoveryChannels.forEach((ch, idx) => {
        const opt = document.createElement("option");
        opt.value = String(idx);
        opt.textContent = ch.channel === "recovery"
            ? t("rec_channel_recovery", { masked: ch.masked })
            : t("rec_channel_primary", { masked: ch.masked });
        sel.appendChild(opt);
    });
    if (prev && Number(prev) >= 0 && Number(prev) < state.recoveryChannels.length) {
        sel.value = prev;
    } else if (state.recoveryChannels.length > 0) {
        sel.value = "0";
    }
    syncWinSelect(sel);
}

function syncRecoveryChannelUi(clearInput = false) {
    const ch = getSelectedRecoveryChannel();
    const isRec = Boolean(ch && ch.channel === "recovery");
    $("recovery-channel-wrap").classList.toggle("hidden", state.recoveryChannels.length <= 1);
    $("recovery-action-wrap").classList.toggle("hidden", !isRec);
    if (!isRec) {
        $("recovery-action").value = "reset";
        syncWinSelect($("recovery-action"));
    }
    $("recovery-masked-hint").textContent = ch ? t("rec_masked_hint", { masked: ch.masked }) : "";
    if (clearInput) {
        $("recovery-confirm-email").value = "";
    }
}

function setRecoveryStep(step) {
    state.recoveryStep = step;
    setRecoveryError("");
    $("recovery-step-0").classList.toggle("hidden", step !== 0);
    $("recovery-step-1").classList.toggle("hidden", step !== 1);
    $("recovery-step-2").classList.toggle("hidden", step !== 2);
    $("recovery-desc").classList.toggle("hidden", step !== 0);
    const submitBtn = $("btn-recovery-submit");
    const backBtn = $("btn-recovery-back");
    if (step === 0) {
        submitBtn.textContent = t("rec_btn_next");
        submitBtn.disabled = false;
        backBtn.textContent = t("btn_twofa_back");
        setTimeout(() => $("recovery-lookup-email").focus(), 40);
    } else if (step === 1) {
        populateRecoveryChannelOptions();
        syncRecoveryChannelUi(false);
        submitBtn.textContent = t("rec_btn_send");
        backBtn.textContent = t("rec_btn_prev");
        updateRecoveryCooldownUi();
        setTimeout(() => $("recovery-confirm-email").focus(), 40);
    } else {
        const ch = getSelectedRecoveryChannel();
        const isLogin = isRecoveryLoginAction();
        $("recovery-sent-hint").textContent = ch ? t("rec_sent_hint", { masked: ch.masked }) : "";
        $("recovery-pwd-fields").classList.toggle("hidden", isLogin);
        submitBtn.textContent = isLogin ? t("rec_btn_login") : t("rec_btn_reset");
        submitBtn.disabled = false;
        backBtn.textContent = t("rec_btn_prev");
        updateRecoveryCooldownUi();
        setTimeout(() => $("recovery-otp").focus(), 40);
    }
}

function refreshRecoveryLocalization() {
    if (!state.inRecovery) return;
    populateRecoveryChannelOptions();
    syncWinSelect($("recovery-action"));
    syncRecoveryChannelUi(false);
    setRecoveryStep(state.recoveryStep);
}

function enterRecoveryFlow() {
    if (!state.providersAvailable) return;
    stopAuthPolling();
    state.inRecovery = true;
    state.inTwoFa = false;
    state.recoveryChannels = [];
    state.recoveryPendingAdvance = false;
    $("auth-mode-tabs").classList.add("hidden");
    $("login-form").classList.add("hidden");
    $("loginkey-form").classList.add("hidden");
    $("twofa-form").classList.add("hidden");
    $("recovery-form").classList.remove("hidden");
    $("recovery-lookup-email").value = $("login-email").value.trim();
    $("recovery-confirm-email").value = "";
    $("recovery-otp").value = "";
    $("recovery-new-password").value = "";
    $("recovery-confirm-password").value = "";
    setLoginFormDisabled(false);
    setRecoveryStep(0);
}

function exitRecoveryFlow() {
    state.inRecovery = false;
    state.recoveryPendingAdvance = false;
    setRecoveryError("");
    setAuthMode("password");
}

function stopWebQrLogin(cancelRemote = false) {
    state.qrGeneration += 1;
    if (state.qrPollTimer) {
        clearInterval(state.qrPollTimer);
        state.qrPollTimer = null;
    }
    if (state.qrCountdownTimer) {
        clearInterval(state.qrCountdownTimer);
        state.qrCountdownTimer = null;
    }
    const prevVisual = state.qrVisualState;
    state.qrVisualState = "idle";
    state.qrExpiresAtMs = 0;
    if (cancelRemote && (prevVisual === "pending" || prevVisual === "scanned" || prevVisual === "awaiting_confirm")) {
        apiRequest("/web-api/auth/qr/cancel", { method: "POST", body: {} }).catch(() => {});
    }
}

function refreshWebQrLocalization() {
    const st = state.qrVisualState;
    if (st === "pending") {
        $("qr-status-text").textContent = t("qr_waiting");
    } else if (st === "scanned") {
        $("qr-status-text").textContent = t("qr_scanned");
        $("qr-overlay-text").textContent = t("qr_scanned");
    } else if (st === "awaiting_confirm") {
        $("qr-status-text").textContent = t("qr_awaiting_confirm");
        $("qr-overlay-text").textContent = t("qr_awaiting_confirm");
    } else if (st === "expired") {
        $("qr-status-text").textContent = t("qr_expired");
        $("qr-overlay-text").textContent = t("qr_expired");
    } else if (st === "cancelled") {
        $("qr-status-text").textContent = t("qr_cancelled");
        $("qr-overlay-text").textContent = t("qr_cancelled");
    } else if (st === "failed") {
        $("qr-status-text").textContent = t("qr_failed");
        $("qr-overlay-text").textContent = t("qr_failed");
    }
}

function applyWebQrState(visualState, username = "", avatarData = null) {
    state.qrVisualState = visualState;
    state.qrScannedUser = username || "";
    state.qrScannedAvatar = avatarData || null;
    const loading = $("qr-loading");
    const overlay = $("qr-overlay");
    const avatarHost = $("qr-avatar-host");
    const avatarSlot = $("qr-avatar-slot");
    const userEl = $("qr-scanned-user");
    const overlayText = $("qr-overlay-text");
    const overlayRefresh = $("btn-qr-overlay-refresh");
    const statusText = $("qr-status-text");

    if (visualState === "loading") {
        loading.classList.remove("hidden");
        overlay.classList.add("hidden");
        $("qr-countdown").classList.add("hidden");
        $("btn-qr-refresh").disabled = true;
        statusText.textContent = t("qr_waiting");
        return;
    }

    loading.classList.add("hidden");
    $("btn-qr-refresh").disabled = false;

    if (visualState === "pending") {
        overlay.classList.add("hidden");
        statusText.textContent = t("qr_waiting");
        return;
    }

    overlay.classList.remove("hidden");
    if (visualState === "scanned" || visualState === "awaiting_confirm") {
        const msg = visualState === "awaiting_confirm" ? t("qr_awaiting_confirm") : t("qr_scanned");
        statusText.textContent = msg;
        overlayText.textContent = msg;
        overlayRefresh.classList.add("hidden");
        avatarHost.classList.remove("hidden");
        renderAvatar(avatarSlot, { username: username || "O", avatar_data: avatarData });
        if (username) {
            userEl.textContent = username;
            userEl.classList.remove("hidden");
        } else {
            userEl.classList.add("hidden");
        }
        return;
    }

    if (state.qrCountdownTimer) {
        clearInterval(state.qrCountdownTimer);
        state.qrCountdownTimer = null;
    }
    if (state.qrPollTimer) {
        clearInterval(state.qrPollTimer);
        state.qrPollTimer = null;
    }
    $("qr-countdown").classList.add("hidden");
    avatarHost.classList.add("hidden");
    userEl.classList.add("hidden");
    overlayRefresh.classList.remove("hidden");
    const errMsg = visualState === "cancelled"
        ? t("qr_cancelled")
        : visualState === "failed"
            ? t("qr_failed")
            : t("qr_expired");
    statusText.textContent = errMsg;
    overlayText.textContent = errMsg;
}

function updateQrCountdown() {
    if (state.qrVisualState !== "pending" && state.qrVisualState !== "scanned" && state.qrVisualState !== "awaiting_confirm") {
        $("qr-countdown").classList.add("hidden");
        return;
    }
    const rem = Math.ceil((state.qrExpiresAtMs - Date.now()) / 1000);
    if (rem <= 0) {
        applyWebQrState("expired");
        return;
    }
    const mm = String(Math.floor(rem / 60)).padStart(2, "0");
    const ss = String(rem % 60).padStart(2, "0");
    const el = $("qr-countdown");
    el.textContent = `${mm}:${ss}`;
    el.classList.remove("hidden");
}

function activateWebQrSession(qrData, gen) {
    if (gen !== state.qrGeneration || state.user) return;
    if (!qrData || !qrData.qr_url) {
        applyWebQrState("failed");
        return;
    }
    try {
        renderQrToCanvas($("qr-canvas"), qrData.qr_url, 360);
    } catch {
        applyWebQrState("failed");
        return;
    }
    state.qrExpiresAtMs = Number(qrData.expires_at) > Date.now()
        ? Number(qrData.expires_at)
        : Date.now() + Math.max(30, Number(qrData.expires_in || 180)) * 1000;
    applyWebQrState("pending");
    updateQrCountdown();
    if (state.qrCountdownTimer) clearInterval(state.qrCountdownTimer);
    state.qrCountdownTimer = setInterval(updateQrCountdown, 1000);

    const pollInterval = Math.max(1200, Math.min(3500, Number(qrData.poll_interval_ms || 1500)));
    let netErrors = 0;
    const pollQr = async () => {
        if (gen !== state.qrGeneration || state.user) return;
        if (Date.now() >= state.qrExpiresAtMs) {
            applyWebQrState("expired");
            return;
        }
        try {
            const st = await apiRequest("/web-api/auth/qr/status");
            if (gen !== state.qrGeneration || state.user) return;
            if (!st.ok || !st.json?.ok || !st.json?.data) {
                netErrors += 1;
                if (netErrors >= 5) applyWebQrState("expired");
                return;
            }
            netErrors = 0;
            const d = st.json.data;
            if (Number(d.expires_in) > 0) {
                state.qrExpiresAtMs = Date.now() + Number(d.expires_in) * 1000;
            }
            if (d.state === "confirmed" && d.user) {
                stopWebQrLogin(false);
                enterAuthenticatedApp(d);
                return;
            }
            if (d.state === "awaiting_confirm") {
                applyWebQrState("awaiting_confirm", d.username || "", d.avatar_data || null);
                return;
            }
            if (d.state === "scanned") {
                applyWebQrState("scanned", "", null);
                return;
            }
            if (d.state === "cancelled") {
                applyWebQrState("cancelled");
                return;
            }
            if (d.state === "expired") {
                applyWebQrState("expired");
            }
        } catch {
            netErrors += 1;
            if (netErrors >= 5) applyWebQrState("expired");
        }
    };
    if (state.qrPollTimer) clearInterval(state.qrPollTimer);
    state.qrPollTimer = setInterval(() => {
        pollQr().catch(() => {});
    }, pollInterval);
}

async function startWebQrLogin() {
    stopWebQrLogin(false);
    const gen = state.qrGeneration;
    applyWebQrState("loading");
    try {
        const res = await apiRequest("/web-api/auth/qr/create", { method: "POST", body: {} });
        if (gen !== state.qrGeneration || state.user) return;
        if (res.status === 202 && res.json?.data?.captcha_url) {
            runAuthCaptchaChallenge(res.json.data.captcha_url, "qr_create", gen, res.json.data.challenge_id);
            return;
        }
        if (res.ok && res.json?.ok && res.json?.data?.qr_url) {
            activateWebQrSession(res.json.data, gen);
            return;
        }
        applyWebQrState("failed");
    } catch {
        if (gen === state.qrGeneration && !state.user) {
            applyWebQrState("failed");
        }
    }
}

function handleChallengeTerminalStatus(st, kind, qrGen) {
    if (st.ok && st.json?.ok) {
        const d = st.json.data || {};
        if (d.state === "completed" && d.user) {
            stopAuthPolling();
            enterAuthenticatedApp(d);
            return true;
        }
        if (st.json.code === 102 || d.state === "two_fa_required") {
            stopAuthPolling();
            enterTwoFaStep();
            return true;
        }
        if (d.state === "otp_sent") {
            stopAuthPolling();
            setLoginFormDisabled(false);
            startRecoveryCooldown(60);
            if (state.recoveryPendingAdvance) {
                state.recoveryPendingAdvance = false;
                setRecoveryStep(2);
            }
            return true;
        }
        if (d.state === "qr_created" && d.qr_url) {
            stopAuthPolling();
            setLoginFormDisabled(false);
            activateWebQrSession(d, qrGen ?? state.qrGeneration);
            return true;
        }
    }
    if (st.ok && (st.json?.code === 101 || st.json?.data?.state === "pending")) {
        return false;
    }
    stopAuthPolling();
    setLoginFormDisabled(false);
    const code = st.json?.code;
    const msg = mapApiError(code);
    if (kind === "qr_create") {
        applyWebQrState("expired");
    } else if (kind === "login_2fa") {
        if (Number(code) === 3020) {
            exitTwoFaStep();
            setAuthError(msg);
        } else {
            setTwoFaError(msg);
            $("login-2fa-code").focus();
        }
    } else if (kind === "login_key") {
        setLoginKeyError(msg);
    } else if (kind === "recovery_otp") {
        state.recoveryPendingAdvance = false;
        if (Number(code) === 3021 || Number(code) === 3022) {
            setRecoveryStep(0);
        }
        setRecoveryError(msg);
    } else {
        setAuthError(msg);
    }
    return true;
}

async function pollAuthChallengeOnce(fromMessage = false) {
    if (!state.authChallengeKind) return "inactive";
    if (state.authChallengeInFlight) {
        if (fromMessage) state.authChallengeQueued = true;
        return "inflight";
    }
    const gen = state.authChallengeGen;
    const kind = state.authChallengeKind;
    const qrGen = state.authChallengeQrGen;
    state.authChallengeInFlight = true;
    state.authChallengeQueued = false;
    let shouldRequeue = false;
    try {
        const st = await apiRequest("/web-api/auth/challenge/status");
        if (gen !== state.authChallengeGen || !state.authChallengeKind) return "stale";
        if (handleChallengeTerminalStatus(st, kind, qrGen)) return "terminal";
        shouldRequeue = state.authChallengeQueued && gen === state.authChallengeGen && Boolean(state.authChallengeKind);
        return "pending";
    } finally {
        state.authChallengeInFlight = false;
        state.authChallengeQueued = false;
        if (shouldRequeue) {
            pollAuthChallengeOnce(false).catch(() => {});
        }
    }
}

function runAuthCaptchaChallenge(captchaUrl, kind, qrGen = null, challengeId = "") {
    stopAuthPolling();
    const gen = state.authChallengeGen;
    state.authChallengeKind = kind;
    state.authChallengeId = String(challengeId || "");
    state.authChallengeQrGen = qrGen;
    state.authPopup = openPopupCentered(captchaUrl, "osmium_captcha", 460, 520);
    if (!state.authPopup) {
        stopAuthPolling();
        if (kind === "qr_create") {
            applyWebQrState("expired");
            showToast(t("err_popup_blocked_captcha"));
        } else if (kind === "login_2fa") {
            setTwoFaError(t("err_popup_blocked_captcha"));
            setLoginFormDisabled(false);
        } else if (kind === "login_key") {
            setLoginKeyError(t("err_popup_blocked_captcha"));
            setLoginFormDisabled(false);
        } else if (kind === "recovery_otp") {
            state.recoveryPendingAdvance = false;
            setRecoveryError(t("err_popup_blocked_captcha"));
            setLoginFormDisabled(false);
        } else {
            setAuthError(t("err_popup_blocked_captcha"));
            setLoginFormDisabled(false);
        }
        return;
    }
    let closedTicks = 0;
    const pollChallenge = async () => {
        const outcome = await pollAuthChallengeOnce(false);
        if (gen !== state.authChallengeGen || outcome !== "pending") return;
        if (state.authPopup && state.authPopup.closed) {
            closedTicks += 1;
            if (closedTicks >= 2) {
                stopAuthPolling();
                setLoginFormDisabled(false);
                if (kind === "qr_create") {
                    applyWebQrState("expired");
                } else if (kind === "login_2fa") {
                    setTwoFaError(t("err_captcha_closed"));
                } else if (kind === "login_key") {
                    setLoginKeyError(t("err_captcha_closed"));
                } else if (kind === "recovery_otp") {
                    state.recoveryPendingAdvance = false;
                    setRecoveryError(t("err_captcha_closed"));
                } else {
                    setAuthError(t("err_captcha_closed"));
                }
            }
        }
    };
    state.authPollTimer = setInterval(() => {
        pollChallenge().catch(() => {});
    }, 1200);
}

function providerIconSvg(provider) {
    if (provider === "google") {
        return '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#4285F4" d="M23.745,12.27 C23.745,11.48 23.675,10.73 23.555,10 H12.255 V14.51 H18.725 C18.435,15.99 17.585,17.24 16.325,18.09 V21.09 H20.185 C22.445,19 23.745,15.92 23.745,12.27 Z"/><path fill="#34A853" d="M12.255,24 C15.495,24 18.205,22.92 20.185,21.09 L16.325,18.09 C15.245,18.81 13.875,19.25 12.255,19.25 C9.125,19.25 6.475,17.14 5.525,14.29 H1.545 V17.38 C3.515,21.3 7.565,24 12.255,24 Z"/><path fill="#FBBC05" d="M5.525,14.29 C5.275,13.57 5.145,12.8 5.145,12 C5.145,11.2 5.285,10.43 5.525,9.71 V6.62 H1.545 A11.86,11.86 0 0 0 1.545,17.38 L5.525,14.29 Z"/><path fill="#EA4335" d="M12.255,4.75 C14.025,4.75 15.605,5.36 16.855,6.55 L20.275,3.13 C18.205,1.19 15.495,0 12.255,0 C7.565,0 3.515,2.7 1.545,6.62 L5.525,9.71 C6.475,6.86 9.125,4.75 12.255,4.75 Z"/></svg>';
    }
    if (provider === "wechat") {
        return '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#07C160" d="M9.5 4C5.36 4 2 6.86 2 10.38c0 2 1.09 3.79 2.79 4.96l-.7 2.13 2.46-1.23c.92.28 1.91.44 2.95.44.31 0 .62-.02.92-.05-.2-.59-.31-1.21-.31-1.86 0-3.16 2.96-5.73 6.6-5.73.17 0 .33.01.5.02C16.58 6.13 13.36 4 9.5 4zm7.2 6.3c-3.15 0-5.7 2.18-5.7 4.86 0 2.68 2.55 4.86 5.7 4.86.68 0 1.33-.1 1.94-.29l1.86.93-.52-1.6c1.27-.9 2.12-2.25 2.12-3.9 0-2.68-2.55-4.86-5.4-4.86z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#12B7F5" d="M12 2C7.8 2 6 5.6 6 9.4c0 .9.1 1.7.2 2.4-.9 1.1-1.6 2.7-1.6 4.1 0 .8.3 1.4.8 1.4.4 0 .8-.5 1.2-1.2.4.9 1.1 1.6 2 2.1-.6.4-1.2.9-1.2 1.4 0 .6.9 1.1 2.4 1.1 1.1 0 1.9-.3 2.2-.8.3.5 1.1.8 2.2.8 1.5 0 2.4-.5 2.4-1.1 0-.5-.6-1-1.2-1.4.9-.5 1.6-1.2 2-2.1.4.7.8 1.2 1.2 1.2.5 0 .8-.6.8-1.4 0-1.4-.7-3-1.6-4.1.1-.7.2-1.5.2-2.4C18 5.6 16.2 2 12 2z"/></svg>';
}

async function loadAuthProviders() {
    $("auth-offline-banner").classList.add("hidden");
    $("oauth-section").classList.add("hidden");
    setLoginFormDisabled(true);
    try {
        const res = await apiRequest("/web-api/auth/providers");
        if (!res.ok || !res.json?.ok) {
            state.providersAvailable = false;
            $("auth-offline-banner").classList.remove("hidden");
            return;
        }
        state.providersAvailable = true;
        setLoginFormDisabled(false);
        const list = Array.isArray(res.json.data?.providers) ? res.json.data.providers : [];
        state.providers = list;
        renderOAuthButtons();
    } catch {
        state.providersAvailable = false;
        $("auth-offline-banner").classList.remove("hidden");
    }
}

function handleOAuthStatusResult(st) {
    if (st.ok && st.json?.ok) {
        const d = st.json.data || {};
        if (d.state === "completed" && d.user) {
            stopAuthPolling();
            enterAuthenticatedApp(d);
            return "terminal";
        }
        if (st.json.code === 102 || d.state === "two_fa_required") {
            stopAuthPolling();
            enterTwoFaStep();
            return "terminal";
        }
        if (d.state === "pending") {
            return "pending";
        }
    }
    stopAuthPolling();
    setLoginFormDisabled(false);
    setAuthError(mapApiError(st.json?.code));
    return "terminal";
}

async function pollOAuthStatusOnce() {
    if (state.oauthStatusInFlight || state.user || state.inTwoFa) return "skip";
    state.oauthStatusInFlight = true;
    try {
        const st = await apiRequest("/web-api/auth/oauth/status");
        if (state.user || state.inTwoFa) return "terminal";
        return handleOAuthStatusResult(st);
    } finally {
        state.oauthStatusInFlight = false;
    }
}

async function startOAuthLogin(provider) {
    if (!state.providersAvailable) return;
    setAuthError("");
    stopAuthPolling();
    state.oauthStatusInFlight = false;
    setLoginFormDisabled(true);
    try {
        const res = await apiRequest("/web-api/auth/oauth/start", {
            method: "POST",
            body: { provider }
        });
        if (!res.ok || !res.json?.ok || !res.json?.data?.authorize_url) {
            setAuthError(mapApiError(res.json?.code));
            setLoginFormDisabled(false);
            return;
        }
        state.authPopup = openPopupCentered(res.json.data.authorize_url, "osmium_oauth", 540, 680);
        if (!state.authPopup) {
            setAuthError(t("err_popup_blocked_oauth"));
            setLoginFormDisabled(false);
            return;
        }
        const pollInterval = Math.max(1000, Number(res.json.data.poll_interval_ms || 1200));
        let closedTicks = 0;
        const pollOnce = async () => {
            const outcome = await pollOAuthStatusOnce();
            if (outcome === "pending") {
                if (state.authPopup && state.authPopup.closed) {
                    closedTicks++;
                    if (closedTicks >= 2) {
                        stopAuthPolling();
                        apiRequest("/web-api/auth/oauth/cancel", { method: "POST", body: {} }).catch(() => {});
                        setLoginFormDisabled(false);
                        setAuthError(t("err_oauth_cancelled"));
                    }
                }
            }
        };
        state.authPollTimer = setInterval(() => {
            pollOnce().catch(() => {});
        }, pollInterval);
    } catch {
        setAuthError(t("err_oauth_start_failed"));
        setLoginFormDisabled(false);
    }
}

async function handleEmailLoginSubmit(e) {
    e.preventDefault();
    if (!state.providersAvailable) return;
    setAuthError("");
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) {
        setAuthError(t("err_enter_credentials"));
        return;
    }
    stopAuthPolling();
    setLoginFormDisabled(true);
    try {
        const res = await apiRequest("/web-api/auth/login", {
            method: "POST",
            body: { email, password }
        });
        if (res.status === 202 && res.json?.data?.captcha_url) {
            runAuthCaptchaChallenge(res.json.data.captcha_url, "login", null, res.json.data.challenge_id);
            return;
        }
        if (res.ok && res.json?.ok && res.json?.data?.user) {
            enterAuthenticatedApp(res.json.data);
            return;
        }
        setAuthError(mapApiError(res.json?.code));
        setLoginFormDisabled(false);
    } catch {
        setAuthError(t("err_network"));
        setLoginFormDisabled(false);
    }
}

async function handleTwoFaSubmit(e) {
    e.preventDefault();
    setTwoFaError("");
    const code = $("login-2fa-code").value.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
        setTwoFaError(t("err_enter_twofa"));
        $("login-2fa-code").focus();
        return;
    }
    stopAuthPolling();
    setLoginFormDisabled(true);
    try {
        const res = await apiRequest("/web-api/auth/login/2fa/verify", {
            method: "POST",
            body: { code }
        });
        if (res.status === 202 && res.json?.data?.captcha_url) {
            runAuthCaptchaChallenge(res.json.data.captcha_url, "login_2fa", null, res.json.data.challenge_id);
            return;
        }
        if (res.ok && res.json?.ok && res.json?.data?.user) {
            enterAuthenticatedApp(res.json.data);
            return;
        }
        const errCode = Number(res.json?.code);
        const msg = mapApiError(errCode);
        setLoginFormDisabled(false);
        if (errCode === 3020 || res.status === 410) {
            exitTwoFaStep();
            setAuthError(msg);
        } else {
            setTwoFaError(msg);
            $("login-2fa-code").select();
            $("login-2fa-code").focus();
        }
    } catch {
        setTwoFaError(t("err_network"));
        setLoginFormDisabled(false);
    }
}

async function handleLoginKeySubmit(e) {
    e.preventDefault();
    if (!state.providersAvailable) return;
    setLoginKeyError("");
    const loginKey = $("login-key-input").value.trim();
    if (!loginKey || loginKey.length < 16) {
        setLoginKeyError(t("err_enter_login_key"));
        $("login-key-input").focus();
        return;
    }
    stopAuthPolling();
    setLoginFormDisabled(true);
    try {
        const res = await apiRequest("/web-api/auth/login/key", {
            method: "POST",
            body: { login_key: loginKey }
        });
        if (res.status === 202 && res.json?.data?.captcha_url) {
            runAuthCaptchaChallenge(res.json.data.captcha_url, "login_key", null, res.json.data.challenge_id);
            return;
        }
        if (res.ok && res.json?.ok && res.json?.data?.user) {
            $("login-key-input").value = "";
            enterAuthenticatedApp(res.json.data);
            return;
        }
        setLoginKeyError(mapApiError(res.json?.code));
        setLoginFormDisabled(false);
    } catch {
        setLoginKeyError(t("err_network"));
        setLoginFormDisabled(false);
    }
}

async function sendRecoveryOtp(advanceOnSuccess) {
    const ch = getSelectedRecoveryChannel();
    if (!ch) {
        setRecoveryStep(0);
        setRecoveryError(t("api_3021"));
        return;
    }
    const confirmEmail = $("recovery-confirm-email").value.trim();
    if (!confirmEmail || !confirmEmail.includes("@")) {
        setRecoveryError(t("err_enter_confirm_email"));
        $("recovery-confirm-email").focus();
        return;
    }
    const isLogin = isRecoveryLoginAction();
    stopAuthPolling();
    setRecoveryError("");
    state.recoveryPendingAdvance = advanceOnSuccess;
    setLoginFormDisabled(true);
    try {
        const res = isLogin
            ? await apiRequest("/web-api/auth/recovery/login/send-code", {
                  method: "POST",
                  body: { confirm_email: confirmEmail }
              })
            : await apiRequest("/web-api/auth/recovery/reset/send-code", {
                  method: "POST",
                  body: { channel: ch.channel, confirm_email: confirmEmail }
              });
        if (res.status === 202 && res.json?.data?.captcha_url) {
            runAuthCaptchaChallenge(res.json.data.captcha_url, "recovery_otp", null, res.json.data.challenge_id);
            return;
        }
        if (res.ok && res.json?.ok) {
            state.recoveryPendingAdvance = false;
            setLoginFormDisabled(false);
            startRecoveryCooldown(60);
            if (advanceOnSuccess) setRecoveryStep(2);
            return;
        }
        state.recoveryPendingAdvance = false;
        const errCode = Number(res.json?.code);
        setLoginFormDisabled(false);
        if (errCode === 3010) {
            startRecoveryCooldown(60);
            if (advanceOnSuccess) setRecoveryStep(2);
            return;
        }
        if (errCode === 3021 || errCode === 3022 || res.status === 410) {
            setRecoveryStep(0);
        }
        setRecoveryError(mapApiError(errCode));
    } catch {
        state.recoveryPendingAdvance = false;
        setRecoveryError(t("err_network"));
        setLoginFormDisabled(false);
    }
}

async function handleRecoverySubmit(e) {
    e.preventDefault();
    if (!state.providersAvailable) return;
    setRecoveryError("");
    if (state.recoveryStep === 0) {
        const email = $("recovery-lookup-email").value.trim();
        if (!email || !email.includes("@")) {
            setRecoveryError(t("err_enter_email"));
            $("recovery-lookup-email").focus();
            return;
        }
        setLoginFormDisabled(true);
        try {
            const res = await apiRequest("/web-api/auth/recovery/lookup", {
                method: "POST",
                body: { email }
            });
            setLoginFormDisabled(false);
            if (!res.ok || !res.json?.ok || !Array.isArray(res.json?.data?.channels) || res.json.data.channels.length === 0) {
                setRecoveryError(mapApiError(res.json?.code));
                return;
            }
            state.recoveryChannels = res.json.data.channels;
            $("recovery-confirm-email").value = "";
            $("recovery-otp").value = "";
            $("recovery-new-password").value = "";
            $("recovery-confirm-password").value = "";
            setRecoveryStep(1);
        } catch {
            setLoginFormDisabled(false);
            setRecoveryError(t("err_network"));
        }
        return;
    }

    if (state.recoveryStep === 1) {
        await sendRecoveryOtp(true);
        return;
    }

    const ch = getSelectedRecoveryChannel();
    if (!ch) {
        setRecoveryStep(0);
        setRecoveryError(t("api_3021"));
        return;
    }
    const confirmEmail = $("recovery-confirm-email").value.trim();
    const code = $("recovery-otp").value.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
        setRecoveryError(t("err_enter_otp"));
        $("recovery-otp").focus();
        return;
    }
    const isLogin = isRecoveryLoginAction();
    if (!isLogin) {
        const newPwd = $("recovery-new-password").value;
        if (newPwd.length < 8 || newPwd.length > 128) {
            setRecoveryError(t("err_password_length"));
            $("recovery-new-password").focus();
            return;
        }
        if (newPwd !== $("recovery-confirm-password").value) {
            setRecoveryError(t("err_password_mismatch"));
            $("recovery-confirm-password").focus();
            return;
        }
    }
    setLoginFormDisabled(true);
    try {
        if (isLogin) {
            const res = await apiRequest("/web-api/auth/recovery/login/confirm", {
                method: "POST",
                body: { confirm_email: confirmEmail, code }
            });
            if (res.ok && res.json?.ok) {
                const d = res.json.data || {};
                if (res.json.code === 102 || d.state === "two_fa_required") {
                    enterTwoFaStep();
                    return;
                }
                if (d.user) {
                    enterAuthenticatedApp(d);
                    return;
                }
            }
            const errCode = Number(res.json?.code);
            setLoginFormDisabled(false);
            if (errCode === 3021 || res.status === 410) {
                setRecoveryStep(0);
            }
            setRecoveryError(mapApiError(errCode));
        } else {
            const res = await apiRequest("/web-api/auth/recovery/reset/confirm", {
                method: "POST",
                body: {
                    channel: ch.channel,
                    confirm_email: confirmEmail,
                    code,
                    new_password: $("recovery-new-password").value
                }
            });
            setLoginFormDisabled(false);
            if (res.ok && res.json?.ok) {
                exitRecoveryFlow();
                showToast(t("toast_password_reset"));
                return;
            }
            const errCode = Number(res.json?.code);
            if (errCode === 3021 || res.status === 410) {
                setRecoveryStep(0);
            }
            setRecoveryError(mapApiError(errCode));
        }
    } catch {
        setLoginFormDisabled(false);
        setRecoveryError(t("err_network"));
    }
}

function showAuthView() {
    stopAuthPolling();
    stopWebQrLogin(false);
    hideFlyout();
    if (state.tokenRefreshTimer) {
        clearInterval(state.tokenRefreshTimer);
        state.tokenRefreshTimer = null;
    }
    if (state.session) {
        state.session.close(true, false);
        state.session = null;
    }
    if (state.signaling) {
        state.signaling.disconnect();
        state.signaling = null;
    }
    state.user = null;
    state.csrfToken = "";
    state.wsToken = "";
    state.devices = [];
    $("boot-screen").classList.add("hidden");
    $("session-view").classList.add("hidden");
    $("app-shell").classList.add("hidden");
    $("auth-view").classList.remove("hidden");
    $("login-password").value = "";
    $("login-key-input").value = "";
    $("login-2fa-code").value = "";
    setAuthMode("password");
    loadAuthProviders();
    startWebQrLogin();
}

function enterAuthenticatedApp(sessionPayload) {
    stopAuthPolling();
    stopWebQrLogin(false);
    state.user = sessionPayload.user;
    state.csrfToken = sessionPayload.csrfToken || "";
    state.wsToken = sessionPayload.wsToken || "";
    state.deviceId = sessionPayload.deviceId || "";
    state.signalingUrl = sessionPayload.signalingUrl || "wss://osmium.fufu.skin";

    $("boot-screen").classList.add("hidden");
    $("auth-view").classList.add("hidden");
    $("app-shell").classList.remove("hidden");

    renderProfile();
    applyCapabilitiesToUi();
    syncSettingsToControls();
    renderRecentList();
    connectSignaling();
    refreshDevices();
    requestAnimationFrame(() => {
        positionNavIndicator();
        positionSubTabIndicator();
    });

    if (state.tokenRefreshTimer) clearInterval(state.tokenRefreshTimer);
    state.tokenRefreshTimer = setInterval(() => {
        refreshSessionToken();
    }, 8 * 60 * 1000);
}

async function refreshSessionToken() {
    try {
        const res = await apiRequest("/web-api/session?refresh=1");
        if (res.status === 401) {
            showToast(t("toast_session_expired"));
            showAuthView();
            return;
        }
        if (res.ok && res.json?.ok && res.json?.data) {
            state.user = res.json.data.user || state.user;
            state.csrfToken = res.json.data.csrfToken || state.csrfToken;
            state.wsToken = res.json.data.wsToken || state.wsToken;
            renderProfile();
            if (state.signaling) state.signaling.updateToken(state.wsToken);
        }
    } catch {}
}

function renderProfile() {
    const u = state.user;
    if (!u) return;
    renderAvatar($("nav-avatar-slot"), u);
    renderAvatar($("profile-avatar-box"), u);
    $("nav-account-label").textContent = u.username || t("nav_account");
    $("profile-username").textContent = u.username || "Osmium";
    $("profile-email").textContent = u.email || t("account_no_email");
    const recEl = $("profile-recovery-email");
    if (recEl) {
        if (u.has_recovery_email && u.recovery_email) {
            recEl.textContent = t("account_recovery_email_label", { email: u.recovery_email });
            recEl.classList.remove("hidden");
        } else {
            recEl.textContent = "";
            recEl.classList.add("hidden");
        }
    }
    const badge = $("profile-status-badge");
    if (u.locked) {
        badge.textContent = t("account_status_locked");
        badge.className = "win-badge err";
        $("account-locked-banner").classList.remove("hidden");
    } else {
        badge.textContent = t("account_status_active");
        badge.className = "win-badge ok";
        $("account-locked-banner").classList.add("hidden");
    }
}

function applyCapabilitiesToUi() {
    const caps = state.caps;
    if (!caps) return;
    const notice = $("browser-notice");
    const noticeText = $("browser-notice-text");
    if (!caps.canConnect) {
        notice.classList.remove("hidden");
        noticeText.textContent = t("browser_unsupported");
    } else if (!caps.isChromeFull) {
        notice.classList.remove("hidden");
        noticeText.textContent = t("browser_partial");
    } else {
        notice.classList.add("hidden");
    }

    $("row-audio").classList.toggle("hidden", !caps.canAudioDecode);
    $("row-pointer-lock").classList.toggle("hidden", !caps.hasPointerLock);
    $("row-pointer-lock-divider").classList.toggle("hidden", !caps.hasPointerLock || !caps.canAudioDecode);
    $("row-keyboard-lock").classList.toggle("hidden", !caps.hasKeyboardLock);
    $("row-keyboard-lock-divider").classList.toggle("hidden", !caps.hasKeyboardLock);
    $("row-gamepad").classList.toggle("hidden", !caps.hasGamepad);
    $("row-gamepad-divider").classList.toggle("hidden", !caps.hasGamepad);

    const fpsSelect = $("set-fps");
    Array.from(fpsSelect.options).forEach((opt) => {
        if (opt.dataset.chromeOnly === "1") {
            opt.hidden = !caps.allowHighFps;
            opt.disabled = !caps.allowHighFps;
        }
    });
    if (!caps.allowHighFps && Number(state.settings.fps) > 60) {
        state.settings.fps = 60;
        saveSettings();
    }
    syncWinSelect(fpsSelect);

    const codecSelect = $("set-codec");
    codecSelect.textContent = "";
    for (const c of caps.supportedCodecs) {
        const opt = document.createElement("option");
        opt.value = String(c.id);
        opt.textContent = c.name;
        codecSelect.appendChild(opt);
    }
    const hideCodec = caps.supportedCodecs.length <= 1;
    $("row-codec").classList.toggle("hidden", hideCodec);
    $("row-codec-divider").classList.toggle("hidden", hideCodec);
    if (caps.supportedCodecs.length > 0 && !caps.supportedCodecs.some((c) => c.id === Number(state.settings.codec))) {
        state.settings.codec = caps.supportedCodecs[0].id;
        saveSettings();
    }
    syncWinSelect(codecSelect);

    $("btn-start-connect").disabled = !caps.canConnect || Boolean(state.user?.locked);
}

function syncSettingsToControls() {
    $("set-resolution").value = state.settings.resolution;
    $("set-fps").value = String(state.settings.fps);
    $("set-bitrate").value = String(state.settings.bitrateKbps);
    if ($("set-codec").options.length > 0) {
        $("set-codec").value = String(state.settings.codec);
    }
    $("set-audio").checked = Boolean(state.settings.audioEnabled);
    $("set-relative-mouse").checked = Boolean(state.settings.relativeMouse);
    $("set-keyboard-lock").checked = Boolean(state.settings.keyboardLock);
    $("set-gamepad").checked = Boolean(state.settings.gamepadEnabled);
    $("set-clipboard").checked = Boolean(state.settings.clipboardEnabled);
    $("set-theme").value = state.settings.theme;
    $("set-language").value = state.settings.language;
    syncWinSelect($("device-filter"));
    syncWinSelect($("set-resolution"));
    syncWinSelect($("set-fps"));
    syncWinSelect($("set-bitrate"));
    syncWinSelect($("set-codec"));
    syncWinSelect($("set-theme"));
    syncWinSelect($("set-language"));
    applyTheme(state.settings.theme);
}

function connectSignaling() {
    if (state.signaling) state.signaling.disconnect();
    state.signaling = new SignalingHubClient({
        devices: (list) => {
            state.devices = list;
            renderDevices();
        },
        cooldown: (ms) => {
            applyConnectCooldown(ms);
        },
        revoked: () => {
            showToast(t("toast_session_revoked"));
            showAuthView();
        },
        replaced: () => {
            showToast(t("toast_session_replaced"));
        },
        message: (msg) => {
            if (state.session) {
                state.session.handleSignalingMessage(msg);
            }
        }
    });
    state.signaling.connect(state.signalingUrl, state.deviceId, state.wsToken);
}

function applyConnectCooldown(ms) {
    if (ms <= 0) {
        state.cooldownUntilMs = 0;
        $("cooldown-hint").classList.add("hidden");
        if (state.cooldownTimer) {
            clearInterval(state.cooldownTimer);
            state.cooldownTimer = null;
        }
        return;
    }
    state.cooldownUntilMs = Date.now() + ms;
    const tick = () => {
        const rem = Math.ceil((state.cooldownUntilMs - Date.now()) / 1000);
        const hint = $("cooldown-hint");
        if (rem <= 0) {
            hint.classList.add("hidden");
            clearInterval(state.cooldownTimer);
            state.cooldownTimer = null;
            return;
        }
        hint.textContent = t("cooldown_hint", { sec: rem });
        hint.classList.remove("hidden");
    };
    if (state.cooldownTimer) clearInterval(state.cooldownTimer);
    tick();
    state.cooldownTimer = setInterval(tick, 500);
}

async function refreshDevices() {
    try {
        const res = await apiRequest("/web-api/devices");
        if (res.status === 401) {
            showAuthView();
            return;
        }
        if (res.ok && res.json?.ok && Array.isArray(res.json.data?.devices)) {
            state.devices = res.json.data.devices;
            renderDevices();
        }
    } catch {}
}

function isDeviceOnline(dev) {
    return Boolean(dev && (dev.is_online === true || dev.online === true));
}

function isDeviceControlled(dev) {
    return Boolean(dev && (dev.is_being_controlled === true || dev.in_session === true));
}

function isDesktopDevice(dev) {
    const os = String(dev?.os_version || "");
    return !/(android|ios|iphone|ipad|harmonyos|\bweb\b)/i.test(os);
}

function buildWaveBackdropSvg(isDark, online, controlled, uid) {
    let base;
    let glow;
    let glowAlt;
    let strand;
    let strandOpacity;
    if (!online) {
        if (isDark) {
            base = ["#1a1a1c", "#232325", "#2d2d30"];
            glow = "#66666b";
            glowAlt = "#48484c";
            strand = "#b8b8be";
            strandOpacity = "0.22";
        } else {
            base = ["#f1f1f2", "#e3e3e5", "#d2d2d5"];
            glow = "#a7a7ac";
            glowAlt = "#d5d5d8";
            strand = "#ffffff";
            strandOpacity = "0.62";
        }
    } else if (controlled) {
        if (isDark) {
            base = ["#1c130b", "#33200f", "#4f2f12"];
            glow = "#e88a30";
            glowAlt = "#b8501e";
            strand = "#ffd2a0";
            strandOpacity = "0.4";
        } else {
            base = ["#fff6ec", "#ffe4c6", "#fcc892"];
            glow = "#ff9c40";
            glowAlt = "#ffd470";
            strand = "#ffffff";
            strandOpacity = "0.72";
        }
    } else if (isDark) {
        base = ["#0a1229", "#0f2048", "#15326c"];
        glow = "#3274ff";
        glowAlt = "#2ab4f0";
        strand = "#a8caff";
        strandOpacity = "0.4";
    } else {
        base = ["#eff5ff", "#d4e5ff", "#a9cbff"];
        glow = "#4c8dff";
        glowAlt = "#7fd6ff";
        strand = "#ffffff";
        strandOpacity = "0.75";
    }

    return `<svg class="device-wave-svg" viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden="true">
<defs>
<linearGradient id="bg_${uid}" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="${base[0]}"/>
<stop offset="52%" stop-color="${base[1]}"/>
<stop offset="100%" stop-color="${base[2]}"/>
</linearGradient>
<radialGradient id="gl1_${uid}" cx="24%" cy="22%" r="62%">
<stop offset="0%" stop-color="${glow}" stop-opacity="0.46"/>
<stop offset="100%" stop-color="${glow}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="gl2_${uid}" cx="84%" cy="62%" r="58%">
<stop offset="0%" stop-color="${glowAlt}" stop-opacity="0.38"/>
<stop offset="100%" stop-color="${glowAlt}" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="400" height="200" fill="url(#bg_${uid})"/>
<rect width="400" height="200" fill="url(#gl1_${uid})"/>
<rect width="400" height="200" fill="url(#gl2_${uid})"/>
<g fill="none" stroke="${strand}" stroke-opacity="${strandOpacity}" stroke-width="1.2">
<path d="M-20 135 C 90 65, 220 165, 420 58"/>
<path d="M-20 144 C 102 74, 226 154, 420 68" stroke-opacity="0.55"/>
<path d="M-20 124 C 82 58, 214 176, 420 48" stroke-opacity="0.45"/>
<path d="M-20 155 C 115 86, 236 142, 420 80" stroke-opacity="0.32"/>
</g>
</svg>`;
}

function renderDevices() {
    const query = ($("device-search").value || "").trim().toLowerCase();
    const digitsQuery = query.replace(/\D/g, "");
    const filter = $("device-filter").value;
    const isDark = isDarkThemeActive();

    const container = $("devices-container");
    container.className = `devices-container ${state.settings.deviceGrid ? "grid" : "list"}`;

    const list = state.devices
        .filter((d) => String(d.device_id) !== state.deviceId)
        .filter((d) => {
            if (filter === "online" && !isDeviceOnline(d)) return false;
            if (!query) return true;
            const name = String(d.device_name || "").toLowerCase();
            if (name.includes(query)) return true;
            if (digitsQuery && String(d.device_id || "").includes(digitsQuery)) return true;
            return false;
        })
        .sort((a, b) => {
            const ao = isDeviceOnline(a) ? 1 : 0;
            const bo = isDeviceOnline(b) ? 1 : 0;
            if (ao !== bo) return bo - ao;
            const ad = isDesktopDevice(a) ? 0 : 1;
            const bd = isDesktopDevice(b) ? 0 : 1;
            if (ad !== bd) return ad - bd;
            return Number(b.last_active_at || 0) - Number(a.last_active_at || 0);
        });

    container.textContent = "";
    if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-devices";
        empty.textContent = query || filter === "online" ? t("empty_devices_filtered") : t("empty_devices");
        container.appendChild(empty);
        return;
    }

    list.forEach((dev, idx) => {
        const desktop = isDesktopDevice(dev);
        const online = isDeviceOnline(dev);
        const controlled = isDeviceControlled(dev);
        const canControl = desktop && online && dev.allow_remote !== false && Boolean(state.caps?.canConnect) && !state.user?.locked;
        const allowPower = desktop && Boolean(dev.allow_remote_power) && !state.user?.locked;
        const hasWolMacs = Array.isArray(dev.wol_macs) && dev.wol_macs.length > 0;
        const showWakeBtn = allowPower && !online && (Boolean(dev.wol_ready) || hasWolMacs);
        const showOnlinePowerBtns = allowPower && online;
        const idFormatted = formatDeviceId(dev.device_id);
        const subtitle = !online
            ? `${idFormatted} · ${t("status_offline")}`
            : (controlled
                ? `${idFormatted} · ${t("status_controlled")}`
                : (dev.os_version ? `${idFormatted} · ${dev.os_version}` : idFormatted));

        const card = document.createElement("div");
        card.className = `device-wallpaper-card${online ? "" : " offline"}`;
        card.innerHTML = buildWaveBackdropSvg(isDark, online, controlled, `${idx}_${dev.device_id}`);

        if (showWakeBtn || showOnlinePowerBtns) {
            const powerBar = document.createElement("div");
            powerBar.className = "device-card-power-bar";
            if (showWakeBtn) {
                const btnWake = document.createElement("button");
                btnWake.type = "button";
                btnWake.className = "card-power-btn accent";
                btnWake.disabled = state.powerBusy;
                btnWake.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg><span>${t("power_wake")}</span>`;
                btnWake.onclick = (e) => {
                    e.stopPropagation();
                    executePowerAction(dev, "wake");
                };
                powerBar.appendChild(btnWake);
            }
            if (showOnlinePowerBtns) {
                const btnRestart = document.createElement("button");
                btnRestart.type = "button";
                btnRestart.className = "card-power-btn";
                btnRestart.disabled = state.powerBusy;
                btnRestart.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>${t("power_restart")}</span>`;
                btnRestart.onclick = (e) => {
                    e.stopPropagation();
                    confirmPowerAction(dev, "restart");
                };

                const btnShutdown = document.createElement("button");
                btnShutdown.type = "button";
                btnShutdown.className = "card-power-btn danger";
                btnShutdown.disabled = state.powerBusy;
                btnShutdown.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg><span>${t("power_shutdown")}</span>`;
                btnShutdown.onclick = (e) => {
                    e.stopPropagation();
                    confirmPowerAction(dev, "shutdown");
                };
                powerBar.appendChild(btnRestart);
                powerBar.appendChild(btnShutdown);
            }
            card.appendChild(powerBar);
        }

        const frosted = document.createElement("div");
        frosted.className = "device-card-frosted";

        const texts = document.createElement("div");
        texts.className = "device-card-texts";
        const nameEl = document.createElement("div");
        nameEl.className = "device-card-name";
        nameEl.textContent = dev.device_name || idFormatted;
        const subEl = document.createElement("div");
        subEl.className = "device-card-sub";
        subEl.textContent = subtitle;
        texts.appendChild(nameEl);
        texts.appendChild(subEl);

        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "device-card-more";
        moreBtn.title = t("title_more_actions");
        moreBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/></svg>';

        const showCardMenu = (anchor) => {
            const menuItems = [];
            if (desktop) {
                menuItems.push({
                    label: t("menu_control"),
                    disabled: !canControl,
                    onClick: () => startRemoteSession({
                        targetDeviceId: dev.device_id,
                        accessCode: "",
                        sameAccount: true,
                        viewOnly: false,
                        hostName: dev.device_name || idFormatted
                    })
                });
                menuItems.push({
                    label: t("menu_view_only"),
                    disabled: !canControl,
                    onClick: () => startRemoteSession({
                        targetDeviceId: dev.device_id,
                        accessCode: "",
                        sameAccount: true,
                        viewOnly: true,
                        hostName: dev.device_name || idFormatted
                    })
                });
            }
            if (showWakeBtn) {
                menuItems.push({ separator: true });
                menuItems.push({
                    label: t("menu_wake"),
                    disabled: state.powerBusy,
                    onClick: () => executePowerAction(dev, "wake")
                });
            }
            if (showOnlinePowerBtns) {
                menuItems.push({ separator: true });
                menuItems.push({
                    label: t("menu_restart"),
                    disabled: state.powerBusy,
                    onClick: () => confirmPowerAction(dev, "restart")
                });
                menuItems.push({
                    label: t("menu_shutdown"),
                    danger: true,
                    disabled: state.powerBusy,
                    onClick: () => confirmPowerAction(dev, "shutdown")
                });
            }
            if (menuItems.length > 0) menuItems.push({ separator: true });
            menuItems.push({
                label: t("menu_copy_id"),
                onClick: () => {
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(String(dev.device_id)).then(() => showToast(t("toast_copied_id"))).catch(() => {});
                    }
                }
            });
            openFlyout(anchor, menuItems);
        };

        moreBtn.onclick = (e) => {
            e.stopPropagation();
            showCardMenu(moreBtn);
        };

        card.onclick = () => {
            if (canControl) {
                startRemoteSession({
                    targetDeviceId: dev.device_id,
                    accessCode: "",
                    sameAccount: true,
                    viewOnly: false,
                    hostName: dev.device_name || idFormatted
                });
            } else {
                showCardMenu(moreBtn);
            }
        };

        frosted.appendChild(texts);
        frosted.appendChild(moreBtn);
        card.appendChild(frosted);
        container.appendChild(card);
    });
}

function renderRecentList() {
    const wrap = $("recent-list");
    wrap.textContent = "";
    if (state.recentIds.length === 0) {
        const empty = document.createElement("span");
        empty.className = "recent-empty";
        empty.textContent = t("recent_empty");
        wrap.appendChild(empty);
        return;
    }
    for (const id of state.recentIds) {
        const chip = document.createElement("div");
        chip.className = "recent-chip";
        const label = document.createElement("span");
        label.textContent = formatDeviceId(id);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "recent-chip-del";
        del.title = t("title_remove");
        del.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
        del.onclick = (e) => {
            e.stopPropagation();
            removeRecentId(id);
        };
        chip.onclick = () => {
            $("target-device-id").value = formatDeviceId(id);
            $("target-access-code").focus();
        };
        chip.appendChild(label);
        chip.appendChild(del);
        wrap.appendChild(chip);
    }
}

function confirmPowerAction(dev, action) {
    const label = action === "restart" ? t("power_restart") : t("power_shutdown");
    const name = dev.device_name || formatDeviceId(dev.device_id);
    openDialog({
        title: t("confirm_power_title", { action: label }),
        bodyNode: t("confirm_power_body", { name, action: label }),
        actions: [
            { label: t("btn_cancel"), className: "win-btn" },
            {
                label: t("btn_confirm_action", { action: label }),
                className: action === "shutdown" ? "win-btn danger-fill" : "win-btn accent",
                onClick: () => executePowerAction(dev, action)
            }
        ]
    });
}

async function executePowerAction(dev, action) {
    if (state.powerBusy) return;
    state.powerBusy = true;
    renderDevices();
    try {
        const res = await apiRequest("/web-api/devices/power", {
            method: "POST",
            csrf: true,
            body: { device_id: dev.device_id, action }
        });
        if (res.status === 401) {
            showAuthView();
            return;
        }
        if (!res.ok || !res.json?.ok) {
            showToast(mapApiError(res.json?.code));
            return;
        }
        if (action === "wake") {
            const d = res.json.data || {};
            if (d.already_online) showToast(t("toast_already_online"));
            else if (Number(d.relayed_count || 0) > 0) showToast(t("toast_wake_sent"));
            else showToast(t("toast_wake_no_helper"));
            return;
        }
        showToast(action === "restart" ? t("toast_restart_sent") : t("toast_shutdown_sent"));
    } finally {
        state.powerBusy = false;
        renderDevices();
    }
}

function startRemoteSession(opts) {
    if (!state.caps?.canConnect) {
        showToast(t("toast_browser_no_playback"));
        return;
    }
    if (state.user?.locked) {
        showToast(t("toast_locked_no_remote"));
        return;
    }
    if (!state.signaling || !state.signaling.registered) {
        showToast(t("toast_not_connected_service"));
        return;
    }
    if (state.cooldownUntilMs > Date.now()) {
        const sec = Math.max(1, Math.ceil((state.cooldownUntilMs - Date.now()) / 1000));
        showToast(t("cooldown_toast", { sec }));
        return;
    }
    if (state.session) {
        state.session.close(true, false);
        state.session = null;
    }
    if (!opts.sameAccount) {
        saveRecentId(opts.targetDeviceId);
    }

    state.lastClipboardFromHost = "";
    const canvas = $("remote-canvas");
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);

    $("tb-host-name").textContent = opts.hostName || formatDeviceId(opts.targetDeviceId);
    $("tb-viewonly-tag").classList.toggle("hidden", !opts.viewOnly);
    $("tb-stats").textContent = t("session_connecting_short");
    $("tb-display-select").classList.add("hidden");
    $("tb-display-select").textContent = "";
    syncWinSelect($("tb-display-select"));

    const showMobileKb = !opts.viewOnly && (Boolean(state.caps.hasTouch) || window.matchMedia("(max-width: 820px)").matches);
    const canFullscreen = typeof $("session-view").requestFullscreen === "function";
    $("tb-btn-mouse").classList.toggle("hidden", opts.viewOnly || !state.caps.hasPointerLock);
    $("tb-btn-mouse").classList.remove("active");
    $("tb-btn-kblock").classList.toggle("hidden", opts.viewOnly || !state.caps.hasKeyboardLock);
    $("tb-btn-kblock").classList.remove("active");
    $("tb-btn-audio").classList.toggle("hidden", !state.caps.canAudioDecode);
    $("tb-btn-audio").classList.toggle("active", Boolean(state.settings.audioEnabled));
    $("tb-btn-keyboard").classList.toggle("hidden", !showMobileKb);
    $("tb-btn-keyboard").classList.remove("active");
    $("tb-btn-clipboard").classList.toggle("hidden", opts.viewOnly || !state.settings.clipboardEnabled);
    $("tb-btn-actions").classList.toggle("hidden", opts.viewOnly);
    $("tb-btn-fullscreen").classList.toggle("hidden", !canFullscreen);
    hideMobileImeBar();

    $("session-loading").classList.remove("hidden");
    $("session-stage-text").textContent = t("session_connecting");
    $("session-toolbar-wrap").classList.remove("collapsed");
    $("session-view").classList.remove("hidden");

    const session = new OsmiumRemoteSession({
        signaling: state.signaling,
        canvas,
        caps: state.caps,
        settings: { ...state.settings },
        callbacks: {
            stage: (text) => {
                $("session-stage-text").textContent = text;
            },
            hostName: (name) => {
                $("tb-host-name").textContent = name;
            },
            established: () => {
                $("session-loading").classList.add("hidden");
                if (!opts.viewOnly && state.settings.relativeMouse && state.caps.hasPointerLock) {
                    session.setRelativeMouse(true);
                }
            },
            stats: (st) => {
                const dim = st.width > 0 && st.height > 0 ? `${st.width}×${st.height} · ` : "";
                $("tb-stats").textContent = `${dim}${st.fps}${t("stats_fps_unit")} · ${st.rttMs}ms`;
            },
            hostStatus: (hs) => {
                const sel = $("tb-display-select");
                const displays = Array.isArray(hs.displays) ? hs.displays : [];
                if (displays.length > 1) {
                    sel.textContent = "";
                    for (const d of displays) {
                        const opt = document.createElement("option");
                        opt.value = String(d.index);
                        opt.textContent = t("display_item", { n: Number(d.index) + 1 });
                        if (Number(d.index) === Number(hs.activeDisplayIndex)) opt.selected = true;
                        sel.appendChild(opt);
                    }
                    sel.classList.remove("hidden");
                } else {
                    sel.classList.add("hidden");
                }
                syncWinSelect(sel);
            },
            pointerLock: (locked) => {
                $("tb-btn-mouse").classList.toggle("active", locked);
            },
            clipboardText: (text) => {
                state.lastClipboardFromHost = text;
                if (state.caps.hasClipboard && document.hasFocus()) {
                    navigator.clipboard.writeText(text).catch(() => {});
                }
                showToast(t("toast_clipboard_received"));
            },
            captchaRequired: (challenge) => {
                exitSessionView();
                state.pendingCaptchaContext = opts;
                const u = new URL(challenge.captcha_url);
                u.searchParams.set("mode", "web");
                const pop = openPopupCentered(u.toString(), "osmium_remote_captcha", 460, 520);
                if (!pop) {
                    showToast(t("toast_captcha_popup_blocked"));
                    state.pendingCaptchaContext = null;
                } else {
                    showToast(t("toast_captcha_popup_open"));
                }
            },
            error: (msg) => {
                exitSessionView();
                showToast(msg, 4200);
            },
            ended: (msg) => {
                exitSessionView();
                showToast(msg);
            }
        }
    });

    state.session = session;
    session.start(opts);
}

const mobileMods = { ctrl: false, alt: false };

function releaseMobileMods() {
    if (mobileMods.ctrl) {
        mobileMods.ctrl = false;
        state.session?.sendVirtualKey(0x11, false, false);
    }
    if (mobileMods.alt) {
        mobileMods.alt = false;
        state.session?.sendVirtualKey(0x12, false, false);
    }
    document.querySelectorAll("[data-mmod]").forEach((btn) => btn.classList.remove("active"));
}

function updateMobileImeViewportOffset() {
    const bar = $("mobile-ime-bar");
    if (!bar || bar.classList.contains("hidden")) return;
    if (window.visualViewport) {
        const vv = window.visualViewport;
        const offset = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
        bar.style.bottom = `${offset}px`;
    } else {
        bar.style.bottom = "0px";
    }
}

function showMobileImeBar() {
    const bar = $("mobile-ime-bar");
    if (!bar) return;
    bar.classList.remove("hidden");
    $("tb-btn-keyboard").classList.add("active");
    updateMobileImeViewportOffset();
    const inp = $("mobile-ime-input");
    if (inp) {
        inp.value = "";
        inp.focus();
    }
}

function hideMobileImeBar() {
    releaseMobileMods();
    const bar = $("mobile-ime-bar");
    if (bar) {
        bar.classList.add("hidden");
        bar.style.bottom = "0px";
    }
    const btn = $("tb-btn-keyboard");
    if (btn) btn.classList.remove("active");
    const inp = $("mobile-ime-input");
    if (inp) {
        inp.value = "";
        inp.blur();
    }
}

function exitSessionView() {
    hideMobileImeBar();
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }
    $("session-view").classList.add("hidden");
    state.session = null;
}

function openClipboardDialog() {
    const area = document.createElement("textarea");
    area.className = "win-textarea";
    area.placeholder = t("ph_clipboard_text");
    area.value = state.lastClipboardFromHost || "";

    openDialog({
        title: t("title_clipboard"),
        bodyNode: area,
        actions: [
            { label: t("btn_cancel"), className: "win-btn" },
            {
                label: t("btn_type_text"),
                className: "win-btn",
                onClick: () => {
                    if (state.session && area.value) {
                        state.session.sendUnicodeText(area.value);
                        showToast(t("toast_text_sent"));
                    }
                }
            },
            {
                label: t("btn_sync_clipboard"),
                className: "win-btn accent",
                onClick: () => {
                    if (state.session && area.value) {
                        state.session.sendClipboardText(area.value);
                        showToast(t("toast_clipboard_synced"));
                    }
                }
            }
        ]
    });
}

function openSessionActionsDialog() {
    const list = document.createElement("div");
    list.className = "dialog-menu-list";
    const items = [
        { label: t("action_cad"), fn: () => state.session?.sendSystemAction(1) },
        { label: t("action_taskmgr"), fn: () => state.session?.sendSystemAction(2) },
        { label: t("action_refresh_frame"), fn: () => state.session?.requestKeyframe() },
        { label: t("action_quality"), fn: () => openQuickQualityDialog() }
    ];
    for (const item of items) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dialog-menu-btn";
        btn.textContent = item.label;
        btn.onclick = () => {
            closeDialog();
            item.fn();
        };
        list.appendChild(btn);
    }
    openDialog({
        title: t("title_more_actions"),
        bodyNode: list,
        actions: [{ label: t("btn_close"), className: "win-btn" }]
    });
}

function openQuickQualityDialog() {
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "12px";

    const makeSelect = (labelText, options, current) => {
        const row = document.createElement("div");
        row.className = "win-field";
        const span = document.createElement("span");
        span.className = "win-field-label";
        span.textContent = labelText;
        const sel = document.createElement("select");
        sel.className = "win-select full";
        for (const [val, txt] of options) {
            const o = document.createElement("option");
            o.value = val;
            o.textContent = txt;
            if (String(val) === String(current)) o.selected = true;
            sel.appendChild(o);
        }
        row.appendChild(span);
        row.appendChild(sel);
        enhanceWinSelect(sel);
        return { row, sel };
    };

    const resCtl = makeSelect(t("set_res_title"), [["native", t("opt_res_native")], ["1080p", "1080p"], ["720p", "720p"]], state.settings.resolution);
    const fpsOpts = state.caps?.allowHighFps
        ? [["30", t("opt_fps_30")], ["60", t("opt_fps_60")], ["120", t("opt_fps_120")]]
        : [["30", t("opt_fps_30")], ["60", t("opt_fps_60")]];
    const fpsCtl = makeSelect(t("set_fps_title"), fpsOpts, state.settings.fps);
    const brCtl = makeSelect(t("set_br_title"), [["4000", "4M"], ["8000", "8M"], ["16000", "16M"], ["25000", "25M"]], state.settings.bitrateKbps);

    wrap.appendChild(resCtl.row);
    wrap.appendChild(fpsCtl.row);
    wrap.appendChild(brCtl.row);

    openDialog({
        title: t("dialog_quality_title"),
        bodyNode: wrap,
        actions: [
            { label: t("btn_cancel"), className: "win-btn" },
            {
                label: t("btn_apply"),
                className: "win-btn accent",
                onClick: () => {
                    state.settings.resolution = resCtl.sel.value;
                    state.settings.fps = Number(fpsCtl.sel.value);
                    state.settings.bitrateKbps = Number(brCtl.sel.value);
                    saveSettings();
                    syncSettingsToControls();
                    state.session?.updateVideoParams({
                        resolution: state.settings.resolution,
                        fps: state.settings.fps,
                        bitrateKbps: state.settings.bitrateKbps
                    });
                    showToast(t("toast_quality_updated"));
                }
            }
        ]
    });
}

function positionNavIndicator() {
    const activeBtn = document.querySelector(`.win-nav-item[data-tab="${state.activeTab}"]`);
    const pane = document.querySelector(".win-nav-pane");
    const ind = $("nav-indicator");
    if (!activeBtn || !pane || !ind) return;
    const pRect = pane.getBoundingClientRect();
    const bRect = activeBtn.getBoundingClientRect();
    const y = (bRect.top - pRect.top) + (bRect.height - 16) / 2;
    ind.style.transform = `translateY(${Math.round(y)}px)`;
}

function positionSubTabIndicator() {
    const activeBtn = document.querySelector(`.win-subtab[data-subtab="${state.activeSubTab}"]`);
    const bar = document.querySelector(".win-subtabs");
    const ind = $("subtab-indicator");
    if (!activeBtn || !bar || !ind) return;
    const barRect = bar.getBoundingClientRect();
    const btnRect = activeBtn.getBoundingClientRect();
    ind.style.width = `${Math.round(btnRect.width)}px`;
    ind.style.transform = `translateX(${Math.round(btnRect.left - barRect.left)}px)`;
}

function switchTab(tab, nextIndex) {
    if (tab === state.activeTab) return;
    hideFlyout();
    closeComboPopup();
    const prevIndex = state.activeTabIndex;
    state.activeTab = tab;
    state.activeTabIndex = nextIndex;

    document.querySelectorAll(".win-nav-item").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    document.querySelectorAll(".win-page").forEach((sec) => {
        sec.classList.toggle("hidden", sec.id !== `tab-${tab}`);
    });

    const host = $("win-page-host");
    host.classList.remove("win-page-enter-down", "win-page-enter-up");
    void host.offsetWidth;
    host.classList.add(nextIndex >= prevIndex ? "win-page-enter-down" : "win-page-enter-up");

    positionNavIndicator();
    if (tab === "devices") refreshDevices();
    if (tab === "settings") requestAnimationFrame(positionSubTabIndicator);
}

function switchSubTab(subtab, nextIndex) {
    if (subtab === state.activeSubTab) return;
    const prevIndex = state.activeSubIndex;
    state.activeSubTab = subtab;
    state.activeSubIndex = nextIndex;

    document.querySelectorAll(".win-subtab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.subtab === subtab);
    });
    document.querySelectorAll(".win-subpanel").forEach((panel) => {
        const active = panel.id === `subpanel-${subtab}`;
        panel.classList.toggle("hidden", !active);
        panel.classList.remove("win-subpanel-left", "win-subpanel-right");
        if (active) {
            void panel.offsetWidth;
            panel.classList.add(nextIndex >= prevIndex ? "win-subpanel-left" : "win-subpanel-right");
        }
    });
    positionSubTabIndicator();
}

function bindGlobalUi() {
    $("btn-retry-providers").onclick = () => {
        loadAuthProviders();
        startWebQrLogin();
    };
    $("login-form").onsubmit = handleEmailLoginSubmit;
    $("twofa-form").onsubmit = handleTwoFaSubmit;
    $("loginkey-form").onsubmit = handleLoginKeySubmit;
    $("recovery-form").onsubmit = handleRecoverySubmit;
    $("btn-open-recovery").onclick = () => enterRecoveryFlow();
    $("btn-recovery-back").onclick = () => {
        if (state.recoveryStep > 0) {
            setRecoveryStep(state.recoveryStep - 1);
        } else {
            exitRecoveryFlow();
        }
    };
    $("recovery-channel").onchange = () => syncRecoveryChannelUi(true);
    $("btn-recovery-resend").onclick = () => sendRecoveryOtp(false);
    $("recovery-otp").addEventListener("input", (e) => {
        e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    });
    $("btn-twofa-back").onclick = () => exitTwoFaStep();
    $("tab-auth-password").onclick = () => setAuthMode("password");
    $("tab-auth-key").onclick = () => setAuthMode("key");
    $("btn-qr-refresh").onclick = () => startWebQrLogin();
    $("btn-qr-overlay-refresh").onclick = () => startWebQrLogin();
    $("btn-auth-lang").onclick = () => {
        state.settings.language = getLocale() === "en-US" ? "zh-CN" : "en-US";
        saveSettings();
        applyLanguage(state.settings.language);
    };

    $("btn-toggle-login-pw").onclick = () => {
        const inp = $("login-password");
        inp.type = inp.type === "password" ? "text" : "password";
    };
    $("btn-toggle-login-key").onclick = () => {
        const inp = $("login-key-input");
        inp.type = inp.type === "password" ? "text" : "password";
    };
    $("login-2fa-code").addEventListener("input", (e) => {
        e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    });
    $("btn-toggle-code").onclick = () => {
        const inp = $("target-access-code");
        inp.type = inp.type === "password" ? "text" : "password";
    };

    $("target-device-id").addEventListener("input", (e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(0, 12);
        e.target.value = digits.length === 9 ? formatDeviceId(digits) : digits;
    });

    $("remote-connect-form").onsubmit = (e) => {
        e.preventDefault();
        const targetId = $("target-device-id").value.replace(/\D/g, "");
        const accessCode = $("target-access-code").value.trim();
        const viewOnly = $("connect-view-only").checked;
        if (targetId.length < 6) {
            showToast(t("err_invalid_device_id"));
            return;
        }
        if (!accessCode) {
            showToast(t("err_enter_access_code"));
            return;
        }
        startRemoteSession({
            targetDeviceId: targetId,
            accessCode,
            sameAccount: false,
            viewOnly,
            hostName: formatDeviceId(targetId)
        });
    };

    $("btn-clear-recent").onclick = () => {
        state.recentIds = [];
        try { localStorage.removeItem(RECENT_KEY); } catch {}
        renderRecentList();
    };

    $("device-search").addEventListener("input", () => renderDevices());
    $("device-filter").onchange = () => renderDevices();
    $("btn-refresh-devices").onclick = () => refreshDevices();
    $("btn-toggle-layout").onclick = () => {
        state.settings.deviceGrid = !state.settings.deviceGrid;
        saveSettings();
        renderDevices();
    };

    document.querySelectorAll(".win-nav-item").forEach((btn) => {
        btn.onclick = () => switchTab(btn.dataset.tab, Number(btn.dataset.index || 0));
    });
    document.querySelectorAll(".win-subtab").forEach((btn) => {
        btn.onclick = () => switchSubTab(btn.dataset.subtab, Number(btn.dataset.subindex || 0));
    });

    $("set-resolution").onchange = (e) => {
        state.settings.resolution = e.target.value;
        saveSettings();
    };
    $("set-fps").onchange = (e) => {
        state.settings.fps = Number(e.target.value);
        saveSettings();
    };
    $("set-bitrate").onchange = (e) => {
        state.settings.bitrateKbps = Number(e.target.value);
        saveSettings();
    };
    $("set-codec").onchange = (e) => {
        state.settings.codec = Number(e.target.value);
        saveSettings();
    };
    $("set-audio").onchange = (e) => {
        state.settings.audioEnabled = e.target.checked;
        saveSettings();
    };
    $("set-relative-mouse").onchange = (e) => {
        state.settings.relativeMouse = e.target.checked;
        saveSettings();
    };
    $("set-keyboard-lock").onchange = (e) => {
        state.settings.keyboardLock = e.target.checked;
        saveSettings();
    };
    $("set-gamepad").onchange = (e) => {
        state.settings.gamepadEnabled = e.target.checked;
        saveSettings();
    };
    $("set-clipboard").onchange = (e) => {
        state.settings.clipboardEnabled = e.target.checked;
        saveSettings();
    };
    $("set-theme").onchange = (e) => {
        state.settings.theme = e.target.value === "dark" ? "dark" : "light";
        saveSettings();
        applyTheme(state.settings.theme);
    };
    $("set-language").onchange = (e) => {
        const v = e.target.value;
        state.settings.language = (v === "zh-CN" || v === "en-US") ? v : "auto";
        saveSettings();
        applyLanguage(state.settings.language);
    };

    $("btn-logout").onclick = () => {
        openDialog({
            title: t("btn_logout"),
            bodyNode: t("logout_confirm_body"),
            actions: [
                { label: t("btn_cancel"), className: "win-btn" },
                {
                    label: t("btn_logout"),
                    className: "win-btn danger-fill",
                    onClick: async () => {
                        await apiRequest("/web-api/auth/logout", { method: "POST", csrf: true, body: {} });
                        showAuthView();
                        showToast(t("toast_logged_out"));
                    }
                }
            ]
        });
    };

    $("btn-toolbar-toggle").onclick = () => {
        $("session-toolbar-wrap").classList.toggle("collapsed");
    };
    $("btn-cancel-connecting").onclick = () => {
        state.session?.close(true, true);
        exitSessionView();
    };
    $("tb-btn-disconnect").onclick = () => {
        state.session?.close(true, false);
        exitSessionView();
    };
    $("tb-display-select").onchange = (e) => {
        state.session?.switchDisplay(Number(e.target.value));
    };
    $("tb-btn-mouse").onclick = () => {
        if (!state.session) return;
        const next = !state.session.mouseRelative;
        state.session.setRelativeMouse(next);
        $("tb-btn-mouse").classList.toggle("active", next);
    };
    $("tb-btn-kblock").onclick = async () => {
        if (!state.session) return;
        const next = !state.session.keyboardLocked;
        const ok = await state.session.setKeyboardLock(next);
        $("tb-btn-kblock").classList.toggle("active", ok);
        if (next && !ok) showToast(t("toast_fullscreen_for_kblock"));
    };
    $("tb-btn-audio").onclick = () => {
        if (!state.session) return;
        const nextMuted = !state.session.audioMuted;
        state.session.setAudioMuted(nextMuted);
        $("tb-btn-audio").classList.toggle("active", !nextMuted);
    };
    $("tb-btn-keyboard").onclick = () => {
        if (!state.session) return;
        const bar = $("mobile-ime-bar");
        if (bar.classList.contains("hidden")) showMobileImeBar();
        else hideMobileImeBar();
    };
    $("btn-mobile-ime-hide").onclick = () => hideMobileImeBar();
    $("mobile-ime-form").onsubmit = (e) => {
        e.preventDefault();
        if (!state.session) return;
        const inp = $("mobile-ime-input");
        const val = inp.value;
        if (val) {
            state.session.sendUnicodeText(val);
            inp.value = "";
        } else {
            state.session.sendKeyTap(0x0D, false);
        }
        releaseMobileMods();
        inp.focus();
    };
    $("mobile-ime-input").addEventListener("keydown", (e) => {
        if (!state.session) return;
        if (e.key === "Backspace" && $("mobile-ime-input").value === "") {
            e.preventDefault();
            state.session.sendKeyTap(0x08, false);
            releaseMobileMods();
        }
    });
    document.querySelectorAll("[data-mmod]").forEach((btn) => {
        btn.onclick = () => {
            if (!state.session) return;
            const mod = btn.dataset.mmod;
            const vk = mod === "ctrl" ? 0x11 : 0x12;
            const next = !mobileMods[mod];
            mobileMods[mod] = next;
            btn.classList.toggle("active", next);
            state.session.sendVirtualKey(vk, next, false);
        };
    });
    const mkeyMap = {
        esc: [0x1B, false],
        tab: [0x09, false],
        win: [0x5B, true],
        bksp: [0x08, false],
        enter: [0x0D, false]
    };
    document.querySelectorAll("[data-mkey]").forEach((btn) => {
        btn.onclick = () => {
            if (!state.session) return;
            const spec = mkeyMap[btn.dataset.mkey];
            if (!spec) return;
            state.session.sendKeyTap(spec[0], spec[1]);
            releaseMobileMods();
        };
    });
    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", updateMobileImeViewportOffset);
        window.visualViewport.addEventListener("scroll", updateMobileImeViewportOffset);
    }
    $("tb-btn-clipboard").onclick = () => openClipboardDialog();
    $("tb-btn-actions").onclick = () => openSessionActionsDialog();
    $("tb-btn-fullscreen").onclick = async () => {
        const el = $("session-view");
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else {
                await el.requestFullscreen();
                if (state.session && state.settings.keyboardLock && state.caps?.hasKeyboardLock) {
                    const ok = await state.session.setKeyboardLock(true);
                    $("tb-btn-kblock").classList.toggle("active", ok);
                }
            }
        } catch {}
    };

    $("modal-backdrop").addEventListener("click", (e) => {
        if (e.target === $("modal-backdrop")) closeDialog();
    });

    document.addEventListener("click", () => {
        hideFlyout();
        closeComboPopup();
    });
    document.addEventListener("keydown", (e) => {
        if (!activeComboSelect) return;
        const popup = $("win-combo-popup");
        const items = popup ? Array.from(popup.querySelectorAll(".win-combo-item")) : [];
        if (e.key === "Escape") {
            e.preventDefault();
            const trig = activeComboSelect._winTrigger;
            closeComboPopup();
            if (trig) trig.focus();
            return;
        }
        if (items.length === 0) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            activeComboFocusIdx = (activeComboFocusIdx + 1) % items.length;
            updateComboFocusHighlight();
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            activeComboFocusIdx = (activeComboFocusIdx - 1 + items.length) % items.length;
            updateComboFocusHighlight();
        } else if (e.key === "Home") {
            e.preventDefault();
            activeComboFocusIdx = 0;
            updateComboFocusHighlight();
        } else if (e.key === "End") {
            e.preventDefault();
            activeComboFocusIdx = items.length - 1;
            updateComboFocusHighlight();
        } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (items[activeComboFocusIdx]) items[activeComboFocusIdx].click();
        }
    });
    document.addEventListener("fullscreenchange", () => closeComboPopup());
    const contentFrame = document.querySelector(".win-content-frame");
    if (contentFrame) {
        contentFrame.addEventListener("scroll", () => {
            hideFlyout();
            closeComboPopup();
        }, { passive: true });
    }
    window.addEventListener("resize", () => {
        positionNavIndicator();
        positionSubTabIndicator();
        hideFlyout();
        closeComboPopup();
    });

    window.addEventListener("message", async (e) => {
        if (!e.data || typeof e.data !== "object") return;
        if (e.data.type === "osmium-oauth-done") {
            if (e.origin !== window.location.origin && e.origin !== "https://osmium.fufu.skin") return;
            await pollOAuthStatusOnce();
            return;
        }
        const allowedCaptchaOrigins = new Set(["https://osmium.fufu.skin"]);
        try {
            const su = new URL(state.signalingUrl);
            allowedCaptchaOrigins.add(`${su.protocol === "ws:" ? "http:" : "https:"}//${su.host}`);
        } catch {}
        if (!allowedCaptchaOrigins.has(e.origin)) return;
        if (e.data.type === "osmium-captcha-done") {
            if (state.pendingCaptchaContext) {
                const retryOpts = state.pendingCaptchaContext;
                state.pendingCaptchaContext = null;
                if (e.data.ok) {
                    showToast(t("toast_captcha_passed"));
                    startRemoteSession(retryOpts);
                } else {
                    showToast(t("toast_captcha_failed"));
                }
                return;
            }
            if (!state.authChallengeKind) return;
            if (e.data.challengeId && state.authChallengeId && String(e.data.challengeId) !== state.authChallengeId) {
                return;
            }
            await pollAuthChallengeOnce(true);
        }
    });
}

async function bootstrap() {
    enhanceAllStaticSelects();
    applyLanguage(state.settings.language);
    applyTheme(state.settings.theme);
    bindGlobalUi();
    state.caps = await detectBrowserCapabilities();
    try {
        const res = await apiRequest("/web-api/session");
        if (res.ok && res.json?.ok && res.json?.data?.user) {
            enterAuthenticatedApp(res.json.data);
            return;
        }
    } catch {}
    showAuthView();
}

bootstrap();
