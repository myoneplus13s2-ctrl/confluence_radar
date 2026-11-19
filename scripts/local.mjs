// Runs Confluence Radar on your own computer, the way Vercel ran it:
//   - installs packages and builds the site when needed,
//   - starts the web server (UI + API routes) on http://localhost:3000 (PORT in .env.local changes it),
//   - runs the price check (/api/tick) every 15 minutes, which on Vercel came from GitHub Actions,
//   - restarts the server if it ever stops.
//
//   node scripts/local.mjs            (start-local.bat does this for you on Windows)
//   node scripts/local.mjs --rebuild  (force a fresh build)
//
// Settings come from .env.local in the project folder (see .env.example).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
mkdirSync(join(root, "logs"), { recursive: true });
const logFile = join(root, "logs", "local.log");

function log(...a) {
  const line = `${new Date().toLocaleString()}  ${a.join(" ")}`;
  console.log(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch {}
}

/** Reads KEY=value lines from .env.local / .env so this script sees the same settings as the site. */
function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
      const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, stdio: "inherit", shell: isWin });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed (exit code ${code})`))));
    p.on("error", reject);
  });
}

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);

/** Newest modification time of any file under these paths. */
function newest(paths) {
  let t = 0;
  const walk = (p) => {
    if (!existsSync(p)) return;
    const s = statSync(p);
    if (s.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else t = Math.max(t, s.mtimeMs);
  };
  paths.forEach((p) => walk(join(root, p)));
  return t;
}

async function prepare() {
  const npm = isWin ? "npm.cmd" : "npm";
  const installed = join(root, "node_modules", ".package-lock.json");
  if (!existsSync(join(root, "node_modules", "next")) || mtime(join(root, "package-lock.json")) > mtime(installed)) {
    log("Installing packages (first run or after an update, takes a few minutes)...");
    await run(npm, ["install", "--no-audit", "--no-fund"]);
  }
  const built = join(root, ".next", "BUILD_ID");
  const sources = ["app", "lib", "public", "middleware.ts", "next.config.mjs", "package.json", "tsconfig.json"];
  if (process.argv.includes("--rebuild") || !existsSync(built) || newest(sources) > mtime(built)) {
    log("Building the site (first run or after an update, takes a minute or two)...");
    await run(npm, ["run", "build"]);
  }
}

const port = () => Number(process.env.PORT) || 3000;
const base = () => `http://127.0.0.1:${port()}`;

let server;
let stopping = false;
function startServer() {
  const next = join(root, "node_modules", "next", "dist", "bin", "next");
  log(`Starting the site on http://localhost:${port()}`);
  server = spawn(process.execPath, [next, "start", "-p", String(port())], { cwd: root, stdio: "inherit", env: process.env });
  server.on("exit", (code) => {
    if (stopping) return;
    log(`The site stopped (exit code ${code}). Restarting in 10 seconds...`);
    setTimeout(startServer, 10_000);
  });
}

function authHeader() {
  // The site lets the scheduled check in with CRON_SECRET, or with the site password itself.
  if (process.env.CRON_SECRET) return { authorization: `Bearer ${process.env.CRON_SECRET}` };
  if (process.env.APP_PASSWORD) return { authorization: "Basic " + Buffer.from(`radar:${process.env.APP_PASSWORD}`).toString("base64") };
  return {};
}

async function waitForSite() {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(base() + "/api/tick", { headers: authHeader(), signal: AbortSignal.timeout(5000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  log("The site did not answer within 2 minutes; the check will keep trying on schedule.");
}

let ticking = false;
async function tick() {
  if (ticking) return log("Price check: previous run still going, skipped this one.");
  ticking = true;
  const started = Date.now();
  try {
    const res = await fetch(base() + "/api/tick", { method: "POST", headers: authHeader(), signal: AbortSignal.timeout(10 * 60_000) });
    const text = await res.text();
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    if (!res.ok) log(`Price check FAILED (HTTP ${res.status}, ${secs}s): ${text.slice(0, 300)}`);
    else log(`Price check done in ${secs}s`);
  } catch (e) {
    log(`Price check FAILED: ${e.message}`);
  } finally {
    ticking = false;
  }
}

/** Every 15 minutes on the quarter hour (:00, :15, :30, :45), like the GitHub Actions schedule. */
function scheduleTicks() {
  const every = 15 * 60_000;
  const wait = every - (Date.now() % every) + 5_000;
  setTimeout(() => {
    tick();
    setInterval(tick, every);
  }, wait);
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    log("DATABASE_URL is missing from .env.local. Open .env.local, paste your Neon connection string, and start again.");
    process.exit(1);
  }
  await prepare();
  startServer();
  await waitForSite();
  log(`Site is up: open http://localhost:${port()} in your browser. Keep this window open (minimise it).`);
  await tick(); // one check right away, then every 15 minutes
  scheduleTicks();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    server?.kill();
    process.exit(0);
  });
}

main().catch((e) => {
  log(`Could not start: ${e.message}`);
  process.exit(1);
});
