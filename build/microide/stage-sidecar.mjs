#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(__dirname, '..', '..');

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root || defaultRoot);
  const outDir = resolvePath(root, options.out || 'dist/microide/resources/microide');
  const sidecarSource = resolvePath(root, options.sidecar || 'sidecars/microclaude');
  const microClaudeSource = resolvePath(root, options.microClaude || 'microClaude');
  const defaultNodeRuntime = getDefaultNodeRuntime(root);
  const runtimeSource = options.noRuntime ? undefined : resolvePath(root, options.runtime || defaultNodeRuntime);
  const microClaudeRuntimeSource = options.noMicroClaudeRuntime
    ? undefined
    : resolveOptionalPath(root, options.microClaudeRuntime || runtimeSource || defaultNodeRuntime);
  const defaultConfigSource = options.noDefaultConfig
    ? undefined
    : resolveOptionalPath(root, options.defaultConfig || join('.runtime', 'microide', 'microclaude.config.json'));
  const runtimeTarget = runtimeSource ? getRuntimeTarget(outDir, runtimeSource) : undefined;
  const microClaudeRuntimeTarget = microClaudeRuntimeSource ? getMicroClaudeRuntimeTarget(outDir, microClaudeRuntimeSource) : undefined;

  if (options.clean) {
    assertSafeCleanRoot(root, outDir, options.allowOutsideRoot);
  }

  const plan = [
    ['sidecar adapter', sidecarSource, join(outDir, 'sidecars', 'microclaude')],
    ['microClaude cli', join(microClaudeSource, 'cli.js'), join(outDir, 'microClaude', 'cli.js')],
    ['microClaude package', join(microClaudeSource, 'package.json'), join(outDir, 'microClaude', 'package.json')],
    ['microClaude dependencies', join(microClaudeSource, 'node_modules'), join(outDir, 'microClaude', 'node_modules')],
  ];

  const optionalMicroClaudeEntries = [
    'vendor',
    join('stubs', 'bundle'),
  ];

  const runtimePlan = dedupeStageTargets([
    runtimeSource && runtimeTarget ? ['runtime', runtimeSource, runtimeTarget] : undefined,
    microClaudeRuntimeSource && microClaudeRuntimeTarget ? ['microClaude runtime', microClaudeRuntimeSource, microClaudeRuntimeTarget] : undefined,
  ]);
  plan.push(...runtimePlan);
  if (defaultConfigSource) {
    plan.push(['default config', defaultConfigSource, getDefaultConfigTarget(outDir)]);
  }

  if (options.dryRun) {
    printPlan({ root, outDir, plan, optionalMicroClaudeEntries, options });
    return;
  }

  if (options.clean) {
    await rm(outDir, { recursive: true, force: true });
  }

  await mkdir(outDir, { recursive: true });
  await stageSidecar(sidecarSource, join(outDir, 'sidecars', 'microclaude'), options);
  await stageMicroClaude(microClaudeSource, join(outDir, 'microClaude'), optionalMicroClaudeEntries, options);

  for (const [, source, target] of runtimePlan) {
    await copyPath(source, target);
  }
  if (defaultConfigSource) {
    await copyPath(defaultConfigSource, getDefaultConfigTarget(outDir));
  }

  const manifest = await createBundleManifest({
    root,
    outDir,
    sidecarDir: join(outDir, 'sidecars', 'microclaude'),
    microClaudeDir: join(outDir, 'microClaude'),
    runtimePath: runtimeTarget,
    microClaudeRuntimePath: microClaudeRuntimeTarget,
    defaultConfigPath: defaultConfigSource ? getDefaultConfigTarget(outDir) : undefined,
  });

  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`MicroIDE sidecar bundle staged at ${outDir}`);
}

