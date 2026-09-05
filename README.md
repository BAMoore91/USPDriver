# AC-MXNET USP-CBOX RTI Driver

RTI XP driver for the AVPro Global **AC-MXNET USP-CBOX**, controlling the unit
over TCP (default port 24) using the USPCBOX USP API (v1.07).

## Package files (shipped to the processor)
| File | Purpose |
|------|---------|
| `DriverManifest.xml` | Driver metadata + stream references |
| `USP_Driver.js` | Processor script (connection, commands, feedback parsing) |
| `ConfigSettings.xml` | Installer-editable settings (IP/port + device/layout/matrix/wall/playlist/CEC slots) |
| `SystemFunctions.xml` | Functions exposed in Integration Designer |
| `SystemVariables.xml` | Two-way feedback variables |
| `DeviceDescription.xml` | Source/template description |
| `Help.rtf` | In-app help text |

## Feature areas (v3.4)
- **Multiview** – set layout on display, switch window source (original v1.4 functions).
- **Matrix** – route a source to one display, to up to three displays, or recall a named matrix preset.
- **Video Wall** – recall a wall layout, swap a source within a wall cell.
- **Media Player** – apply / upload a playlist to displays.
- **Device & System** – reboot, identify light, OSD, stream on/off; CBOX reboot and status queries; raw command passthrough.
- **CEC** – display power on/off and stored CEC payloads sent out of any TX/RX
  endpoint, to one device, up to three displays, or all displays.
- **Two-way feedback** – command success/last response, active matrix/layout/wall
  state, and per-output matrix routing surfaced as System Variables.

See `Help.rtf` for setup and the full function/variable list.


## CEC

CEC functions build the API's `config set device cec {hexData} {device_id/device_mac}`.

- **Power** buttons send the documented `poweron` / `poweroff` keywords. The CBOX
  responds by emitting its own set of the most commonly used CEC power frames at
  the sink device from that endpoint, so these are preferred over a hand-built
  power frame.
- **Stored payloads** live in `ConfigSettings` slots `C1`..`C16`. A slot holds CEC
  data as one space-free block (`0036`), several blocks separated by commas
  (`0036,0037`), or a power keyword. Typed spaces are stripped before sending, so
  `0036, 0037` goes out as `0036,0037`.
- **Targets** may be an encoder (TX) or a decoder (RX) — CEC leaves that endpoint
  toward whatever is connected to it. The multi-display functions join endpoints
  with `:` (the API accepts fewer than 50 per command); the all-displays functions
  use `ALLRX`.
- The USP API has **no CEC query**, so there is no real display power state to read
  back. `LastCECData` / `LastCECTarget` report what the driver last sent.


## Matrix route feedback

`OutSrc1`..`OutSrc64` report the source currently feeding the display in each
`O1`..`O64` config slot; `LiveDisplaySource` does the same for the display
selected in the live Display List.

The driver reads this with `config get device routes vaurs ALLRX`. Two things
about that reply shaped the implementation:

- **It is a Lua table, not JSON** — `{ ["mac"] = {video = "mac", ...} }` — so it
  gets its own parser (`ForEachLuaEntry` / `LuaField`) rather than the JSON-ish
  helpers every other reply uses. The API doc shows it arriving without the
  usual `{"cmd":...,"code":0}` envelope, so it is recognised either by the
  echoed command or by shape; a reply that yields no entries is ignored rather
  than allowed to blank live feedback.
- **It names devices by MAC.** `config get devicelist` is keyed by MAC and
  carries each device's `id`, so `ParseDeviceList` now records both directions
  of that map and route feedback resolves through it. Until the device list has
  loaded, the variables show raw MACs; the driver republishes them with real
  names as soon as it arrives.

Routes are re-read on connect, after each routing command (single, multi, preset
recall, and the live-list route), and on demand via **Refresh Matrix Routes**.
Only video routing is surfaced — the query asks for `vaurs` because that is the
only selector form the API doc demonstrates, but audio/USB/IR/serial are parsed
and discarded.

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
