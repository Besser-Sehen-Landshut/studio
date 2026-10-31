#!/usr/bin/env node
// Claude Code PreToolUse hook for crew sessions. Fails closed on every error.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function deny(reason, summary) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  const dir = process.env.STUDIO_STATE_DIR;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, 'guard.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), tool: summary?.tool ?? null, reason, input: summary?.input ?? null })}\n`,
      );
    } catch {
      // logging must never turn a deny into an allow
    }
  }
}

async function loadGuard() {
  try {
    return await import(new URL('../dist/guard.js', import.meta.url).href);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  // Fallback for a checkout that was not built: native TypeScript type stripping.
  return await import(new URL('../src/guard.ts', import.meta.url).href);
}

let summary;
try {
  const raw = readFileSync(0, 'utf8');
  const hook = JSON.parse(raw);
  const input = hook.tool_input ?? {};
  summary = { tool: hook.tool_name, input: JSON.stringify(input).slice(0, 300) };
  const ctxPath = process.env.STUDIO_GUARD_CTX;
  if (!ctxPath) {
    deny('guard context missing (STUDIO_GUARD_CTX not set)', summary);
  } else {
    let ctx;
    try {
      ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    } catch {
      deny('guard context unreadable', summary);
    }
    if (ctx !== undefined && (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx))) {
      deny('guard context is not an object', summary);
    } else if (ctx) {
      const { evaluateGuard } = await loadGuard();
      const result = evaluateGuard(
        { toolName: hook.tool_name, toolInput: input, cwd: hook.cwd },
        ctx,
      );
      if (result.decision === 'deny') deny(result.reason ?? 'denied by guard', summary);
    }
  }
} catch (err) {
  deny(`guard error: ${err instanceof Error ? err.message : String(err)}`, summary);
}
