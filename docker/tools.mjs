/**
 * tools.mjs — Shared tool implementations for sub-agent and edit-agent
 *
 * Single source of truth for workspace helpers and tool execution.
 * Both agent.mjs and edit-agent.mjs import from this module.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "fs";
import { join, relative } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Workspace helpers ───────────────────────────────────────────────────────

export const WORKSPACE = "/workspace";

export function resolvePath(p) {
  if (!p) return WORKSPACE;
  return p.startsWith("/") ? p : join(WORKSPACE, p);
}

export function listWorkspace(dir, depth = 0) {
  if (depth > 3) return [];
  try {
    return readdirSync(dir).flatMap((entry) => {
      if (entry === "node_modules" || entry.startsWith(".")) return [];
      const fp = join(dir, entry);
      try {
        const st = statSync(fp);
        const rel = relative(WORKSPACE, fp);
        if (st.isDirectory()) return [rel + "/", ...listWorkspace(fp, depth + 1)];
        return [rel];
      } catch { return []; }
    });
  } catch { return []; }
}

// ── Tool status label (DRY helper for emitStatus) ───────────────────────────

export function toolStatusLabel(name, input) {
  const ctx = input.path ? ` (${input.path})`
    : input.url ? ` (${input.url})`
    : input.command ? ` (${input.command})`
    : "";
  return `Executando: ${name}${ctx}`;
}

// ── Core tool execution (shared by both agents) ─────────────────────────────

const COMMAND_TIMEOUT = 120_000; // 2 minutes

/**
 * Execute a tool by name. Returns a string result.
 *
 * @param {string} name  — Tool name
 * @param {object} input — Tool input parameters
 * @param {function} [extraHandler] — Optional handler for agent-specific tools.
 *        Called with (name, input); return undefined to fall through to default.
 */
export async function executeTool(name, input, extraHandler) {
  switch (name) {
    case "read_file": {
      const fp = resolvePath(input.path);
      try { return readFileSync(fp, "utf-8"); }
      catch (e) { return `Erro ao ler arquivo: ${e.message}`; }
    }
    case "write_file": {
      const fp = resolvePath(input.path);
      try {
        const dir = fp.substring(0, fp.lastIndexOf("/"));
        if (dir) mkdirSync(dir, { recursive: true });
        writeFileSync(fp, input.content ?? "", "utf-8");
        return `Arquivo escrito: ${fp}`;
      } catch (e) { return `Erro ao escrever arquivo: ${e.message}`; }
    }
    case "edit_file": {
      const fp = resolvePath(input.path);
      try {
        let content = readFileSync(fp, "utf-8");
        if (!content.includes(input.old_string)) {
          return `Erro: old_string não encontrado em ${fp}`;
        }
        content = content.replace(input.old_string, input.new_string);
        writeFileSync(fp, content, "utf-8");
        return `Arquivo editado: ${fp}`;
      } catch (e) { return `Erro ao editar arquivo: ${e.message}`; }
    }
    case "list_directory": {
      const dp = resolvePath(input.path);
      const entries = listWorkspace(dp);
      return entries.length ? entries.join("\n") : "(diretório vazio)";
    }
    case "run_command": {
      try {
        const { stdout, stderr } = await execFileAsync(
          input.command,
          input.args ?? [],
          { cwd: WORKSPACE, timeout: COMMAND_TIMEOUT }
        );
        return (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");
      } catch (e) {
        return `Saída ${e.code ?? 1}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
      }
    }
    default: {
      // Let the caller handle agent-specific tools (web_fetch, rick_memory, etc.)
      if (extraHandler) {
        const result = await extraHandler(name, input);
        if (result !== undefined) return result;
      }
      return `Ferramenta desconhecida: ${name}`;
    }
  }
}
