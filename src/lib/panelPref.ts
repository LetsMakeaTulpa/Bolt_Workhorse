/**
 * Whether the investigation panel is collapsed.
 *
 * The panel earns its width while sources are being read and costs it while the answer is; a user
 * who collapses it is closing a thing they will want open again later, not for this tab. Kept on the
 * device rather than in the account: it is where this screen puts a panel, not who the account is,
 * and it has to be readable synchronously while the first render is being decided.
 *
 * The default is open, which is what the panel did before it could remember anything. A stored
 * value is the only thing that starts it closed.
 */
const KEY = 'fieldwork.panel-collapse.v1';

/** Only an explicit `collapsed` closes the panel; anything else — junk, `open`, nothing — opens it. */
export function parsePanelCollapsed(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'collapsed';
}

export function readPanelCollapsed(): boolean {
  try {
    return parsePanelCollapsed(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
  } catch {
    // storage blocked: the panel still opens, it just cannot remember that it was closed
    return false;
  }
}

export function writePanelCollapsed(collapsed: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    // a preference that cannot persist still applies to this session
  }
}

export const PANEL_COLLAPSE_KEY = KEY;