function parseArgs(args) {
  const options = {
    includeTests: false,
    clean: false,
    dryRun: false,
    noRuntime: false,
    noMicroClaudeRuntime: false,
    noDefaultConfig: false,
    allowOutsideRoot: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--root':
        options.root = requireValue(args, ++i, arg);
        break;
      case '--out':
        options.out = requireValue(args, ++i, arg);
        break;
      case '--sidecar':
        options.sidecar = requireValue(args, ++i, arg);
        break;
      case '--microclaude':
        options.microClaude = requireValue(args, ++i, arg);
        break;
      case '--runtime':
        options.runtime = requireValue(args, ++i, arg);
        break;
      case '--microclaude-runtime':
        options.microClaudeRuntime = requireValue(args, ++i, arg);
        break;
      case '--default-config':
        options.defaultConfig = requireValue(args, ++i, arg);
        break;
      case '--include-tests':
        options.includeTests = true;
        break;
      case '--clean':
        options.clean = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-runtime':
        options.noRuntime = true;
        break;
      case '--no-microclaude-runtime':
        options.noMicroClaudeRuntime = true;
        break;
      case '--no-default-config':
        options.noDefaultConfig = true;
        break;
      case '--allow-outside-root':
        options.allowOutsideRoot = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function resolvePath(root, value) {
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

function resolveOptionalPath(root, value) {
  return value ? resolvePath(root, value) : undefined;
}

function assertSafeCleanRoot(root, outDir, allowOutsideRoot) {
  if (allowOutsideRoot) {
    return;
  }

  const rel = relative(root, outDir);
  if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
    throw new Error(`Refusing to clean output outside the repo root: ${outDir}`);
  }
}

function getRuntimeTarget(outDir, runtimeSource) {
  if (looksLikeFile(runtimeSource)) {
    return process.platform === 'win32'
      ? join(outDir, 'runtime', 'node.exe')
      : join(outDir, 'runtime', 'bin', 'node');
  }

  return join(outDir, 'runtime');
}

function getMicroClaudeRuntimeTarget(outDir, runtimeSource) {
  return getRuntimeTarget(outDir, runtimeSource);
}

function getDefaultConfigTarget(outDir) {
  return join(outDir, 'defaults', 'microclaude.config.json');
}

function getDefaultNodeRuntime(root) {
  const nodeRuntime = findBundledNodeRuntime(root);
  if (nodeRuntime) {
    return nodeRuntime;
  }

  return process.execPath;
}

function findBundledNodeRuntime(root) {
  const toolsRoot = join(root, '.tools');
  if (!existsSync(toolsRoot)) {
    return undefined;
  }

  const executable = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('node-')) {
      continue;
    }

    const candidate = join(toolsRoot, entry.name, executable);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function looksLikeFile(path) {
  return /\.[^\\/]+$/.test(path) || /(^|[\\/])(node|bun)(\.exe)?$/i.test(path);
}

async function stageSidecar(sourceDir, targetDir, options) {
  const entries = [
    'adapter',
    'schemas',
    'manifest.json',
    'package.json',
    'README.md',
  ];

  if (options.includeTests) {
    entries.push('tests');
  }

  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    await copyPath(join(sourceDir, entry), join(targetDir, entry));
  }
}

async function stageMicroClaude(sourceDir, targetDir, optionalEntries, options) {
  await mkdir(targetDir, { recursive: true });
  await copyPath(join(sourceDir, 'cli.js'), join(targetDir, 'cli.js'));
  await copyPath(join(sourceDir, 'package.json'), join(targetDir, 'package.json'));
  await copyPath(join(sourceDir, 'node_modules'), join(targetDir, 'node_modules'));

  for (const entry of optionalEntries) {
    const source = join(sourceDir, entry);
    if (await exists(source)) {
      await copyPath(source, join(targetDir, entry));
    }
  }

  if (options.fullMicroClaude) {
    await copyPath(sourceDir, targetDir);
  }
}

async function copyPath(source, target) {
  await assertExists(source);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    errorOnExist: false,
  });
}

function dedupeStageTargets(entries) {
  const byTarget = new Map();

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const [label, source, target] = entry;
    const targetKey = resolve(target);
    const sourceKey = resolve(source);
    const existing = byTarget.get(targetKey);
    if (!existing) {
      byTarget.set(targetKey, [label, source, target]);
      continue;
    }

    if (resolve(existing[1]) !== sourceKey) {
      throw new Error(`Refusing to stage ${label} from ${source} over ${existing[0]} from ${existing[1]} at ${target}. Use --no-runtime or --no-microclaude-runtime to keep one runtime.`);
    }

    byTarget.set(targetKey, [`${existing[0]} / ${label}`, existing[1], existing[2]]);
  }

  return Array.from(byTarget.values());
}

