interface ImportMeta {
  readonly hot?: {
    on(event: string, cb: (data: unknown) => void): void;
  };
}
