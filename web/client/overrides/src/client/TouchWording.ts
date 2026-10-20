// LostCity iOS port: touch wording for the game's own instructions. New module (no upstream counterpart), used by
// Client (patch "touch wording") on a touch screen for every text the server sets (IF_SETTEXT: Tutorial Island's
// instructions, dialogues, message boxes) and for the interfaces' own texts ("Click here to continue").
//
// The table holds exact, case-sensitive phrases from the rev-274 content (Server/content/scripts), applied in order to
// one line at a time. The server splits long texts into lines (split_init with the font's metrics) and sends every line
// on its own, so a phrase broken over two lines has an entry per piece ('start' / 'end': only at the start / end of a
// line). Every replacement keeps the line within the width the server split it to (450 px of q8 in the tutorial box,
// 380 in dialogues, 470 in message boxes) and static texts within their component; most get shorter. "Mouse" as an
// animal and "click" as a sound ("a satisfying 'click'", "CLICK!") match nothing here.

type Where = 'start' | 'end';

export const TOUCH_WORDING: readonly (readonly [string, string, Where?])[] = [
    // Tutorial Island's first steps
    ['use your left mouse-button to click', 'tap'],
    ["use your keyboard's arrow keys to rotate the view", 'drag the view with your finger to turn it'],
    ["If you can't see him, use your", "If you can't see him, drag the", 'end'],
    ["keyboard's arrow keys to rotate the view.", 'view with your finger to turn it.', 'start'],
    ['by pressing the arrow keys', 'by dragging it'],
    ['with the arrow keys', 'by dragging the view'],
    ['Moving your', 'Touching', 'end'],
    ['mouse over the icons', 'the icons', 'start'],
    ['As you pass the', 'As you touch', 'end'],
    ['mouse over an item', 'an item', 'start'],
    ['move your mouse over', 'touch'],
    ['put the mouse over', 'touch'],
    ['with your mouse', 'with your finger'],
    ['left-mouse button', 'finger'],
    ['Remember, to attack right', 'Remember, to attack', 'end'],
    ['click on the monster', 'long-press the monster', 'start'],
    ['To deposit something right', 'To deposit something', 'end'],
    ['click it and select store', 'long-press it, select store', 'start'],
    ['but first click', 'but first tap', 'end'],
    ['found at the bottom right', 'found at the right'], // the tabs are a column on the right in the mobile layout
    ['in the bottom right', 'on the right'],
    // right click: a long-press
    ['Right clicking', 'Long-pressing'],
    ['right clicking on', 'long-pressing'],
    ['right click on', 'long-press'],
    ['right-click on', 'long-press'],
    ['right click', 'long-press'],
    ['right-click', 'long-press'],
    ['Right-click on', 'Long-press'],
    ['Right-click', 'Long-press'],
    // left click: a tap
    ['left clicking on', 'tapping'],
    ['left click on', 'tap'],
    ['left click', 'tap'],
    ['left-click', 'tap'],
    ['Clicking on', 'Tapping'],
    ['clicking on', 'tapping'],
    ['clicking', 'tapping'],
    ['Click on', 'Tap'],
    ['click on', 'tap'],
    ['Click to the gate', 'Tap the gate'],
    ['Click to continue', 'Tap to continue'],
    ['Click here to', 'Tap here to'],
    ['Click the', 'Tap the'],
    ['click the', 'tap the'],
    ['click it', 'tap it'],
    ['click below', 'tap below'],
    ['Click Dump', 'Tap Dump']
];

// `text` (one line) in touch wording; unchanged when nothing matches
export function touchWording(text: string): string {
    let out: string = text;
    for (const [from, to, where] of TOUCH_WORDING) {
        if (where === 'start') {
            if (out.startsWith(from)) {
                out = to + out.substring(from.length);
            }
        } else if (where === 'end') {
            if (out.endsWith(from)) {
                out = out.substring(0, out.length - from.length) + to;
            }
        } else if (out.indexOf(from) !== -1) {
            out = out.split(from).join(to);
        }
    }

    return out;
}
