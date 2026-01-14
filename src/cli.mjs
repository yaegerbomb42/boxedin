import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAgentLoop } from './core/agent.mjs';
import { getDefaultLimits } from './core/limits.mjs';
import { exportAll, importAll, loadMemory } from './core/memory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();
program
  .name('boxedin')
  .description('Autonomous AI agent with sandboxed tool creation and execution using Google Gemini')
  .version('0.1.0');

const defaultDataDir = path.join(__dirname, '..', 'data');
const defaultSandboxDir = path.join(__dirname, '..', 'sandbox');
const defaultLimits = getDefaultLimits();
const defaultModel = process.env.GEMINI_MODEL || 'gemini-3-flash';
const geminiApiKey = 'AIzaSyAvzNpziSosmT7m0av5mAHUn-LAdCQ5afI';

function ensureDirs(baseDir, sandboxDir) {
  fs.ensureDirSync(baseDir);
  fs.ensureDirSync(sandboxDir);
  fs.ensureDirSync(path.join(baseDir, 'memory'));
  fs.ensureDirSync(path.join(baseDir, 'logs'));
  fs.ensureDirSync(path.join(sandboxDir, 'tools'));
  fs.ensureDirSync(path.join(sandboxDir, 'runs'));
}

program.option('-d, --data <dir>', 'Data directory for memory/logs', defaultDataDir);
program.option('-s, --sandbox <dir>', 'Sandbox directory for tools and runs', defaultSandboxDir);
program.option('--model <name>', 'Gemini model name (gemini-3-flash, gemini-3-pro-preview)', defaultModel);
program.option('--timeout-ms <n>', 'Sandbox timeout ms', (v) => parseInt(v, 10), defaultLimits.timeoutMs);
program.option('--memory-mb <n>', 'Sandbox memory MB', (v) => parseInt(v, 10), defaultLimits.memoryMb);
program.option('--cpu <n>', 'Sandbox CPU (e.g., 1, 2, 4)', defaultLimits.cpu);
program.option('--allow-network', 'Allow network in sandbox containers', defaultLimits.network);

program
  .command('run')
  .description('Run the agent interactively or with a one-off goal')
  .option('-g, --goal <text>', 'User goal to execute')
  .option('--no-interactive', 'Disable interactive mode')
  .action(async (opts) => {
    const baseDir = program.opts().data;
    const sandboxDir = program.opts().sandbox;
    ensureDirs(baseDir, sandboxDir);

    const goal = opts.goal || (process.stdin.isTTY ? null : (await fs.readFile(0, 'utf8')).trim());
    const interactive = opts.interactive !== false;

    const config = {
      dataDir: baseDir,
      sandboxDir,
      gemini: { apiKey: geminiApiKey, model: program.opts().model },
      limits: {
        maxTokens: defaultLimits.maxTokens,
        contextWindow: defaultLimits.contextWindow,
        timeoutMs: program.opts().timeoutMs,
        memoryMb: program.opts().memoryMb,
        cpu: program.opts().cpu,
        network: program.opts().allowNetwork,
      },
    };

    if (!config.gemini.apiKey) {
      console.error('Missing GEMINI_API_KEY env var. Set it before running.');
      process.exit(1);
    }

    const memory = await loadMemory(config);

    if (goal) {
      const result = await runAgentLoop({ goal, config, memory, interactive: false });
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    if (!interactive) {
      console.error('No goal provided and interactive mode disabled.');
      process.exit(1);
    }

    // Simple REPL with helper commands
    process.stdout.write('Interactive mode. Type a goal and press Enter. Commands: /exit, /help, /status\n> ');
    process.stdin.setEncoding('utf8');
    for await (const line of process.stdin) {
      const input = line.trim();
      if (!input) { process.stdout.write('> '); continue; }
      if (input === '/exit') break;
      if (input === '/help') { console.log('Commands: /exit, /help, /status'); process.stdout.write('> '); continue; }
      if (input === '/status') { const m = await loadMemory(config); console.log(JSON.stringify({ tools: Object.keys(m.tools).length, runs: m.runs.length }, null, 2)); process.stdout.write('> '); continue; }
      try {
        const result = await runAgentLoop({ goal: input, config, memory, interactive: true });
        console.log('\nResult:\n', JSON.stringify(result, null, 2));
      } catch (e) {
        console.error('Agent error:', e?.message || e);
      }
      process.stdout.write('\n> ');
    }
  });

program
  .command('status')
  .description('Show memory and available tools')
  .action(async () => {
    const baseDir = program.opts().data;
    const sandboxDir = program.opts().sandbox;
    ensureDirs(baseDir, sandboxDir);
    const config = { dataDir: baseDir, sandboxDir };
    const mem = await loadMemory(config);
    const summary = {
      conversations: mem.history.length,
      tools: Object.keys(mem.tools).length,
      lastRun: mem.runs[mem.runs.length - 1] || null,
    };
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command('export')
  .description('Export memory and sandbox as a zip to stdout')
  .action(async () => {
    const baseDir = program.opts().data;
    const sandboxDir = program.opts().sandbox;
    ensureDirs(baseDir, sandboxDir);
    await exportAll({ dataDir: baseDir, sandboxDir, outPath: null });
  });

program
  .command('import <zipFile>')
  .description('Import memory and sandbox from a zip file')
  .action(async (zipFile) => {
    const baseDir = program.opts().data;
    const sandboxDir = program.opts().sandbox;
    ensureDirs(baseDir, sandboxDir);
    await importAll({ dataDir: baseDir, sandboxDir, zipPath: zipFile });
    console.log('Imported.');
  });

program.parseAsync(process.argv);
