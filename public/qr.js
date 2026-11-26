// Self-contained ISO/IEC 18004 QR Code encoder (Byte mode, Error Correction Level M, Versions 1-20)
// Ported from Osmium.Core.Helpers.QrCodeEncoder for CSP-strict browser canvas rendering.

const EC_CODEWORDS_M = [
    0,
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
    30, 22, 22, 24, 24, 28, 28, 26, 26, 26
];

const NUM_BLOCKS_M = [
    0,
    1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
    5, 8, 9, 9, 10, 10, 11, 13, 14, 16
];

function getNumRawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const numAlign = Math.floor(version / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (version >= 7) result -= 36;
    }
    return result;
}

function getNumDataCodewords(version) {
    return Math.floor(getNumRawDataModules(version) / 8) - EC_CODEWORDS_M[version] * NUM_BLOCKS_M[version];
}

function selectVersion(byteCount) {
    for (let v = 1; v <= 20; v++) {
        const dataCapBits = getNumDataCodewords(v) * 8;
        const ccBits = v <= 9 ? 8 : 16;
        if (4 + ccBits + byteCount * 8 <= dataCapBits) return v;
    }
    throw new Error("QR payload too large");
}

function appendBits(bits, val, length) {
    for (let i = length - 1; i >= 0; i--) {
        bits.push(((val >>> i) & 1) !== 0);
    }
}

function buildDataCodewords(dataBytes, version) {
    const dataCapCodewords = getNumDataCodewords(version);
    const dataCapBits = dataCapCodewords * 8;
    const bits = [];
    appendBits(bits, 0b0100, 4);
    appendBits(bits, dataBytes.length, version <= 9 ? 8 : 16);
    for (let i = 0; i < dataBytes.length; i++) {
        appendBits(bits, dataBytes[i], 8);
    }
    appendBits(bits, 0, Math.min(4, dataCapBits - bits.length));
    appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
    let padIdx = 0;
    while (bits.length < dataCapBits) {
        appendBits(bits, (padIdx++ & 1) === 0 ? 0xEC : 0x11, 8);
    }
    const result = new Uint8Array(dataCapCodewords);
    for (let i = 0; i < bits.length; i++) {
        if (bits[i]) result[i >>> 3] |= 1 << (7 - (i & 7));
    }
    return result;
}

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 255;
}

function computeRsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function computeRsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (let k = 0; k < data.length; k++) {
        const factor = data[k] ^ result[0];
        result.copyWithin(0, 1);
        result[result.length - 1] = 0;
        for (let i = 0; i < result.length; i++) {
            result[i] ^= gfMultiply(divisor[i], factor);
        }
    }
    return result;
}

function addEccAndInterleave(data, version) {
    const numBlocks = NUM_BLOCKS_M[version];
    const ecLen = EC_CODEWORDS_M[version];
    const totalCodewords = Math.floor(getNumRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
    const shortBlockLen = Math.floor(totalCodewords / numBlocks);
    const rsDivisor = computeRsDivisor(ecLen);
    const blocks = [];
    const eccs = [];
    let offset = 0;
    for (let i = 0; i < numBlocks; i++) {
        const dataLen = shortBlockLen - ecLen + (i < numShortBlocks ? 0 : 1);
        const blockData = data.subarray(offset, offset + dataLen);
        offset += dataLen;
        blocks.push(blockData);
        eccs.push(computeRsRemainder(blockData, rsDivisor));
    }
    const out = new Uint8Array(totalCodewords);
    let pos = 0;
    const maxDataLen = shortBlockLen - ecLen + (numShortBlocks < numBlocks ? 1 : 0);
    for (let i = 0; i < maxDataLen; i++) {
        for (let b = 0; b < numBlocks; b++) {
            if (i < blocks[b].length) out[pos++] = blocks[b][i];
        }
    }
    for (let i = 0; i < ecLen; i++) {
        for (let b = 0; b < numBlocks; b++) {
            out[pos++] = eccs[b][i];
        }
    }
    return out;
}

function getAlignPositions(version) {
    if (version === 1) return [];
    const numAlign = Math.floor(version / 7) + 2;
    const step = Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
    const res = new Array(numAlign);
    res[0] = 6;
    for (let i = numAlign - 1, p = version * 4 + 10; i >= 1; i--, p -= step) {
        res[i] = p;
    }
    return res;
}

function setFn(mods, isFn, size, x, y, dark) {
    mods[y * size + x] = dark ? 1 : 0;
    isFn[y * size + x] = 1;
}

function drawFinder(mods, isFn, size, cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || x >= size || y < 0 || y >= size) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            setFn(mods, isFn, size, x, y, d !== 2 && d !== 4);
        }
    }
}

