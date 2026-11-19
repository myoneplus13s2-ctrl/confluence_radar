// Copies the Confluence Radar database from Neon into PostgreSQL on this computer and switches .env.local to it.
//
//   node scripts/move-db.mjs      (move-db-to-pc.bat does this for you on Windows)
//
// Needs PostgreSQL installed on this computer (https://www.postgresql.org/download/windows/).
// The Neon address is taken from DATABASE_URL in .env.local, or asked for. Your Neon data is only read, never changed.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
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
  return readFileSync(envFile, "utf8").replace(/^\uFEFF/, "");
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

async function main() {
  console.log("\nCopy the Confluence Radar database from Neon to this PC\n");
  const bin = findBin();
  if (!bin && isWin) {
    throw new Error("PostgreSQL is not installed. Install it from https://www.postgresql.org/download/windows/ and run this again.");
  }
  console.log(`Using PostgreSQL tools in: ${bin || "(PATH)"}`);

  const env = readEnv();
  let neon = envValue(env, "DATABASE_URL");
  if (!neon || isLocal(neon) || isPlaceholder(neon)) neon = envValue(env, "NEON_DATABASE_URL");
  if (!neon || isLocal(neon) || isPlaceholder(neon)) {
    neon = (await ask("Paste your Neon connection string (starts with postgresql://) and press Enter:\n> ")).trim();
  } else {
    console.log(`Neon database: ${neon.replace(/:[^:@/]*@/, ":****@")}`);
  }
  if (!/^postgres(ql)?:\/\//.test(neon)) throw new Error("That does not look like a connection string (it should start with postgresql://).");

  const password = (await ask("Password you chose for the \"postgres\" user when installing PostgreSQL:\n> ")).trim();
  const port = (await ask("Port (press Enter for 5432):\n> ")).trim() || "5432";
  const dbName = "confluence_radar";
  const local = { PGHOST: "localhost", PGPORT: port, PGUSER: "postgres", PGPASSWORD: password };

  console.log("\n1/3  Creating the local database...");
  try {
    await run(bin, "createdb", [dbName], local);
  } catch (e) {
    if (!/already exists/.test(e.stderr ?? "")) {
      if (/password authentication failed/.test(e.stderr ?? "")) throw new Error("Wrong password for the postgres user.");
      if (/could not connect|Connection refused/i.test(e.stderr ?? "")) throw new Error(`PostgreSQL is not running on port ${port}.`);
      throw e;
    }
    console.log("     (it already exists; its tables will be replaced with the copy from Neon)");
  }

  mkdirSync(join(root, "logs"), { recursive: true });
  const dump = join(root, "logs", "neon-backup.dump");
  console.log("2/3  Downloading everything from Neon (can take a minute)...");
  await run(bin, "pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", dump, neon]);

  console.log("3/3  Loading it into the database on this PC...");
  // pg_restore exits 1 for harmless warnings ("errors ignored on restore", e.g. Neon-only settings); other failures stop here.
  await run(bin, "pg_restore", ["--no-owner", "--no-privileges", "--clean", "--if-exists", "--dbname", dbName, dump], local).catch((e) => {
    if (!/errors ignored on restore/i.test(e.stderr ?? "")) throw e;
    console.log("     (some warnings above can be ignored; they are about Neon-only settings)");
  });

  // Check the copy really has the data before switching over.
  const count = async (env, target) => {
    let out = "";
    await new Promise((resolve, reject) => {
      const p = spawn(bin ? join(bin, exe("psql")) : "psql", ["-tAc", "SELECT count(*) FROM signals", ...(target ? [target] : [])], {
        env: { ...process.env, ...env, ...(target ? {} : { PGDATABASE: dbName }) },
      });
      p.stdout.on("data", (d) => (out += d));
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("could not count the signals"))));
    });
    return Number(out.trim());
  };
  const [fromNeon, onPc] = [await count({}, neon), await count(local)];
  console.log(`     Signals in Neon: ${fromNeon}, on this PC: ${onPc}`);
  if (onPc < fromNeon) throw new Error("The copy on this PC has fewer signals than Neon, so the switch was not made.");

  const localUrl = `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/${dbName}`;
  if (existsSync(envFile)) copyFileSync(envFile, envFile + ".before-move");
  let text = readEnv() || readFileSync(join(root, ".env.example"), "utf8");
  const line = `DATABASE_URL=${localUrl}`;
  const keepNeon = isLocal(envValue(text, "DATABASE_URL")) ? "" : `# Neon, kept in case you want to go back:\nNEON_DATABASE_URL=${neon}\n`;
  text = /^\s*DATABASE_URL\s*=.*$/m.test(text) ? text.replace(/^\s*DATABASE_URL\s*=.*$/m, line) : `${line}\n${text}`;
  if (keepNeon && !/^\s*NEON_DATABASE_URL\s*=/m.test(text)) text += (text.endsWith("\n") ? "" : "\n") + keepNeon;
  writeFileSync(envFile, text.replace(/\r?\n/g, isWin ? "\r\n" : "\n"));

  console.log(`\nDone. .env.local now uses the database on this PC (${dbName}).`);
  console.log("A copy of the old .env.local is in .env.local.before-move, and the Neon backup in logs\\neon-backup.dump.");
  console.log("Close the Confluence Radar window if it is open and start start-local.bat again.\n");
}

main()
  .catch((e) => {
    console.error(`\nStopped: ${e.message}\nNothing was changed in .env.local.\n`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
