jest.mock(
  "vscode",
  () => ({
    EventEmitter: jest.fn().mockImplementation(() => ({
      event: "mockEvent",
      fire: jest.fn()
    })),
    Uri: {
      parse: jest.fn((s: string) => ({
        scheme: "adt",
        authority: "conn",
        path: s,
        toString: () => s
      }))
    }
  }),
  { virtual: true }
)

jest.mock("../conections", () => ({
  getClient: jest.fn()
}))

jest.mock("../includes", () => ({
  IncludeService: {
    get: jest.fn().mockReturnValue({
      needMain: jest.fn().mockReturnValue(false),
      current: jest.fn().mockReturnValue(null)
    })
  },
  IncludeProvider: {
    get: jest.fn().mockReturnValue({
      switchIncludeIfMissing: jest.fn().mockResolvedValue(null)
    })
  }
}))

jest.mock("../../lib", () => ({
  isDefined: jest.fn((x: any) => x !== undefined && x !== null),
  channel: { appendLine: jest.fn() }
}))

jest.mock("abap-adt-api", () => ({
  isAdtError: jest.fn(),
  inactiveObjectsInResults: jest.fn(),
  session_types: { stateful: "stateful" }
}))

jest.mock("../../services/funMessenger", () => ({
  funWindow: {
    showQuickPick: jest.fn(),
    showErrorMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    withProgress: jest.fn()
  }
}))

jest.mock("abapobject", () => ({}))

jest.mock("../../services/writePolicy", () => ({
  assertWriteAllowed: jest.fn(),
  assertWriteAllowedAll: jest.fn(),
  targetFromObject: jest.fn(async () => ({ name: "MAIN" })),
  targetFromAdtObject: jest.fn(async () => ({ name: "OTHER" })),
  targetKey: jest.fn((t: { name: string }) => t.name)
}))
import { AdtObjectActivator, ActivationEvent } from "./AdtObjectActivator"
import * as writePolicy from "../../services/writePolicy"
import { getClient } from "../conections"

const mockGetClient = getClient as jest.Mock

describe("AdtObjectActivator", () => {
  let mockStatelessClient: any
  let mockClient: any

  beforeEach(() => {
    jest.clearAllMocks()
    AdtObjectActivator["instances"].clear()

    mockStatelessClient = {
      activate: jest.fn(),
      inactiveObjects: jest.fn().mockResolvedValue([]),
      statelessClone: {
        nodeContents: jest.fn().mockResolvedValue({ nodes: [] }),
        login: jest.fn()
      },
      nodeContents: jest.fn().mockResolvedValue({ nodes: [] }),
      httpClient: {
        request: jest.fn().mockResolvedValue({ body: "" })
      }
    }
    mockClient = {
      ...mockStatelessClient,
      statelessClone: mockStatelessClient
    }
    mockGetClient.mockReturnValue(mockClient)
  })

  it("creates an instance via get()", () => {
    const instance = AdtObjectActivator.get("testconn")
    expect(instance).toBeDefined()
    expect(instance).toBeInstanceOf(AdtObjectActivator)
  })

  it("get() returns the same instance for same connId", () => {
    const a = AdtObjectActivator.get("conn1")
    const b = AdtObjectActivator.get("conn1")
    expect(a).toBe(b)
  })

  it("get() returns different instances for different connIds", () => {
    const a = AdtObjectActivator.get("conn1")
    const b = AdtObjectActivator.get("conn2")
    expect(a).not.toBe(b)
  })

  it("onActivate returns an event", () => {
    const instance = AdtObjectActivator.get("conn3")
    expect(instance.onActivate).toBeDefined()
  })

  it("constructor uses stateless client", () => {
    AdtObjectActivator.get("conn4")
    expect(mockGetClient).toHaveBeenCalledWith("conn4", false)
  })

  describe("write policy", () => {
    const denied = new Error("Blocked by ABAP FS write policy")
    const makeObject = () => {
      const main: any = { type: "CLAS/OC", name: "ZCL_X", path: "/classes/zcl_x" }
      main.lockObject = main
      main.loadStructure = jest.fn()
      return main
    }
    const uri = { authority: "conn", path: "/zcl_x" } as any

    it("rejects activation of a denied object before calling SAP", async () => {
      ;(writePolicy.assertWriteAllowed as jest.Mock).mockRejectedValueOnce(denied)
      const activator = AdtObjectActivator.get("conn")

      await expect(activator.activate(makeObject(), uri, false)).rejects.toBe(denied)

      expect(writePolicy.assertWriteAllowed).toHaveBeenCalledWith({ name: "MAIN" }, "activate")
      expect(mockClient.activate).not.toHaveBeenCalled()
    })

    it("checks additional inactive objects activated together", async () => {
      const sibling = (uri: string, name: string) => ({
        object: {
          "adtcore:uri": uri,
          "adtcore:parentUri": "/classes/zcl_x",
          "adtcore:type": "CLAS/I",
          "adtcore:name": name
        }
      })
      mockClient.inactiveObjects.mockResolvedValue([
        sibling("/classes/zcl_x", "ZCL_X"),
        sibling("/classes/zcl_other", "ZCL_OTHER")
      ])
      ;(writePolicy.assertWriteAllowedAll as jest.Mock).mockRejectedValue(denied)
      const activator = AdtObjectActivator.get("conn")

      const result = await activator.activate(makeObject(), uri, false)

      expect(result.ok).toBe(false)
      expect(result.summary).toContain("write policy")
      expect(writePolicy.assertWriteAllowedAll).toHaveBeenCalledWith(
        [{ name: "OTHER" }, { name: "OTHER" }],
        "activate"
      )
      expect(mockClient.activate).not.toHaveBeenCalled()
    })
  })
})
