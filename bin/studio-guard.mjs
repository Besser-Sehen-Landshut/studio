#!/usr/bin/env node
// Claude Code PreToolUse hook for crew sessions. Loads the committed self-contained bundle (an
// installed plugin has no node_modules and no dist). Fails closed: if no entry can be loaded, deny.
async function load() {
  for (const rel of ['../dist-bundle/studio-guard.mjs', '../dist/guard-main.js']) {
    try {
      return await import(new URL(rel, import.meta.url).href);
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    }
  }
  throw new Error('guard bundle not found');
}

try {
  await load();
} catch (err) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `guard error: ${err instanceof Error ? err.message : String(err)}`,
      },
    })}\n`,
  );
}
