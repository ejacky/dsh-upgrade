/**
 * `patch`: inspect and maintain the source patches staging applies.
 *
 * `dsh-upgrade stage` refuses to prepare a version when a configured patch no longer applies,
 * which is the correct outcome but tells the operator very little. This command answers the
 * questions that come before it: which patches are configured, are they still in the catalog,
 * and does each one still apply to the tree that is serving now?
 *
 * Verification runs against a real checkout. A patch whose reverse applies is "applied"
 * (the upstream release absorbed it), one whose forward applies is "applies", and one where
 * neither works is a conflict that needs a human.
 *
 * @module dsh-upgrade/commands/patch
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RunOptions } from '../cli.ts'
import { loadConfig, resolveConfigPath, type Config } from '../engine/config.ts'
import { tagAtHead } from '../engine/git.ts'
import {
  defaultManifestPath,
  findEntry,
  loadManifest,
  normalizePatchFile,
  samePatchFile,
  type LoadedManifest,
} from '../engine/patchManifest.ts'
import { checkPatch, resolvePatchFile } from '../engine/patches.ts'
import { activeSlot, slotExists, slotPath, SLOT_NAMES, type SlotName } from '../engine/slots.ts'

/** Exit codes; see `src/cli.ts` for the contract. */
const EXIT = { ok: 0, usage: 2, manual: 3, probe: 4 } as const

/** Verbs this command accepts. */
const VERBS = ['list', 'verify', 'add', 'remove'] as const

/** A `patch` verb. */
type Verb = typeof VERBS[number]

/** Parsed `patch` arguments. */
interface PatchFlags {
  /** Which verb to run; `list` when none was given. */
  readonly verb: Verb
  /** The patch name for `add` and `remove`. */
  readonly name?: string
  /** `--file <path>`: an ad-hoc patch outside the catalog. */
  readonly file?: string
  /** `--manifest <path>`: a catalog other than the shipped one. */
  readonly manifest?: string
  /** `--slot <a|b>`: force the tree to verify against. */
  readonly slot?: SlotName
  /** `--all`: verify every catalogued patch, not only the configured ones. */
  readonly all: boolean
}

/**
 * Parse `patch` arguments.
 * @param args - arguments after the command name.
 * @returns the verb and its options.
 */
function parseFlags(args: readonly string[]): PatchFlags {
  let verb: Verb | undefined
  let name: string | undefined
  let file: string | undefined
  let manifest: string | undefined
  let slot: SlotName | undefined
  let all = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === '--all') { all = true; continue }
    if (argument === '--file' || argument === '--manifest' || argument === '--slot') {
      const value = args[index + 1]
      if (value === undefined || value === '') throw new Error(`${argument} needs a value`)
      index += 1
      if (argument === '--file') file = value
      else if (argument === '--manifest') manifest = value
      else if (value === 'a' || value === 'b') slot = value
      else throw new Error('--slot must be a or b')
      continue
    }
    if (argument.startsWith('-')) throw new Error(`unknown argument "${argument}"`)
    if (verb === undefined) {
      if (!VERBS.includes(argument as Verb)) {
        throw new Error(`unknown patch command "${argument}" (expected ${VERBS.join(', ')})`)
      }
      verb = argument as Verb
      continue
    }
    if (name !== undefined) throw new Error(`unexpected argument "${argument}"`)
    name = argument
  }

  const chosen = verb ?? 'list'
  if (chosen === 'add' || chosen === 'remove') {
    if (name !== undefined && file !== undefined) throw new Error(`${chosen} takes a name or --file, not both`)
    if (name === undefined && file === undefined) throw new Error(`${chosen} needs a patch name or --file <path>`)
  } else {
    if (name !== undefined) throw new Error(`${chosen} takes no positional argument`)
    if (file !== undefined) throw new Error(`${chosen} does not take --file`)
  }
  return {
    verb: chosen,
    ...name === undefined ? {} : { name },
    ...file === undefined ? {} : { file },
    ...manifest === undefined ? {} : { manifest },
    ...slot === undefined ? {} : { slot },
    all,
  }
}

