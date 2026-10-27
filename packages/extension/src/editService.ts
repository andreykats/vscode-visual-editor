import * as vscode from 'vscode';
import { AnalyzeResponseSchema, literalRaw, type Candidate, type PendingEdit, type Quote } from '@vibe-visual-editor/protocol';
import { EditLedger, isActive, type LedgerEntry, type Op } from './editLedger';

export class EditError extends Error {}

const EDIT_LABEL = 'Vibe Visual Editor: rename text';

/**
 * Turns preview edits into unsaved changes in the source documents, one
 * string literal at a time, and owns save / discard / undo / redo for them.
 * Nothing is written to disk except by an explicit save.
 */
export class EditService implements vscode.Disposable {
  private readonly ledger = new EditLedger();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly saved = new vscode.EventEmitter<string[]>();
  /** Fires when the set of pending edits changes. */
  readonly onDidChange = this.changed.event;
  /** Fires with the literal ids whose edits reached disk. */
  readonly onDidSave = this.saved.event;

  constructor(
    /** Dev server origin, for re-analyzing documents that differ from the index. */
    private readonly devServerOrigin: () => string,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      this.changed,
      this.saved,
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forgetFile(doc.uri.fsPath)),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  pending(): PendingEdit[] {
    return this.ledger.pending();
  }

  get pendingCount(): number {
    return this.ledger.active().length;
  }

  /** Replaces the literal `candidate` with `newValue`, leaving the document dirty. */
  async edit(candidate: Candidate, newValue: string): Promise<void> {
    const uri = vscode.Uri.file(candidate.file);
    if (!vscode.workspace.getWorkspaceFolder(uri)) throw new EditError(`${candidate.rel} is outside the workspace folders.`);
    const { quote, raw } = candidate;
    if (!looksLike(raw, quote)) throw new EditError('Not a text literal.');
    const doc = await vscode.workspace.openTextDocument(uri);

    let entry = this.ledger.get(candidate.id);
    let created = false;
    if (entry) {
      if (doc.getText(rangeOf(doc, entry)) !== entry.currentRaw) {
        this.ledger.remove((e) => e === entry);
        this.changed.fire();
        throw new EditError(`${candidate.rel} changed around this text. Reload the preview and try again.`);
      }
    } else {
      const located = await this.locate(doc, candidate);
      entry = {
        key: candidate.id,
        file: uri.fsPath,
        start: located.start,
        end: located.end,
        quote,
        originalRaw: located.raw,
        originalValue: candidate.value,
        currentRaw: located.raw,
        values: new Map(),
      };
      this.ledger.add(entry);
      created = true;
    }

    // Going back to the original value restores the original source text exactly.
    const newRaw = newValue === entry.originalValue ? entry.originalRaw : literalRaw(newValue, quote, entry.originalRaw);
    if (newRaw === entry.currentRaw) return;
    if (newRaw !== entry.originalRaw) entry.values.set(newRaw, newValue);
    const from = entry.currentRaw;
    try {
      await this.replace(doc, entry, newRaw);
    } catch (err) {
      if (created) this.ledger.remove((e) => e === entry);
      throw err;
    }
    this.ledger.recordEdit({ key: entry.key, from, to: newRaw });
  }

