// One id, two directions: pressing a [n] marker lights the sentences that cite it and its source
// row; pressing the source row lights the same sentences. The mapping is the one the grounding pass
// already builds from the answer's own text, so nothing new is stored for it. These checks pin the
// transform that makes markers and sentences addressable, the markup it produces, and the click.
// Run: npm run smoke (or node experiments/citation-focus.test.mjs)

import { bundle, tmpPath } from './lib/build.mjs';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// smoke passes absolute paths; standalone the bundles live inside the project
const absolute = (file) => (/^(?:[A-Za-z]:|[\\/])/.test(file) ? file : `${process.cwd()}/${file}`);
const load = async (file) => import(`${pathToFileURL(absolute(file)).href}?t=${Date.now()}`);

const LIB = process.env.CITATION_FOCUS_MODULE ?? tmpPath('citation-focus.mjs');
const BUBBLE = process.env.CITATION_BUBBLE_MODULE ?? 'node_modules/.cache/fieldwork/citation-bubble.mjs';
if (!process.env.CITATION_FOCUS_MODULE) bundle('src/lib/citationFocus.ts', LIB);
if (!process.env.CITATION_BUBBLE_MODULE) {
  mkdirSync('node_modules/.cache/fieldwork', { recursive: true });
  // react-markdown's entity decoder resolves to a DOM build that touches `document` on import
  bundle('src/components/MessageBubble.tsx', BUBBLE, [
    '--jsx=automatic',
    '--external:react',
    '--external:react-dom',
    '--alias:decode-named-character-reference=./node_modules/decode-named-character-reference/index.js',
  ]);
}

const { transformCitations, splitSentenceChunks, CITATION_PREFIX, SENTENCE_PREFIX } = await load(LIB);
const { MessageBubble } = await load(BUBBLE);
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

const paragraphTree = (value) => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
});
const sentencesOf = (tree) => tree.children[0].children;
const textOf = (node) => (node.children ? node.children.map(textOf).join('') : (node.value ?? ''));
const urls = (nodes) => nodes.map((node) => node.url ?? '');

// 1. sentences are split the way the audit splits them, abbreviations included
{
  const chunks = splitSentenceChunks('Costs fell. They rose, e.g. 12% in 2024. Then flat!');
  check('text splits into its three sentences', chunks.length === 3, chunks.join('|'));
  check('an abbreviation does not start a sentence', /e\.g\. 12% in 2024\.$/.test(chunks[1].trim()), chunks[1].trim());
  check('the break leaves the space with the sentence it ends', chunks[0] === 'Costs fell. ', JSON.stringify(chunks[0]));
}

// 2. one node per sentence, tagged with the ids it cites
{
  const tree = paragraphTree('Costs fell 47% [1]. Policy changed [2][5]. No source here.');
  transformCitations(tree);
  const sentences = sentencesOf(tree);
  check('one node per sentence', sentences.length === 3, String(sentences.length));
  check(
    'each sentence carries the ids it cites',
    sentences.map((node) => node.url.slice(SENTENCE_PREFIX.length)).join('|') === '1|2.5|',
    sentences.map((node) => node.url).join(' '),
  );
  check('a sentence with no citation still gets an address', sentences[2].url === SENTENCE_PREFIX);
  const markers = sentences[0].children.filter((node) => node.url?.startsWith(CITATION_PREFIX));
  check('the markers became their own nodes', markers.length === 1 && markers[0].url === `${CITATION_PREFIX}1`);
  check('a marker keeps its bracket label', textOf(markers[0]) === '[1]', textOf(markers[0]));
  check('the sentence text is unchanged by the wrapping', textOf(sentences[0]).trim() === 'Costs fell 47% [1].', textOf(sentences[0]));
}

// 2b. emphasis is prose: it neither ends a sentence nor hides a marker
{
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'strong', children: [{ type: 'text', value: 'Costs fell 47% [1]. Policy changed [2].' }] },
          { type: 'text', value: ' The rest cites [1].' },
        ],
      },
    ],
  };
  transformCitations(tree);
  const sentences = sentencesOf(tree);
  check('a full stop inside bold ends a sentence', sentences.length === 3, String(sentences.length));
  check(
    'each unit carries only its own ids',
    sentences.map((node) => node.url.slice(SENTENCE_PREFIX.length)).join('|') === '1|2|1',
    sentences.map((node) => node.url).join(' '),
  );
  check('the bold survives the split', sentences.slice(0, 2).every((node) => node.children[0]?.type === 'strong'));
  check(
    'the sentence after the bold is its own unit',
    textOf(sentences[2]).trim() === 'The rest cites [1].',
    JSON.stringify(textOf(sentences[2])),
  );
  check('the words are unchanged', textOf(sentences[0]).trim() === 'Costs fell 47% [1].', JSON.stringify(textOf(sentences[0])));
  check(
    'the space between the two sentences survives the split',
    /\s$/.test(textOf(sentences[0])),
    JSON.stringify(textOf(sentences[0])),
  );
  check(
    'a marker inside bold became a marker',
    sentences[0].children[0].children.some((node) => node.url === `${CITATION_PREFIX}1`),
  );
  check('the sentence it does not cite is not in its unit', !textOf(sentences[0]).includes('Policy'), textOf(sentences[0]));
}