async function createBundleManifest({ root, outDir, sidecarDir, microClaudeDir, runtimePath, microClaudeRuntimePath, defaultConfigPath }) {
  const sidecarManifest = JSON.parse(await readFile(join(sidecarDir, 'manifest.json'), 'utf8'));
  const checksumTargets = new Set([
    join(sidecarDir, 'manifest.json'),
    join(sidecarDir, 'adapter', 'index.js'),
    join(microClaudeDir, 'cli.js'),
  ]);

  if (runtimePath && looksLikeFile(runtimePath)) {
    checksumTargets.add(runtimePath);
  }
  if (microClaudeRuntimePath && looksLikeFile(microClaudeRuntimePath)) {
    checksumTargets.add(microClaudeRuntimePath);
  }
  if (defaultConfigPath && looksLikeFile(defaultConfigPath)) {
    checksumTargets.add(defaultConfigPath);
  }

  const checksums = {};
  for (const file of checksumTargets) {
    if (await isFile(file)) {
      checksums[toPortablePath(relative(outDir, file))] = await sha256(file);
    }
  }

  return {
    name: 'microide-sidecar-runtime-bundle',
    version: '0.1.0',
    createdAt: new Date().toISOString(),
    root: toPortablePath(relative(root, outDir)),
    sidecar: {
      name: sidecarManifest.name,
      version: sidecarManifest.version,
      protocolVersion: sidecarManifest.protocolVersion,
      path: 'sidecars/microclaude',
      entry: 'sidecars/microclaude/adapter/index.js',
    },
    microClaude: {
      path: 'microClaude',
      cli: 'microClaude/cli.js',
      runtime: microClaudeRuntimePath
        ? {
            type: 'node',
            path: toPortablePath(relative(outDir, microClaudeRuntimePath)),
          }
        : undefined,
    },
    defaults: defaultConfigPath
      ? {
          config: toPortablePath(relative(outDir, defaultConfigPath)),
        }
      : undefined,
    runtime: runtimePath
      ? {
          type: 'node',
          path: toPortablePath(relative(outDir, runtimePath)),
        }
      : undefined,
    checksums,
  };
}

async function sha256(file) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', rejectHash);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertExists(path) {
  if (!(await exists(path))) {
    throw new Error(`Missing required path: ${path}`);
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function toPortablePath(path) {
  return path.replace(/\\/g, '/');
}

function printPlan({ root, outDir, plan, optionalMicroClaudeEntries, options }) {
  console.log('MicroIDE sidecar staging plan');
  console.log(`root: ${root}`);
  console.log(`out:  ${outDir}`);
  console.log(`clean: ${options.clean ? 'yes' : 'no'}`);
  for (const [label, source, target] of plan) {
    console.log(`${label}: ${source} -> ${target}`);
  }
  console.log(`optional microClaude entries: ${optionalMicroClaudeEntries.join(', ')}`);
}

function printHelp() {
  console.log(`Usage: node build/microide/stage-sidecar.mjs [options]

Options:
  --out <path>            Output directory. Default: dist/microide/resources/microide
  --root <path>           Repository root. Default: current microIDE repo
  --sidecar <path>        Sidecar source directory. Default: sidecars/microclaude
  --microclaude <path>    microClaude source directory. Default: microClaude
  --runtime <path>        Node runtime file or directory. Default: current node executable
  --microclaude-runtime <path>
                          Node runtime for the microClaude CLI. Default: .tools/node-*/node(.exe), then current node
  --default-config <path> Bundled default microClaude config. Default: .runtime/microide/microclaude.config.json
  --no-runtime            Do not stage a runtime
  --no-microclaude-runtime
                          Do not stage a dedicated microClaude CLI runtime
  --no-default-config     Do not stage a bundled default microClaude config
  --include-tests         Include sidecar protocol tests in the staged bundle
  --clean                 Remove the output directory before staging
  --dry-run               Print the plan without copying files
  --allow-outside-root    Allow --clean when --out is outside --root
`);
}
