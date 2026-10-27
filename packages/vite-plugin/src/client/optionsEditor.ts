import { flatten, NO_LAYOUT, type Layout, type TextEditor } from './editor';

interface Row {
  /** What the option shows. */
  label: string;
  /** The app's selected option. */
  current: boolean;
}

export interface EditableRow extends Row {
  node: Text;
  /** Kept around the edited text; the label is the text without it. */
  layout?: Layout;
  /** Shown beside the row, e.g. "Used in 3 places". */
  warning?: string;
}

export interface ReadonlyRow extends Row {
  /** Why the text can't be edited. */
  readonly: string;
}

export type OptionRow = EditableRow | ReadonlyRow;

export interface OptionsEditorOptions {
  /** A row's text changed; the node already shows `value`. */
  onCommit(row: EditableRow, value: string, previous: string): void;
  onClose(): void;
}

const CSS = `
:host { all: initial; }
.panel { position: fixed; z-index: 2147483647; box-sizing: border-box; max-height: 50vh; overflow: auto; padding: 4px;
  border: 2px solid #3b82f6; border-radius: 6px; background: #fff; color: #111827; box-shadow: 0 4px 16px rgba(0,0,0,.25);
  font: 13px/1.4 system-ui, -apple-system, sans-serif; }
.row { display: flex; align-items: center; gap: 6px; }
input { flex: 1; min-width: 0; margin: 1px 0; padding: 3px 6px; font: inherit; color: inherit; background: transparent;
  border: 1px solid transparent; border-radius: 3px; }
input:focus { outline: none; border-color: #3b82f6; background: rgba(59,130,246,.08); }
input:disabled { color: #6b7280; border: 1px dashed #d1d5db; }
.current input { font-weight: 600; }
.note { font-size: 11px; color: #b45309; white-space: nowrap; }
.help { margin-top: 2px; padding: 2px 6px 0; border-top: 1px solid #e5e7eb; font-size: 11px; color: #6b7280; }
`;

/**
 * Edits the option texts of a `<select>`. The browser draws the native list
 * itself and an option can only hold text, so the options are listed in a
 * panel of plain-text fields next to the select instead.
 */
export class OptionsEditor implements TextEditor {
  private readonly host: HTMLElement;
  private readonly panel: HTMLDivElement;
  private readonly root: ShadowRoot;
  private readonly fields = new Map<HTMLInputElement, EditableRow>();
  private done = false;

  constructor(
    private readonly select: HTMLSelectElement,
    rows: OptionRow[],
    private readonly options: OptionsEditorOptions,
  ) {
    this.host = document.createElement('vibe-visual-editor-options');
    this.root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    this.root.append(style, this.panel);

    let focus: HTMLInputElement | undefined;
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = row.current ? 'row current' : 'row';
      const input = document.createElement('input');
      input.value = row.label;
      input.spellcheck = false;
      if ('readonly' in row) {
        input.disabled = true;
        input.title = row.readonly;
      } else {
        this.fields.set(input, row);
        input.addEventListener('blur', this.onBlur);
        if (!focus || row.current) focus = input;
      }
      line.append(input);
      if ('warning' in row && row.warning) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = row.warning;
        line.append(note);
      }
      this.panel.append(line);
    }
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = this.fields.size > 0 ? 'Enter saves · Tab next · Esc cancels' : 'No option text here can be edited';
    this.panel.append(help);

    document.documentElement.appendChild(this.host);
    this.place();
    addEventListener('scroll', this.place, { capture: true, passive: true });
    addEventListener('resize', this.place, { passive: true });
    focus?.focus();
    focus?.select();
  }

  get active(): boolean {
    return !this.done;
  }

  contains(target: EventTarget | null): boolean {
    return target === this.host;
  }

  commit(): void {
    const field = this.focused();
    if (field) this.commitField(field);
    this.close();
  }

  cancel(): void {
    this.close();
  }

  key(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    // Wrap around the editable rows rather than tabbing out into the page.
    e.preventDefault();
    const list = [...this.fields.keys()];
    if (list.length === 0) return;
    const at = list.indexOf(this.focused()!);
    const next = list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length]!;
    next.focus();
    next.select();
  }

  private focused(): HTMLInputElement | undefined {
    const el = this.root.activeElement;
    return el instanceof HTMLInputElement && this.fields.has(el) ? el : undefined;
  }

  /** Writes the field's value to its option and reports it, once per change. */
  private commitField(field: HTMLInputElement): void {
    const row = this.fields.get(field)!;
    const previous = row.node.data;
    const layout = row.layout ?? NO_LAYOUT;
    const value = layout.lead + flatten(field.value) + layout.trail;
    if (value === previous) return;
    row.node.data = value;
    this.options.onCommit(row, value, previous);
  }

  private close(): void {
    if (this.done) return;
    this.done = true;
    removeEventListener('scroll', this.place, { capture: true });
    removeEventListener('resize', this.place);
    for (const field of this.fields.keys()) field.removeEventListener('blur', this.onBlur);
    this.host.remove();
    this.options.onClose();
  }

  private readonly onBlur = (e: FocusEvent) => {
    if (!this.done) this.commitField(e.target as HTMLInputElement);
  };

  /** Below the select, or above it when there's more room there; kept inside the viewport. */
  private readonly place = () => {
    if (!this.select.isConnected) return;
    const rect = this.select.getBoundingClientRect();
    const style = this.panel.style;
    style.minWidth = `${Math.max(rect.width, 180)}px`;
    const height = this.panel.offsetHeight;
    const width = this.panel.offsetWidth;
    const below = innerHeight - rect.bottom;
    style.top = `${below >= height + 8 || below >= rect.top ? rect.bottom + 4 : Math.max(4, rect.top - height - 4)}px`;
    style.left = `${Math.max(4, Math.min(rect.left, innerWidth - width - 4))}px`;
  };
}
