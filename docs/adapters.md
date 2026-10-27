# Writing a source adapter

An adapter teaches the Vite plugin how one rendering style creates elements. The plugin core already does the generic work:

- parsing with `oxc-parser`
- indexing every string literal, substitution-free template literal, JSX text and JSX attribute string, with exact UTF-16 offsets, raw text, cooked value and line/column
- skipping literals that are syntax rather than values: import sources, object keys, TS literal types, directives, `require()` arguments, and tagged templates
- counting how many places read a `const` literal, including across imports
- tagging creation sites, either by wrapping them as `__le(expr, loc)` or with a `data-vve-loc` attribute, and producing source maps
- indexing the text of HTML pages as Vite serves them, with no adapter involved
- serving `/__vibe-visual-editor/resolve`

The adapter supplies only facts that depend on the framework. The interface lives in `packages/protocol/src/adapter.ts`:

```ts
interface SourceAdapter {
  name: string;
  include(id: string, code: string): boolean;
  analyze(ctx: { id; code; root; program }): {
    creationSites: CreationSite[]; // expressions that create an element (Span, plus attributeAt for attribute tagging)
    excluded: Span[];              // literals inside these aren't rendered text
    owners: Map<number, number>;   // literal start -> creation-site start that has it as a direct child
  };
  rank(candidates: Candidate[], ctx: { elementLoc?: SourceLoc }): RankedCandidate[];
}
```

## The `h()` adapter (reference)

The reference implementation is `packages/vite-plugin/src/adapters/h.ts`. It works as follows:

- **`include`** accepts `.ts`/`.js` files outside `node_modules`.
- **`analyze`** finds imports of the factory from the configured module, both named (aliases included) and namespace (`dom.h`). Every call to the factory is a creation site. The first argument (the tag) is excluded, and so is the second when it's an object literal (the attributes). String-literal children are owned by their call.
- **`rank`** orders candidates: first a literal owned by the element's own call (rank 0), then any literal in the element's module (rank 1), then any literal elsewhere (rank 2). If several candidates share the best rank, the user picks one.

## The React adapter

`packages/vite-plugin/src/adapters/react.ts` covers JSX. JSX differs from `h()` in two ways, and the core handles both:

- **Tagging.** `<div>` evaluates to a React element, not a DOM node, so the `__le` wrapper can't record which DOM element it becomes. A creation site can instead set `attributeAt`, and the core inserts `data-vve-loc="token:start:end:line:column"` there. The element carries the attribute into the DOM, including through server rendering. Each module registers its file path once under the short token, so the attribute never repeats paths.
- **Literal kinds.** JSX text (`<h2>Videos</h2>`) and JSX attribute strings (`title="Hi"`) aren't JS strings. The protocol has two more literal kinds, `jsx` and `jsx-attr`. `cookJsxText` and `cookJsxAttribute` turn source into the rendered string, and `literalRaw` writes a value back. Cooking follows oxc's JSX transform, which is what Vite uses, and a conformance test compares the two. Where JSX compilers disagree, cooking returns `null` and the text isn't offered.

The adapter itself:

- **`include`**: script files outside `node_modules`, so constants in `.ts` files are indexed too.
- **`analyze`**: every lowercase JSX element (`<div>`, `<my-element>`) is a creation site, tagged after its name. Its attribute values are excluded, and its JSX text and string children are owned by it. Components aren't tagged, since they render their own elements. Their string props stay indexed, because props like `title` are often rendered as text, except props that never are (`key`, `className`, `style`, `id`, `href`, `src`, `type`, `role`, `htmlFor`, `data-*`, `aria-*`).
- **`rank`**: the same ownership rule as `h()`.

## Testing an adapter

Add cases that build a `SourceIndex` with your adapter and assert on `analyzeDetached` and `resolve` (see `packages/vite-plugin/test/indexer.test.ts` and `jsx.test.ts`). Also add a fixture app under `fixtures/` with a plugin integration test (`plugin.test.ts`, `react.test.ts`) and page tests in `tests/page/`.
