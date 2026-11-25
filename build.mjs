import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { minify as terserMinify } from "terser";
import { minify as minifyHtml } from "html-minifier-terser";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB_DIR = path.join(ROOT, "public");
const DIST_DIR = path.join(ROOT, "dist");

function shortHash(content) {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 10);
}

async function build() {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });

    const appBundled = await esbuild.build({
        entryPoints: [path.join(PUB_DIR, "app.js")],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        treeShaking: true,
        legalComments: "none",
        charset: "utf8"
    });

    const workletBundled = await esbuild.build({
        entryPoints: [path.join(PUB_DIR, "audio-worklet.js")],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: ["es2022"],
        treeShaking: true,
        legalComments: "none",
        charset: "utf8"
    });

    const appCode = appBundled.outputFiles[0].text;
    const workletCode = workletBundled.outputFiles[0].text;

    const combined = `(function(){"use strict";if(typeof registerProcessor==="function"&&typeof AudioWorkletProcessor==="function"){${workletCode}}else{${appCode}}})();`;

    const terserResult = await terserMinify(combined, {
        ecma: 2022,
        toplevel: true,
        compress: {
            ecma: 2022,
            passes: 3,
            toplevel: true,
            dead_code: true,
            unused: true,
            drop_console: true,
            drop_debugger: true,
            collapse_vars: true,
            reduce_vars: true,
            join_vars: true,
            sequences: true,
            conditionals: true,
            evaluate: true,
            booleans: true,
            loops: true,
            if_return: true,
            hoist_funs: true
        },
        mangle: {
            toplevel: true,
            properties: {
                regex: /^_/
            }
        },
        format: {
            comments: false,
            ascii_only: false
        }
    });

    if (!terserResult || typeof terserResult.code !== "string" || !terserResult.code) {
        throw new Error("JS compilation produced empty output");
    }

    const finalJs = terserResult.code;
    const jsHash = shortHash(finalJs);
    const jsFileName = `app.${jsHash}.js`;
    fs.writeFileSync(path.join(DIST_DIR, jsFileName), finalJs, "utf8");

    const rawCss = fs.readFileSync(path.join(PUB_DIR, "styles.css"), "utf8");
    const minCss = await esbuild.transform(rawCss, {
        loader: "css",
        minify: true,
        legalComments: "none",
        charset: "utf8"
    });
    const cssHash = shortHash(minCss.code);
    const cssFileName = `app.${cssHash}.css`;
    fs.writeFileSync(path.join(DIST_DIR, cssFileName), minCss.code, "utf8");

    let rawHtml = fs.readFileSync(path.join(PUB_DIR, "index.html"), "utf8");
    rawHtml = rawHtml.replace(
        /<link\s+rel="stylesheet"\s+href="\/styles\.css(?:\?[^"]*)?"\s*>/i,
        `<link rel="stylesheet" href="/${cssFileName}">`
    );
    rawHtml = rawHtml.replace(
        /<script\s+type="module"\s+src="\/app\.js(?:\?[^"]*)?"\s*><\/script>/i,
        `<script defer src="/${jsFileName}"></script>`
    );

    const finalHtml = await minifyHtml(rawHtml, {
        collapseWhitespace: true,
        conservativeCollapse: false,
        collapseBooleanAttributes: true,
        removeComments: true,
        removeEmptyAttributes: true,
        removeRedundantAttributes: true,
        removeScriptTypeAttributes: true,
        removeStyleLinkTypeAttributes: true,
        useShortDoctype: true,
        caseSensitive: true,
        keepClosingSlash: false,
        minifyCSS: true,
        minifyJS: true
    });
    fs.writeFileSync(path.join(DIST_DIR, "index.html"), finalHtml, "utf8");

    fs.copyFileSync(path.join(PUB_DIR, "logo.png"), path.join(DIST_DIR, "logo.png"));

    const outFiles = fs.readdirSync(DIST_DIR);
    for (const f of outFiles) {
        const st = fs.statSync(path.join(DIST_DIR, f));
        console.log(`${f} (${(st.size / 1024).toFixed(2)} KiB)`);
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