function drawAlign(mods, isFn, size, cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            setFn(mods, isFn, size, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }
}

function drawFunctionPatterns(mods, isFn, size, version) {
    for (let i = 0; i < size; i++) {
        setFn(mods, isFn, size, 6, i, (i & 1) === 0);
        setFn(mods, isFn, size, i, 6, (i & 1) === 0);
    }
    drawFinder(mods, isFn, size, 3, 3);
    drawFinder(mods, isFn, size, size - 4, 3);
    drawFinder(mods, isFn, size, 3, size - 4);
    const alignPos = getAlignPositions(version);
    const n = alignPos.length;
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
            drawAlign(mods, isFn, size, alignPos[i], alignPos[j]);
        }
    }
    for (let i = 0; i <= 5; i++) setFn(mods, isFn, size, 8, i, false);
    setFn(mods, isFn, size, 8, 7, false);
    setFn(mods, isFn, size, 8, 8, false);
    setFn(mods, isFn, size, 7, 8, false);
    for (let i = 0; i <= 5; i++) setFn(mods, isFn, size, 5 - i, 8, false);
    for (let i = 0; i < 8; i++) setFn(mods, isFn, size, size - 1 - i, 8, false);
    for (let i = 0; i < 7; i++) setFn(mods, isFn, size, 8, size - 7 + i, false);
    setFn(mods, isFn, size, 8, size - 8, true);
    if (version >= 7) {
        for (let i = 0; i < 18; i++) {
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            setFn(mods, isFn, size, a, b, false);
            setFn(mods, isFn, size, b, a, false);
        }
    }
}

function drawFormatBits(mods, size, mask) {
    const data = mask; // EcFormatBitsM === 0
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) mods[i * size + 8] = (bits >>> i) & 1;
    mods[7 * size + 8] = (bits >>> 6) & 1;
    mods[8 * size + 8] = (bits >>> 7) & 1;
    mods[8 * size + 7] = (bits >>> 8) & 1;
    for (let i = 9; i < 15; i++) mods[8 * size + (14 - i)] = (bits >>> i) & 1;
    for (let i = 0; i < 8; i++) mods[8 * size + (size - 1 - i)] = (bits >>> i) & 1;
    for (let i = 8; i < 15; i++) mods[(size - 15 + i) * size + 8] = (bits >>> i) & 1;
    mods[(size - 8) * size + 8] = 1;
}

function drawVersionBits(mods, size, version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
        const bit = (bits >>> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        mods[b * size + a] = bit;
        mods[a * size + b] = bit;
    }
}

function drawCodewords(mods, isFn, size, codewords) {
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        const upward = ((right + 1) & 2) === 0;
        for (let vert = 0; vert < size; vert++) {
            const y = upward ? size - 1 - vert : vert;
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                if (isFn[y * size + x]) continue;
                let dark = 0;
                if (bitIdx < totalBits) {
                    dark = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
                    bitIdx++;
                }
                mods[y * size + x] = dark;
            }
        }
    }
}

