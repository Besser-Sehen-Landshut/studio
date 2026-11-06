// Claude Code PreToolUse hook for crew sessions. Fails closed on every error.
// Bundled to dist-bundle/studio-guard.mjs (see `pnpm bundle`); bin/studio-guard.mjs loads it.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentStartOf, markTimedOut, timeoutDecision } from './analyzer-timeout.js';
import { evaluateGuard, type GuardContext } from './guard.js';

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

/** Records a subagent's start for its analyzer timeout. It cannot block: errors are dropped. */
function subagentStart(hook: { agent_id?: unknown; agent_type?: unknown }): void {
  try {
    const ctxPath = process.env.STUDIO_GUARD_CTX;
    if (!ctxPath || typeof hook.agent_id !== 'string') return;
    const ctx = JSON.parse(readFileSync(ctxPath, 'utf8')) as GuardContext;
    if (ctx.timeouts === undefined) return;
    agentStartOf(
      ctx.timeouts.agentsFile,
      hook.agent_id,
      Date.now(),
      typeof hook.agent_type === 'string' ? hook.agent_type : undefined,
    );
  } catch {
    // The first tool call of the subagent records its start instead.
  }
}

/** A reviewer past its time: the deny line, or undefined. Throws to deny on any doubt. */
function overTime(hook: Record<string, unknown>, ctx: GuardContext): string | undefined {
  const t = ctx.timeouts;
  if (t === undefined) return undefined;
  const now = Date.now();
  const agentId = typeof hook.agent_id === 'string' ? hook.agent_id : undefined;
  const type = typeof hook.agent_type === 'string' ? hook.agent_type : undefined;
  const line = timeoutDecision(t, {
    now,
    ...(agentId === undefined
      ? {}
      : { agentId, agentStart: agentStartOf(t.agentsFile, agentId, now, type) }),
    toolName: String(hook.tool_name),
    toolInput: (hook.tool_input ?? {}) as Record<string, unknown>,
    ...(typeof hook.cwd === 'string' ? { cwd: hook.cwd } : {}),
  });
  // A subagent refused for time is recorded, so collect never takes its analyzer as a pass.
  if (line !== undefined && agentId !== undefined) markTimedOut(t.agentsFile, agentId, now, type);
  return line;
}

let summary: Summary | undefined;
try {
  const hook = JSON.parse(readFileSync(0, 'utf8'));
  if (hook?.hook_event_name === 'SubagentStart') {
    subagentStart(hook);
    process.exit(0);
  }
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
        // A reviewer past its time gets the timeout line before anything else is judged.
        const late = overTime(hook, ctx as GuardContext);
        const result: { decision: string; reason?: string } =
          late !== undefined
            ? { decision: 'deny', reason: late }
            : evaluateGuard(
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
