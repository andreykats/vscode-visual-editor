import path from 'node:path';

const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/;

export function isScript(file: string): boolean {
  return SCRIPT_EXT.test(file);
}

/** Pages Vite serves through `transformIndexHtml`. */
export function isHtml(file: string): boolean {
  return file.endsWith('.html');
}

export function stripScriptExt(file: string): string {
  return file.replace(SCRIPT_EXT, '');
}

/**
 * Resolves a relative (`./x`) or root-relative (`/src/x`) import specifier to
 * an absolute path without its script extension. Bare specifiers return null.
 */
export function resolveImportBase(source: string, importer: string, root: string): string | null {
  if (source.startsWith('./') || source.startsWith('../')) {
    return stripScriptExt(path.resolve(path.dirname(importer), source));
  }
  if (source.startsWith('/')) return stripScriptExt(path.join(root, source));
  return null;
}

export function toRel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** Module id without Vite's query/hash suffix. */
export function cleanId(id: string): string {
  return id.replace(/[?#].*$/, '');
}
