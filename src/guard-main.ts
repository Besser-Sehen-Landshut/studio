// Claude Code PreToolUse hook for crew sessions. Fails closed on every error.
// Bundled to dist-bundle/studio-guard.mjs (see `pnpm bundle`); bin/studio-guard.mjs loads it.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateGuard } from './guard.js';

interface Summary {
  tool?: string;
  input?: string;
}

function deny(reason: string, summary?: Summary): void {
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

let summary: Summary | undefined;
try {
  const hook = JSON.parse(readFileSync(0, 'utf8'));
  const input = hook.tool_input ?? {};
  summary = { tool: hook.tool_name, input: JSON.stringify(input).slice(0, 300) };
  const ctxPath = process.env.STUDIO_GUARD_CTX;
  if (!ctxPath) {
    deny('guard context missing (STUDIO_GUARD_CTX not set)', summary);
  } else {
    let ctx: unknown;
    let readable = true;
    try {
      ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
    } catch {
      readable = false;
      deny('guard context unreadable', summary);
    }
    if (readable) {
      if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) {
        deny('guard context is not an object', summary);
      } else {
        const result = evaluateGuard(
          { toolName: hook.tool_name, toolInput: input, cwd: hook.cwd },
          ctx as Parameters<typeof evaluateGuard>[1],
        );
        if (result.decision === 'deny') deny(result.reason ?? 'denied by guard', summary);
      }
    }
  }
} catch (err) {
  deny(`guard error: ${err instanceof Error ? err.message : String(err)}`, summary);
}
