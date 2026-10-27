import { LOC_ATTRIBUTE, type LocFile, type SourceLoc } from '@vibe-visual-editor/protocol';

/** A table shared with the plugin's runtime module through a global symbol. */
function shared<T extends object>(name: string, make: () => T): T {
  const g = globalThis as unknown as Record<symbol, T | undefined>;
  return (g[Symbol.for(name)] ??= make());
}

/** Creation sites recorded by the plugin's `__le` wrapper. */
const wrapped = () => shared('vibe-visual-editor.locs', () => new WeakMap<object, SourceLoc>());
/** Module token -> file, registered by `__leFile` in each module that uses `data-vve-loc`. */
const files = () => shared('vibe-visual-editor.files', () => new Map<string, LocFile>());

/** Records the files behind a page's own module tokens, passed in by the host that served it. */
export function registerFiles(entries: Readonly<Record<string, LocFile>>): void {
  for (const [token, entry] of Object.entries(entries)) files().set(token, entry);
}

const ATTRIBUTE_VALUE = /^([0-9a-z]+):(\d+):(\d+):(\d+):(\d+)$/;

/** The creation site in an element's `data-vve-loc` attribute (`token:start:end:line:column`). */
function fromAttribute(el: Element): SourceLoc | undefined {
  const match = ATTRIBUTE_VALUE.exec(el.getAttribute(LOC_ATTRIBUTE) ?? '');
  const source = match && files().get(match[1]!);
  if (!match || !source) return undefined;
  return { ...source, start: Number(match[2]), end: Number(match[3]), line: Number(match[4]), column: Number(match[5]) };
}

/** The element's creation site, from the `__le` wrapper or its `data-vve-loc` attribute. */
export function locOf(el: Element): SourceLoc | undefined {
  return wrapped().get(el) ?? fromAttribute(el);
}

/** The element's own creation site, or the nearest tagged ancestor's. */
export function nearestLoc(el: Element): { loc: SourceLoc; isAncestor: boolean } | undefined {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const loc = locOf(cur);
    if (loc) return { loc, isAncestor: cur !== el };
  }
  return undefined;
}
