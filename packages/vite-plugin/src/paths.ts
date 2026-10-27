import path from 'node:path';

const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?)$/;

export function isScript(file: string): boolean {
  return SCRIPT_EXT.test(file);
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

/** Module id without Vite's query/hash suffix. */
export function cleanId(id: string): string {
  return id.replace(/[?#].*$/, '');
}
