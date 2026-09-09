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

Build tooling (not shipped to the processor): `PackageDriver.exe`, `Build.bat`.

## Feature areas (v4.1)
- **Multiview** – set layout on display, switch window source (original v1.4 functions).
- **Matrix** – arm a source, then tap each destination to route it; also the
  original direct routes (one display, up to three) and named preset recall.
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


## Autoprogramming tags

The driver tags its commands and selection feedback so Integration Designer can
assign them to tagged template buttons. **These tags are non-standard** (they are
not on the RTI Developer Site's standard list, so PackageDriver warns about them
and stock RTI templates will not match them) — they are defined here, and
templates must carry the same tags.

Requires `minimumApexVersion="10.0"` in `DriverManifest.xml`; without it
Integration Designer ignores every autoprogramming attribute in the driver.
`minimumSoftwareVersion` stays at 10.0 and is unrelated — ID 10+ ignores it and
it still describes the ID 9-era features (dynamic naming) the driver uses.

| Tag | Count | Assigns | Reversed state |
|-----|-------|---------|----------------|
| `SelectInput1`..`64` | 64 | Matrix: arm the source in slot `I1`..`I64` | `SrcSel1`..`64` |
| `RouteToDisplay1`..`64` | 64 | Matrix: route the armed source to `O1`..`O64` | — |
| `SelectWinID1`..`16` | 16 | Multiview: arm window 1..16 | `WinSel1`..`16` |
| `MVIDInput1`..`64` | 64 | Multiview: route slot `I1`..`I64` into the armed window | — |

Text tags, which label a button rather than command it. Integration Designer
shows these as **TEXT TAG** entries and binds them to a button's text, so one
button can carry a command tag plus two text tags — the usual display button is
`{DisplayName16}` over `{SourceName16}` with the button itself tagged
`RouteToDisplay16`:

| Tag | Count | Puts on the button |
|-----|-------|--------------------|
| `RouteToDisplay1`..`64` | 64 | **Both lines at once** — the output's name and the source it is subscribed to |
| `DisplayName1`..`64` | 64 | The name entered in output slot `O1`..`O64` |
| `SourceName1`..`64` | 64 | The source that output is subscribed to (live) |
| `InputName1`..`64` | 64 | The name entered in input slot `I1`..`I64` |
| `MVIDWinSource1`..`16` | 16 | The source currently in multiview window 1..16 (live) |
| `SelectedInputName` | 1 | The armed source (live) |
| `SelectedDisplayName` | 1 | The display selected in the Display List (live) |
| `SelectedDisplaySource` | 1 | The source feeding that selected display (live) |

`RouteToDisplay{N}` is deliberately both a command tag and a text tag. A tag's
variable can fill any one of the button's Text / Reversed / Inactive / Visible
slots, and a command and a variable on the same tag do not collide — so a
display button tagged only `RouteToDisplay16` gets the route command *and* a
label reading `RX-Bar` over `Apple TV`, with no second tag. The combined string
is published as `OutLabel1`..`64`.

A tag has one Text slot, so the two halves arrive as one string. **Label
Separator** in the driver configuration joins them: a line break by default,
with an alternate line break and visible ` - ` / `: ` / ` / ` options, because
the runtime's line-break character for button text is not documented — if the
label comes out on one line, switch the setting rather than rebuilding. A
display with no current route shows its name alone, never a dangling separator.

**Text tags carry their own number.** A tag is matched as an exact string, so a
bare `SourceName` cannot pick up the `16` from a `RouteToDisplay16` tag sitting
on the same button — there is no cross-tag context in the tag system, and tag
parameters (`Tag:#PARAMETER1`) are documented as valid only on functions, so they
cannot drive button text. Tag the text `DisplayName16` / `SourceName16` to match
the button's `RouteToDisplay16`. Making a bare `SourceName` resolve per button
would require the multi-instance restructure (each output its own `sourceid`),
which this driver does not currently use.

So a button can carry a command tag *and* text tags: tag it `SelectInput3` and
`InputName3` and it arms input 3, lights when armed, and labels itself with
whatever that slot is configured as — all from the driver.

So a source button tagged `SelectInput1` gets the arm command *and* lights up
when armed, with no manual wiring; a destination button tagged `RouteToDisplay3`
routes the armed source to whatever output `O3` names.

How this is expressed in the XML:

