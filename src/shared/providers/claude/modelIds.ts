/**
 * The model without its 1M-context suffix. Current models have the 1M window without it; only Opus 4.6 and
 * Sonnet 4.6 need "[1m]" (typed as a custom model ID), and Claude Code rejects it when 1M is turned off.
 */
export const baseModel = (model: string): string => model.replace(/\[1m\]$/i, '')