/** A tree that patches can be checked against. */
interface Tree {
  /** Which slot the tree is. */
  readonly slot: SlotName
  /** Absolute slot directory. */
  readonly directory: string
  /** The tag the tree is checked out at, when it is exactly at a tag. */
  readonly tag?: string
}

/**
 * Pick the tree to verify against.
 * @param config - resolved tool configuration.
 * @param requested - `--slot` when given.
 * @returns the tree, `no-slot` when no checkout exists, or `missing` when `--slot` names an empty one.
 */
function treeOf(config: Config, requested: SlotName | undefined): Tree | 'no-slot' | 'missing' {
  const describe = (slot: SlotName): Tree => {
    const directory = slotPath(config, slot)
    const tag = tagAtHead(directory)
    return { slot, directory, ...tag === undefined ? {} : { tag } }
  }
  if (requested !== undefined) return slotExists(config, requested) ? describe(requested) : 'missing'
  const active = activeSlot(config)
  if (active !== undefined && slotExists(config, active)) return describe(active)
  const prepared = SLOT_NAMES.find(name => slotExists(config, name))
  return prepared === undefined ? 'no-slot' : describe(prepared)
}

/** One patch, as the catalog and the configuration together describe it. */
interface Row {
  /** Catalog name, absent for a configured patch the catalog does not know. */
  readonly name?: string
  /** Patch path as the configuration or the catalog stores it. */
  readonly file: string
  /** Whether staging applies it. */
  readonly active: boolean
  /** Whether the patch file exists. */
  readonly exists: boolean
  /** Catalog summary. */
  readonly summary?: string
  /** Tags the catalog says were verified. */
  readonly verifiedTags: readonly string[]
  /** Release that made the patch unnecessary. */
  readonly obsoleteSince?: string
}

/**
 * Merge the catalog with the configured patch list.
 * @param config - resolved tool configuration.
 * @param loaded - the catalog.
 * @param toolRoot - the tool's own directory.
 * @returns catalog order first, then configured patches the catalog does not know.
 */
function rowsOf(config: Config, loaded: LoadedManifest, toolRoot: string): Row[] {
  const rows: Row[] = loaded.manifest.patches.map(entry => ({
    name: entry.name,
    file: entry.file,
    active: config.patchFiles.some(entryFile => samePatchFile(entryFile, entry.file)),
    exists: existsSync(resolvePatchFile(entry.file, toolRoot)),
    summary: entry.summary,
    verifiedTags: entry.verifiedTags,
    ...entry.obsoleteSince === undefined ? {} : { obsoleteSince: entry.obsoleteSince },
  }))
  for (const entryFile of config.patchFiles) {
    if (loaded.manifest.patches.some(entry => samePatchFile(entry.file, entryFile))) continue
    rows.push({
      file: normalizePatchFile(entryFile),
      active: true,
      exists: existsSync(resolvePatchFile(entryFile, toolRoot)),
      verifiedTags: [],
    })
  }
  return rows
}

/**
 * Note the problems a row carries, in the order an operator acts on them.
 * @param row - the merged row.
 */
function notesOf(row: Row): string[] {
  const notes: string[] = []
  if (!row.exists) notes.push('the patch file does not exist; staging will fail')
  if (row.obsoleteSince !== undefined) notes.push(`upstream no longer needs it since ${row.obsoleteSince}`)
  if (!row.active && row.exists) notes.push(`not applied; enable with "dsh-upgrade patch add ${row.name ?? row.file}"`)
  return notes
}

/**
 * Write the configured patch list back without disturbing the rest of the file.
 *
 * Rewriting the parsed configuration would drop fields this build does not know and would
 * turn relative paths absolute; editing the raw object keeps the operator's file intact.
 * @param configPath - the configuration file.
 * @param mutate - receives the current list and returns the next one.
 * @returns the list that was written.
 */
