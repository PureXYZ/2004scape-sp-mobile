// 274's wear requirements, read from the content's scripts: each [opheld2,obj] block's @levelrequire_* label (the
// levelrequire scripts, tier1-tier70.rs2, and the few elsewhere) and any literal stat_base(stat) < N in it. The bots'
// gear goes on past the wear script, so the tests hold it to these.
import fs from 'fs';
import path from 'path';
import { CONTENT_DIR } from './paths.mjs';

const STAT = { attack: 'atk', strength: 'str', defence: 'def', ranged: 'range', magic: 'magic' };
/** each label's levels from its arguments (a quest label's levels; the quest itself is not checked) */
const LABEL = {
    attack: a => ({ atk: a[0] }),
    attack_caps: a => ({ atk: a[0] }),
    defence: a => ({ def: a[0] }),
    defence_caps: a => ({ def: a[0] }),
    ranged: a => ({ range: a[0] }),
    ranged_lower: a => ({ range: a[0] }),
    magic: a => ({ magic: a[0] }),
    magic_and_attack: a => ({ magic: a[0], atk: a[1] }),
    ranged_and_defence: a => ({ range: a[0], def: a[1] }),
    defence_and_strength: a => ({ def: a[0], str: a[0] }),
    magic_and_defence: a => ({ magic: a[0], def: a[1] }),
    attack_and_strength: a => ({ atk: a[0], str: a[1] }),
    dragon_slayer_quest_defence: a => ({ def: a[0] }),
    dragon_slayer_quest_ranged_and_defence: a => ({ range: a[0], def: a[1] }),
    heroes_quest_attack: a => ({ atk: a[0] }),
    legends_quest_defence: a => ({ def: a[0] }),
    zanaris_quest_attack: a => ({ atk: a[0] }),
    viking_quest_helm: a => ({ def: a[0] }),
    iban_staff: () => ({ magic: 50, atk: 50 }),
    regicide_quest_attack_strength: a => ({ atk: a[0], str: a[1] })
};

let cached = null;

/** debugname → { atk?, str?, def?, range?, magic? }; throws on a label it does not know (a new one to add above) */
export function levelRequirements() {
    if (cached) return cached;
    const out = new Map();
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const f = path.join(dir, e.name);
            if (e.isDirectory()) walk(f);
            else if (e.name.endsWith('.rs2')) {
                const src = fs.readFileSync(f, 'utf8');
                for (const [, obj, body] of src.matchAll(/^\[opheld2,([a-z0-9_]+)\]([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
                    const req = {};
                    for (const [, label, argText] of body.matchAll(/@levelrequire_([a-z_]+)\(([^)]*)\)/g)) {
                        if (!LABEL[label]) throw new Error(`levelrequire: unknown label levelrequire_${label} (${obj}, ${f})`);
                        Object.assign(req, LABEL[label](argText.split(',').map(x => Number(x.trim()))));
                    }
                    for (const [, stat, level] of body.matchAll(/stat_base\((attack|strength|defence|ranged|magic)\) *< *(\d+)/g)) req[STAT[stat]] = Math.max(req[STAT[stat]] ?? 0, Number(level));
                    if (Object.keys(req).length) out.set(obj, req);
                }
            }
        }
    };
    walk(path.join(CONTENT_DIR, 'scripts'));
    return (cached = out);
}

/** the levels these stats ({ atk, str, def, range, magic }; missing = 1) lack for the item: "def 30<40", or '' */
export function shortOf(debugname, levels) {
    const req = levelRequirements().get(debugname);
    if (!req) return '';
    return Object.entries(req)
        .filter(([k, need]) => (levels[k] ?? 1) < need)
        .map(([k, need]) => `${k} ${levels[k] ?? 1}<${need}`)
        .join(', ');
}
