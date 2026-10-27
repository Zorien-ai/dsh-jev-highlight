/**
 * Test-only seams.
 *
 * `src/index.ts` re-exports this module, so node:test reaches every pure
 * helper, class and error type through the built `lib/index.js` bundle:
 *
 *   import { StreamingSplitter, LruVerdictCache } from '../../lib/index.js'
 *
 * Nothing here is part of the DSH plugin contract consumed by the Loader; it
 * only widens the bundle's exports for tests and debugging.
 */
export * from './errors.js'
export * from './token-estimator.js'
export * from './signals.js'
export * from './semaphore.js'
export * from './cache.js'
export * from './credentials.js'
export * from './think-mode.js'
export * from './splitter.js'
export * from './store.js'
export * from './jev-client.js'
export * from './routes.js'
export * from './pipeline.js'
export { createHostRuntime, pluginName } from './runtime.js'
export type { HostContextLike, HostLogger, HostRuntime, HostRuntimeInstance, HostRuntimeOptions } from './runtime.js'
export {
  DEFAULT_THRESHOLDS,
  MAX_QUESTION_CHARS,
  PRIORITY_WEIGHTS,
  QUESTION_SET_VERSION,
  STARTLUX_THRESHOLDS,
  combinePriority,
  levelFor,
} from '../contract.js'
export type {
  ContentUnit,
  DiagSnapshot,
  HighlightLevel,
  HighlightThresholds,
  NoulScores,
  ResolvedConfig,
  UnitContext,
  UnitType,
  UnitVerdict,
} from '../contract.js'

import { Semaphore } from './semaphore.js'
import { StreamingSplitter, splitMarkdownText } from './splitter.js'
import { LruVerdictCache, cacheKeyFor, cacheKeyForUnit, normaliseCacheText } from './cache.js'
import {
  MissingJevApiKeyError,
  credentialsFilePath,
  parseCredentialsYaml,
  resolveDshHome,
  resolveJevApiKey,
} from './credentials.js'
import {
  JevClient,
  NOUL_QUESTIONS,
  buildJevQuestions,
  buildStateText,
  combineScoresMax,
  extractProbability,
  parseSystemOneScores,
  parseSystemOneScoresDetailed,
  planUnitRequests,
} from './jev-client.js'
import {
  HARD_STATE_QUESTION_LIMIT,
  HARD_TOTAL_LIMIT,
  FIXED_REQUEST_OVERHEAD_TOKENS,
  estimateJsonTokens,
  estimateRequestTokens,
  estimateTokens,
  splitTextToTokenBudget,
} from './token-estimator.js'
import { VerdictStore } from './store.js'
import { JudgePipeline } from './pipeline.js'
import { guardRouteRequest, parseQuery, readJsonBody, registerJevRoutes, sendJson } from './routes.js'
import { createHostRuntime } from './runtime.js'
import { DEFAULT_THRESHOLDS, MAX_QUESTION_CHARS, PRIORITY_WEIGHTS, QUESTION_SET_VERSION, STARTLUX_THRESHOLDS, combinePriority, levelFor } from '../contract.js'
export { normaliseConfig } from './config.js'

/**
 * Grouped access for tests that prefer a namespace object over many named
 * imports. Keep the groups in sync with the exports above.
 */
export const __internals = {
  StreamingSplitter,
  splitMarkdownText,
  LruVerdictCache,
  cacheKeyFor,
  cacheKeyForUnit,
  normaliseCacheText,
  MissingJevApiKeyError,
  credentialsFilePath,
  parseCredentialsYaml,
  resolveDshHome,
  resolveJevApiKey,
  JevClient,
  NOUL_QUESTIONS,
  buildJevQuestions,
  buildStateText,
  combineScoresMax,
  extractProbability,
  parseSystemOneScores,
  parseSystemOneScoresDetailed,
  planUnitRequests,
  HARD_STATE_QUESTION_LIMIT,
  HARD_TOTAL_LIMIT,
  FIXED_REQUEST_OVERHEAD_TOKENS,
  estimateJsonTokens,
  estimateRequestTokens,
  estimateTokens,
  splitTextToTokenBudget,
  Semaphore,
  VerdictStore,
  JudgePipeline,
  guardRouteRequest,
  parseQuery,
  readJsonBody,
  registerJevRoutes,
  sendJson,
  createHostRuntime,
  DEFAULT_THRESHOLDS,
  STARTLUX_THRESHOLDS,
  MAX_QUESTION_CHARS,
  PRIORITY_WEIGHTS,
  QUESTION_SET_VERSION,
  combinePriority,
  levelFor,
} as const
