import type { Candidate, ClientConfig, ElementDescriptor, HostMessage, Mode } from '@vibe-visual-editor/protocol';
import { Channel } from './channel';
import { describeElement } from './descriptor';
import { optionText, selectAt, showsLineBreaks, textBounds, textNodeAt } from './dom';
import { editablePart, InlineEditor, sourceLayout, type Layout, type TextEditor } from './editor';
import { registerFiles } from './locs';
import { OptionsEditor, type OptionRow } from './optionsEditor';
import { Overlay } from './overlay';
import { PendingEdits } from './pending';
import { Resolver } from './resolver';

const RUNTIME_HINT = 'Built at runtime: select it and ask the agent';
const LABEL_HINT = 'Shows its label attribute: select it and ask the agent';
const SELECT_HINT = 'Click to edit its options';
const LINE_BREAK_HINT = "Line break added, but this element's CSS shows it as a space. Ask the agent to add white-space: pre-line to it.";
const POINTER_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

interface InFlight {
  node: Text;
  previous: string;
  candidates: Candidate[];
  value: string;
}

/** What an edit of a text node would change, or why it can't be edited. */
type EditTarget = { candidates: Candidate[]; uses: number } | { reason: string; error: boolean };

const lineBreaks = (s: string) => s.split('\n').length - 1;

/** HTML text keeps its source indentation out of the editor. */
const layoutOf = (node: Text, candidates: Candidate[]): Layout | undefined =>
  candidates.every((c) => c.quote === 'html') ? sourceLayout(node.data) : undefined;

class VibeVisualEditorClient {
  private readonly channel: Channel;
  private readonly resolver = new Resolver();
  private readonly overlay = new Overlay();
  private readonly pending = new PendingEdits(this.resolver, this.overlay.host);
  private mode: Mode = 'browse';
  private editor: TextEditor | null = null;
  private selected: Element | null = null;
  private hoverToken = 0;
  private nextRequestId = 1;
  private readonly inFlight = new Map<number, InFlight>();
  private lastUrl = location.href;

  constructor(config: ClientConfig) {
    this.channel = new Channel(config.trustedParentOrigins);
    // Registered before the app's own listeners so the capture handlers run first.
    for (const type of POINTER_EVENTS) window.addEventListener(type, this.onPointer, { capture: true });
    window.addEventListener('mousemove', this.onMove, { capture: true, passive: true });
    window.addEventListener('keydown', this.onKey, { capture: true });
    for (const type of ['keyup', 'keypress'] as const) window.addEventListener(type, this.onOtherKey, { capture: true });
    this.channel.on((msg) => this.onHost(msg));
    setInterval(() => this.reportLocation(), 1000);
    window.addEventListener('hashchange', () => this.reportLocation());
    window.addEventListener('popstate', () => this.reportLocation());
    this.channel.hello();
  }

  private onHost(msg: HostMessage): void {
    switch (msg.type) {
      case 'le:ack':
        this.pending.start();
        this.channel.send({ type: 'le:ready', url: location.href });
        break;
      case 'le:setMode':
        this.setMode(msg.mode);
        break;
      case 'le:editApplied': {
        const req = this.inFlight.get(msg.requestId);
        this.inFlight.delete(msg.requestId);
        const candidate = req?.candidates.find((c) => c.id === msg.literalId);
        if (req && candidate) this.pending.track(req.node, candidate, msg.value);
        break;
      }
      case 'le:editRejected': {
        const req = this.inFlight.get(msg.requestId);
        this.inFlight.delete(msg.requestId);
        if (req && req.node.data === req.value) req.node.data = req.previous;
        this.overlay.toast(msg.reason);
        break;
      }
      case 'le:pending':
        this.pending.sync(msg.edits);
        break;
      case 'le:saved':
        this.pending.forget(msg.literalIds);
        break;
      case 'le:clearSelection':
        this.select(null, false);
        break;
    }
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.editor?.commit();
    this.mode = mode;
    this.overlay.hideHover();
    if (mode !== 'select') this.select(null, true);
  }

  private reportLocation(): void {
    if (location.href === this.lastUrl) return;
    this.lastUrl = location.href;
    this.channel.send({ type: 'le:location', url: location.href });
  }