- **Per-choice tags.** `SelectInput`, `RouteToDisplay` and `MVIDInput` are
  `buttontag` attributes on individual `<choice>` elements inside one function's
  multiple-choice parameter. Integration Designer treats each choice as its own
  command, setting that parameter to the choice's value and leaving other
  parameters at their defaults — so one function covers all 64 tags rather than
  64 near-duplicate function entries.
- **Per-function tags.** `SelectWinID` sits on the function itself, since window
  arming is already 16 separate functions each carrying its window number as a
  hidden parameter.
- **Reversed state.** `SrcSel`/`WinSel` booleans carry the same tag plus
  `tagtype="reversed"`, which binds them to the Reversed state of the button
  holding that tag.
- **Button text.** `InName`/`OutName`/`OutSrc` are *string* variables carrying a
  `buttontag` and no `tagtype` — `tagtype` is documented as boolean-only, so on a
  string variable the variable attaches to the tagged button itself and supplies
  its text. `InName`/`OutName` are published once at startup from the config
  slots (`PublishSlotNames`); every other text tag is live feedback the driver
  already maintained — `OutputSource` from the route query, `MVIDWinSource` from
  `mvid layout get`, and the three `Selected*` singletons from the arm-then-route
  and live-list selections.

Tag counts follow the config-slot ceilings (64 inputs, 64 outputs, 16 windows),
and the per-choice tags inherit each choice's `condition`, so tags for slots
beyond the configured counts are not offered. `test/metadata.py` pins the whole
scheme.

## Matrix routing (select source, then destinations)

The primary matrix workflow mirrors the multiview arm-then-route pattern:

1. **Select Source (Arm)** on each source button — arms it, sends nothing.
2. **Route to Display** on each destination button — routes the armed source
   immediately.

So one source tap followed by TV 1, TV 3, TV 4 issues three
`matrix aset :av` commands, one per destination. The source stays armed across
the run until another is armed or **Clear Source Selection** runs; a
destination tap with nothing armed is a no-op rather than a stray route.

`SelectedSourceID` holds the armed input slot number for highlighting, with
`SrcSel1`..`SrcSel64` as per-source booleans to bind a button's Reversed state
to — each named after its input definition slot.

The armed source is the same value the live Source List sets, so the two
workflows interoperate: arm from a config slot and route by tapping the live
Display List (**Select Display and Route**), or arm from the list and route to
slot destination buttons. Arming from the list sets `SelectedSourceID` to 0,
since no config slot owns that source.

The original `RouteSourceToDisplay` / `RouteSourceMulti` functions are
unchanged, so pages already built around them keep working.

## Matrix route feedback

`OutSrc1`..`OutSrc64` report the source currently feeding the display in each
`O1`..`O64` config slot; `LiveDisplaySource` does the same for the display
selected in the live Display List.

In Integration Designer each of these is **named after its config slot** using
dynamic naming (`name="%%O1%% Source"`), so an output defined as `RX-Bar` shows
as *RX-Bar Source* rather than *Output 1 Source*, and each carries
`condition="$OutputCount >= N"` so only outputs the installer actually defined
appear. The same applies to the `SrcSel` booleans, which are named from the
`I1`..`I64` input slots. This is the treatment `SystemFunctions.xml` already
gave its dropdowns; it needs `minimumSoftwareVersion` 9.0 or higher in the
manifest (this driver is at 10.0).

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

## Building the driver package

Double-click **`Build.bat`** (Windows). It changes to its own directory and runs:

```bat
PackageDriver.exe -o USPDRIVER.RTIDRIVER
```

producing `USPDRIVER.RTIDRIVER` for Integration Designer. `PackageDriver.exe`
is committed alongside it, so a ZIP export of this repo carries everything
needed to build. `-m` is omitted because PackageDriver defaults to
`DriverManifest.xml`.

The script reports the exit code and pauses, because PackageDriver
schema-validates every XML file and refuses to build if any fails — you need to
read those messages before the window closes. Note this is stricter than the
well-formedness check in `test/run.sh`.

`PackageDriver.exe`, `Build.bat` and `test/` are not part of the built package;
PackageDriver bundles only the streams named in `DriverManifest.xml`.

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

`test/metadata.py` covers what neither the harness nor PackageDriver checks:
that every `export` in `SystemFunctions.xml` resolves to a function in the
script (PackageDriver validates XML but never reads the script, so a typo here
would only surface on hardware), that hidden parameters come last, that the
per-output and per-source variables stay slot-named and conditioned, that the
config slots the script reads are declared, and that the autoprogramming tag
scheme above is complete, uniquely assigned, and backed by
`minimumApexVersion`.
