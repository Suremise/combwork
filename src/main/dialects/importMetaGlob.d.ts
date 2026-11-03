// Vite's import.meta.glob, for main's build (the node project has no vite/client types): schema.ts bundles the
// agent-text schema with it.
interface ImportMeta {
  glob<T = unknown>(pattern: string | string[], options: { eager: true; import?: string }): Record<string, T>
}
