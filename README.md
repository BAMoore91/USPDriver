# AC-MXNET USP-CBOX RTI Driver

RTI XP driver for the AVPro Global **AC-MXNET USP-CBOX**, controlling the unit
over TCP (default port 24) using the USPCBOX USP API (v1.07).

## Package files (shipped to the processor)
| File | Purpose |
|------|---------|
| `DriverManifest.xml` | Driver metadata + stream references |
| `USP_Driver.js` | Processor script (connection, commands, feedback parsing) |
| `ConfigSettings.xml` | Installer-editable settings (IP/port + device/layout/matrix/wall/playlist slots) |
| `SystemFunctions.xml` | Functions exposed in Integration Designer |
| `SystemVariables.xml` | Two-way feedback variables |
| `DeviceDescription.xml` | Source/template description |
| `Help.rtf` | In-app help text |

## Feature areas (v2.0)
- **Multiview** – set layout on display, switch window source (original v1.4 functions).
- **Matrix** – route a source to one display, to up to three displays, or recall a named matrix preset.
- **Video Wall** – recall a wall layout, swap a source within a wall cell.
- **Media Player** – apply / upload a playlist to displays.
- **Device & System** – reboot, identify light, OSD, stream on/off; CBOX reboot and status queries; raw command passthrough.
- **Two-way feedback** – command success/last response and active matrix/layout/wall state surfaced as System Variables.

See `Help.rtf` for setup and the full function/variable list.

## Development
Verification (no RTI hardware required) lives in `test/` and is **not** part of
the shipped package:

```bash
bash test/run.sh        # syntax + behavioral harness + XML well-formedness
```

The harness (`test/run.js`) loads `USP_Driver.js` in a sandbox that stubs the
RTI runtime (`TCP`, `Config`, `SystemVars`, `System`, `Timer`), asserts each
exported function emits the exact CBOX command, and exercises the feedback
parser. The reference SDK is `XPDriverGuide_v25.pdf`.
