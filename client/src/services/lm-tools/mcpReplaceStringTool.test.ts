const mockSettings: Record<string, { globalValue?: unknown }> = {}

jest.mock(
  "vscode",
  () => ({
    Uri: {
      parse: jest.fn((s: string) => ({
        scheme: s.split("://")[0],
        authority: s.split("://")[1]?.split("/")[0] ?? "",
        path: "/" + (s.split("://")[1]?.split("/").slice(1).join("/") ?? ""),
        toString: () => s
      }))
    },
    workspace: {
      fs: { readFile: jest.fn(), writeFile: jest.fn() },
      getConfiguration: jest.fn(() => ({
        inspect: jest.fn((key: string) => mockSettings[key])
      }))
    }
  }),
  { virtual: true }
)
jest.mock("abapfs", () => ({ isAbapFile: jest.fn(() => true) }))
jest.mock("../../adt/conections", () => ({ getOrCreateRoot: jest.fn(), getRoot: jest.fn() }))
jest.mock("../funMessenger", () => ({ funWindow: { showWarningMessage: jest.fn() } }))
jest.mock("../../lib", () => ({
  log: Object.assign(jest.fn(), { warn: jest.fn(), debug: jest.fn() })
}))

import * as vscode from "vscode"
import { executeReplace } from "./mcpReplaceStringTool"
import { getOrCreateRoot, getRoot } from "../../adt/conections"
import { funWindow } from "../funMessenger"
import { clearWritePolicyPackageCache, WritePolicyError } from "../writePolicy"

const readFile = vscode.workspace.fs.readFile as jest.Mock
const writeFile = vscode.workspace.fs.writeFile as jest.Mock
const URI = "adt://dev100/System Library/ZPROD/Source Code Library/Classes/ZCL_X/ZCL_X.clas.abap"

const setPolicy = (values: Record<string, unknown>) => {
  for (const key of Object.keys(mockSettings)) delete mockSettings[key]
  for (const [key, value] of Object.entries(values)) mockSettings[key] = { globalValue: value }
}

beforeEach(() => {
  jest.clearAllMocks()
  clearWritePolicyPackageCache()
  const clas: any = { type: "CLAS/OC", name: "ZCL_X", path: "/sap/bc/adt/oo/classes/zcl_x" }
  clas.lockObject = clas
  const include = { type: "CLAS/I", name: "ZCL_X", path: "/inc", lockObject: clas }
  ;(getOrCreateRoot as jest.Mock).mockResolvedValue({
    getNodeAsync: jest.fn().mockResolvedValue({ object: include })
  })
  const objectPath = jest.fn().mockResolvedValue([
    { "adtcore:type": "DEVC/K", "adtcore:name": "ZPROD" },
    { "adtcore:type": "CLAS/OC", "adtcore:name": "ZCL_X" }
  ])
  ;(getRoot as jest.Mock).mockReturnValue({ service: { objectPath } })
  readFile.mockResolvedValue(Buffer.from("old line", "utf8"))
  writeFile.mockResolvedValue(undefined)
})

describe("executeReplace write policy", () => {
  test("writes when the policy is disabled", async () => {
    await executeReplace(URI, "old", "new")
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  test("writes when the target is allowed", async () => {
    setPolicy({ enabled: true, rules: [{ packages: ["ZPROD"] }] })
    await executeReplace(URI, "old", "new")
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  test("rejects a denied target and does not write", async () => {
    setPolicy({ enabled: true, rules: [{ packages: ["$TMP"] }] })
    await expect(executeReplace(URI, "old", "new")).rejects.toBeInstanceOf(WritePolicyError)
    expect(writeFile).not.toHaveBeenCalled()
  })

  test("never offers the confirm override", async () => {
    setPolicy({ enabled: true, onViolation: "confirm", rules: [{ packages: ["$TMP"] }] })
    ;(funWindow.showWarningMessage as jest.Mock).mockResolvedValue("Allow once")
    await expect(executeReplace(URI, "old", "new")).rejects.toThrow(/write policy/)
    expect(funWindow.showWarningMessage).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })
})
