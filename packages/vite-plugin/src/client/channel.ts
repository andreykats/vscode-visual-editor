import {
  EnvelopeSchema,
  HostMessageSchema,
  PROTOCOL_VERSION,
  type HostMessage,
  type PageMessage,
  type Unversioned,
} from '@vibe-visual-editor/protocol';

/** Origins a VS Code webview can have: desktop, and VS Code for the Web. */
const WEBVIEW_ORIGIN = [/^vscode-webview:\/\/[\w-]+$/, /^https:\/\/[\w-]+\.vscode-cdn\.net$/];


/**
 * postMessage link to the Vibe Visual Editor webview. Only `le:hello` goes out before
 * the handshake (with targetOrigin '*'; it carries nothing sensitive). Once a
 * trusted parent acks, every message is pinned to that parent's origin.
 */
export class Channel {
  private parentOrigin: string | null = null;
  private readonly handlers = new Set<(msg: HostMessage) => void>();

  /** `trustedParentOrigins`: origins to trust besides VS Code webviews, for test harnesses. */
  constructor(private readonly trustedParentOrigins: readonly string[]) {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const parsed = HostMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        const env = EnvelopeSchema.safeParse(event.data);
        if (env.success && env.data.v !== PROTOCOL_VERSION) {
          console.warn(`[vibe-visual-editor] protocol mismatch: page v${PROTOCOL_VERSION}, host v${env.data.v}`);
        }
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'le:ack') {
        if (!this.isTrustedParent(event.origin)) {
          console.warn(`[vibe-visual-editor] ignoring handshake from untrusted origin ${event.origin}`);
          return;
        }
        this.parentOrigin = event.origin;
      } else if (event.origin !== this.parentOrigin) {
        return;
      }
      for (const h of this.handlers) h(msg);
    });
  }

  private isTrustedParent(origin: string): boolean {
    return WEBVIEW_ORIGIN.some((re) => re.test(origin)) || this.trustedParentOrigins.includes(origin);
  }

  get connected(): boolean {
    return this.parentOrigin !== null;
  }

  hello(): void {
    window.parent.postMessage({ type: 'le:hello', v: PROTOCOL_VERSION, url: location.href, title: document.title.slice(0, 512) }, '*');
  }

  send(msg: Unversioned<PageMessage>): void {
    if (!this.parentOrigin) return;
    window.parent.postMessage({ ...msg, v: PROTOCOL_VERSION }, this.parentOrigin);
  }

  on(handler: (msg: HostMessage) => void): void {
    this.handlers.add(handler);
  }
}
