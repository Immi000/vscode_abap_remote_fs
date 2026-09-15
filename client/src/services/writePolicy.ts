/**
 * Write Policy - object-level write restrictions
 *
 * Restricts which SAP objects may be created, changed, deleted, activated or have their
 * text elements changed, by connection, package, object name and object type.
 *
 * The policy is enforced at the actual SAP write paths (FsProvider, object creation,
 * activation, text elements, ...), so it applies equally to GitHub Copilot, the MCP server
 * and manual actions.
 *
 * Security notes:
 * - Configuration is read ONLY from user/global settings. Workspace settings are ignored so
 *   an AI agent editing .vscode/settings.json cannot weaken the policy.
 * - Calls originating from the MCP server never get the "confirm" override: MCP invocations
 *   are marked with AsyncLocalStorage (see runAsMcp) and always block.
 * - SAP authorizations (S_DEVELOP) remain the authoritative control.
 */

import { AsyncLocalStorage } from "async_hooks"
import { workspace } from "vscode"
import { AbapObject } from "abapobject"
import { CreatableTypeIds, PathStep, isGroupType, objectPath } from "abap-adt-api"
import { isAbapStat } from "abapfs"
import { funWindow as window } from "./funMessenger"
import { getRoot } from "../adt/conections"
import { ObjectType, parseObjectName } from "../adt/textElements"
import { log } from "../lib"

// ============================================================================
// TYPES
// ============================================================================

export type WriteOp = "write" | "delete" | "create" | "activate" | "textElements"
export const WRITE_OPS: readonly WriteOp[] = [
  "write",
  "delete",
  "create",
  "activate",
  "textElements"
]

export type WritePolicyMode = "allowlist" | "denylist"
export type WritePolicyViolationAction = "block" | "confirm"

/** A rule matches when every specified field matches. Missing/empty fields match everything. */
export interface WritePolicyRule {
  connections?: string[]
  packages?: string[]
  names?: string[]
  types?: string[]
  operations?: WriteOp[]
}

export interface WriteTarget {
  connectionId: string
  name: string
  type: string
  /** undefined when the package could not be resolved - never matches package patterns */
  packageName?: string
}

export interface WritePolicyConfig {
  enabled: boolean
  mode: WritePolicyMode
  onViolation: WritePolicyViolationAction
  rules: WritePolicyRule[]
}

export interface WriteCheckOptions {
  /** force MCP semantics (never confirm) even without an MCP async context */
  fromMcp?: boolean
}

export class WritePolicyError extends Error {
  constructor(
    message: string,
    readonly targets: WriteTarget[],
    readonly op: WriteOp
  ) {
    super(message)
    this.name = "WritePolicyError"
  }
}

// ============================================================================
// MCP CONTEXT
// ============================================================================

const mcpContext = new AsyncLocalStorage<{ source: "mcp" }>()

/** Runs fn marked as an MCP invocation. Write policy violations inside always block. */
export function runAsMcp<T>(fn: () => T): T {
  return mcpContext.run({ source: "mcp" }, fn)
}

export function isMcpInvocation(): boolean {
  return mcpContext.getStore()?.source === "mcp"
}

// ============================================================================
// CONFIGURATION (user/global scope only)
// ============================================================================

const SECTION = "abapfs.writePolicy"

function globalValue<T>(key: string): T | undefined {
  return workspace.getConfiguration(SECTION).inspect<T>(key)?.globalValue
}

const toStringList = (value: unknown): string[] | undefined => {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === "string")
}

function sanitizeRule(raw: unknown): WritePolicyRule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  return {
    connections: toStringList(r.connections),
    packages: toStringList(r.packages),
    names: toStringList(r.names),
    types: toStringList(r.types),
    operations: toStringList(r.operations) as WriteOp[] | undefined
  }
}

export function readWritePolicyConfig(): WritePolicyConfig {
  const rawRules = globalValue<unknown>("rules")
  const rules = Array.isArray(rawRules) ? rawRules.map(sanitizeRule) : []
  return {
    enabled: globalValue<boolean>("enabled") === true,
    mode: globalValue<string>("mode") === "denylist" ? "denylist" : "allowlist",
    onViolation: globalValue<string>("onViolation") === "confirm" ? "confirm" : "block",
    rules: rules.filter((r): r is WritePolicyRule => !!r)
  }
}

// ============================================================================
// MATCHING
// ============================================================================

const globCache = new Map<string, RegExp>()

export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern)
  if (cached) return cached
  const source = pattern
    .split("")
    .map(c => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&")))
    .join("")
  const regex = new RegExp(`^${source}$`, "i")
  globCache.set(pattern, regex)
  return regex
}