function writePatchFiles(configPath: string, mutate: (current: readonly string[]) => readonly string[]): readonly string[] {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const current = Array.isArray(raw['patchFiles']) ? (raw['patchFiles'] as string[]) : []
  const next = [...mutate(current)]
  raw['patchFiles'] = next
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return next
}

/**
 * Whether a configured entry names the patch a query names.
 * @param entry - one configured entry.
 * @param query - a path the operator typed.
 * @param toolRoot - the tool's own directory.
 * @param cwd - the directory the operator ran in.
 */
function samePatchEntry(entry: string, query: string, toolRoot: string, cwd: string): boolean {
  if (samePatchFile(entry, query)) return true
  const entryAbsolute = resolvePatchFile(entry, toolRoot)
  const queryAbsolute = isAbsolute(query) ? query : resolve(cwd, query)
  return samePatchFile(entryAbsolute, queryAbsolute)
}

/**
 * How to store a patch path: relative to the tool root when it lives there.
 * @param file - absolute patch path.
 * @param toolRoot - the tool's own directory.
 */
function storedPath(file: string, toolRoot: string): string {
  const relativePath = relative(toolRoot, file)
  const inside = relativePath !== '' && !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath)
  return inside ? normalizePatchFile(relativePath) : file
}

/**
 * Print one patch line, then its notes.
 * @param row - the patch to print.
 */
function printRow(row: Row): void {
  const marker = row.active ? 'active  ' : '-       '
  const verified = row.verifiedTags.length === 0 ? 'no verified tags' : `verified ${row.verifiedTags.join(', ')}`
  const label = row.name === undefined ? row.file : `${row.name} (${row.file})`
  process.stdout.write(`  ${marker} ${label}  — ${verified}\n`)
  if (row.summary !== undefined) process.stdout.write(`           ${row.summary}\n`)
  for (const note of notesOf(row)) process.stdout.write(`           ! ${note}\n`)
}

/**
 * Run `patch list`.
 * @param config - resolved tool configuration.
 * @param loaded - the catalog.
 * @param toolRoot - the tool's own directory.
 * @param options - global options.
 */