  // ---------------------------------------------------------------- pointer

  private readonly onPointer = (e: MouseEvent) => {
    if (!this.channel.connected || this.mode === 'browse') return;
    if (this.editor?.active && this.editor.contains(e.target)) {
      // Let the caret move inside the editor, but keep the app (e.g. a parent button) from seeing it.
      e.stopImmediatePropagation();
      if (e.type === 'click' || e.type === 'auxclick') e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'pointerdown') {
      // preventDefault also blocks the frame from taking focus; keys (Esc, Cmd+S) must still reach us.
      window.focus();
      if (this.editor?.active) {
        this.editor.commit();
        return;
      }
    }
    if (e.type !== 'click') return;
    if (this.mode === 'edit') void this.beginEdit(e.clientX, e.clientY);
    else if (this.mode === 'select') {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && !this.overlay.host.contains(el)) this.select(el, true);
    }
  };

  private readonly onMove = (e: MouseEvent) => {
    if (!this.channel.connected || this.mode === 'browse' || this.editor?.active) return;
    if (this.mode === 'select') {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && !this.overlay.host.contains(el)) this.overlay.showHover(el.getBoundingClientRect(), 'select-hover', `<${el.tagName.toLowerCase()}>`);
      else this.overlay.hideHover();
      return;
    }
    const node = textNodeAt(e.clientX, e.clientY, this.overlay.host);
    const token = ++this.hoverToken;
    if (!node) {
      const select = selectAt(e.clientX, e.clientY, this.overlay.host);
      return select ? this.overlay.showHover(select.getBoundingClientRect(), 'editable', SELECT_HINT) : this.overlay.hideHover();
    }
    if (this.pending.literalOf(node)) return this.overlay.showHover(textBounds(node), 'editable', 'Unsaved edit');
    this.resolver
      .resolve(node)
      .then((res) => {
        if (token !== this.hoverToken || this.mode !== 'edit' || this.editor?.active) return;
        if (!res.editable) return this.overlay.showHover(textBounds(node), 'readonly', RUNTIME_HINT);
        const c = res.candidates;
        const tip = c.length > 1 ? `${c.length} identical literals: you'll pick one` : c[0]!.uses > 1 ? `Used in ${c[0]!.uses} places` : undefined;
        this.overlay.showHover(textBounds(node), 'editable', tip);
      })
      .catch(() => {
        if (token === this.hoverToken) this.overlay.showHover(textBounds(node), 'readonly', 'Vibe Visual Editor: could not reach the dev server');
      });
  };

  // ------------------------------------------------------------------- edit

  private async beginEdit(x: number, y: number): Promise<void> {
    const node = textNodeAt(x, y, this.overlay.host);
    if (!node) {
      const select = selectAt(x, y, this.overlay.host);
      if (select) await this.editOptions(select);
      return;
    }
    const target = await this.editTarget(node);
    if ('reason' in target) return this.overlay.toast(target.reason, target.error ? 'error' : 'info');
    if (this.editor?.active || !node.isConnected || this.mode !== 'edit') return;
    this.overlay.hideHover();
    const previous = node.data;
    const { candidates, uses } = target;
    this.editor = new InlineEditor(node, {
      warning: uses > 1 ? `Used in ${uses} places` : undefined,
      layout: layoutOf(node, candidates),
      onCommit: (value) => {
        this.editor = null;
        this.submitEdit(node, previous, candidates, value);
        const parent = node.parentElement;
        if (lineBreaks(value) > lineBreaks(previous) && parent && !showsLineBreaks(parent)) this.overlay.toast(LINE_BREAK_HINT, 'info');
      },
      onCancel: () => {
        this.editor = null;
      },
    });
    if (uses > 1) this.overlay.toast(`Used in ${uses} places: the change applies to all of them`, 'info');
  }

  /** Lists the select's options in a panel where each literal option text can be retyped. */
  private async editOptions(select: HTMLSelectElement): Promise<void> {
    const targets = new Map<Text, EditTarget>();
    const rows = await Promise.all(
      [...select.options].map(async (option): Promise<OptionRow | null> => {
        const node = optionText(option);
        if (!node) return null;
        const current = option.selected;
        if (option.hasAttribute('label')) return { label: option.label, current, readonly: LABEL_HINT };
        const target = await this.editTarget(node);
        targets.set(node, target);
        if ('reason' in target) return { label: node.data, current, readonly: target.reason };
        const layout = layoutOf(node, target.candidates);
        const label = layout ? editablePart(node.data, layout) : node.data;
        return { label, current, node, layout, warning: target.uses > 1 ? `Used in ${target.uses} places` : undefined };
      }),
    );
    if (this.editor?.active || !select.isConnected || this.mode !== 'edit') return;
    this.overlay.hideHover();
    this.editor = new OptionsEditor(
      select,
      rows.filter((row) => row !== null),
      {
        onCommit: (row, value, previous) => {
          const target = targets.get(row.node);
          if (target && 'candidates' in target) this.submitEdit(row.node, previous, target.candidates, value);
        },
        onClose: () => {
          this.editor = null;
        },
      },
    );
  }

  private async editTarget(node: Text): Promise<EditTarget> {
    const tracked = this.pending.literalOf(node);
    const trackedCandidate = tracked ? this.pending.candidateOf(tracked) : undefined;
    if (trackedCandidate) return { candidates: [trackedCandidate], uses: trackedCandidate.uses };
    try {
      const res = await this.resolver.resolve(node);
      if (!res.editable) return { reason: RUNTIME_HINT, error: false };
      return { candidates: res.candidates, uses: res.candidates.length === 1 ? res.candidates[0]!.uses : 1 };
    } catch (err) {
      return { reason: `Vibe Visual Editor: ${(err as Error).message}`, error: true };
    }
  }

  /** `node` already shows `value`; it goes back to `previous` if the extension rejects the edit. */
  private submitEdit(node: Text, previous: string, candidates: Candidate[], value: string): void {
    const requestId = this.nextRequestId++;
    this.inFlight.set(requestId, { node, previous, candidates, value });
    this.channel.send({ type: 'le:edit', requestId, candidates, newValue: value });
  }

  // ----------------------------------------------------------------- select

  private select(el: Element | null, notify: boolean): void {
    this.selected = el;
    this.overlay.trackSelection(el ? () => (el.isConnected ? el.getBoundingClientRect() : null) : null);
    if (!notify) return;
    if (!el) {
      this.channel.send({ type: 'le:clearSelection' });
      return;
    }
    void this.editableTextOf(el).then((editableText) => {
      if (this.selected !== el) return;
      this.channel.send({ type: 'le:select', descriptor: describeElement(el, editableText) });
    });
  }

  /** The literal behind the element's first resolvable direct text child, if it is unambiguous. */
  private async editableTextOf(el: Element): Promise<ElementDescriptor['editableText']> {
    for (const child of el.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !(child as Text).data.trim()) continue;
      try {
        const res = await this.resolver.resolve(child as Text);
        const c = res.candidates.length === 1 ? res.candidates[0]! : undefined;
        if (c) return { value: c.value, rel: c.rel, line: c.line, column: c.column };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------------- keys

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.channel.connected) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    const action = !mod ? null : key === 's' ? 'save' : key === 'z' ? (e.shiftKey ? 'redo' : 'undo') : key === 'y' && !IS_MAC ? 'redo' : null;

    if (this.editor?.active) {
      e.stopImmediatePropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.editor.commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.editor.cancel();
      } else if (action === 'save') {
        e.preventDefault();
        this.editor.commit();
        this.channel.send({ type: 'le:key', action });
      } else {
        // Undo/redo inside the editor stay native.
        this.editor.key?.(e);
      }
      return;
    }
    if (action) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.channel.send({ type: 'le:key', action });
      return;
    }
    if (e.key === 'Escape' && this.mode === 'select' && this.selected) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.select(null, true);
    }
  };

  private readonly onOtherKey = (e: KeyboardEvent) => {
    if (this.editor?.active) e.stopImmediatePropagation();
  };
}

let started = false;

/**
 * Starts the client. The host that served the page calls it once, from the
 * inline module it injects. Outside the preview's frame it only records the
 * page's files.
 */
export function start(config: ClientConfig): void {
  if (config.files) registerFiles(config.files);
  if (started || window.parent === window) return;
  started = true;
  new VibeVisualEditorClient(config);
}