/** Namespace objects may carry the division slash used in file names */
const normalize = (value: string) => value.replace(/∕/g, "/").trim()

export function matchesGlob(patterns: string[] | undefined, value: string | undefined): boolean {
  if (!patterns || patterns.length === 0) return true
  if (value === undefined || value === "") return false
  const normalized = normalize(value)
  return patterns.some(p => globToRegExp(normalize(p)).test(normalized))
}

const matchesOperation = (operations: string[] | undefined, op: WriteOp) =>
  !operations ||
  operations.length === 0 ||
  operations.some(o => o.toLowerCase() === op.toLowerCase())

export function ruleMatches(rule: WritePolicyRule, target: WriteTarget, op: WriteOp): boolean {
  return (
    matchesOperation(rule.operations, op) &&
    matchesGlob(rule.connections, target.connectionId) &&
    matchesGlob(rule.packages, target.packageName) &&
    matchesGlob(rule.names, target.name) &&
    matchesGlob(rule.types, target.type)
  )
}

export function isWriteAllowed(config: WritePolicyConfig, target: WriteTarget, op: WriteOp) {
  if (!config.enabled) return true
  const matched = config.rules.some(rule => ruleMatches(rule, target, op))
  return config.mode === "allowlist" ? matched : !matched
}

// ============================================================================
// ENFORCEMENT
// ============================================================================

const describeTarget = (t: WriteTarget) =>
  `${t.type} ${t.name} (package ${t.packageName ?? "unknown"}, connection ${t.connectionId})`

function violationMessage(config: WritePolicyConfig, targets: WriteTarget[], op: WriteOp) {
  const reason =
    config.mode === "allowlist" ? "no allowlist rule matches" : "the object matches a denylist rule"
  return (
    `Blocked by ABAP FS write policy: operation "${op}" is not permitted for ` +
    `${targets.map(describeTarget).join(", ")} - ${reason}. ` +
    `Do not retry or work around this restriction. The user can review the ` +
    `"abapfs.writePolicy" settings in their user settings.`
  )
}

function logDecision(kind: string, targets: WriteTarget[], op: WriteOp, fromMcp: boolean) {
  for (const t of targets)
    log.warn(
      `[WritePolicy] ${kind}: connection=${t.connectionId} op=${op} type=${t.type} ` +
        `name=${t.name} package=${t.packageName ?? "<unknown>"} source=${fromMcp ? "mcp" : "other"}`
    )
}

async function confirmOverride(message: string) {
  const allowOnce = "Allow once"
  const choice = await window.showWarningMessage(message, { modal: true }, allowOnce)
  return choice === allowOnce
}