  /** Saves every document with pending Vibe Visual Editor edits, and only those. */
  async save(): Promise<number> {
    const files = new Set(this.ledger.active().map((e) => e.file));
    for (const file of files) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      if (!(await doc.save())) throw new EditError(`Could not save ${vscode.workspace.asRelativePath(doc.uri)}.`);
    }
    return files.size;
  }

  /** Restores every edited literal to its original text, leaving other unsaved changes alone. */
  async discard(): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const skipped: string[] = [];
    for (const entry of this.ledger.active()) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
      const range = rangeOf(doc, entry);
      if (doc.getText(range) !== entry.currentRaw) {
        skipped.push(vscode.workspace.asRelativePath(doc.uri));
        continue;
      }
      edit.replace(doc.uri, range, entry.originalRaw, { label: 'Vibe Visual Editor: discard', needsConfirmation: false });
    }
    if (edit.size > 0 && !(await vscode.workspace.applyEdit(edit))) throw new EditError('VS Code rejected the discard.');
    // A file Vibe Visual Editor alone had touched now matches disk but may still show as modified:
    // VS Code's only revert acts on the active editor, and saving could run format-on-save.
    this.ledger.remove(() => true);
    this.changed.fire();
    if (skipped.length > 0) {
      void vscode.window.showWarningMessage(`Vibe Visual Editor: left ${skipped.join(', ')} alone because the edited text changed outside the preview.`);
    }
  }

  async undo(): Promise<boolean> {
    return this.step(this.ledger.takeUndo(), 'from');
  }

  async redo(): Promise<boolean> {
    return this.step(this.ledger.takeRedo(), 'to');
  }

  private async step(op: Op | undefined, target: 'from' | 'to'): Promise<boolean> {
    if (!op) return false;
    const entry = this.ledger.get(op.key);
    if (!entry) return false;
    const expected = target === 'from' ? op.to : op.from;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
    if (doc.getText(rangeOf(doc, entry)) !== expected || entry.currentRaw !== expected) {
      throw new EditError('The text changed outside the preview; nothing to undo here.');
    }
    await this.replace(doc, entry, op[target]);
    return true;
  }

  /**
   * Finds the literal in the document as it is now. The dev server indexed
   * the file on disk; if the document differs (unsaved edits, or the file
   * changed since the page loaded), re-analyze the document text and match by
   * value and position among equal literals. Never guesses beyond that.
   */
  private async locate(doc: vscode.TextDocument, c: Candidate): Promise<{ start: number; end: number; raw: string }> {
    const text = doc.getText();
    if (text.slice(c.start, c.end) === c.raw) return { start: c.start, end: c.end, raw: c.raw };
    let literals;
    try {
      const res = await fetch(new URL('/__vibe-visual-editor/analyze', this.devServerOrigin()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: c.file, code: text }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = AnalyzeResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error('malformed response');
      literals = parsed.data.literals;
    } catch (err) {
      throw new EditError(`${c.rel} differs from what the page was built from, and the dev server could not re-check it (${(err as Error).message}).`);
    }
    const same = literals.filter((l) => l.value === c.value && l.quote === c.quote);
    const match = same.length === c.sameValueCount ? same[c.ordinal] : undefined;
    if (!match || text.slice(match.start, match.end) !== match.raw) {
      throw new EditError(`${c.rel} changed since the page loaded, so this text can't be located safely. Reload the preview and try again.`);
    }
    this.log.info(`Re-located ${JSON.stringify(c.value)} in ${c.rel}: ${c.start} -> ${match.start}`);
    return match;
  }

  private async replace(doc: vscode.TextDocument, entry: LedgerEntry, newRaw: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, rangeOf(doc, entry), newRaw, { label: EDIT_LABEL, needsConfirmation: false });
    if (!(await vscode.workspace.applyEdit(edit))) throw new EditError('VS Code rejected the edit.');
    // onDidChangeTextDocument has run by now and moved the entry to its new text.
    if (entry.currentRaw !== newRaw) throw new EditError('The edit did not land where expected; it is no longer tracked.');
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return;
    const changes = e.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }));
    const { dropped, stateChanged } = this.ledger.applyChanges(e.document.uri.fsPath, changes);
    for (const d of dropped) {
      const where = vscode.workspace.asRelativePath(e.document.uri);
      this.log.warn(`Stopped tracking ${JSON.stringify(d.originalValue)} in ${where}: it was changed outside the preview.`);
      void vscode.window.showWarningMessage(`Vibe Visual Editor: ${where} was changed outside the preview, so the edit to "${d.originalValue}" is no longer tracked.`);
    }
    if (stateChanged) this.changed.fire();
  }

  private onDocumentSaved(doc: vscode.TextDocument): void {
    const file = doc.uri.fsPath;
    const savedKeys = this.ledger.all().filter((e) => e.file === file && isActive(e)).map((e) => e.key);
    this.ledger.remove((e) => e.file === file);
    if (savedKeys.length > 0) {
      this.saved.fire(savedKeys);
      this.changed.fire();
    }
  }

  private forgetFile(file: string): void {
    if (this.ledger.remove((e) => e.file === file).length > 0) this.changed.fire();
  }
}

/** Whether `raw` is shaped like a literal of kind `quote`: quoted strings, or non-empty JSX or HTML text. */
function looksLike(raw: string, quote: Quote): boolean {
  if (quote === 'jsx' || quote === 'html') return raw.length > 0;
  const quotes = quote === 'jsx-attr' ? ['"', "'"] : [quote];
  return raw.length >= 2 && quotes.includes(raw[0]!) && raw[raw.length - 1] === raw[0];
}

function rangeOf(doc: vscode.TextDocument, entry: { start: number; end: number }): vscode.Range {
  return new vscode.Range(doc.positionAt(entry.start), doc.positionAt(entry.end));
}
