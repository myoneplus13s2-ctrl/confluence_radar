// Copies the Confluence Radar database from PostgreSQL on this computer up to a new Neon database, for the site on
// Vercel. Run it once, when moving the site back to Vercel:
//
//   node scripts/copy-db-to-neon.mjs      (copy-db-to-neon.bat does this for you on Windows)
//
// The local database (DATABASE_URL in .env.local) is only read, never changed, and .env.local is left as it is, so
// the copy on this PC still works as a fallback. The Neon database's tables are replaced with the copy.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env.local");
const isWin = process.platform === "win32";
const exe = (name) => (isWin ? name + ".exe" : name);
const rl = createInterface({ input: process.stdin });
const lines = [];
const waiting = [];
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on("close", () => waiting.splice(0).forEach((w) => w("")));
/** Asks a question and waits for the typed answer. */
const ask = (q) => {
  process.stdout.write(q);
  return lines.length ? Promise.resolve(lines.shift()) : new Promise((r) => waiting.push(r));
};
const isLocal = (url) => /@(localhost|127\.0\.0\.1)[:/]/.test(url);
/** The example value from .env.example ("postgres://user:pass@host/db") counts as not filled in. */
const isPlaceholder = (url) => /@host\//.test(url);

function readEnv() {
  if (!existsSync(envFile)) return "";
  // Any line ending (Notepad can save CR-only files) becomes \n, so the line-based matching below works.
  return readFileSync(envFile, "utf8").replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
}

function envValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
  if (!m) return "";
  let v = m[1].trim();
  if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
  return v;
}

/** The newest PostgreSQL bin folder (C:\Program Files\PostgreSQL\<version>\bin), or "" to use PATH. */
function findBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  for (const base of ["C:\\Program Files\\PostgreSQL", "C:\\Program Files (x86)\\PostgreSQL"]) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .filter((v) => existsSync(join(base, v, "bin", exe("pg_dump"))))
      .sort((a, b) => parseFloat(b) - parseFloat(a));
    if (versions.length) return join(base, versions[0], "bin");
  }
  return "";
}

function run(bin, cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin ? join(bin, exe(cmd)) : cmd, args, { stdio: ["ignore", "inherit", "pipe"], env: { ...process.env, ...env } });
    let err = "";
    p.stderr.on("data", (d) => {
      err += d;
      process.stderr.write(d);
    });
    p.on("error", (e) => reject(e.code === "ENOENT" ? new Error(`${cmd} not found. Is PostgreSQL installed?`) : e));
    p.on("exit", (code) => (code === 0 ? resolve(err) : reject(Object.assign(new Error(`${cmd} failed (exit code ${code})`), { stderr: err }))));
  });
}

async function count(bin, url) {
  let out = "";
  await new Promise((resolve, reject) => {
    const p = spawn(bin ? join(bin, exe("psql")) : "psql", ["-tAc", "SELECT count(*) FROM signals", url]);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("could not count the signals"))));
  });
  return Number(out.trim());
}

async function main() {
  console.log("\nCopy the Confluence Radar database from this PC to Neon\n");
  const bin = findBin();
  if (!bin && isWin) {
    throw new Error("PostgreSQL's tools were not found. They come with PostgreSQL: https://www.postgresql.org/download/windows/");
  }
  console.log(`Using PostgreSQL tools in: ${bin || "(PATH)"}`);

  const local = envValue(readEnv(), "DATABASE_URL");
  if (!local || !isLocal(local)) throw new Error("DATABASE_URL in .env.local is not a database on this PC, so there is nothing to copy from here.");
  console.log(`Database on this PC: ${local.replace(/:[^:@/]*@/, ":****@")}`);

  const neon = (await ask(
    "Paste the NEW Neon connection string (Neon console > Connect; turn \"Connection pooling\" OFF; starts with postgresql://) and press Enter:\n> ",
  )).trim();
  if (!/^postgres(ql)?:\/\//.test(neon)) throw new Error("That does not look like a connection string (it should start with postgresql://).");
  if (isLocal(neon)) throw new Error("That is a database on this PC, not Neon.");
  if (/-pooler\./.test(neon)) console.log("     (that is the pooled address; it usually works, but if the copy fails use the one with pooling turned off)");

  mkdirSync(join(root, "logs"), { recursive: true });
  const dump = join(root, "logs", "pc-to-neon.dump");
  console.log("\n1/2  Saving everything from the database on this PC...");
  await run(bin, "pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", dump, local]);

  console.log("2/2  Loading it into Neon (can take a few minutes)...");
  // pg_restore exits 1 for harmless warnings ("errors ignored on restore", e.g. settings Neon doesn't have); other failures stop here.
  await run(bin, "pg_restore", ["--no-owner", "--no-privileges", "--clean", "--if-exists", "--dbname", neon, dump]).catch((e) => {
    if (!/errors ignored on restore/i.test(e.stderr ?? "")) throw e;
    console.log("     (some warnings above can be ignored; they are about settings Neon doesn't have)");
  });

  const [onPc, inNeon] = [await count(bin, local), await count(bin, neon)];
  console.log(`     Signals on this PC: ${onPc}, in Neon: ${inNeon}`);
  if (inNeon < onPc) throw new Error("Neon has fewer signals than this PC, so the copy is not complete. Run this again.");

  console.log("\nDone. Neon now has all your data. Put the same connection string in Vercel as DATABASE_URL.");
  console.log(".env.local was not changed: the copy on this PC still uses its own database.\n");
}

main()
  .catch((e) => {
    console.error(`\nStopped: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
