import fs from 'fs-extra';
import path from 'path';
import { z } from 'zod';

const ToolManifest = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  language: z.enum(['python', 'node']),
  entry: z.string(),
  inputs: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean().optional() })).default([]),
  outputs: z.array(z.object({ name: z.string(), type: z.string() })).default([]),
  usage: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export async function saveTool({ sandboxDir, manifest }) {
  const parsed = ToolManifest.parse(manifest);
  const toolsDir = path.join(sandboxDir, 'tools', parsed.id);
  await fs.ensureDir(toolsDir);
  const manifestPath = path.join(toolsDir, 'manifest.json');
  await fs.writeJson(manifestPath, parsed, { spaces: 2 });
  return { ...parsed, path: toolsDir, manifestPath };
}

export async function writeToolCode({ sandboxDir, toolId, files }) {
  const toolsDir = path.join(sandboxDir, 'tools', toolId);
  await fs.ensureDir(toolsDir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(toolsDir, rel);
    await fs.ensureDir(path.dirname(abs));
    await fs.writeFile(abs, content, 'utf8');
  }
  return toolsDir;
}

export async function loadTools({ sandboxDir }) {
  const toolsRoot = path.join(sandboxDir, 'tools');
  await fs.ensureDir(toolsRoot);
  const ids = (await fs.readdir(toolsRoot)).filter((d) => !d.startsWith('.'));
  const out = {};
  for (const id of ids) {
    const manifestPath = path.join(toolsRoot, id, 'manifest.json');
    if (!(await fs.pathExists(manifestPath))) continue;
    try {
      const m = await fs.readJson(manifestPath);
      const parsed = ToolManifest.parse(m);
      out[id] = { ...parsed, path: path.join(toolsRoot, id), manifestPath };
    } catch (e) {
      // skip bad manifest
    }
  }
  return out;
}

export function toolsToPrompt(tools) {
  const lines = [];
  for (const t of Object.values(tools)) {
    lines.push(`- ${t.name} [${t.id}] (${t.language})\n  Purpose: ${t.purpose}\n  Entry: ${t.entry}\n  Inputs: ${t.inputs.map(i=>i.name+':'+i.type).join(', ')}\n  Outputs: ${t.outputs.map(o=>o.name+':'+o.type).join(', ')}\n  Usage: ${t.usage}`);
  }
  return lines.join('\n\n');
}
