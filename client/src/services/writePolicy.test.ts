const mockSettings: Record<string, { globalValue?: unknown; workspaceValue?: unknown }> = {}

jest.mock(
  "vscode",
  () => ({
    workspace: {
      getConfiguration: jest.fn(() => ({
        inspect: jest.fn((key: string) => mockSettings[key])
      }))
    }
  }),
  { virtual: true }
)
jest.mock("./funMessenger", () => ({
  funWindow: { showWarningMessage: jest.fn() }
}))
jest.mock("../adt/conections", () => ({ getRoot: jest.fn() }))
jest.mock("../adt/AdtTransports", () => ({ selectTransport: jest.fn() }))
jest.mock("abapfs", () => ({ isAbapStat: (x: any) => !!x?.object }))
jest.mock("../lib", () => ({
  log: Object.assign(jest.fn(), { warn: jest.fn(), debug: jest.fn() })
}))
jest.mock("abap-adt-api", () => ({
  isGroupType: (t: string) => t === "FUGR/FF" || t === "FUGR/I",
  objectPath: (type: string, name: string) => `/sap/bc/adt/${type}/${name}`.toLowerCase()
}))

import {
  assertWriteAllowed,
  assertWriteAllowedAll,
  assertWriteNotBlocked,
  clearWritePolicyPackageCache,
  creationTarget,
  globToRegExp,
  isMcpInvocation,
  packageFromPath,
  readWritePolicyConfig,
  runAsMcp,
  targetFromObject,
  WritePolicyError,
  WriteTarget
} from "./writePolicy"
import { funWindow } from "./funMessenger"
import { getRoot } from "../adt/conections"
import { log } from "../lib"

const showWarning = funWindow.showWarningMessage as jest.Mock
const mockGetRoot = getRoot as jest.Mock

const setPolicy = (values: Record<string, unknown>) => {
  for (const key of Object.keys(mockSettings)) delete mockSettings[key]
  for (const [key, value] of Object.entries(values)) mockSettings[key] = { globalValue: value }
}

const target = (overrides: Partial<WriteTarget> = {}): WriteTarget => ({
  connectionId: "dev100",
  name: "ZCL_AI_TEST",
  type: "CLAS/OC",
  packageName: "Z_AI_SANDBOX",
  ...overrides
})

const sandboxRules = [
  { connections: ["dev*"], packages: ["$TMP", "Z_AI_SANDBOX*"] },
  {
    connections: ["dev*"],
    names: ["ZCL_AI_*"],
    types: ["CLAS/OC"],
    operations: ["write", "activate"]
  }
]

const step = (type: string, name: string) =>
  ({
    "adtcore:type": type,
    "adtcore:name": name,
    "adtcore:uri": "",
    "projectexplorer:category": ""
  }) as any

beforeEach(() => {
  jest.clearAllMocks()
  clearWritePolicyPackageCache()
  setPolicy({})
})

describe("configuration", () => {
  test("defaults to disabled allowlist/block", () => {
    expect(readWritePolicyConfig()).toEqual({
      enabled: false,
      mode: "allowlist",
      onViolation: "block",
      rules: []
    })
  })

  test("ignores workspace-level settings", async () => {
    mockSettings.enabled = { workspaceValue: true }
    mockSettings.rules = { workspaceValue: [] }
    expect(readWritePolicyConfig().enabled).toBe(false)
    await expect(assertWriteAllowed(target(), "write")).resolves.toBeUndefined()
  })

  test("workspace settings cannot weaken user settings", async () => {
    mockSettings.enabled = { globalValue: true, workspaceValue: false }
    mockSettings.mode = { globalValue: "allowlist", workspaceValue: "denylist" }
    mockSettings.rules = { globalValue: [], workspaceValue: [{}] }
    await expect(assertWriteAllowed(target(), "write")).rejects.toBeInstanceOf(WritePolicyError)
  })

  test("unknown mode/onViolation values fall back to the safe defaults", () => {
    setPolicy({ enabled: true, mode: "nonsense", onViolation: "yolo" })
    const config = readWritePolicyConfig()
    expect(config.mode).toBe("allowlist")
    expect(config.onViolation).toBe("block")
  })
})

