import path from 'path';
import fs from 'fs-extra';
import { GeminiClient } from './gemini.mjs';
import { addHistory, saveMemory, summarizeHistory } from './memory.mjs';
import { Sandbox } from './sandbox.mjs';
import { loadTools, saveTool, toolsToPrompt, writeToolCode } from './tools.mjs';

const SYSTEM_PROMPT = `You are an autonomous software agent. You can:
- Plan steps to achieve a user's goal.
- Reuse existing tools when possible.
- Create new tools (code files) in Python or Node when needed.
- Write clear manifests and minimal, executable code.
- Test tools using the sandbox executor and iterate on failures.
- Return structured JSON describing your plan, actions, and code.

Constraints:
- File IO must stay within the /app sandbox directory.
- Keep code minimal and focused on the task.
- Prefer deterministic output; avoid network calls unless asked and safe.
- Do not use third-party libraries or packages (e.g., \"wikipedia\"), only the standard library unless the user explicitly requests them and network is allowed.
- Use stdout for tool results, and exit with non-zero on error.`;

function parseJsonBlocks(text) {
  // Prefer fenced JSON block
  const match = text.match(/```json[\s\S]*?```/);
  let raw = match ? match[0].replace(/^```json\n?|```$/g, '') : null;
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  // Try to locate first balanced JSON object
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function makePlanningPrompt({ goal, tools, memory, networkAllowed }) {
  const toolDesc = toolsToPrompt(tools);
  const history = summarizeHistory(memory).slice(-20)
    .map(h => `${h.role}: ${h.content.substring(0, 500)}`)
    .join('\n');
  return `User goal: ${goal}\n\nRelevant history (truncated):\n${history}\n\nIf existing tools suffice, plan to call them. Otherwise, propose new tool(s).\nEnvironment: Network is ${networkAllowed ? 'ALLOWED' : 'DISALLOWED'}. ${networkAllowed ? 'If you use third-party packages, include requirements.txt (Python) or package.json (Node) in files.' : 'Do NOT use third-party packages; use only standard library.'}\nReturn ONLY a JSON object as a fenced \`json\` block with the shape:\n{\n  "plan": "string",
  "steps": ["..."],
  "createTools": [
    { "id": "string", "name": "string", "language": "python|node", "entry": "string",
      "purpose": "string", "files": { "path": "content" },
      "inputs": [{"name":"x","type":"string"}], "outputs": [{"name":"y","type":"json"}],
      "usage": "example" }
  ],
  "run": [ { "id": "tool-id", "args": ["arg1","arg2"], "stdin": "" } ]
}\nKeep it minimal.`;
}

export async function runAgentLoop({ goal, config, memory, interactive, reporter }) {
  const logsDir = path.join(config.dataDir, 'logs');
  await fs.ensureDir(logsDir);
  const sandbox = new Sandbox({ sandboxDir: config.sandboxDir, logsDir, limits: config.limits || {} });
  const gemini = new GeminiClient({ apiKey: config.gemini.apiKey, model: config.gemini.model, limits: config.limits });
  const tools = await loadTools({ sandboxDir: config.sandboxDir });

  addHistory(memory, 'user', goal);
    let planning = await gemini.generate({
    systemPrompt: SYSTEM_PROMPT,
      toolsDescription: toolsToPrompt(tools),
      messages: [{ role: 'user', content: makePlanningPrompt({ goal, tools, memory, networkAllowed: config.limits?.network !== false }) }],
    temperature: 0.2,
  });

  let plan = parseJsonBlocks(planning) || { plan: 'fallback', steps: [], createTools: [], run: [] };
  // If nothing to run or create, try one refinement iteration asking to propose tools
  if ((!plan.createTools || plan.createTools.length === 0) && (!plan.run || plan.run.length === 0)) {
      const refine = await gemini.generate({
      systemPrompt: SYSTEM_PROMPT,
        toolsDescription: toolsToPrompt(tools),
        messages: [{ role: 'user', content: `${makePlanningPrompt({ goal, tools, memory, networkAllowed: config.limits?.network !== false })}\n\nNo actions proposed. Identify missing tools and propose minimal ones, then a run plan.` }],
      temperature: 0.3,
    });
    plan = parseJsonBlocks(refine) || plan;
  }
  addHistory(memory, 'assistant', `Plan: ${JSON.stringify(plan.plan || plan, null, 2)}`);

  const created = [];
  const createdFiles = {};
  if ((interactive || reporter) && (plan.plan || plan.steps)) {
    console.log('\n--- PLAN ---');
    console.log(typeof plan.plan === 'string' ? plan.plan : JSON.stringify(plan, null, 2));
    reporter?.plan(plan);
  }
  if ((interactive || reporter) && plan.createTools?.length) {
    console.log('\n--- CREATE TOOLS ---');
    for (const t of plan.createTools) {
      console.log(`Tool ${t.id || t.name}: ${t.language} -> ${t.entry}`);
      if (t.files) {
        for (const [p, c] of Object.entries(t.files)) {
          console.log(`File ${p}:\n${c}\n`);
        }
      }
    }
    reporter?.createTools(plan.createTools.map(t => ({ id: t.id, name: t.name, language: t.language, entry: t.entry, purpose: t.purpose })));
  }
  for (const t of plan.createTools || []) {
    try {
      const toolId = t.id || (t.name || 'tool').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
  await writeToolCode({ sandboxDir: config.sandboxDir, toolId, files: t.files || {} });
  createdFiles[toolId] = Object.keys(t.files || {});
  const manifest = await saveTool({ sandboxDir: config.sandboxDir, manifest: {
        id: toolId,
        name: t.name || toolId,
        purpose: t.purpose || 'N/A',
        language: t.language || 'node',
        entry: t.entry || 'index.mjs',
        inputs: t.inputs || [],
        outputs: t.outputs || [],
        usage: t.usage || '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }});
      tools[toolId] = manifest;
      created.push(toolId);
    } catch (e) {
      addHistory(memory, 'assistant', `Failed to create tool: ${e.message}`);
    }
  }

  const runs = [];
  const runIndex = {};
  let lastRun = null;
  const expand = (tpl) => {
    if (!tpl || typeof tpl !== 'string') return tpl;
    return tpl.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      try {
        if (expr === 'last.stdout') return lastRun?.stdout ?? '';
        const m = expr.match(/^runs\.(.+?)\.(stdout|stderr|code)$/);
        if (m) {
          const r = runIndex[m[1]]; if (!r) return '';
          return String(r[m[2]] ?? '');
        }
      } catch {}
      return '';
    });
  };
  if ((interactive || reporter) && plan.run?.length) {
    console.log('\n--- RUN ---');
  }
  for (const call of plan.run || []) {
    const id = call.id || call.toolId;
    const t = tools[id];
    if (!t) { runs.push({ id, error: 'Tool not found' }); continue; }
    const args = (call.args || []).map(a => expand(a));
    let stdin;
    if (Object.prototype.hasOwnProperty.call(call, 'stdin')) {
      stdin = expand(call.stdin || '');
    } else {
      stdin = lastRun?.stdout ?? '';
    }
    if (interactive) {
      console.log(`\n[${id}] args=${JSON.stringify(args)}${stdin ? ' stdin preview: ' + JSON.stringify(stdin.slice(0,120)) : ''}`);
    }
    reporter?.runStart({ id, args });
    let res = await sandbox.run({ language: t.language, entry: path.join('tools', id, t.entry), args, stdin, runId: `${id}-${Date.now()}`,
      onStdout: (s)=>{ if (interactive) process.stdout.write(s); reporter?.runChunk({ id, stream: 'stdout', chunk: s }); },
      onStderr: (s)=>{ if (interactive) process.stderr.write(s); reporter?.runChunk({ id, stream: 'stderr', chunk: s }); },
    });
    const runSummary = { id, args, ...res };
    runs.push(runSummary);
  runIndex[id] = runSummary;
  lastRun = runSummary;
    reporter?.runEnd({ id, code: res.code });
    // If non-zero, try to auto-fix common missing dependency errors when network is allowed, then one LLM-based fix.
  if (res.code !== 0) {
      let autoFixed = false;
      if (config.limits?.network !== false) {
        try {
          const toolDir = path.join(config.sandboxDir, 'tools', id);
          const stderr = String(res.stderr || '');
          if (t.language === 'python') {
            const m = stderr.match(/ModuleNotFoundError: No module named ['"]([^'\"]+)['"]/);
            if (m && m[1]) {
              const pkg = m[1];
              const reqPath = path.join(toolDir, 'requirements.txt');
              const exists = await fs.pathExists(reqPath);
              const content = exists ? await fs.readFile(reqPath, 'utf8') : '';
              if (!content.split(/\r?\n/).some(line => line.trim() === pkg)) {
                await fs.appendFile(reqPath, (content && !content.endsWith('\n') ? '\n' : '') + pkg + '\n');
              }
              // Retry with requirements installation
              const retry = await sandbox.run({ language: t.language, entry: path.join('tools', id, t.entry), args, stdin, runId: `${id}-deps-${Date.now()}`,
                onStdout: (s)=>{ if (interactive) process.stdout.write(s); reporter?.runChunk({ id, stream: 'stdout', chunk: s }); },
                onStderr: (s)=>{ if (interactive) process.stderr.write(s); reporter?.runChunk({ id, stream: 'stderr', chunk: s }); },
              });
              runs.push({ id, retry: true, reason: 'auto-install-python', ...retry });
              runIndex[id] = retry;
              lastRun = retry;
              reporter?.runEnd({ id, code: retry.code });
              res = retry;
              if (retry.code === 0) autoFixed = true;
            }
          } else if (t.language === 'node') {
            const m = stderr.match(/Cannot find module ['"]([^'\"]+)['"]/);
            if (m && m[1]) {
              const pkg = m[1];
              const pkgJsonPath = path.join(toolDir, 'package.json');
              let pkgJson = { name: id, version: '0.0.0', private: true, dependencies: {} };
              if (await fs.pathExists(pkgJsonPath)) {
                try { pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')); } catch {}
                if (!pkgJson.dependencies) pkgJson.dependencies = {};
              }
              if (!pkgJson.dependencies[pkg]) {
                pkgJson.dependencies[pkg] = '*';
                await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
              }
              const retry = await sandbox.run({ language: t.language, entry: path.join('tools', id, t.entry), args, stdin, runId: `${id}-deps-${Date.now()}`,
                onStdout: (s)=>{ if (interactive) process.stdout.write(s); reporter?.runChunk({ id, stream: 'stdout', chunk: s }); },
                onStderr: (s)=>{ if (interactive) process.stderr.write(s); reporter?.runChunk({ id, stream: 'stderr', chunk: s }); },
              });
              runs.push({ id, retry: true, reason: 'auto-install-node', ...retry });
              runIndex[id] = retry;
              lastRun = retry;
              reporter?.runEnd({ id, code: retry.code });
              res = retry;
              if (retry.code === 0) autoFixed = true;
            }
          }
        } catch {}
      }
      // If still failing, attempt one iteration of fix via Gemini
      if (!autoFixed && res.code !== 0) {
      const fixPrompt = `Tool ${t.name} failed. stderr:\n${res.stderr}\n\nPropose a minimal patch to fix. Return JSON {files:{path: content}}`;
      const fix = await gemini.generate({ systemPrompt: SYSTEM_PROMPT, messages: [{ role: 'user', content: fixPrompt }], temperature: 0.2 });
      const fixJson = parseJsonBlocks(fix);
      if (fixJson?.files) {
        await writeToolCode({ sandboxDir: config.sandboxDir, toolId: id, files: fixJson.files });
        const retry = await sandbox.run({ language: t.language, entry: path.join('tools', id, t.entry), args, stdin: call.stdin || '', runId: `${id}-retry-${Date.now()}`,
          onStdout: interactive ? (s)=>process.stdout.write(s) : undefined,
          onStderr: interactive ? (s)=>process.stderr.write(s) : undefined,
        });
        runs.push({ id, retry: true, ...retry });
      }
      }
    }
  }

  const result = { goal, plan: plan.plan || plan, created, createdFiles, runs, tools: Object.values(tools).map(t => ({ id: t.id, name: t.name, entry: t.entry, language: t.language, purpose: t.purpose })) };
  // Produce a concise, human-friendly answer summarizing the outcome
  try {
    const last = runs[runs.length - 1];
    const contextText = [
      `Goal: ${goal}`,
      plan?.plan ? `Plan: ${typeof plan.plan === 'string' ? plan.plan : JSON.stringify(plan.plan)}` : '',
      last ? `Last run ${last.id} exit ${last.code}, stdout:\n${(last.stdout||'').slice(0,2000)}\nstderr:\n${(last.stderr||'').slice(0,1000)}` : '',
    ].filter(Boolean).join('\n\n');
    const answer = await new GeminiClient({ apiKey: config.gemini.apiKey, model: config.gemini.model, limits: config.limits }).generate({
      systemPrompt: 'You are a helpful assistant. Respond in clear, plain language. Keep it short (2-5 sentences).',
      messages: [{ role: 'user', content: `Given the following context, answer the goal directly.\n\n${contextText}` }],
      temperature: 0.2,
    });
    result.answer = (answer || '').trim();
  } catch {}
  addHistory(memory, 'assistant', JSON.stringify(result));
  memory.runs.push({ goal, steps: plan.steps || [], result, ts: Date.now() });
  await saveMemory(config, memory);
  reporter?.result(result);
  return result;
}
