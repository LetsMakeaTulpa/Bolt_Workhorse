/**
 * Citations and sentences as addressable units in an answer.
 *
 * `checkGrounding` already knows, sentence by sentence, which citation IDs a sentence carries. That
 * mapping is enough to make the transcript answer "what does [1] actually say here?" without
 * storing anything new: the markers become controls, and the sentences they appear in become the
 * thing those controls light up. The same mapping runs in the other direction — pressing a source
 * lights every sentence that cites it — because both directions are one id.
 *
 * The work is a remark transform rather than a regex over the rendered HTML: mdast only hands over
 * text, so `[1]` inside a link, inline code or a fenced block is never turned into a marker, and a
 * sentence that contains emphasis or a real link is wrapped without breaking the markdown around it.
 *
 * Highlight spans are emitted as links with private fragment hrefs (`#cite-1`, `#say-1.3`) because
 * the renderer can tell them apart from a real link by their href, and because a fragment passes
 * react-markdown's default URL sanitising. They are rendered as a button and a span, never as
 * anchors, so nothing navigates when one is pressed.
 */
import { citationIds } from './grounding';

/** The slice of mdast this transform reads and writes. */
export interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

export const CITATION_PREFIX = '#cite-';
export const SENTENCE_PREFIX = '#say-';

/**
 * `[2]` → `2`: the one id a marker, a receipt row and a panel card all agree on. Brackets are how a
 * marker is written, never part of what it points at.
 */
export const citationIdOf = (marker?: string | null): string => String(marker ?? '').replace(/[^0-9]/g, '');

const CITATION = /\[(\d{1,3})\]/g;

/** A sentence ender followed by whitespace — the boundary `splitSentences` also uses. */
const ENDER = /[.!?]+(?=\s)/g;

/**
 * Abbreviations whose full stop does not end a sentence. Kept in step with the audit's own guard so
 * a highlight covers the same sentence the grounding strip talks about.
 */
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|vs|etc|fig|no|dr|mr|mrs|ms|prof|approx|ca|cf|al|ed|eds|pp|p|vol)\.$/i;

/** Container types whose text is not prose, or whose children must not be re-wrapped. */
const SKIP = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html', 'image', 'imageReference', 'heading']);

/** Emphasis is still prose: it changes how a sentence looks, not where it ends. */
const EMPHASIS = new Set(['strong', 'emphasis', 'delete']);

const textOf = (nodes: MarkdownNode[]): string =>
  nodes.map((node) => (node.children ? textOf(node.children) : (node.value ?? ''))).join('');

/**
 * Split raw text at sentence boundaries, keeping each break's trailing whitespace with the sentence
 * it ends. Abbreviations (`e.g. 2024`) join the sentence before them instead of starting a new one.
 */
export function splitSentenceChunks(value: string): string[] {
  const chunks: string[] = [];
  ENDER.lastIndex = 0;
  let start = 0;
  let match: RegExpExecArray | null;
  const push = (chunk: string) => {
    if (!chunk) return;
    const previous = chunks[chunks.length - 1];
    if (previous !== undefined && ABBREVIATION.test(previous.trimEnd())) chunks[chunks.length - 1] = previous + chunk;
    else chunks.push(chunk);
  };
  while ((match = ENDER.exec(value))) {
    let stop = match.index + match[0].length;
    while (stop < value.length && /\s/.test(value[stop])) stop += 1;
    push(value.slice(start, stop));
    start = stop;
  }
  push(value.slice(start));
  return chunks;
}

/** A text run with every `[n]` replaced by its own marker node. */
function citationsIn(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let last = 0;
  for (const match of value.matchAll(CITATION)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push({ type: 'text', value: value.slice(last, at) });
    nodes.push({ type: 'link', url: `${CITATION_PREFIX}${match[1]}`, children: [{ type: 'text', value: match[0] }] });
    last = at + match[0].length;
  }
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}

