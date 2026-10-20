// Runs INSIDE Server/engine's tsx (started by compile.mjs, which also prepares the directories):
//   cwd                 a work dir under build/tmp/bots: data/pack/{server,client} = clones of the vanilla packs (the
//                       compile context: inv/varp/param/... types), output goes to data/pack/server/script.{dat,idx}
//   ../content          scripts + pack (*.pack id maps) cloned from Server/content, with the bot patches applied
//   LC_ENGINE_DIR       Server/engine: its modules are loaded in place (tsx resolves '#/' through --tsconfig)
//   LC_BOT_COMMANDS     web/engine/bots/src/port/BotScriptCommands.ts (the opcode numbers)
//
// The engine's own compiler takes command names and numbers from ScriptOpcodeMap (+ ScriptOpcodePointers) and the
// signatures from the [command,...] lines in engine.rs2 (0001 patch). The two bot commands are registered here at
// their explicit numbers, past the engine's last block, so no stock opcode moves; never edit ScriptOpcode.ts.
// Prints one line: `RESULT {json}`.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const engineDir = process.env.LC_ENGINE_DIR;
const commandsFile = process.env.LC_BOT_COMMANDS;
if (!engineDir || !commandsFile) {
    throw new Error('compile.mts is started by compile.mjs (LC_ENGINE_DIR and LC_BOT_COMMANDS are not set)');
}
const engine = (rel: string) => import(pathToFileURL(path.join(engineDir, rel)).href);

const numbers = (await import(pathToFileURL(commandsFile).href)) as { P_ISBOT: number; P_BOT_INTERACT_TRADE: number };
const commands: [string, number][] = [
    ['P_ISBOT', numbers.P_ISBOT],
    ['P_BOT_INTERACT_TRADE', numbers.P_BOT_INTERACT_TRADE]
];

const { ScriptOpcodeMap } = (await engine('src/engine/script/ScriptOpcode.ts')) as { ScriptOpcodeMap: Map<string, number> };
const pointers = (await engine('src/engine/script/ScriptOpcodePointers.ts')).default as Record<number, { require?: string[]; require2?: string[] }>;
const taken = new Map([...ScriptOpcodeMap].map(([name, opcode]) => [opcode, name]));
for (const [name, opcode] of commands) {
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0xffff) throw new Error(`${name}: bad opcode ${opcode}`);
    if (ScriptOpcodeMap.has(name)) throw new Error(`${name} already exists in the engine (opcode ${ScriptOpcodeMap.get(name)}): the overlay must not shadow it`);
    if (taken.has(opcode)) throw new Error(`opcode ${opcode} for ${name} is taken by ${taken.get(opcode)}`);
    ScriptOpcodeMap.set(name, opcode);
    // as upstream (ScriptOpcodePointers.ts): the active player, or the secondary one for the `.` variant
    pointers[opcode] = { require: ['active_player'], require2: ['active_player2'] };
}

const t0 = performance.now();
const { runServerCompiler } = await engine('tools/pack/Compiler.ts');
runServerCompiler();

// opcode numbers compile.mjs needs to walk the bytecode (ScriptFile.decode's operand rules)
const op = (name: string) => {
    const n = ScriptOpcodeMap.get(name);
    if (n === undefined) throw new Error(`ScriptOpcodeMap has no ${name}`);
    return n;
};
const result = {
    ms: Math.round(performance.now() - t0),
    commands: Object.fromEntries(commands.map(([name, opcode]) => [name.toLowerCase(), opcode])),
    opcodes: {
        PUSH_CONSTANT_STRING: op('PUSH_CONSTANT_STRING'),
        RETURN: op('RETURN'),
        POP_INT_DISCARD: op('POP_INT_DISCARD'),
        POP_STRING_DISCARD: op('POP_STRING_DISCARD'),
        GOSUB: op('GOSUB'),
        JUMP: op('JUMP')
    }
};
console.log('RESULT ' + JSON.stringify(result));
