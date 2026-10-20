#!/usr/bin/env node
// The bot modules the runtime glue can reach run inside the iOS engine worker (BOTS.md §5): no Node built-ins, no
// files, no network, no database, no process/Buffer/require/__dirname/import.meta, no timers (they fire while the
// world is paused and after it stopped: schedule in ticks, port/BotSchedule), and every console call goes through
// port/BotLog (gated by the debug flag, errors rate-limited). Also: every import resolves with its exact case (the
// bundler runs on a case-insensitive disk, a case-sensitive one would not find it), the upstream files the port
// replaces stay out of the bundle, and rev 254's CSV trim is gone.
//
//   node web/engine/bots/test/worker-safety.test.mjs
import fs from 'fs';
import path from 'path';
import { BOTS_SRC, ENGINE_DIR, typescript } from './lib/paths.mjs';
import { ENTRY_POINTS, reachableBotModules } from './lib/graph.mjs';

const ts = await typescript();
const modules = await reachableBotModules();
const failures = [];
const fail = (file, node, sf, what) => {
    const line = node ? sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 : 0;
    failures.push(`${file}${line ? `:${line}` : ''}: ${what}`);
};

const NODE_BUILTINS = new Set(['fs', 'path', 'url', 'http', 'https', 'net', 'tls', 'os', 'child_process', 'worker_threads', 'crypto', 'stream', 'zlib', 'module', 'events', 'readline', 'dgram', 'dns', 'cluster', 'perf_hooks', 'timers', 'util', 'buffer', 'process', 'vm']);
const FORBIDDEN_PACKAGES = ['ws', 'kysely', 'better-sqlite3', 'sqlite3', 'node-fetch', 'express'];
const FORBIDDEN_ENGINE = ['#/db/', '#/server/', '#/web/', '#/util/Logger', '#/util/OpenRS2', '#/util/PackFile', '#/lostcity/'];
const FORBIDDEN_GLOBALS = new Set(['process', 'Buffer', 'require', '__dirname', '__filename', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'importScripts']);
const NOT_IN_BUNDLE = ['BotDatabase.ts', 'BotTask.ts', 'debug/BotDebugServer.ts'];

/** Does `specifier` name a file that exists with exactly this case? */
function existsExactly(file) {
    const parts = path.relative('/', file).split(path.sep);
    let dir = '/';
    for (const part of parts) {
        if (!fs.existsSync(dir) || !fs.readdirSync(dir).includes(part)) return false;
        dir = path.join(dir, part);
    }
    return true;
}
function resolveEngine(specifier) {
    const rel = specifier.slice(2).replace(/\.js$/, '');
    for (const ext of ['.ts', '.js', '/index.ts']) {
        const file = path.join(ENGINE_DIR, 'src', rel + ext);
        if (fs.existsSync(file)) return file;
    }
    return path.join(ENGINE_DIR, 'src', rel + '.ts');
}

for (const [file, { sf, imports }] of modules) {
    // ---- imports ----
    for (const { specifier, resolved } of imports) {
        const bare = specifier.replace(/^node:/, '');
        if (specifier.startsWith('node:') || NODE_BUILTINS.has(bare.split('/')[0])) fail(file, null, sf, `imports the Node built-in '${specifier}'`);
        else if (FORBIDDEN_PACKAGES.includes(bare.split('/')[0])) fail(file, null, sf, `imports '${specifier}'`);
        else if (FORBIDDEN_ENGINE.some(p => specifier.startsWith(p))) fail(file, null, sf, `imports '${specifier}' (server, database or file code)`);

        let target = null;
        if (specifier.startsWith('#/engine/bot/')) {
            target = path.join(BOTS_SRC, resolved);
        } else if (specifier.startsWith('.')) {
            target = path.resolve(path.dirname(path.join(BOTS_SRC, file)), specifier.replace(/\.js$/, '.ts'));
        } else if (specifier.startsWith('#/')) {
            target = resolveEngine(specifier);
        }
        if (target && !existsExactly(target)) fail(file, null, sf, `'${specifier}' does not resolve with its exact case (${path.relative(BOTS_SRC, target)})`);
    }

    // ---- globals, import.meta, console ----
    let usesConsole = false;
    const visit = node => {
        if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) fail(file, node, sf, 'uses import.meta');
        if (ts.isIdentifier(node)) {
            const parent = node.parent;
            const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node) || ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === node) || (ts.isImportSpecifier(parent) && parent.propertyName === node);
            if (!isMemberName && FORBIDDEN_GLOBALS.has(node.text)) fail(file, node, sf, `uses ${node.text}`);
            if (ts.isPropertyAccessExpression(parent) && parent.name === node && FORBIDDEN_GLOBALS.has(node.text) && ts.isIdentifier(parent.expression) && ['globalThis', 'window', 'self'].includes(parent.expression.text)) {
                fail(file, node, sf, `uses ${parent.expression.text}.${node.text}`);
            }
            if (node.text === 'console' && !isMemberName && !(ts.isImportSpecifier(parent) && parent.name === node)) usesConsole = true;
            if (node.text === 'trimPathAtCsvBlock') fail(file, node, sf, "still has rev 254's trimPathAtCsvBlock");
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    if (usesConsole && file !== 'port/BotLog.ts') {
        const shadowed = sf.statements.some(
            s => ts.isImportDeclaration(s) && s.moduleSpecifier.text.endsWith('port/BotLog.js') && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) && s.importClause.namedBindings.elements.some(e => e.name.text === 'console' && e.propertyName?.text === 'botConsole')
        );
        if (!shadowed) fail(file, null, sf, "logs with console without `import { botConsole as console } from '#/engine/bot/port/BotLog.js'`");
    }
}
for (const file of NOT_IN_BUNDLE) {
    if (modules.has(file)) failures.push(`${file} is reachable from ${ENTRY_POINTS.join(', ')}: it must stay out of the bundle`);
}
if (!modules.has('port/BotLog.ts')) failures.push('port/BotLog.ts is not reachable');

console.log(`worker safety: ${modules.size} modules reachable from ${ENTRY_POINTS.length} entry points (${NOT_IN_BUNDLE.join(', ')} not among them)`);
if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`${failures.length} failure(s)`);
    process.exit(1);
}
console.log('ok');