function runList(config: Config, loaded: LoadedManifest, toolRoot: string, options: RunOptions): number {
  const rows = rowsOf(config, loaded, toolRoot)
  const active = rows.filter(row => row.active).length
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      manifest: { path: loaded.path, present: loaded.present, count: loaded.manifest.patches.length },
      active: config.patchFiles.map(normalizePatchFile),
      patches: rows.map(row => ({
        name: row.name ?? null,
        file: row.file,
        active: row.active,
        exists: row.exists,
        summary: row.summary ?? null,
        verifiedTags: row.verifiedTags,
        obsoleteSince: row.obsoleteSince ?? null,
      })),
    })}\n`)
    return EXIT.ok
  }
  process.stdout.write('dsh-upgrade patch list\n')
  process.stdout.write(`  catalog   ${loaded.present ? loaded.path : `${loaded.path} (missing)`}\n`)
  process.stdout.write(`  applied   ${active} of ${rows.length}\n`)
  if (rows.length === 0) {
    process.stdout.write('  no patches are configured or catalogued; staging applies nothing extra\n')
    return EXIT.ok
  }
  for (const row of rows) printRow(row)
  return EXIT.ok
}

/**
 * Run `patch verify`.
 * @param config - resolved tool configuration.
 * @param loaded - the catalog.
 * @param tree - the tree to check against.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns `0` when every patch applies or is present, `3` when one needs a human.
 */
function runVerify(
  config: Config,
  loaded: LoadedManifest,
  tree: Tree,
  flags: PatchFlags,
  options: RunOptions,
): number {
  const candidates: { readonly name?: string, readonly file: string, readonly active: boolean }[] = []
  for (const entryFile of config.patchFiles) {
    const entry = findEntry(loaded.manifest, entryFile)
    candidates.push({ ...entry === undefined ? {} : { name: entry.name }, file: entryFile, active: true })
  }
  if (flags.all) {
    for (const entry of loaded.manifest.patches) {
      if (candidates.some(candidate => samePatchFile(candidate.file, entry.file))) continue
      candidates.push({ name: entry.name, file: entry.file, active: false })
    }
  }

  const checks = candidates.map(candidate => {
    const absolute = resolvePatchFile(candidate.file, options.toolRoot)
    const check = checkPatch(absolute, tree.directory)
    return { ...candidate, absolute, state: check.state, detail: check.detail }
  })
  const failing = checks.filter(check => check.state === 'conflict' || check.state === 'missing')

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: failing.length === 0,
      tree: { slot: tree.slot, path: tree.directory, tag: tree.tag ?? null },
      checks: checks.map(check => ({
        name: check.name ?? null,
        file: check.file,
        active: check.active,
        state: check.state,
        detail: check.detail ?? null,
      })),
      nextAction: failing.length === 0 ? null : 'rebase or remove the failing patches',
    })}\n`)
    return failing.length === 0 ? EXIT.ok : EXIT.manual
  }

  process.stdout.write(`dsh-upgrade patch verify — slot ${tree.slot} at ${tree.tag ?? 'an untagged commit'}\n`)
  if (checks.length === 0) {
    process.stdout.write('  no patches to verify; staging applies nothing extra\n')
    return EXIT.ok
  }
  for (const check of checks) {
    const label = check.name === undefined ? check.file : `${check.name} (${check.file})`
    const suffix = check.active ? '' : ' [not applied]'
    process.stdout.write(`  ${check.state.padEnd(8)} ${label}${suffix}\n`)
    if (check.detail !== undefined) process.stdout.write(`           ${check.detail}\n`)
  }
  if (failing.length > 0) {
    process.stderr.write(
      'dsh-upgrade patch verify: '
      + `${failing.length} patch(es) need attention; stage would refuse to prepare this version\n`
      + '  rebase the patch onto the new tag, or drop it with "dsh-upgrade patch remove <name>"\n',
    )
  }
  return failing.length === 0 ? EXIT.ok : EXIT.manual
}

/**
 * Resolve the patch a query names to an absolute path.
 * @param query - a patch name or patch path.
 * @param loaded - the catalog.
 * @param options - global options.
 * @returns the absolute path, or a message explaining why there is none.
 */
function resolveQuery(query: string, loaded: LoadedManifest, options: RunOptions): string | string[] {
  const entry = findEntry(loaded.manifest, query)
  if (entry !== undefined) return resolvePatchFile(entry.file, options.toolRoot)
  const direct = isAbsolute(query) ? query : resolve(options.cwd, query)
  if (existsSync(direct)) return direct
  if (!loaded.present) {
    return [`no patch catalog at ${loaded.path}; pass a patch path, or create the catalog`]
  }
  const names = loaded.manifest.patches.map(candidate => candidate.name)
  return [names.length === 0
    ? `the catalog at ${loaded.path} lists no patches; pass a patch path`
    : `unknown patch "${query}"; known: ${names.join(', ')}`]
}

/**
 * Run `patch add` or `patch remove`.
 * @param config - resolved tool configuration.
 * @param configPath - the configuration file to edit.
 * @param loaded - the catalog.
 * @param flags - parsed arguments.
 * @param options - global options.
 * @returns `0` when the list is in the requested state, `2`/`4` otherwise.
 */
