// Backs up the Confluence Radar database to a file, by default into Google Drive for desktop's "My Drive"
// so it is copied to Google Drive by itself.
//
//   node scripts/backup-db.mjs      (backup-db.bat does this for you on Windows)
//
// Where the backups go, first match wins:
//   1. BACKUP_DIR in .env.local
//   2. "My Drive\Confluence Radar backups" on the Google Drive for desktop drive (any drive letter)
//      or in a "Google Drive" / "My Drive" folder in your user folder
//   3. logs\backups in this folder (then copy them to Google Drive yourself)
// The newest 14 backups are kept; older ones in that folder are deleted.
// scripts/local.mjs also calls backup() once a day while the site runs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const exe = (name) => (isWin ? name + ".exe" : name);
const KEEP = 14;
const PREFIX = "confluence_radar-";

function envValue(key) {
  if (process.env[key]) return process.env[key];
  const file = join(root, ".env.local");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
  if (!m) return "";
  let v = m[1].trim();
  if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
  return v;
}

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

/** Google Drive for desktop shows up as a drive (usually G:) with a "My Drive" folder, or as a folder in the user folder. */
function googleDrive() {
  const candidates = [];
  if (isWin) for (const letter of "GHIJKLMNOPQRSTUVWXYZDEF") candidates.push(`${letter}:\\My Drive`);
  candidates.push(join(homedir(), "My Drive"), join(homedir(), "Google Drive", "My Drive"), join(homedir(), "Google Drive"));
  return candidates.find((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

export function backupDir() {
  const custom = envValue("BACKUP_DIR");
  if (custom) return { dir: custom, where: "BACKUP_DIR" };
  const drive = googleDrive();
  if (drive) return { dir: join(drive, "Confluence Radar backups"), where: "Google Drive" };
  return { dir: join(root, "logs", "backups"), where: "local" };
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Newest backup time in the folder, or 0. */
export function lastBackupTime() {
  const { dir } = backupDir();
  if (!existsSync(dir)) return 0;
  return Math.max(0, ...readdirSync(dir).filter((f) => f.startsWith(PREFIX)).map((f) => statSync(join(dir, f)).mtimeMs));
}

export async function backup() {
  const url = envValue("DATABASE_URL") || envValue("POSTGRES_URL");
  if (!url) throw new Error("DATABASE_URL is missing from .env.local.");
  const bin = findBin();
  const { dir, where } = backupDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${PREFIX}${stamp()}.dump`);
  await new Promise((resolve, reject) => {
    const p = spawn(bin ? join(bin, exe("pg_dump")) : "pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", file, url], {
      stdio: ["ignore", "inherit", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(e.code === "ENOENT" ? new Error("pg_dump not found. Is PostgreSQL installed?") : e));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump failed (exit code ${code}): ${err.trim().slice(0, 300)}`))));
  });
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(".dump"))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) {
    try {
      unlinkSync(join(dir, f));
    } catch {}
  }
  return { file, where, size: statSync(file).size };
}

// Run directly: one backup now.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  backup()
    .then(({ file, where, size }) => {
      console.log(`\nBackup saved (${(size / 1024 / 1024).toFixed(1)} MB):\n  ${file}\n`);
      if (where === "Google Drive") console.log("Google Drive for desktop uploads it by itself in the next minutes.");
      else if (where === "local") {
        console.log("Google Drive for desktop was not found, so it is saved here. Upload this file to drive.google.com,");
        console.log("or install Google Drive for desktop (https://www.google.com/drive/download/) and run this again.");
      }
      console.log(`The newest ${KEEP} backups are kept. The site also makes one by itself every day while it runs.\n`);
    })
    .catch((e) => {
      console.error(`\nBackup failed: ${e.message}\n`);
      process.exitCode = 1;
    });
}