describe("glob matching", () => {
  test.each([
    ["Z_AI_*", "z_ai_sandbox", true],
    ["Z_AI_?", "Z_AI_1", true],
    ["Z_AI_?", "Z_AI_12", false],
    ["$TMP", "$tmp", true],
    ["$TMP", "$TMPX", false],
    ["/UI5/*", "/ui5/cl_x", true],
    ["ZCL.X", "ZCLAX", false],
    ["*", "", true]
  ])("%s ~ %s = %s", (pattern, value, expected) => {
    expect(globToRegExp(pattern).test(value)).toBe(expected)
  })
})

describe("allowlist", () => {
  beforeEach(() => setPolicy({ enabled: true, rules: sandboxRules }))

  test("does nothing when disabled", async () => {
    setPolicy({ enabled: false, rules: [] })
    await expect(assertWriteAllowed(target({ packageName: "ZPROD" }), "delete")).resolves.toBe(
      undefined
    )
  })

  test("allows objects matching a rule", async () => {
    await expect(assertWriteAllowed(target(), "delete")).resolves.toBeUndefined()
    await expect(assertWriteAllowed(target({ packageName: "$tmp" }), "create")).resolves.toBe(
      undefined
    )
  })

  test("blocks objects matching no rule with a clear message", async () => {
    const promise = assertWriteAllowed(target({ name: "ZCL_OTHER", packageName: "ZPROD" }), "write")
    await expect(promise).rejects.toBeInstanceOf(WritePolicyError)
    await expect(promise).rejects.toThrow(/write policy.*"write".*ZCL_OTHER.*ZPROD.*dev100/)
  })

  test("blocks other connections", async () => {
    await expect(assertWriteAllowed(target({ connectionId: "prd100" }), "write")).rejects.toThrow(
      WritePolicyError
    )
  })

  test("respects the operations filter", async () => {
    const outsidePackage = target({ packageName: "ZPROD" })
    await expect(assertWriteAllowed(outsidePackage, "write")).resolves.toBeUndefined()
    await expect(assertWriteAllowed(outsidePackage, "activate")).resolves.toBeUndefined()
    await expect(assertWriteAllowed(outsidePackage, "delete")).rejects.toThrow(WritePolicyError)
    await expect(assertWriteAllowed(outsidePackage, "textElements")).rejects.toThrow(
      WritePolicyError
    )
  })

  test("unknown package never matches package rules", async () => {
    await expect(
      assertWriteAllowed(target({ name: "ZOTHER", packageName: undefined }), "write")
    ).rejects.toThrow(WritePolicyError)
  })

  test("reports all denied targets at once", async () => {
    const denied = [
      target({ name: "ZA", packageName: "X" }),
      target({ name: "ZB", packageName: "Y" })
    ]
    await expect(assertWriteAllowedAll([target(), ...denied], "delete")).rejects.toMatchObject({
      targets: denied
    })
  })

  test("logs denials with source", async () => {
    await expect(
      assertWriteAllowed(target({ name: "ZX", packageName: "ZPROD" }), "delete")
    ).rejects.toThrow()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/denied.*op=delete.*name=ZX.*source=other/)
    )
  })
})

describe("denylist", () => {
  beforeEach(() =>
    setPolicy({ enabled: true, mode: "denylist", rules: [{ packages: ["ZPROD*"] }] })
  )

  test("blocks objects matching a rule", async () => {
    await expect(
      assertWriteAllowed(target({ packageName: "ZPROD_CORE" }), "write")
    ).rejects.toThrow(/denylist/)
  })

  test("allows objects matching no rule", async () => {
    await expect(assertWriteAllowed(target(), "write")).resolves.toBeUndefined()
  })
})

describe("confirm mode", () => {
  const denied = target({ name: "ZX", packageName: "ZPROD" })
  beforeEach(() => setPolicy({ enabled: true, onViolation: "confirm", rules: sandboxRules }))

  test("allows once when the user confirms", async () => {
    showWarning.mockResolvedValue("Allow once")
    await expect(assertWriteAllowed(denied, "delete")).resolves.toBeUndefined()
    expect(showWarning).toHaveBeenCalledWith(expect.any(String), { modal: true }, "Allow once")
  })

  test("blocks when the dialog is dismissed", async () => {
    showWarning.mockResolvedValue(undefined)
    await expect(assertWriteAllowed(denied, "delete")).rejects.toThrow(WritePolicyError)
  })

  test("MCP invocations never get the confirm override", async () => {
    showWarning.mockResolvedValue("Allow once")
    await expect(runAsMcp(() => assertWriteAllowed(denied, "delete"))).rejects.toThrow(
      WritePolicyError
    )
    expect(showWarning).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("source=mcp"))
  })

  test("MCP context survives async boundaries", async () => {
    const seen = await runAsMcp(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return isMcpInvocation()
    })
    expect(seen).toBe(true)
    expect(isMcpInvocation()).toBe(false)
  })

  test("explicit fromMcp option never confirms", async () => {
    showWarning.mockResolvedValue("Allow once")
    await expect(assertWriteAllowed(denied, "delete", { fromMcp: true })).rejects.toThrow()
    expect(showWarning).not.toHaveBeenCalled()
  })

  test("early check does not prompt outside MCP", async () => {
    await expect(assertWriteNotBlocked(denied, "delete")).resolves.toBeUndefined()
    expect(showWarning).not.toHaveBeenCalled()
  })

  test("early check blocks MCP", async () => {
    await expect(runAsMcp(() => assertWriteNotBlocked(denied, "delete"))).rejects.toThrow()
  })
})

