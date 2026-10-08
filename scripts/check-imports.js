import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gameDir = path.resolve(__dirname, '../src/game');

const FORBIDDEN_PATTERNS = [
  /from\s+['"][^'"]*\/platforms\/(dummy|crazygames|playgama|itch|android)['"]/i,
  /import\s+['"][^'"]*\/platforms\/(dummy|crazygames|playgama|itch|android)['"]/i,
  /from\s+['"]@capacitor[^'"]*['"]/i,
  /import\s+['"]@capacitor[^'"]*['"]/i,
  /from\s+['"][^'"]*crazygames[^'"]*['"]/i,
  /from\s+['"][^'"]*playgama[^'"]*['"]/i,
];

let violationsFound = 0;

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            console.error(
              `[Rule 1 Violation] ${path.relative(path.resolve(__dirname, '..'), fullPath)}:${idx + 1}`
            );
            console.error(`  Line: ${line.trim()}`);
            console.error(`  Forbidden: Direct provider or Capacitor import in game code.`);
            console.error(`  Required: Only import from src/platforms (the resolved interface).\n`);
            violationsFound++;
          }
        }
      });
    }
  }
}

console.log('[check-imports] Validating game layer isolation under src/game/ ...');
scanDir(gameDir);

if (violationsFound > 0) {
  console.error(`[check-imports] FAILED with ${violationsFound} violation(s).`);
  process.exit(1);
} else {
  console.log('[check-imports] PASSED: All game files comply with platform isolation rules.');
}
