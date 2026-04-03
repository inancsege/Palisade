import { Command } from 'commander';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DetectionEngine } from '../../detection/engine.js';
import { defaultPolicy } from '../../policy/defaults.js';
import { loadPolicy } from '../../policy/loader.js';
import type { DetectionResult } from '../../types/verdict.js';
import { printBanner, printScanResult, printScanSummary } from '../output.js';

const SCANNABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.yaml', '.yml', '.json', '.py', '.js', '.ts',
  '.jsx', '.tsx', '.html', '.xml', '.csv', '.env', '.cfg', '.ini',
  '.toml', '.sh', '.bash', '.zsh', '.prompt', '.template',
]);

function walkDir(dir: string, files: string[] = []): string[] {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath, files);
    } else if (SCANNABLE_EXTENSIONS.has(extname(entry).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

export const scanCommand = new Command('scan')
  .description('Scan a directory for prompt injection patterns')
  .argument('<dir>', 'Directory to scan')
  .option('--policy <path>', 'Path to policy.yaml file')
  .option('--format <format>', 'Output format (text|json)', 'text')
  .action(async (dir: string, options) => {
    if (options.format !== 'json') printBanner();

    let policy = defaultPolicy;
    if (options.policy) {
      policy = loadPolicy(options.policy);
    }

    const engine = new DetectionEngine(policy.detection);

    let files: string[];
    try {
      files = walkDir(dir);
    } catch (err) {
      console.error(`Error reading directory: ${(err as Error).message}`);
      process.exit(1);
    }

    const results: Array<{ file: string; result: DetectionResult }> = [];
    let totalMatches = 0;
    let blocked = 0;
    let warned = 0;

    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        if (content.length === 0) continue;

        const result = await engine.detect(
          [{ source: file, role: 'document', text: content }],
        );

        if (result.matches.length > 0) {
          results.push({ file, result });
          totalMatches += result.matches.length;
          if (result.action === 'block') blocked++;
          else if (result.action === 'warn') warned++;
        }
      } catch {
        // Skip files that can't be read as text
      }
    }

    if (options.format === 'json') {
      console.log(JSON.stringify({ files: files.length, results }, null, 2));
    } else {
      for (const { file, result } of results) {
        printScanResult(file, result);
      }
      printScanSummary(files.length, totalMatches, blocked, warned);
    }

    process.exit(blocked > 0 ? 1 : 0);
  });