const uniqueTargets = (targets: WriteTarget[]) => {
  const seen = new Set<string>()
  return targets.filter(t => {
    const key = targetKey(t)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const targetKey = (t: WriteTarget) =>
  `${t.connectionId}|${t.type}|${normalize(t.name)}`.toUpperCase()

/**
 * Throws a WritePolicyError when any target is not allowed for op.
 * With onViolation "confirm" (never for MCP calls) the user may allow the operation once.
 */
export async function assertWriteAllowedAll(
  targets: WriteTarget[],
  op: WriteOp,
  options: WriteCheckOptions = {}
): Promise<void> {
  const config = readWritePolicyConfig()
  if (!config.enabled) return
  const denied = uniqueTargets(targets.filter(t => !isWriteAllowed(config, t, op)))
  if (denied.length === 0) return
  const fromMcp = options.fromMcp === true || isMcpInvocation()
  const message = violationMessage(config, denied, op)
  if (config.onViolation === "confirm" && !fromMcp && (await confirmOverride(message))) {
    logDecision("allowed once by user", denied, op, fromMcp)
    return
  }
  logDecision("denied", denied, op, fromMcp)
  throw new WritePolicyError(message, denied, op)
}

export function assertWriteAllowed(target: WriteTarget, op: WriteOp, options?: WriteCheckOptions) {
  return assertWriteAllowedAll([target], op, options)
}

/**
 * Non-interactive early check (tool invoke/prepareInvocation): throws only when the
 * violation would block anyway, i.e. for MCP calls or onViolation "block".
 * In "confirm" mode the actual write path asks the user.
 */
export async function assertWriteNotBlocked(target: WriteTarget, op: WriteOp) {
  const config = readWritePolicyConfig()
  if (!config.enabled || isWriteAllowed(config, target, op)) return
  if (config.onViolation === "confirm" && !isMcpInvocation()) return
  return assertWriteAllowed(target, op)
}

// ============================================================================
// TARGET RESOLUTION
// ============================================================================

const PACKAGE_TTL_MS = 5 * 60_000
const packageCache = new Map<string, { packageName: string; expires: number }>()

export function clearWritePolicyPackageCache() {
  packageCache.clear()
}

const isPackageStep = (s: PathStep) => `${s["adtcore:type"] ?? ""}`.startsWith("DEVC")

/** The object's immediate package: the last package step before the object itself */
export function packageFromPath(steps: PathStep[], name: string): string | undefined {
  const last = steps[steps.length - 1]
  const isSelf = last && `${last["adtcore:name"]}`.toUpperCase() === name.toUpperCase()
  const parents = isSelf ? steps.slice(0, -1) : steps
  return parents.filter(isPackageStep).pop()?.["adtcore:name"]
}

/** Resolves the package of an object by its ADT URI. Cached per connection+type+name. */
export async function resolvePackage(
  connectionId: string,
  type: string,
  name: string,
  adtUri: string
): Promise<string | undefined> {
  const key = targetKey({ connectionId, type, name })
  const cached = packageCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.packageName
  try {
    const steps = await getRoot(connectionId).service.objectPath(adtUri)
    const packageName = packageFromPath(steps, name)
    if (packageName) packageCache.set(key, { packageName, expires: Date.now() + PACKAGE_TTL_MS })
    return packageName
  } catch (e) {
    log.debug(`[WritePolicy] could not resolve package of ${type} ${name}: ${e}`)
    return undefined
  }
}

/** Target for an existing object. Includes map to their main (lock) object. */
export async function targetFromObject(
  connectionId: string,
  object: AbapObject
): Promise<WriteTarget> {
  const main = object.lockObject
  const packageName = await resolvePackage(connectionId, main.type, main.name, main.path)
  return { connectionId, name: main.name, type: main.type, packageName }
}

/** Target for an object identified by name/type and its ADT URI */
export async function targetFromAdtUri(
  connectionId: string,
  type: string,
  name: string,
  adtUri: string
): Promise<WriteTarget> {
  const packageName = await resolvePackage(connectionId, type, name, adtUri)
  return { connectionId, name, type, packageName }
}

/**
 * Target for an object known only by its ADT URI (e.g. inactive object lists).
 * Resolved through the filesystem so includes map to their main object like in FsProvider.
 */
export async function targetFromAdtObject(
  connectionId: string,
  type: string,
  name: string,
  adtUri: string
): Promise<WriteTarget> {
  try {
    const found = await getRoot(connectionId).findByAdtUri(adtUri)
    if (isAbapStat(found?.file)) return targetFromObject(connectionId, found.file.object)
  } catch (e) {
    log.debug(`[WritePolicy] could not resolve ${adtUri}: ${e}`)
  }
  return targetFromAdtUri(connectionId, type, name, adtUri)
}

const TEXT_ELEMENT_TYPES: Record<string, string> = {
  [ObjectType.CLASS]: "CLAS/OC",
  [ObjectType.FUNCTION_GROUP]: "FUGR/F"
}

/** Target for text element changes. Unknown kinds are treated as programs like the ADT URL. */
export async function textElementsTarget(
  connectionId: string,
  objectName: string,
  objectType?: string
): Promise<WriteTarget> {
  const info = parseObjectName(objectName, objectType)
  const type = TEXT_ELEMENT_TYPES[info.type] ?? "PROG/P"
  const name = info.cleanName.toUpperCase()
  const uri = objectPath(type as CreatableTypeIds, name, "")
  return targetFromAdtUri(connectionId, type, name, uri)
}

/** Target for operations writing into a whole package (e.g. abapGit pull) */
export const packageTarget = (connectionId: string, packageName: string): WriteTarget => ({
  connectionId,
  name: packageName,
  type: "DEVC/K",
  packageName
})

export interface CreationDetails {
  objtype: string
  name: string
  parentName?: string
}

/**
 * Target for a new object. Function group members (function modules, includes) live in
 * the package of their function group, so the package is resolved from the parent group
 * instead of trusting the requested package.
 */
export async function creationTarget(
  connectionId: string,
  details: CreationDetails,
  packageName: string | undefined
): Promise<WriteTarget> {
  const { objtype, name, parentName } = details
  const type = objtype.toUpperCase()
  if (!isGroupType(type)) return { connectionId, name, type, packageName: packageName || undefined }
  if (!parentName) return { connectionId, name, type, packageName: undefined }
  const group = parentName.toUpperCase()
  const groupUri = objectPath("FUGR/F", group, "")
  const groupPackage = await resolvePackage(connectionId, "FUGR/F", group, groupUri)
  return { connectionId, name, type, packageName: groupPackage }
}
