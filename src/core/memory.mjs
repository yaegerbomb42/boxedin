import fs from 'fs-extra';
import path from 'path';
import { loadTools } from './tools.mjs';

const defaultMemory = () => ({
  tools: {}, // id -> {name, purpose, inputs, outputs, usage, path, language, manifestPath, createdAt, updatedAt}
  history: [], // conversation turns {role, content, ts}
  runs: [], // run summaries {goal, steps: [...], result, ts}
});

export async function loadMemory(config) {
  const file = path.join(config.dataDir, 'memory', 'memory.json');
  if (await fs.pathExists(file)) {
    const data = await fs.readJson(file);
    // Best-effort: merge with current sandbox tools
    const memory = { ...defaultMemory(), ...data };
    const tools = await loadTools({ sandboxDir: config.sandboxDir || path.join(config.dataDir, '..', 'sandbox') });
    memory.tools = tools;
    return memory;
  }
  await fs.ensureFile(file);
  await fs.writeJson(file, defaultMemory(), { spaces: 2 });
  const mem = defaultMemory();
  const tools = await loadTools({ sandboxDir: config.sandboxDir || path.join(config.dataDir, '..', 'sandbox') });
  mem.tools = tools;
  return mem;
}

export async function saveMemory(config, memory) {
  const file = path.join(config.dataDir, 'memory', 'memory.json');
  // Avoid persisting file system paths that can change; store only manifest-level fields
  const toPersist = { ...memory, tools: Object.fromEntries(Object.entries(memory.tools || {}).map(([id, t]) => [id, {
    id: t.id, name: t.name, purpose: t.purpose, language: t.language, entry: t.entry,
    inputs: t.inputs || [], outputs: t.outputs || [], usage: t.usage || '', createdAt: t.createdAt, updatedAt: t.updatedAt
  }])) };
  await fs.writeJson(file, toPersist, { spaces: 2 });
}

export function addHistory(memory, role, content) {
  memory.history.push({ role, content, ts: Date.now() });
}

export function summarizeHistory(memory, maxTurns = 40) {
  // Simple heuristic: keep last N turns, and a placeholder for older content.
  if (memory.history.length <= maxTurns) return memory.history;
  const keep = memory.history.slice(-maxTurns);
  const omitted = memory.history.length - keep.length;
  return [{ role: 'system', content: `Summarized context: ${omitted} earlier turns omitted.` } , ...keep];
}

export async function exportAll({ dataDir, sandboxDir, outPath }) {
  // Minimalistic tar.gz to stdout if outPath not provided
  const archiver = await import('node:child_process');
  const tarCmd = outPath ? `tar -czf ${outPath} -C ${path.dirname(dataDir)} ${path.basename(dataDir)} -C ${path.dirname(sandboxDir)} ${path.basename(sandboxDir)}`
    : `tar -cz -C ${path.dirname(dataDir)} ${path.basename(dataDir)} -C ${path.dirname(sandboxDir)} ${path.basename(sandboxDir)}`;
  await new Promise((resolve, reject) => {
    const p = archiver.exec(tarCmd, { maxBuffer: 1024 * 1024 * 50 }, (err) => err ? reject(err) : resolve());
    if (!outPath) { p.stdout?.pipe(process.stdout); p.stderr?.pipe(process.stderr); }
  });
}

export async function importAll({ dataDir, sandboxDir, zipPath }) {
  await fs.ensureDir(dataDir);
  await fs.ensureDir(sandboxDir);
  const child = await import('node:child_process');
  const tmp = path.join(path.dirname(dataDir), 'import_tmp');
  await fs.ensureDir(tmp);
  await new Promise((resolve, reject) => {
    child.exec(`tar -xzf ${zipPath} -C ${tmp}`, (err) => err ? reject(err) : resolve());
  });
  // Best effort: move folders if present
  const moveIfExists = async (srcName, dst) => {
    const src = path.join(tmp, srcName);
    if (await fs.pathExists(src)) await fs.copy(src, dst, { overwrite: true });
  };
  await moveIfExists(path.basename(dataDir), dataDir);
  await moveIfExists(path.basename(sandboxDir), sandboxDir);
  await fs.remove(tmp);
}