// 2c. a marker after a sentence-ending bold run opens the next sentence, it does not close the last
{
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'strong', children: [{ type: 'text', value: 'Costs fell 47% [1].' }] },
          { type: 'text', value: ' [2] Policy changed.' },
        ],
      },
    ],
  };
  transformCitations(tree);
  const sentences = sentencesOf(tree);
  check('the bold sentence ends at its own full stop', textOf(sentences[0]).trim() === 'Costs fell 47% [1].', textOf(sentences[0]));
  check(
    'the marker after it belongs to the next sentence',
    sentences[1].url === `${SENTENCE_PREFIX}2` && /^\[2\]/.test(textOf(sentences[1]).trim()),
    `${sentences[1].url} ${JSON.stringify(textOf(sentences[1]))}`,
  );
  check(
    'and the space between them survives',
    /\s$/.test(textOf(sentences[0])) || /^\s/.test(textOf(sentences[1])),
    `${JSON.stringify(textOf(sentences[0]))} | ${JSON.stringify(textOf(sentences[1]))}`,
  );
}

// 3. code and real links are not turned into markers
{
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'Run ' },
          { type: 'inlineCode', value: 'query [1]' },
          { type: 'text', value: ' first [2].' },
        ],
      },
      { type: 'code', value: 'cite [3]' },
    ],
  };
  transformCitations(tree);
  const inline = sentencesOf(tree)[0].children;
  check('inline code keeps its brackets', inline.some((node) => node.type === 'inlineCode' && node.value === 'query [1]'));
  check('fenced code is untouched', tree.children[1].value === 'cite [3]');
  check('the rest of the paragraph is still marked', urls(inline).includes(`${CITATION_PREFIX}2`), urls(inline).join(' '));
}
{
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'link', url: 'https://example.org/a', children: [{ type: 'text', value: 'the paper' }] },
          { type: 'text', value: ' says so [1].' },
        ],
      },
    ],
  };
  transformCitations(tree);
  const [sentence] = sentencesOf(tree);
  check('a real link keeps its url', sentence.children.some((node) => node.url === 'https://example.org/a'));
  check('a real link is not treated as a marker', !urls(sentence.children).some((url) => url.includes('https://') && url.startsWith(CITATION_PREFIX)));
  check('the sentence around it is tagged', sentence.url === `${SENTENCE_PREFIX}1`, sentence.url);
}
{
  const heading = { type: 'root', children: [{ type: 'heading', depth: 2, children: [{ type: 'text', value: 'CLAIM LEDGER [1]' }] }] };
  transformCitations(heading);
  check('a heading is not rewritten', heading.children[0].children[0].value === 'CLAIM LEDGER [1]');
}

