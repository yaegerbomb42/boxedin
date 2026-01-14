import fs from 'fs-extra';
import path from 'path';
import { execFile } from 'node:child_process';
import { loadTools } from './tools.mjs';

const defaultMemory = () => ({
  tools: {}, // id -> {name, purpose, inputs, outputs, usage, path, language, manifestPath, createdAt, updatedAt}
  history: [], // conversation turns {role, content, ts}
  runs: [], // run summaries {goal, steps: [...], result, ts}
});

function ensureDatabase(config) {
  const memoryDir = path.join(config.dataDir, 'memory');
  fs.ensureDirSync(memoryDir);
  const file = path.join(memoryDir, 'memory.sqlite');
  return file;
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runSqlite(dbPath, sql) {
  const args = ['-cmd', '.mode json', '-cmd', '.headers on', '-cmd', '.timeout 5000', '-cmd', 'PRAGMA busy_timeout=5000;', '-cmd', 'PRAGMA journal_mode=WAL;', dbPath, sql];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await new Promise((resolve, reject) => {
        execFile('sqlite3', args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim());
        });
      });
    } catch (err) {
      const message = String(err?.message || err);
      if (!message.includes('database is locked') || attempt === 2) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return '';
}

async function loadLegacyJson(config) {
  const legacy = path.join(config.dataDir, 'memory', 'memory.json');
  if (await fs.pathExists(legacy)) {
    return await fs.readJson(legacy);
  }
  return null;
}

export async function loadMemory(config) {
  const dbPath = ensureDatabase(config);
  await runSqlite(dbPath, 'create table if not exists memory_store (id integer primary key, data text not null, updated_at integer not null);');
  const result = await runSqlite(dbPath, 'select data from memory_store where id = 1;');
  let data = null;
  if (result) {
    const parsed = JSON.parse(result);
    if (parsed[0]?.data) data = JSON.parse(parsed[0].data);
  }
  if (!data) {
    const legacy = await loadLegacyJson(config);
    data = legacy || defaultMemory();
    const serialized = sqlQuote(JSON.stringify(data));
    await runSqlite(dbPath, `insert into memory_store (id, data, updated_at) values (1, ${serialized}, ${Date.now()}) on conflict(id) do update set data = excluded.data, updated_at = excluded.updated_at;`);
  }
  const memory = { ...defaultMemory(), ...data };
  const tools = await loadTools({ sandboxDir: config.sandboxDir || path.join(config.dataDir, '..', 'sandbox') });
  memory.tools = tools;
  return memory;
}

export async function saveMemory(config, memory) {
  const dbPath = ensureDatabase(config);
  await runSqlite(dbPath, 'create table if not exists memory_store (id integer primary key, data text not null, updated_at integer not null);');
  const toPersist = { ...memory, tools: Object.fromEntries(Object.entries(memory.tools || {}).map(([id, t]) => [id, {
    id: t.id, name: t.name, purpose: t.purpose, language: t.language, entry: t.entry,
    inputs: t.inputs || [], outputs: t.outputs || [], usage: t.usage || '', createdAt: t.createdAt, updatedAt: t.updatedAt
  }])) };
  const serialized = sqlQuote(JSON.stringify(toPersist));
  await runSqlite(dbPath, `insert into memory_store (id, data, updated_at) values (1, ${serialized}, ${Date.now()}) on conflict(id) do update set data = excluded.data, updated_at = excluded.updated_at;`);
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
