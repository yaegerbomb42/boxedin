import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAgentLoop } from '../core/agent.mjs';
import { loadMemory } from '../core/memory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SANDBOX_DIR = path.join(__dirname, '..', '..', 'sandbox');

function makeConfig() {
  return {
    dataDir: DATA_DIR,
    sandboxDir: SANDBOX_DIR,
    gemini: { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-1.5-flash' },
    limits: { maxTokens: 8192, contextWindow: 20000, timeoutMs: parseInt(process.env.SANDBOX_TIMEOUT_MS || '60000', 10), memoryMb: parseInt(process.env.SANDBOX_MEMORY_MB || '512', 10), cpu: process.env.SANDBOX_CPU || '0.5', network: false }
  };
}

app.use('/', express.static(path.join(__dirname, 'static')));

app.get('/api/status', async (req, res) => {
  const mem = await loadMemory({ dataDir: DATA_DIR, sandboxDir: SANDBOX_DIR });
  res.json({ conversations: mem.history.length, tools: Object.keys(mem.tools).length, runs: mem.runs.length });
});

app.get('/api/tools', async (req, res) => {
  const mem = await loadMemory({ dataDir: DATA_DIR, sandboxDir: SANDBOX_DIR });
  res.json(Object.values(mem.tools));
});

app.get('/api/run-stream', async (req, res) => {
  const goal = String(req.query.goal || '').trim();
  if (!goal) return res.status(400).end('Missing goal');
  const config = makeConfig();
  if (!config.gemini.apiKey) return res.status(400).end('Missing GEMINI_API_KEY');
  const memory = await loadMemory(config);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const reporter = {
    plan: (plan) => send('plan', plan),
    createTools: (list) => send('createTools', list),
    runStart: (info) => send('runStart', info),
    runChunk: (info) => send('runChunk', info),
    runEnd: (info) => send('runEnd', info),
    result: (r) => send('result', r),
    done: (r) => send('done', r),
    error: (e) => send('error', e),
  };

  try {
    const final = await runAgentLoop({ goal, config, memory, interactive: false, reporter });
    send('complete', final);
  } catch (e) {
    send('error', { err: e?.message || String(e) });
  } finally {
    res.end();
  }
});

// Backward compatibility: global SSE and /run JSON endpoint
const clients = new Set();
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const client = { res };
  clients.add(client);
  req.on('close', () => clients.delete(client));
});
function broadcast(event, data) {
  for (const { res } of clients) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  }
}
app.post('/run', async (req, res) => {
  const goal = String(req.body?.goal || '').trim();
  if (!goal) return res.status(400).json({ error: 'Missing goal' });
  const config = makeConfig();
  if (!config.gemini.apiKey) return res.status(400).json({ error: 'Missing GEMINI_API_KEY' });
  const memory = await loadMemory(config);
  const reporter = {
    plan: (plan) => broadcast('plan', plan),
    createTools: (list) => broadcast('createTools', list),
    runStart: (info) => broadcast('runStart', info),
    runChunk: (info) => broadcast('runChunk', info),
    runEnd: (info) => broadcast('runEnd', info),
    result: (r) => broadcast('result', r),
    done: (r) => broadcast('done', r),
    error: (e) => broadcast('error', e),
  };
  try {
    const final = await runAgentLoop({ goal, config, memory, interactive: false, reporter });
    res.json(final);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BoxedIn web listening on http://localhost:${PORT}`);
});
