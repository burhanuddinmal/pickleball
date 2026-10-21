// Builds every release target.
// Web targets go to release/<name>/ and are zipped to release/<name>.zip.
// Android is built only if .env.android.production holds real AdMob IDs and android/keystore.properties exists;
// otherwise it is skipped with a reason (it never ships unsigned or with test ads).
// Usage: node scripts/build-all.js [--skip-android] [--no-zip]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const args = new Set(process.argv.slice(2));
const WEB_TARGETS = ['crazygames', 'playgama', 'itch'];
const isWin = process.platform === 'win32';
const summary = [];

function run(cmd, cmdArgs, cwd = root) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: isWin });
  return r.status === 0;
}

function step(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    const res = fn();
    if (res === true || res === undefined) summary.push(`OK      ${name}`);
    else if (res === false) summary.push(`FAILED  ${name}`);
    else summary.push(`SKIPPED ${name}: ${res}`);
  } catch (e) {
    summary.push(`FAILED  ${name}: ${e.message}`);
  }
}

if (!run('npx', ['tsc', '--noEmit'])) {
  console.error('Typecheck failed; aborting.');
  process.exit(1);
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const t of WEB_TARGETS) {
  step(`web: ${t}`, () => {
    const dir = path.join(out, t);
    if (!run('npx', ['vite', 'build', '--mode', t, '--outDir', dir, '--emptyOutDir'])) return false;
    // bsdtar picks zip from the extension; on Windows use the system one (Git Bash's GNU tar reads "C:" as a host)
    const tar = isWin ? path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
    if (!args.has('--no-zip')) return run(`"${tar}"`, ['-a', '-c', '-f', path.join(out, `${t}.zip`), '-C', dir, '.']);
  });
}

step('android release (AAB)', () => {
  if (args.has('--skip-android')) return '--skip-android';
  if (!fs.existsSync(path.join(root, 'android', 'keystore.properties'))) return 'android/keystore.properties not found (no signing key)';
  if (!run('node', ['scripts/sync-admob-app-id.js', 'android.production'])) return 'AdMob production IDs not filled in .env.android.production';
  if (!run('npx', ['vite', 'build', '--mode', 'android.production'])) return false;
  if (!run('npx', ['cap', 'sync', 'android'])) return false;
  if (!run(isWin ? 'gradlew.bat' : './gradlew', ['bundleRelease'], path.join(root, 'android'))) return false;
  const aab = path.join(root, 'android/app/build/outputs/bundle/release/app-release.aab');
  fs.copyFileSync(aab, path.join(out, 'pickle-smash.aab'));
});

console.log('\n=== Summary ===\n' + summary.join('\n'));
process.exit(summary.some((s) => s.startsWith('FAILED')) ? 1 : 0);