describe("early check in block mode", () => {
  test("throws without dialog", async () => {
    setPolicy({ enabled: true, rules: sandboxRules })
    await expect(
      assertWriteNotBlocked(target({ name: "ZX", packageName: "ZPROD" }), "delete")
    ).rejects.toThrow(WritePolicyError)
    expect(showWarning).not.toHaveBeenCalled()
  })
})

describe("target resolution", () => {
  const objectPath = jest.fn()
  beforeEach(() => mockGetRoot.mockReturnValue({ service: { objectPath } }))

  test("packageFromPath returns the immediate package", () => {
    const steps = [step("DEVC/K", "ZMAIN"), step("DEVC/K", "ZSUB"), step("CLAS/OC", "ZCL_X")]
    expect(packageFromPath(steps, "ZCL_X")).toBe("ZSUB")
    expect(packageFromPath([step("DEVC/K", "ZMAIN"), step("DEVC/K", "ZSUB")], "ZSUB")).toBe("ZMAIN")
    expect(packageFromPath([], "ZCL_X")).toBeUndefined()
  })

  test("includes resolve to their main object", async () => {
    objectPath.mockResolvedValue([step("DEVC/K", "Z_AI_SANDBOX"), step("CLAS/OC", "ZCL_MAIN")])
    const main = { type: "CLAS/OC", name: "ZCL_MAIN", path: "/sap/bc/adt/oo/classes/zcl_main" }
    const include = { type: "CLAS/I", name: "ZCL_MAIN======CCIMP", path: "/inc", lockObject: main }
    ;(main as any).lockObject = main

    const result = await targetFromObject("dev100", include as any)

    expect(result).toEqual({
      connectionId: "dev100",
      name: "ZCL_MAIN",
      type: "CLAS/OC",
      packageName: "Z_AI_SANDBOX"
    })
    expect(objectPath).toHaveBeenCalledWith("/sap/bc/adt/oo/classes/zcl_main")
  })

  test("caches package lookups", async () => {
    objectPath.mockResolvedValue([step("DEVC/K", "$TMP"), step("PROG/P", "ZPROG")])
    const obj: any = { type: "PROG/P", name: "ZPROG", path: "/p" }
    obj.lockObject = obj
    await targetFromObject("dev100", obj)
    await targetFromObject("dev100", obj)
    expect(objectPath).toHaveBeenCalledTimes(1)
  })

  test("unresolvable package yields undefined", async () => {
    objectPath.mockRejectedValue(new Error("404"))
    const obj: any = { type: "PROG/P", name: "ZPROG", path: "/p" }
    obj.lockObject = obj
    expect((await targetFromObject("dev100", obj)).packageName).toBeUndefined()
  })

  test("function modules take the package of their function group", async () => {
    objectPath.mockResolvedValue([step("DEVC/K", "ZPROD"), step("FUGR/F", "ZFG")])
    const result = await creationTarget(
      "dev100",
      { objtype: "FUGR/FF", name: "Z_FM", parentName: "zfg" },
      "$TMP"
    )
    expect(result.packageName).toBe("ZPROD")
    expect(objectPath).toHaveBeenCalledWith("/sap/bc/adt/fugr/f/zfg")
  })

  test("regular objects use the requested package", async () => {
    const result = await creationTarget("dev100", { objtype: "CLAS/OC", name: "ZCL_X" }, "$TMP")
    expect(result).toEqual({
      connectionId: "dev100",
      name: "ZCL_X",
      type: "CLAS/OC",
      packageName: "$TMP"
    })
    expect(objectPath).not.toHaveBeenCalled()
  })
})