function runEdit(
  config: Config,
  configPath: string,
  loaded: LoadedManifest,
  flags: PatchFlags,
  options: RunOptions,
): number {
  const adding = flags.verb === 'add'
  let target: string
  if (flags.file !== undefined) {
    target = isAbsolute(flags.file) ? flags.file : resolve(options.cwd, flags.file)
    if (adding && (!existsSync(target) || !statSync(target).isFile())) {
      process.stderr.write(`dsh-upgrade patch add: no patch file at ${target}\n`)
      return EXIT.usage
    }
  } else {
    const resolved = resolveQuery(flags.name ?? '', loaded, options)
    if (Array.isArray(resolved)) {
      process.stderr.write(`dsh-upgrade patch ${flags.verb}: ${resolved[0]}\n`)
      return EXIT.usage
    }
    target = resolved
  }

  if (adding) {
    if (!existsSync(target)) {
      process.stderr.write(`dsh-upgrade patch add: the catalog names ${target}, which does not exist\n`)
      return EXIT.probe
    }
    if (!looksLikePatch(target)) {
      process.stderr.write(`dsh-upgrade patch add: ${target} does not look like a git patch (no diff header)\n`)
      return EXIT.usage
    }
  }

  const stored = storedPath(target, options.toolRoot)
  const present = config.patchFiles.some(entryFile =>
    samePatchEntry(entryFile, target, options.toolRoot, options.cwd))

  if (adding && present) {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, file: stored, alreadyActive: true })}\n`)
    else process.stdout.write(`patch ${stored} is already applied; nothing to do\n`)
    return EXIT.ok
  }
  if (!adding && !present) {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, file: stored, wasActive: false })}\n`)
    else process.stdout.write(`patch ${stored} is not applied; nothing to do\n`)
    return EXIT.ok
  }

  const next = writePatchFiles(configPath, current => adding
    ? [...current, stored]
    : current.filter(entryFile => !samePatchEntry(entryFile, target, options.toolRoot, options.cwd)))

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, file: stored, patchFiles: next, nextAction: 'stage' })}\n`)
    return EXIT.ok
  }
  process.stdout.write(`${adding ? 'added' : 'removed'} patch ${stored}\n`)
  process.stdout.write(`  patchFiles now ${next.length > 0 ? next.join(', ') : '(empty)'}\n`)
  if (adding) process.stdout.write('  next: dsh-upgrade patch verify, then dsh-upgrade stage\n')
  return EXIT.ok
}

/**
 * Whether a file starts with something git would read as a patch.
 * @param file - absolute path of the candidate.
 */
function looksLikePatch(file: string): boolean {
  const head = readFileSync(file, 'utf8').split(/\r?\n/, 16)
  return head.some(line => line.startsWith('diff --git ') || line.startsWith('--- '))
}

/**
 * Run `patch`.
 * @param args - arguments after the command name.
 * @param options - global options.
 * @returns the process exit code.
 */
export function runPatch(args: readonly string[], options: RunOptions): number {
  let flags: PatchFlags
  try {
    flags = parseFlags(args)
  } catch (error) {
    process.stderr.write(`dsh-upgrade patch: ${(error as Error).message}\n`)
    return EXIT.usage
  }

  const configPath = resolveConfigPath(options.configPath, options.cwd, options.toolRoot)
  if (!existsSync(configPath)) {
    process.stderr.write(`dsh-upgrade patch: ${configPath} not found (run "dsh-upgrade init")\n`)
    return EXIT.probe
  }
  const config = loadConfig(configPath)

  const manifestPath = flags.manifest === undefined
    ? defaultManifestPath(options.toolRoot)
    : resolve(options.cwd, flags.manifest)
  let loaded: LoadedManifest
  try {
    loaded = loadManifest(manifestPath)
  } catch (error) {
    process.stderr.write(`dsh-upgrade patch: ${(error as Error).message}\n`)
    return EXIT.probe
  }

  if (flags.verb === 'list') return runList(config, loaded, options.toolRoot, options)
  if (flags.verb === 'verify') {
    const tree = treeOf(config, flags.slot)
    if (tree === 'no-slot') {
      process.stderr.write(`dsh-upgrade patch verify: no slot checkout under ${config.slotsRoot} (run "dsh-upgrade stage")\n`)
      return EXIT.probe
    }
    if (tree === 'missing') {
      process.stderr.write(`dsh-upgrade patch verify: slot ${flags.slot ?? '?'} has no checkout\n`)
      return EXIT.probe
    }
    return runVerify(config, loaded, tree, flags, options)
  }
  return runEdit(config, configPath, loaded, flags, options)
}