/** A node with its markers already replaced, and whether a sentence ended just before it. */
interface Piece {
  node: MarkdownNode;
  boundary: boolean;
}

/**
 * Flatten inline content into sentence pieces.
 *
 * Emphasis has to stay in the tree — a bold opening sentence and a cited phrase inside italics are
 * both rendered as they were written — but it must not stop sentence splitting: `**One [1]. Two
 * [2].**` is two sentences, and pressing [2] has to leave the sentence citing [1] alone. So a
 * container is cut at the same boundaries as plain text and rebuilt once per run, keeping its own
 * markup, and every `[n]` inside it becomes a marker like any other.
 */
function pieces(nodes: MarkdownNode[]): Piece[] {
  const out: Piece[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      splitSentenceChunks(node.value ?? '').forEach((chunk, index) => {
        // only the chunk's first node starts a sentence; its markers do not, or `[2]` would be
        // cut away from the words it belongs to
        citationsIn(chunk).forEach((marker, at) => out.push({ node: marker, boundary: at === 0 && index > 0 }));
      });
      continue;
    }
    if (EMPHASIS.has(node.type) && node.children) {
      let run: MarkdownNode[] = [];
      let startsSentence = false;
      const flushRun = () => {
        if (run.length === 0) return;
        out.push({ node: { ...node, children: run }, boundary: startsSentence });
        run = [];
      };
      for (const piece of pieces(node.children)) {
        if (piece.boundary) {
          flushRun();
          startsSentence = true;
        }
        run.push(piece.node);
      }
      flushRun();
      continue;
    }
    out.push({ node, boundary: false });
  }

  // A full stop can end a sentence at a node edge, where the whitespace after it lives in the next
  // node: `**BLUF [1].** The rest`, and `**BLUF.** [2] The rest` where the marker opens the next
  // sentence rather than closing the previous one. Reading the text accumulated so far handles both,
  // and `[1].` still does not break because the stop is then followed by a bracket, not a space.
  let before = '';
  let pending = false;
  for (let index = 0; index < out.length; index += 1) {
    const text = textOf([out[index].node]);
    const spoken = before.trimEnd();
    const closed =
      /[.!?]$/.test(spoken) && !ABBREVIATION.test(spoken) && (/\s$/.test(before) || /^\s/.test(text));
    // the break belongs to the first word after it: a bare space is not a sentence of its own
    if (index > 0 && closed) pending = true;
    if (pending && text.trim() !== '') {
      if (!out[index].boundary) out[index].boundary = true;
      pending = false;
    }
    before += text;
  }
  return out;
}

/** Group a paragraph's inline nodes into one node per sentence, tagged with the ids it cites. */
function decorate(children: MarkdownNode[]): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  let group: MarkdownNode[] = [];
  const flush = () => {
    const content = group;
    group = [];
    // A unit without words is not a sentence. A space that separates a marker from the words before
    // it has to stay, though: once the units are separate inline boxes it is the only separator left.
    if (!content.some((node) => textOf([node]).trim() !== '')) return;
    out.push({
      type: 'link',
      url: `${SENTENCE_PREFIX}${citationIds(textOf(content)).join('.')}`,
      children: content,
    });
  };

  for (const piece of pieces(children)) {
    if (piece.boundary) flush();
    group.push(piece.node);
  }
  flush();
  return out;
}

function walk(node: MarkdownNode): void {
  if (!node.children) return;
  if (node.type === 'paragraph') {
    node.children = decorate(node.children);
    return;
  }
  if (SKIP.has(node.type)) return;
  for (const child of node.children) walk(child);
}

/** Rewrite an mdast tree in place: markers become controls, sentences become highlight targets. */
export function transformCitations(tree: MarkdownNode): void {
  walk(tree);
}

/** The remark plugin `MessageBubble` renders answers with. */
export function remarkCitations(): (tree: MarkdownNode) => void {
  return (tree) => transformCitations(tree);
}