// 4. what the bubble actually renders
const sources = [
  { title: 'A paper', url: 'https://example.org/a', snippet: 's', source_engine: 'exa', citation_id: '[1]' },
  { title: 'Another paper', url: 'https://example.org/b', snippet: 's', source_engine: 'exa', citation_id: '[2]' },
];
const message = {
  id: 'm-1',
  conversation_id: 'c-1',
  role: 'assistant',
  content: 'Costs fell 47% [1]. Policy changed [2].',
  created_at: '2026-11-17T00:00:00Z',
  search_enabled: true,
  model: 'x/y',
  search_results: sources,
};
const props = { message, isStreaming: false, query: 'costs' };
const html = renderToStaticMarkup(React.createElement(MessageBubble, props));
check('a citation renders as a control', /<button[^>]*data-citation="1"[^>]*>\[1\]<\/button>/.test(html), 'marker');
check('the marker says what it will do', /Highlight the sentences citing \[1\]/.test(html), 'title');
check('a sentence is addressable by the ids it cites', /<span[^>]*data-cites="1"/.test(html), 'sentence span');
check('the source row is a selection control', /data-source="1"/.test(html), 'source row');
check('the row still opens the page', /href="https:\/\/example\.org\/a"/.test(html), 'source link');
check('nothing is highlighted before a click', !/<span[^>]*data-cites[^>]*bg-accent\/15/.test(html), 'initial highlight');
const boldHtml = renderToStaticMarkup(
  React.createElement(MessageBubble, {
    ...props,
    message: { ...message, content: '**Costs fell 47% [1].** Policy changed [2].' },
  }),
);
check('a marker inside bold renders as a control', /<strong>[\s\S]{0,120}data-citation="1"/.test(boldHtml), 'bold marker');
check(
  'the rendered answer keeps its spaces around the split',
  /Costs fell 47% \[1\]\. Policy changed \[2\]\./.test(boldHtml.replace(/<[^>]+>/g, '')),
  boldHtml.replace(/<[^>]+>/g, ''),
);
check(
  'and the bold full stop splits the highlight units',
  (boldHtml.match(/data-cites="/g) || []).length === 2,
  String((boldHtml.match(/data-cites="/g) || []).length),
);

// 5. the click, both ways, with a mounted renderer
const { act, create } = await import('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let renderer;
await act(async () => {
  renderer = create(React.createElement(MessageBubble, props));
});
const nodes = () => {
  const all = [];
  const walk = (node) => {
    if (!node || typeof node === 'string') return;
    all.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(renderer.root);
  return all;
};
const find = (predicate) => nodes().find(predicate);
const highlighted = () =>
  nodes()
    .filter((node) => node.type === 'span' && node.props['data-cites'] !== undefined)
    .filter((node) => String(node.props.className ?? '').includes('bg-accent/15'))
    .map((node) => node.props['data-cites']);

check('nothing starts highlighted', highlighted().length === 0, highlighted().join(','));
const marker1 = find((node) => node.type === 'button' && node.props['data-citation'] === '1');
check('the marker is mounted', Boolean(marker1));
await act(async () => {
  marker1.props.onClick();
});
check('clicking a marker highlights the sentence citing it', highlighted().join(',') === '1', highlighted().join(','));
check(
  'clicking a marker presses its source row too',
  find((node) => node.type === 'button' && node.props['data-source'] === '1').props['aria-pressed'] === true,
);
check(
  'the marker reports itself pressed',
  find((node) => node.type === 'button' && node.props['data-citation'] === '1').props['aria-pressed'] === true,
);

const marker2 = find((node) => node.type === 'button' && node.props['data-citation'] === '2');
await act(async () => {
  marker2.props.onClick();
});
check('a different marker moves the highlight', highlighted().join(',') === '2', highlighted().join(','));

await act(async () => {
  find((node) => node.type === 'button' && node.props['data-citation'] === '2').props.onClick();
});
check('pressing the same marker again clears it', highlighted().length === 0, highlighted().join(','));

const row2 = find((node) => node.type === 'button' && node.props['data-source'] === '2');
await act(async () => {
  row2.props.onClick();
});
check('clicking a source row highlights its sentences', highlighted().join(',') === '2', highlighted().join(','));
check(
  'and the sentence it does not cite stays plain',
  nodes().filter((node) => node.type === 'span' && node.props['data-cites'] === '1' && String(node.props.className ?? '').includes('bg-accent/15')).length === 0,
);

// 6. the selection can be owned by the page, so the Sources panel presses the same id
{
  const walk = (root) => {
    const all = [];
    const visit = (node) => {
      if (!node || typeof node === 'string') return;
      all.push(node);
      (node.children ?? []).forEach(visit);
    };
    visit(root);
    return all;
  };
  let controlled;
  await act(async () => {
    controlled = create(React.createElement(MessageBubble, { ...props, focusedCitation: '2' }));
  });
  const controlledNodes = walk(controlled.root);
  check(
    'a citation selected elsewhere lights its sentences here',
    controlledNodes.filter(
      (node) => node.type === 'span' && node.props['data-cites'] === '2' && String(node.props.className ?? '').includes('bg-accent/15'),
    ).length === 1,
    'controlled highlight',
  );
  check(
    'and its source row reports the same state',
    controlledNodes.find((node) => node.type === 'button' && node.props['data-source'] === '2').props['aria-pressed'] === true,
  );

  // a press here has to reach the page, or the panel could not follow it
  const seen = [];
  let relayed;
  await act(async () => {
    relayed = create(React.createElement(MessageBubble, { ...props, onCitationFocus: (id) => seen.push(id) }));
  });
  const relayedNodes = walk(relayed.root);
  const marker = relayedNodes.find((node) => node.type === 'button' && node.props['data-citation'] === '2');
  await act(async () => {
    marker.props.onClick();
  });
  check('a marker press reports the selected id upward', seen.join(',') === '2', seen.join(','));
  await act(async () => {
    walk(relayed.root).find((node) => node.type === 'button' && node.props['data-citation'] === '2').props.onClick();
  });
  check('pressing it again reports the clear', seen.join(',') === '2,', seen.join(','));
}

const failures = results.filter((row) => !row.ok);
console.log(`\n${results.length - failures.length}/${results.length} assertions passed`);
if (failures.length) process.exit(1);
