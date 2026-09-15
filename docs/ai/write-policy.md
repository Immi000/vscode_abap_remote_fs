# Write Policy (Object-level restrictions)

The write policy restricts which SAP objects ABAP FS may **create, change, delete, activate** or **edit text elements for** — by connection, package, object name and object type.

It is useful when you let AI assistants work on a development system, but want to keep them inside a sandbox (for example `$TMP` or a dedicated `Z_AI_SANDBOX` package) no matter what they try.

The policy is enforced where ABAP FS actually writes to SAP, so it applies equally to:

- **GitHub Copilot** — ABAP FS language model tools and Copilot's built-in file edits on `adt://` files
- **External AI clients via the [MCP server](../mcp-server.md)** (Cursor, Claude Code, Cline, ...)
- **Manual actions** — saving in the editor, creating objects, activating, abapGit pull, ...

> **Important:** The write policy is an additional safety net inside VS Code. SAP authorizations (authorization object `S_DEVELOP`) remain the authoritative control over what a user can change in the system.

## Settings

All write policy settings are only read from your **user settings**. Values in a workspace `.vscode/settings.json` are ignored, so an AI agent that edits workspace files cannot weaken the policy.

| Setting                            | Default       | Description                                                                                                   |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `abapfs.writePolicy.enabled`       | `false`       | Turns the write policy on                                                                                     |
| `abapfs.writePolicy.mode`          | `"allowlist"` | `allowlist`: only operations matching a rule are allowed. `denylist`: operations matching a rule are blocked |
| `abapfs.writePolicy.onViolation`   | `"block"`     | `block`: refuse the operation. `confirm`: ask with an **Allow once** button (never for MCP requests)          |
| `abapfs.writePolicy.rules`         | `[]`          | List of rules, see below                                                                                      |

## Example

Allow AI assistants (and yourself) to change only `$TMP` and the `Z_AI_SANDBOX*` packages on connections starting with `dev`, plus source changes and activation of `ZCL_AI_*` classes anywhere on those systems:

```json
{
  "abapfs.writePolicy.enabled": true,
  "abapfs.writePolicy.rules": [
    { "connections": ["dev*"], "packages": ["$TMP", "Z_AI_SANDBOX*"] },
    {
      "connections": ["dev*"],
      "names": ["ZCL_AI_*"],
      "types": ["CLAS/OC"],
      "operations": ["write", "activate"]
    }
  ]
}
```

With this configuration, trying to edit a class in package `ZPROD_CORE` fails with an error like:

```text
Blocked by ABAP FS write policy: operation "write" is not permitted for CLAS/OC ZCL_BILLING
(package ZPROD_CORE, connection dev100) - no allowlist rule matches.
```

The AI assistant receives this message as the tool error.

## Rules

A rule matches when **all** of its specified fields match. A missing or empty field matches everything — so in allowlist mode an empty rule `{}` allows everything.

| Field         | Matches against                                                     | Example                   |
| ------------- | ------------------------------------------------------------------- | ------------------------- |
| `connections` | The connection ID as shown in ABAP FS                               | `["dev100", "dev*"]`      |
| `packages`    | The object's immediate package                                      | `["$TMP", "Z_AI_*"]`      |
| `names`       | The object name                                                     | `["ZCL_AI_*"]`            |
| `types`       | The ADT object type                                                 | `["CLAS/OC", "PROG/P"]`   |
| `operations`  | `write`, `delete`, `create`, `activate`, `textElements`             | `["write", "activate"]`   |

Patterns support `*` (any characters) and `?` (one character) and are case-insensitive.

Operation names are case-insensitive. A rule containing an unknown operation name (for example a typo such as `activation`) is treated conservatively: it never allows anything in `allowlist` mode and blocks everything it matches in `denylist` mode. A warning is written to the **ABAP FS** output channel.

### How objects are identified

- **Includes are checked against their main object.** Editing a method of a class checks the class (`CLAS/OC`), editing a function module checks its function group (`FUGR/F`).
- **The package is the object's immediate package.** Sub-packages are not matched by the super package — use a pattern such as `Z_AI_SANDBOX*` or list them explicitly. Package lookups are cached for 5 minutes.
- **Unknown package:** if the package cannot be determined, package patterns do not match. In `allowlist` mode such objects are blocked by rules that require a package; in `denylist` mode package rules do not block them.
- **New objects** are checked against the package they are created in. Function modules and function group includes are checked against the package of their function group, regardless of the package requested.

### Operations

| Operation      | Covers                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `write`        | Saving source code (editor saves, Copilot edits, `replace_string_in_abap_object`), creating a test include, Extract Method refactoring, abapGit pull (checked against the repository package, type `DEVC/K`) |
| `delete`       | Deleting objects                                                                                                               |
| `create`       | Creating objects (command, create object editor, `abapfs_create_object` tool, RAP generator — every generated object)         |
| `activate`     | Activating objects, including other inactive objects activated together and activation before unit test runs                  |
| `textElements` | Creating or updating text elements (tool and text elements editor). Saving text elements also activates the object, so `activate` must be allowed as well |

## Confirm Mode

With `"abapfs.writePolicy.onViolation": "confirm"`, a violation shows a modal warning with an **Allow once** button instead of failing immediately. Closing the dialog blocks the operation.

Requests that come from the **MCP server are always blocked** and never show this dialog, because the person at the keyboard may not be the one who triggered them.

## Logging

Every denied operation (and every **Allow once** override) is logged to the **ABAP FS** output channel with connection, operation, object type, name, package and source (`mcp` or `other`).

## Limitations

- Locks taken when you start typing in an editor are not restricted — only the actual save is.
- Transport operations (release, delete, add user) are not object changes and are not covered.
- The check runs inside VS Code: changes made in SAP GUI, Eclipse ADT or other tools are not affected.
