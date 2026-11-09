#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

// Secret signatures that should never appear in committed or staged code
const SECRET_PATTERNS = [
  { name: "Live Stripe Secret Key", regex: /(?:sk_live_|rk_live_)[0-9a-zA-Z]{24,}/ },
  { name: "Stripe Webhook Secret", regex: /whsec_[0-9a-zA-Z]{24,}/ },
  { name: "OpenAI Live API Key", regex: /sk-(?:proj-)?[a-zA-Z0-9T3BlbkFJ]{24,}/ },
  { name: "Anthropic Live API Key", regex: /sk-ant-api03-[a-zA-Z0-9_-]{32,}/ },
  { name: "Google API Key", regex: /AIza[0-9A-Za-z-_]{35}/ },
  { name: "AWS Access Key ID", regex: /AKIA[0-9A-Z]{16}/ },
  { name: "Private RSA/EC/SSH Key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    name: "Production Postgres Password URI",
    regex: /postgres(?:ql)?:\/\/(?!postgres:postgres|prospex:prospex|getleads:getleads|user:pass|postgres:\$\{|prospex:\$\{)[^:\s]+:[^@\s]+@[^:\s\/]+(?::\d+)?\/[^\s\?"'\\]+/
  },
  { name: "Resend Live API Key", regex: /re_(?!PLATFORMKEY|TESTKEY)[a-zA-Z0-9_]{24,}/ },
  { name: "GitHub Personal Access Token", regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: "Slack Token", regex: /xox[baprs]-[0-9a-zA-Z]{10,48}/ }
];

const IGNORE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".pdf",
  ".zip",
  ".tar",
  ".gz"
]);

function shouldIgnorePath(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (IGNORE_EXTENSIONS.has(ext)) return true;

  // Ignore documentation examples, sample env files, and test mocks
  if (relPath.endsWith(".env.example") || relPath.endsWith(".md") || relPath.endsWith(".mdx")) {
    return true;
  }

  // Allow explicit mock secret tests in security test suites
  if (relPath.includes(".test.") || relPath.includes(".spec.") || relPath.includes("/test/")) {
    return true;
  }

  return false;
}

function maskSecret(val) {
  if (!val) return "";
  return val.slice(0, 4) + "...";
}

let violations = 0;

function scanFile(relPath) {
  if (shouldIgnorePath(relPath)) return;

  const fullPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) return;

  // Verify no non-example .env file is tracked
  const baseName = path.basename(relPath);
  if (baseName.startsWith(".env") && !baseName.endsWith(".example")) {
    console.error(`\x1b[31m[SECURITY VIOLATION]\x1b[0m Committed or staged environment file detected: ${relPath}`);
    violations++;
    return;
  }

  try {
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of SECRET_PATTERNS) {
        const match = rule.regex.exec(line);
        if (match) {
          console.error(
            `\x1b[31m[SECURITY VIOLATION]\x1b[0m ${rule.name} detected in ${relPath}:${i + 1} (Masked value: ${maskSecret(match[0])})`
          );
          violations++;
        }
      }
    }
  } catch {
    // skip unreadable/binary
  }
}

const isPreCommit = process.argv.includes("--staged");
let filesToScan = [];

try {
  if (isPreCommit) {
    const staged = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" });
    filesToScan = staged.split("\n").filter(Boolean);
  } else {
    const tracked = execSync("git ls-files", { encoding: "utf8" });
    const untracked = execSync("git status --porcelain", { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.startsWith("?? "))
      .map((l) => l.slice(3).trim());
    filesToScan = [...new Set([...tracked.split("\n").filter(Boolean), ...untracked])];
  }
} catch {
  console.warn("Could not determine git files, falling back to all repository files.");
}

console.log(`Running secret scan over ${filesToScan.length} files (${isPreCommit ? "staged only" : "tracked + untracked"})...`);

for (const file of filesToScan) {
  scanFile(file);
}

if (violations > 0) {
  console.error(`\n\x1b[31mFAILED:\x1b[0m Found ${violations} potential hardcoded secret(s). Please move credentials to environment variables.`);
  process.exit(1);
} else {
  console.log("\x1b[32mPASSED:\x1b[0m No secrets detected.");
  process.exit(0);
}
