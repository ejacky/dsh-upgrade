/**
 * Tool configuration: one JSON file, validated once, resolved to absolute paths.
 *
 * The file records deployment choices (where the slots live, which upstream to follow, ports)
 * and policy (build mode, patch list).
 * Everything the engine does is derived from it, so a machine's layout is reproducible and
 * a second machine only needs a different `root`.
 *
 * @module dsh-upgrade/engine/config
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** File name written by `init` and read by every command. */
export const CONFIG_FILENAME = 'dsh-upgrade.json'

/** Validated tool configuration with absolute paths. */
export interface Config {
  /** Metadata revision of this file. */
  readonly schema: 1
  /** Parent directory that holds the slots and the stable path. */
  readonly root: string
  /** Stable path: the link (junction or symlink) to whichever slot is serving. */
  readonly stablePath: string
  /** Directory holding the slot checkouts. */
  readonly slotsRoot: string
  /** Git URL to follow. */
  readonly upstream: string
  /** Tag glob, e.g. `dsh-v*`. */
  readonly tagPattern: string
  /** Port the serving web app listens on. */
  readonly webPort: number
  /** Port used to smoke-test a staged version. */
  readonly smokePort: number
  /** `true` when this machine only builds from an administrator console. */
  readonly manualBuild: boolean
  /** Gate parallelism for `pnpm run build`; 1 serialises the build. */
  readonly buildGateConcurrency: number
  /** Source patches applied to every staged slot, relative to the tool root. */
  readonly patchFiles: readonly string[]
}

/** The subset a caller may omit; defaults fill the rest. */
export type ConfigInput = Partial<Omit<Config, 'schema'>> & { readonly root: string }

const PORT = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`config: "${field}" must be an integer port`)
  }
  return value
}

const STRING = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`config: "${field}" must be a non-empty string`)
  return value
}

const CONCURRENCY = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error('config: "buildGateConcurrency" must be an integer between 1 and 64')
  }
  return value
}

/**
 * Build a complete configuration from a partial one.
 * @param input - at minimum `root`; omitted keys take defaults.
 * @returns the configuration with absolute paths.
 */
export function defaultConfig(input: ConfigInput): Config {
  const root = resolve(input.root)
  return {
    schema: 1,
    root,
    stablePath: resolve(input.stablePath ?? join(root, 'deepseek-harness')),
    slotsRoot: resolve(input.slotsRoot ?? join(root, 'dsh-slots')),
    upstream: input.upstream ?? 'https://github.com/deepseek-ai/deepseek-harness.git',
    tagPattern: input.tagPattern ?? 'dsh-v*',
    webPort: input.webPort ?? 3080,
    smokePort: input.smokePort ?? 3099,
    manualBuild: input.manualBuild ?? false,
    buildGateConcurrency: input.buildGateConcurrency ?? 1,
    patchFiles: input.patchFiles ?? [],
  }
}

/**
 * Validate a parsed JSON object into a {@link Config}.
 * @param raw - parsed JSON.
 * @param baseDir - directory relative paths resolve against.
 */
export function parseConfig(raw: unknown, baseDir: string): Config {
  if (typeof raw !== 'object' || raw === null) throw new Error('config: expected a JSON object')
  const record = raw as Record<string, unknown>
  const root = resolve(baseDir, STRING(record['root'], 'root'))
  const absolute = (value: unknown, field: string, fallback: string): string => {
    if (value === undefined) return fallback
    const text = STRING(value, field)
    return isAbsolute(text) ? text : resolve(baseDir, text)
  }
  const patches = record['patchFiles']
  if (patches !== undefined && (!Array.isArray(patches) || patches.some(patch => typeof patch !== 'string'))) {
    throw new Error('config: "patchFiles" must be an array of strings')
  }
  const schema = record['schema']
  if (schema !== undefined && schema !== 1) throw new Error('config: unsupported "schema" (expected 1)')
  const stablePath = absolute(record['stablePath'], 'stablePath', join(root, 'deepseek-harness'))
  const slotsRoot = absolute(record['slotsRoot'], 'slotsRoot', join(root, 'dsh-slots'))
  // A slots root inside the stable path would make every slot write go through the link the
  // tool switches, so the "never touch the serving slot" guards could no longer tell them apart.
  const nested = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(`${outer}\\`) || inner.startsWith(`${outer}/`)
  if (nested(stablePath, slotsRoot)) throw new Error('config: "slotsRoot" must not be inside "stablePath"')
  if (nested(slotsRoot, stablePath)) throw new Error('config: "stablePath" must not be inside "slotsRoot"')
  return defaultConfig({
    root,
    stablePath,
    slotsRoot,
    ...record['upstream'] === undefined ? {} : { upstream: STRING(record['upstream'], 'upstream') },
    ...record['tagPattern'] === undefined ? {} : { tagPattern: STRING(record['tagPattern'], 'tagPattern') },
    webPort: record['webPort'] === undefined ? 3080 : PORT(record['webPort'], 'webPort'),
    smokePort: record['smokePort'] === undefined ? 3099 : PORT(record['smokePort'], 'smokePort'),
    manualBuild: record['manualBuild'] === true,
    buildGateConcurrency: record['buildGateConcurrency'] === undefined
      ? 1
      : CONCURRENCY(record['buildGateConcurrency']),
    patchFiles: (patches as string[] | undefined) ?? [],
  })
}

/**
 * Resolve which configuration file an invocation uses.
 * @param explicit - `--config` value when given.
 * @param cwd - current working directory.
 * @param toolRoot - the tool's own directory, used as the last resort.
 * @returns the absolute path to read or write.
 */
export function resolveConfigPath(explicit: string | undefined, cwd: string, toolRoot: string): string {
  if (explicit !== undefined) return resolve(cwd, explicit)
  const fromEnv = process.env['DSH_UPGRADE_CONFIG']
  if (fromEnv !== undefined && fromEnv !== '') return resolve(cwd, fromEnv)
  const local = join(cwd, CONFIG_FILENAME)
  return existsSync(local) ? local : join(toolRoot, CONFIG_FILENAME)
}

/**
 * Read and validate a configuration file.
 * @param path - absolute path to the JSON file.
 */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) throw new Error(`config not found: ${path} (run "dsh-upgrade init")`)
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')), dirname(path))
}

/**
 * Write a configuration file, creating its directory when needed.
 * @param path - absolute path to the JSON file.
 * @param config - the configuration to persist.
 */
export function saveConfig(path: string, config: Config): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
