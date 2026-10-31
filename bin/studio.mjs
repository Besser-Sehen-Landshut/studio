#!/usr/bin/env node
// Studio control-room CLI. Runs the built module, or the TypeScript source in an unbuilt checkout.
async function load(name) {
  try {
    return await import(new URL(`../dist/${name}.js`, import.meta.url).href);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  // Fallback for a checkout that was not built: native TypeScript type stripping.
  return await import(new URL(`../src/${name}.ts`, import.meta.url).href);
}

const { runCli } = await load('cli');
const { realPorts } = await load('ports');
const { homedir } = await import('node:os');

const code = await runCli(process.argv.slice(2), {
  ports: realPorts(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  homedir: homedir(),
  cwd: process.cwd(),
});
process.exitCode = code;