function applyMask(mods, isFn, size, mask) {
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = y * size + x;
            if (isFn[idx]) continue;
            let inv = false;
            if (mask === 0) inv = ((x + y) & 1) === 0;
            else if (mask === 1) inv = (y & 1) === 0;
            else if (mask === 2) inv = x % 3 === 0;
            else if (mask === 3) inv = (x + y) % 3 === 0;
            else if (mask === 4) inv = ((Math.floor(y / 2) + Math.floor(x / 3)) & 1) === 0;
            else if (mask === 5) inv = (x * y) % 2 + (x * y) % 3 === 0;
            else if (mask === 6) inv = (((x * y) % 2 + (x * y) % 3) & 1) === 0;
            else if (mask === 7) inv = (((x + y) % 2 + (x * y) % 3) & 1) === 0;
            if (inv) mods[idx] ^= 1;
        }
    }
}

function addHistory(len, h) {
    for (let i = 6; i >= 1; i--) h[i] = h[i - 1];
    h[0] = len;
}

function finderMatch(h) {
    const n = h[1];
    if (n <= 0) return false;
    return h[2] === n && h[3] === 3 * n && h[4] === n && h[5] === n && (h[0] >= 4 * n || h[6] >= 4 * n);
}

function computePenalty(mods, size) {
    let penalty = 0;
    for (let y = 0; y < size; y++) {
        let color = 0;
        let run = 0;
        const h = [0, 0, 0, 0, 0, 0, 0];
        for (let x = 0; x < size; x++) {
            const v = mods[y * size + x];
            if (v === color) {
                run++;
                if (run === 5) penalty += 3;
                else if (run > 5) penalty++;
            } else {
                addHistory(run, h);
                if (!color && finderMatch(h)) penalty += 40;
                color = v;
                run = 1;
            }
        }
        addHistory(run, h);
        if (!color && finderMatch(h)) penalty += 40;
    }
    for (let x = 0; x < size; x++) {
        let color = 0;
        let run = 0;
        const h = [0, 0, 0, 0, 0, 0, 0];
        for (let y = 0; y < size; y++) {
            const v = mods[y * size + x];
            if (v === color) {
                run++;
                if (run === 5) penalty += 3;
                else if (run > 5) penalty++;
            } else {
                addHistory(run, h);
                if (!color && finderMatch(h)) penalty += 40;
                color = v;
                run = 1;
            }
        }
        addHistory(run, h);
        if (!color && finderMatch(h)) penalty += 40;
    }
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const c = mods[y * size + x];
            if (c === mods[y * size + x + 1] && c === mods[(y + 1) * size + x] && c === mods[(y + 1) * size + x + 1]) {
                penalty += 3;
            }
        }
    }
    let dark = 0;
    for (let i = 0; i < mods.length; i++) dark += mods[i];
    const total = size * size;
    const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
    if (k > 0) penalty += k * 10;
    return penalty;
}

export function encodeQrMatrix(text) {
    const dataBytes = new TextEncoder().encode(String(text || ""));
    const version = selectVersion(dataBytes.length);
    const size = version * 4 + 17;
    const codewords = addEccAndInterleave(buildDataCodewords(dataBytes, version), version);
    const isFn = new Uint8Array(size * size);
    const base = new Uint8Array(size * size);
    drawFunctionPatterns(base, isFn, size, version);
    drawCodewords(base, isFn, size, codewords);

    let bestPenalty = Infinity;
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const cand = base.slice();
        applyMask(cand, isFn, size, mask);
        drawFormatBits(cand, size, mask);
        if (version >= 7) drawVersionBits(cand, size, version);
        const p = computePenalty(cand, size);
        if (p < bestPenalty) {
            bestPenalty = p;
            best = cand;
        }
    }
    return { size, modules: best };
}

export function renderQrToCanvas(canvas, text, targetPixels = 360) {
    if (!canvas) return;
    const { size, modules } = encodeQrMatrix(text);
    const quiet = 3;
    const total = size + quiet * 2;
    const scale = Math.max(2, Math.floor(targetPixels / total));
    const px = total * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#111111";
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (modules[y * size + x]) {
                ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
            }
        }
    }
}
