/**
 * The agent-text schema this Combwork was built with (dialects, HI-2065): agent-text/schema/<area>.json, generated from the
 * code by `npm run agent-text:extract` (each id with its placeholders), bundled into main at build time, one file per
 * area so the extraction cards don't share one. Every dialect file is checked against it when it is loaded or saved.
 */
import { schemaOf, type DialectSchema } from './format'

const AREAS = import.meta.glob<unknown>('../../../agent-text/schema/*.json', { eager: true, import: 'default' })

let schema: DialectSchema | null = null

/** This Combwork's schema: each agent text's id → its placeholders. */
export function agentTextSchema(): DialectSchema {
  return (schema ??= schemaOf(Object.values(AREAS)))
}
