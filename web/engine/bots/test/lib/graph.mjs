// The bot modules the runtime glue can reach (BOTS.md §4.2: BotManager, BotChat, BotTrade, PlayerBotFields,
// BotScriptCommands) and what each one imports, from the TypeScript source. Upstream files nothing imports
// (BotTask.ts, BotDatabase.ts, debug/BotDebugServer.ts) are not in the bundle and not checked.
import fs from 'fs';
import path from 'path';
import { BOTS_DIR, BOTS_SRC, typescript } from './paths.mjs';

export const ENTRY_POINTS = ['BotManager.ts', 'port/BotChat.ts', 'port/BotTrade.ts', 'port/PlayerBotFields.ts', 'port/BotScriptCommands.ts'];

/** Map of reachable bot file (relative to src/) → { sf: SourceFile, imports: [{ specifier, resolved }] }. */
export async function reachableBotModules() {
    const ts = await typescript();
    const modules = new Map();
    const queue = ENTRY_POINTS.filter(f => fs.existsSync(path.join(BOTS_SRC, f)));
    while (queue.length) {
        const rel = queue.shift();
        if (modules.has(rel)) continue;
        const file = path.join(BOTS_SRC, rel);
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const imports = [];
        for (const stmt of sf.statements) {
            if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
                if (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly) continue;
                if (ts.isExportDeclaration(stmt) && stmt.isTypeOnly) continue;
                const specifier = stmt.moduleSpecifier.text;
                let resolved = null;
                if (specifier.startsWith('#/engine/bot/')) {
                    resolved = specifier.slice('#/engine/bot/'.length).replace(/\.js$/, '.ts');
                } else if (specifier.startsWith('.')) {
                    const abs = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
                    resolved = abs.startsWith(BOTS_SRC + path.sep) ? path.relative(BOTS_SRC, abs) : path.relative(BOTS_DIR, abs);
                }
                imports.push({ specifier, resolved });
                if (resolved && resolved.endsWith('.ts') && !resolved.startsWith('..') && fs.existsSync(path.join(BOTS_SRC, resolved))) queue.push(resolved);
            }
        }
        modules.set(rel, { sf, imports });
    }
    return modules;
}
