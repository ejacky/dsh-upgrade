/**
 * Upgrade state: what is serving, what is staged, and what happened last.
 *
 * Slots are recorded by name (`a`/`b`) rather than by path so the file stays valid when a
 * machine's layout is re-rooted. Writes are atomic: a crash mid-upgrade must never leave a
 * half-written state that the next run believes.
 *
 * @module dsh-upgrade/engine/state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'

/** One slot's version record. */
export interface SlotRecord {
  /** Release tag the slot is checked out at. */
  readonly tag: string
  /** Slot name, not a path. */
  readonly slot: 'a' | 'b'
  /** ISO timestamp of the event. */
  readonly at: string
  /** Built client version, when the slot carries a build record. */
  readonly clientVersion?: string
  /** Number of built client artifacts, when known. */
  readonly clientArtifacts?: number
}

/** Persisted upgrade state. */
export interface State {
  /** Metadata revision of this file. */
  readonly schema: 1
  /** Version currently serving through the stable path. */
  readonly deployed: SlotRecord | null
  /** Version prepared in the spare slot and waiting for `apply`. */
  readonly staged: SlotRecord | null
  /** ISO timestamp of the last `check`. */
  readonly lastCheck: string | null
  /** Message of the last failure, cleared on success. */
  readonly lastError: string | null
  /** Most recent switches, newest first. */
  readonly history: readonly SlotRecord[]
}

/** Deliberately small: enough to explain the last few switches, not an audit log. */
const HISTORY_LIMIT = 20

/**
 * State used before the first run.
 * @returns an empty, valid state.
 */
export function emptyState(): State {
  return { schema: 1, deployed: null, staged: null, lastCheck: null, lastError: null, history: [] }
}

/**
 * Where a configuration keeps its state file.
 * @param config - resolved tool configuration.
 */
export function statePathOf(config: Config): string {
  return join(config.root, 'state', 'upgrade-state.json')
}

/**
 * Read the state file, tolerating a missing file.
 * @param path - absolute path to the JSON file.
 * @returns the parsed state, or {@link emptyState} when the file does not exist.
 */
export function readState(path: string): State {
  if (!existsSync(path)) return emptyState()
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}: expected a JSON object`)
  const record = raw as Record<string, unknown>
  const slot = (value: unknown): SlotRecord | null => {
    if (value === null || value === undefined) return null
    if (typeof value !== 'object') throw new Error(`${path}: slot record must be an object`)
    const item = value as Record<string, unknown>
    if (item['tag'] === undefined || item['slot'] === undefined || item['at'] === undefined) {
      throw new Error(`${path}: slot record needs tag, slot, and at`)
    }
    const name = item['slot']
    if (name !== 'a' && name !== 'b') throw new Error(`${path}: slot must be "a" or "b"`)
    return {
      tag: String(item['tag']),
      slot: name,
      at: String(item['at']),
      ...item['clientVersion'] === undefined ? {} : { clientVersion: String(item['clientVersion']) },
      ...item['clientArtifacts'] === undefined ? {} : { clientArtifacts: Number(item['clientArtifacts']) },
    }
  }
  return {
    schema: 1,
    deployed: slot(record['deployed']),
    staged: slot(record['staged']),
    lastCheck: record['lastCheck'] === null || record['lastCheck'] === undefined ? null : String(record['lastCheck']),
    lastError: record['lastError'] === null || record['lastError'] === undefined ? null : String(record['lastError']),
    history: Array.isArray(record['history']) ? record['history'].map(slot).filter((item): item is SlotRecord => item !== null) : [],
  }
}

/**
 * Write the state file atomically.
 * @param path - absolute path to the JSON file.
 * @param state - the state to persist.
 */
export function writeState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/**
 * Record a switch, pushing the previous record into the bounded history.
 * @param state - the current state.
 * @param record - the newly deployed version.
 * @returns the state with the switch applied.
 */
export function withDeployed(state: State, record: SlotRecord): State {
  return {
    ...state,
    deployed: record,
    staged: null,
    lastError: null,
    history: [record, ...state.history].slice(0, HISTORY_LIMIT),
  }
}
