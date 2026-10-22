import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const distDir = path.resolve(webRoot, "dist");
const ssrDir = path.resolve(webRoot, "dist-ssr");
const templatePath = path.resolve(distDir, "index.html");

if (!fs.existsSync(templatePath)) {
  console.error("[prerender] dist/index.html does not exist. Run vite build first.");
  process.exit(1);
}

console.log("[prerender] Compiling SSR bundle with Vite...");
execSync("npx vite build --ssr src/prerender.tsx --outDir dist-ssr", {
  cwd: webRoot,
  stdio: "inherit",
});

const ssrEntryPath = path.resolve(ssrDir, "prerender.js");
if (!fs.existsSync(ssrEntryPath)) {
  console.error("[prerender] dist-ssr/prerender.js was not generated.");
  process.exit(1);
}

console.log("[prerender] Loading SSR entry and generating static HTML markup...");
const { renderLanding, renderPrivacy, renderTerms } = await import(
  `file://${ssrEntryPath}`
);

const template = fs.readFileSync(templatePath, "utf-8");

// Helper to inject rendered HTML into template
function injectHtml(tpl, bodyHtml) {
  if (tpl.includes('<div id="root"></div>')) {
    return tpl.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`);
  }
  // If already contains markup, replace its inner content
  return tpl.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${bodyHtml}</div>`);
}

// 1. Prerender Landing Page (/)
console.log("[prerender] Rendering Home Landing Page (/)...");
const landingBody = renderLanding();
const landingFullHtml = injectHtml(template, landingBody);
fs.writeFileSync(templatePath, landingFullHtml, "utf-8");
console.log(
  `[prerender]  ✓ dist/index.html updated with ${landingBody.length.toLocaleString()} characters of SSR markup.`
);

// 2. Prerender Privacy Policy (/privacy)
console.log("[prerender] Rendering Privacy Policy (/privacy)...");
const privacyDir = path.resolve(distDir, "privacy");
fs.mkdirSync(privacyDir, { recursive: true });
const privacyBody = renderPrivacy();
let privacyHtml = injectHtml(template, privacyBody);
privacyHtml = privacyHtml
  .replace(
    /<title>.*?<\/title>/,
    "<title>Privacy Policy - Scout by MNB Research</title>"
  )
  .replace(
    /<link rel="canonical" href=".*?" \/>/,
    '<link rel="canonical" href="https://scout.mnbresearch.com/privacy" />'
  )
  .replace(
    /<meta name="description" content=".*?" \/>/,
    '<meta name="description" content="Scout Privacy Policy: what data Scout processes, sub-processors, retention and your rights (India DPDP Act 2023, GDPR)." />'
  );
fs.writeFileSync(path.resolve(privacyDir, "index.html"), privacyHtml, "utf-8");
console.log(
  `[prerender]  ✓ dist/privacy/index.html created (${privacyBody.length.toLocaleString()} chars).`
);

// 3. Prerender Terms of Service (/terms)
console.log("[prerender] Rendering Terms of Service (/terms)...");
const termsDir = path.resolve(distDir, "terms");
fs.mkdirSync(termsDir, { recursive: true });
const termsBody = renderTerms();
let termsHtml = injectHtml(template, termsBody);
termsHtml = termsHtml
  .replace(
    /<title>.*?<\/title>/,
    "<title>Terms of Service - Scout by MNB Research</title>"
  )
  .replace(
    /<link rel="canonical" href=".*?" \/>/,
    '<link rel="canonical" href="https://scout.mnbresearch.com/terms" />'
  )
  .replace(
    /<meta name="description" content=".*?" \/>/,
    '<meta name="description" content="Scout Terms of Service: acceptable use, plans and credits, liability, governing law (India)." />'
  );
fs.writeFileSync(path.resolve(termsDir, "index.html"), termsHtml, "utf-8");
console.log(
  `[prerender]  ✓ dist/terms/index.html created (${termsBody.length.toLocaleString()} chars).`
);

// Cleanup temporary dist-ssr directory
fs.rmSync(ssrDir, { recursive: true, force: true });
console.log("[prerender]  ✓ Cleaned up temporary dist-ssr directory.");
console.log("[prerender] Complete! All public pages are pre-rendered into static HTML without empty body.");
