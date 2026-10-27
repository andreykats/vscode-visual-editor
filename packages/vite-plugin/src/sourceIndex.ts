import type { Candidate, LiteralEntry, ResolveRequest, ResolveResponse, SourceAdapter } from '@vibe-visual-editor/protocol';
import { analyzeHtml } from './html';
import { analyzeModule, type ImportBinding, type ModuleAnalysis, type ModuleRecord } from './indexer';
import { isHtml, stripScriptExt } from './paths';

interface Importer {
  module: ModuleRecord;
  binding: ImportBinding;
}

/**
 * In-memory map from rendered text back to source literals, rebuilt module by
 * module as Vite transforms them, and page by page as it serves HTML.
 */
export class SourceIndex {
  private readonly modules = new Map<string, ModuleRecord>();
  /** Literal value -> every indexed literal with that value. */
  private readonly byValue = new Map<string, Set<LiteralEntry>>();
  /** Target module path (no extension) -> modules importing from it. */
  private readonly importers = new Map<string, Set<Importer>>();

  constructor(
    readonly root: string,
    readonly adapters: readonly SourceAdapter[],
  ) {}

  adapterFor(file: string, code: string): SourceAdapter | undefined {
    return this.adapters.find((a) => a.include(file, code));
  }

  /** Re-indexes a module. Returns null (and drops any old index) if no adapter accepts it. */
  update(file: string, code: string): ModuleAnalysis | null {
    this.remove(file);
    const adapter = this.adapterFor(file, code);
    if (!adapter) return null;
    const analysis = analyzeModule(file, code, this.root, adapter);
    this.add(analysis.record);
    return analysis;
  }

  /** Re-indexes an HTML page. */
  updateHtml(file: string, html: string): Omit<ModuleAnalysis, 'headerAt'> {
    this.remove(file);
    const analysis = analyzeHtml(file, html, this.root);
    this.add(analysis.record);
    return analysis;
  }

  private add(record: ModuleRecord): void {
    this.modules.set(record.file, record);
    for (const lit of record.literals) {
      let set = this.byValue.get(lit.value);
      if (!set) this.byValue.set(lit.value, (set = new Set()));
      set.add(lit);
    }
    for (const binding of record.imports) {
      let set = this.importers.get(binding.target);
      if (!set) this.importers.set(binding.target, (set = new Set()));
      set.add({ module: record, binding });
    }
  }

  remove(file: string): void {
    const old = this.modules.get(file);
    if (!old) return;
    this.modules.delete(file);
    for (const lit of old.literals) {
      const set = this.byValue.get(lit.value);
      set?.delete(lit);
      if (set?.size === 0) this.byValue.delete(lit.value);
    }
    for (const binding of old.imports) {
      const set = this.importers.get(binding.target);
      if (!set) continue;
      for (const imp of set) if (imp.module === old) set.delete(imp);
      if (set.size === 0) this.importers.delete(binding.target);
    }
  }

  has(file: string): boolean {
    return this.modules.has(file);
  }

  /** Literals of `code` analyzed as `file`, without touching the index. */
  analyzeDetached(file: string, code: string): LiteralEntry[] {
    if (isHtml(file)) return analyzeHtml(file, code, this.root).record.literals;
    const adapter = this.adapterFor(file, code);
    if (!adapter) return [];
    return analyzeModule(file, code, this.root, adapter).record.literals;
  }

  resolve(req: ResolveRequest): ResolveResponse {
    const { elementLoc } = req;
    // Text in an HTML page shows only inside the element written around it, never elsewhere.
    const matches = [...(this.byValue.get(req.text) ?? [])].filter(
      (lit) => lit.quote !== 'html' || (lit.file === elementLoc?.file && lit.owner === elementLoc.start),
    );
    if (matches.length === 0 || req.text.trim() === '') return { editable: false, candidates: [] };
    const candidates = matches.map((lit) => this.toCandidate(lit));
    const ownerModule = elementLoc ? this.modules.get(elementLoc.file) : undefined;
    const rank = ownerModule?.rank ?? this.modules.get(candidates[0]!.file)!.rank;
    const ranked = rank(candidates, { elementLoc });
    const best = Math.min(...ranked.map((r) => r.rank));
    return { editable: true, candidates: ranked.filter((r) => r.rank === best).map((r) => r.candidate) };
  }

  private toCandidate(lit: LiteralEntry): Candidate {
    const mod = this.modules.get(lit.file)!;
    const same = mod.literals.filter((l) => l.value === lit.value && l.quote === lit.quote);
    return { ...lit, ordinal: same.indexOf(lit), sameValueCount: same.length, uses: this.usesOf(mod, lit) };
  }

  /** Reads of the literal: 1 when inline, otherwise references to its const binding here and in importers. */
  private usesOf(mod: ModuleRecord, lit: LiteralEntry): number {
    if (!lit.binding) return 1;
    let uses = mod.refs.get(lit.binding) ?? 0;
    const exported = mod.exportsByLocal.get(lit.binding) ?? [];
    if (exported.length > 0) {
      for (const imp of this.importers.get(stripScriptExt(mod.file)) ?? []) {
        if (exported.includes(imp.binding.imported)) uses += imp.module.refs.get(imp.binding.local) ?? 0;
      }
    }
    return Math.max(1, uses);
  }
}
