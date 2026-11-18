import type { CompilationReport } from '../types';

/**
 * One line for the activity trail describing what the query compiler did.
 *
 * The compiler is a model call made on the owner's account before any engine runs, so it is
 * recorded like the extraction step is: which model, whether it ran, what it cost, and why it did
 * not when that is the case. A rewritten question must never be a silent expense, and a skipped
 * compiler must not look like a compiled one.
 */
export function describeCompilation(report: CompilationReport): string {
  switch (report.reason) {
    case 'disabled':
      return 'Query compilation off for this run — searched the question as typed';
    case 'no_key':
      return 'Query compilation skipped (no model key configured) — searched the question as typed';
    case 'timeout':
      return `Query compiler did not answer in time (${report.model}) — searched the question as typed`;
    case 'error':
      return `Query compiler failed (${report.model}${report.detail ? `: ${report.detail}` : ''}) — searched the question as typed`;
    case 'empty':
      return `Query compiler returned no queries (${report.model}) — searched the question as typed`;
    default: {
      const count = report.queries?.length ?? 0;
      const cost = report.tokens ? ` · ${report.tokens} tokens` : '';
      return `Compiled ${count} search ${count === 1 ? 'query' : 'queries'} with ${report.model} (${report.duration_ms} ms${cost})`;
    }
  }
}

/** A compiler that errored or timed out is a failed step, not a quiet one. */
export function compilationStatus(report: CompilationReport): 'completed' | 'failed' {
  return report.reason === 'error' || report.reason === 'timeout' ? 'failed' : 'completed';
}
