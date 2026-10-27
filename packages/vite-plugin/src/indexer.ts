import { parseSync } from 'oxc-parser';
import { cookJsxAttribute, cookJsxText, type AstNode, type LiteralEntry, type Quote, type SourceAdapter, type SourceLoc, type Span } from '@vibe-visual-editor/protocol';
import { lineStarts, positionAt, toRel } from '@vibe-visual-editor/server-core';
import { isNode, nameOf, walk } from './ast';
import { resolveImportBase } from './paths';

export interface ImportBinding {
  /** Resolved target path without extension. */
  target: string;
  imported: string;
  local: string;
}

/** Everything the index keeps about one module. */
export interface ModuleRecord {
  file: string;
  rel: string;
  adapter: SourceAdapter;
  literals: LiteralEntry[];
  /** Identifier name -> number of references in this module. */
  refs: Map<string, number>;
  /** Local binding name -> names it is exported as. */
  exportsByLocal: Map<string, string[]>;
  imports: ImportBinding[];
}

export interface CreationSiteLoc extends SourceLoc {
  /** Where to insert a `data-vve-loc` attribute instead of wrapping the expression. */
  attributeAt?: number;
}

export interface ModuleAnalysis {
  record: ModuleRecord;
  creationSites: CreationSiteLoc[];
  /** Offset after the directive prologue (`'use client'` etc.), where injected imports go. */
  headerAt: number;
}

export class ParseError extends Error {}

/** Parents under which a string literal is syntax, not a runtime value. */
function isNonValuePosition(node: AstNode, parent: AstNode | undefined, key: string): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ImportExpression':
    case 'TSExternalModuleReference':
    case 'TSImportType':
      return key === 'source' || key === 'argument';
    case 'ImportAttribute':
    case 'ImportSpecifier':
    case 'ExportSpecifier':
    case 'TSLiteralType':
    case 'TSEnumMember':
    case 'TSModuleDeclaration':
      return true;
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
      return key === 'key' && !parent.computed;
    case 'ExpressionStatement':
      return typeof parent.directive === 'string';
    case 'CallExpression': {
      const callee = parent.callee as AstNode;
      return callee.type === 'Identifier' && callee.name === 'require';
    }
    case 'TaggedTemplateExpression':
      return node.type === 'TemplateLiteral';
    default:
      return false;
  }
}

/** Identifier positions that declare or name something rather than read a binding. */
function isReference(parent: AstNode | undefined, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case 'VariableDeclarator':
      return key !== 'id';
    case 'MemberExpression':
      return key !== 'property' || Boolean(parent.computed);
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'TSPropertySignature':
      // A shorthand `{ x }` is visited again as `value`, which is where it counts.
      return key !== 'key' || Boolean(parent.computed);
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return key !== 'id' && key !== 'params';
    default:
      return true;
  }
}

function within(spans: readonly Span[], offset: number): boolean {
  return spans.some((s) => offset >= s.start && offset < s.end);
}

export function parseModule(file: string, code: string): AstNode {
  const result = parseSync(file, code);
  const fatal = result.errors.find((e) => e.severity === 'Error');
  if (fatal) throw new ParseError(`${file}: ${fatal.message}`);
  return result.program as unknown as AstNode;
}

/** Parses `code`, runs `adapter`, and builds the module's literal index and binding tables. */
export function analyzeModule(file: string, code: string, root: string, adapter: SourceAdapter): ModuleAnalysis {
  const program = parseModule(file, code);
  const facts = adapter.analyze({ id: file, code, root, program });
  const starts = lineStarts(code);
  const rel = toRel(root, file);
  const loc = (span: Span): SourceLoc => ({ file, rel, ...positionAt(starts, span.start), start: span.start, end: span.end });

  const literals: LiteralEntry[] = [];
  const refs = new Map<string, number>();
  const exportsByLocal = new Map<string, string[]>();
  const imports: ImportBinding[] = [];
  const addExport = (local: string, exported: string) => {
    const list = exportsByLocal.get(local) ?? [];
    list.push(exported);
    exportsByLocal.set(local, list);
  };

  walk(program, (node, ancestors, key) => {
    const parent = ancestors[ancestors.length - 1];

    if (node.type === 'Identifier') {
      if (isReference(parent, key)) refs.set(node.name as string, (refs.get(node.name as string) ?? 0) + 1);
      return;
    }

    if (node.type === 'ImportDeclaration' && isNode(node.source)) {
      const target = resolveImportBase(node.source.value as string, file, root);
      if (target) {
        for (const spec of (node.specifiers as AstNode[]) ?? []) {
          const local = nameOf(spec.local);
          const imported = spec.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(spec.imported);
          if (local && imported && spec.type !== 'ImportNamespaceSpecifier') imports.push({ target, imported, local });
        }
      }
    }

    if (node.type === 'ExportNamedDeclaration' && !node.source) {
      const decl = node.declaration as AstNode | null;
      if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations as AstNode[]) {
          const name = nameOf(d.id);
          if (name) addExport(name, name);
        }
      }
      for (const spec of (node.specifiers as AstNode[]) ?? []) {
        const local = nameOf(spec.local);
        const exported = nameOf(spec.exported);
        if (local && exported) addExport(local, exported);
      }
    }

    const isString = node.type === 'Literal' && typeof node.value === 'string';
    const isTemplate = node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0;
    if (!isString && !isTemplate && node.type !== 'JSXText') return;

    const raw = code.slice(node.start, node.end);
    let value: string | null | undefined;
    let quote: Quote | undefined;
    if (node.type === 'JSXText') {
      value = cookJsxText(raw);
      quote = 'jsx';
      // Whitespace between tags renders as nothing.
      if (value?.trim() === '') value = null;
    } else if (isString) {
      if (parent?.type === 'JSXAttribute') {
        value = cookJsxAttribute(raw.slice(1, -1));
        quote = 'jsx-attr';
      } else {
        value = node.value as string;
        quote = raw[0] as Quote;
      }
    } else {
      const cooked = ((node.quasis as AstNode[])[0]?.value as { cooked: string | null } | undefined)?.cooked;
      if (typeof cooked === 'string') value = cooked;
      quote = '`';
    }
    if (value === undefined) return;
    // null: the source can't be mapped to its rendered text with certainty, so it isn't offered for editing.
    if (value === null || quote === undefined) return false;
    if (isNonValuePosition(node, parent, key) || within(facts.excluded, node.start)) return false;

    let binding: string | undefined;
    const grand = ancestors[ancestors.length - 2];
    if (parent?.type === 'VariableDeclarator' && key === 'init' && grand?.type === 'VariableDeclaration' && grand.kind === 'const') {
      binding = nameOf(parent.id);
    }
    const owner = facts.owners.get(node.start);
    literals.push({
      id: `${file}:${node.start}`,
      ...loc(node),
      value,
      raw,
      quote,
      ...(owner !== undefined ? { owner } : {}),
      ...(binding ? { binding } : {}),
    });
    return false;
  });

  let headerAt = 0;
  for (const stmt of program.body as AstNode[]) {
    if (stmt.type !== 'ExpressionStatement' || typeof stmt.directive !== 'string') break;
    headerAt = stmt.end;
  }

  return {
    record: { file, rel, adapter, literals, refs, exportsByLocal, imports },
    creationSites: facts.creationSites.map((site) => ({
      ...loc(site),
      ...(site.attributeAt !== undefined ? { attributeAt: site.attributeAt } : {}),
    })),
    headerAt,
  };
}
