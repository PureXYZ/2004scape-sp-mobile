// The licences page the apps carry: LICENSE and THIRD_PARTY_NOTICES.md as one plain-text file, which
// scripts/build-web.mjs writes to build/Game/licenses.txt and the host page shows under Settings › About › Licences
// (web/host/host.js about). Both apps ship build/Game, so this one file is the notices of both.
//
// The bundles do not carry the libraries' licence comments (esbuild's legalComments: 'none' in web/client/build.mjs;
// the engine's 'eof' finds none to keep): this file is where the notices are, for every component in them.
//
// Markdown becomes plain text that a narrow screen can wrap: a paragraph or a list item is one line, headings are
// underlined, a table row becomes a list item with its column names, links keep their address unless it is a link
// within the page, code blocks (the licence texts) are kept line for line, and the Contents list is left out.
//
//   node scripts/lib/notices.mjs   # prints it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The licences page as plain text (LICENSE, then THIRD_PARTY_NOTICES.md). */
export function renderNotices(repoDir = REPO_DIR) {
    const license = fs.readFileSync(path.join(repoDir, 'LICENSE'), 'utf8').trimEnd();
    const notices = fs.readFileSync(path.join(repoDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const title = '2004Scape: licences and notices';
    return [title, '='.repeat(title.length), '', license, '', '', markdownToText(notices)].join('\n').replace(/\n{3,}/g, '\n\n\n').trimEnd() + '\n';
}

function inline(text) {
    return text
        .replace(/\[([^\]]+)\]\((#[^)]*)\)/g, '$1') // a link within the page: its text
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => (label.includes(url.replace(/^https?:\/\//, '')) ? label : `${label} (${url})`))
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1');
}

const cells = line =>
    line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(c => inline(c.trim()));

export function markdownToText(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = null; // the paragraph or list item being joined into one line
    const flush = () => {
        if (para !== null) {
            out.push(para);
            para = null;
        }
    };
    let skipping = false; // inside the Contents section
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('```')) {
            flush();
            for (i++; i < lines.length && !lines[i].startsWith('```'); i++) {
                out.push(lines[i]);
            }
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            flush();
            const text = inline(heading[2]);
            skipping = text === 'Contents';
            if (skipping) {
                continue;
            }
            const rule = heading[1].length === 1 ? '=' : heading[1].length === 2 ? '-' : '~';
            out.push('', '', text, rule.repeat(text.length));
            continue;
        }
        if (skipping) {
            continue;
        }
        if (line.trim() === '') {
            flush();
            out.push('');
            continue;
        }
        if (line.trimStart().startsWith('|')) {
            flush();
            const header = cells(line);
            i++; // the |---| row
            while (i + 1 < lines.length && lines[i + 1].trimStart().startsWith('|')) {
                const row = cells(lines[++i]);
                out.push(`- ${row[0]}`);
                for (let c = 1; c < row.length; c++) {
                    if (row[c]) out.push(row[c].startsWith(header[c]) ? `    ${row[c]}` : `    ${header[c]}: ${row[c]}`);
                }
            }
            continue;
        }
        const quote = /^>\s?(.*)$/.exec(line);
        const item = /^(\s*)[-*]\s+(.*)$/.exec(line);
        if (item) {
            flush();
            para = `${item[1]}- ${inline(item[2])}`;
        } else if (quote) {
            para = para === null ? inline(quote[1]) : `${para} ${inline(quote[1])}`;
        } else {
            para = para === null ? inline(line.trim()) : `${para} ${inline(line.trim())}`;
        }
    }
    flush();
    return out.join('\n').replace(/^\n+/, '');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    process.stdout.write(renderNotices());
}
