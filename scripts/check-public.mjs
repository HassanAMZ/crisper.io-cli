#!/usr/bin/env node
// Gate for a public repository and a public npm package. Fails when:
//   1. a tracked file isn't on the allowlist below,
//   2. a tracked file or a packed file contains a secret or an internal reference,
//   3. the npm tarball would contain anything but dist/*.js, package.json, README and LICENSE,
//   4. package.json drifts from what the publish workflow expects.
// Usage: node scripts/check-public.mjs [--tag v0.0.2]
// The tarball check runs `npm pack --dry-run`, which builds through `prepack`.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const TRACKED_ALLOWLIST = [
  /^\.github\/workflows\/[a-z0-9-]+\.yml$/,
  /^\.gitignore$/,
  /^README\.md$/,
  /^skills\/crisper\/SKILL\.md$/,
  /^LICENSE(\.md)?$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig(\.build)?\.json$/,
  /^vitest\.config\.ts$/,
  /^scripts\/[a-z0-9-]+\.mjs$/,
  /^src\/[a-z0-9/-]+\.ts$/,
  /^test\/[a-z0-9/-]+\.test\.ts$/,
];
const PACKED_ALLOWLIST = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE(\.md)?$/,
  /^dist\/[a-z0-9/-]+\.js$/,
];
const MAX_FILE_BYTES = 200_000;
const MAX_PACKED_BYTES = 500_000;

// Anything here must never appear in this repository or the package.
// Secrets can't be silenced; a line marked ALLOW_MARKER may contain a
// reference (for test fixtures that must look real), never a secret.
const SECRETS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Stripe or Clerk secret key", /\b[sr]k_(live|test)_[A-Za-z0-9]{8,}/],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{8,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["OpenAI or Anthropic key", /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ["Convex deploy key", /\b(prod|dev|preview):[a-z0-9-]+\|[A-Za-z0-9+/=]{20,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credential in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:[^\s/@"'`]+@/i],
];
const REFERENCES = [
  ["Convex deployment URL", /\b[a-z]+-[a-z]+-\d+\.convex\.(cloud|site)\b/],
  ["Clerk development instance", /\.clerk\.accounts\.dev\b/],
  ["local home directory", /(\/(Users|home)\/[A-Za-z0-9._-]+\/|\b[A-Z]:\\\\?Users\\\\?[A-Za-z0-9._ -]+)/],
  ["private Crisper path", /\b(agent-context|docs\/agents|convex\/[a-z]+\.ts)\b/], // public-check: allow
  ["personal email address", /\b[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud)\.com\b/i],
];
const ALLOW_MARKER = "public-check: allow";

const failures = [];
const fail = (message) => failures.push(message);

function scan(label, text) {
  text.split("\n").forEach((line, index) => {
    const checks = line.includes(ALLOW_MARKER) ? SECRETS : [...SECRETS, ...REFERENCES];
    for (const [name, pattern] of checks)
      if (pattern.test(line)) fail(`${label}:${index + 1}: ${name}`);
  });
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

// 1 and 2: tracked files
const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
for (const file of tracked) {
  if (!TRACKED_ALLOWLIST.some((re) => re.test(file)))
    fail(`${file}: not on the tracked-file allowlist in scripts/check-public.mjs`);
  const { size } = statSync(file);
  if (size > MAX_FILE_BYTES && file !== "pnpm-lock.yaml")
    fail(`${file}: ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit`);
  if (file !== "pnpm-lock.yaml") scan(file, readFileSync(file, "utf8"));
}
// The lockfile is generated; it may only point at the public npm registry.
for (const [index, line] of readFileSync("pnpm-lock.yaml", "utf8").split("\n").entries()) {
  const url = line.match(/https?:\/\/[^\s'"]+/)?.[0];
  if (url && !url.startsWith("https://registry.npmjs.org/"))
    fail(`pnpm-lock.yaml:${index + 1}: dependency from outside registry.npmjs.org`);
}

// 4: package.json
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.name !== "crisperio") fail(`package.json: name is ${pkg.name}, expected crisperio`);
if (pkg.private) fail("package.json: private is set, so the publish would fail");
if (JSON.stringify(pkg.files) !== JSON.stringify(["dist", "README.md"]))
  fail('package.json: "files" must stay ["dist", "README.md"]');
if (pkg.repository?.url !== "git+https://github.com/HassanAMZ/crisper.io-cli.git")
  fail("package.json: repository.url must match this repo, or provenance won't verify");
for (const hook of ["preinstall", "install", "postinstall"])
  if (pkg.scripts?.[hook]) fail(`package.json: "${hook}" script would run on users' machines`);
for (const [name, range] of Object.entries(pkg.dependencies ?? {}))
  if (/^(file|link|git|github|https?):/.test(range))
    fail(`package.json: dependency ${name} isn't from the npm registry (${range})`);

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1];
  if (tag !== `v${pkg.version}`)
    fail(`release tag ${tag} doesn't match package.json version v${pkg.version}`);
}

// 2 and 3: the tarball npm would publish
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts=false"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
for (const { path } of packed.files) {
  if (!PACKED_ALLOWLIST.some((re) => re.test(path)))
    fail(`npm package: ${path} isn't on the packed-file allowlist`);
  else scan(`npm package ${path}`, readFileSync(path, "utf8"));
}
if (!packed.files.some(({ path }) => path === "dist/crisper.js"))
  fail("npm package: dist/crisper.js (the bin) is missing");
if (packed.unpackedSize > MAX_PACKED_BYTES)
  fail(`npm package: ${packed.unpackedSize} bytes unpacked, over ${MAX_PACKED_BYTES}`);

if (failures.length) {
  console.error(`Public check failed (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `Public check passed: ${tracked.length} tracked files, ` +
    `${packed.files.length} packed files (${packed.name}@${packed.version}).`,
);
