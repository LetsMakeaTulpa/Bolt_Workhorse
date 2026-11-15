/**
 * Splits a model answer into prose and its trailing follow-up questions.
 *
 * The prompt asks for a final `FOLLOW-UPS` section with one bullet per question. Models drift, so
 * the section is only treated as such when the heading is followed exclusively by bullets — an
 * answer that happens to mention "follow-ups" mid-sentence keeps its text.
 */

const FOLLOW_UP_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*follow[\s-]?ups?\b\s*(?:\*\*)?\s*:?\s*$/i;
const BULLET = /^(?:[-*•]|\d+[.)])\s+/;

export interface ParsedAnswer {
  /** the answer with the follow-up section removed */
  body: string;
  followUps: string[];
}

function clean(question: string): string {
  return question
    .replace(BULLET, '')
    .replace(/\*\*|__/g, '')
    .replace(/^[`"']+|[`"']+$/g, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
}

export function splitFollowUps(content: string): ParsedAnswer {
  const lines = content.split('\n');

  // the section belongs at the end, so scan backwards and stop at the last heading
  let heading = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (FOLLOW_UP_HEADING.test(lines[i])) {
      heading = i;
      break;
    }
  }
  if (heading < 0) return { body: content.trim(), followUps: [] };

  const tail = lines.slice(heading + 1).filter((line) => line.trim());
  if (tail.length === 0 || !tail.every((line) => BULLET.test(line.trim()))) {
    return { body: content.trim(), followUps: [] };
  }

  const followUps = tail
    .map(clean)
    .filter(Boolean)
    .filter((question) => question.length <= 200)
    .slice(0, 4);

  if (followUps.length === 0) return { body: content.trim(), followUps: [] };

  return { body: lines.slice(0, heading).join('\n').trim(), followUps };
}
