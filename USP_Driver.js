var tcpClient = null;
var hostIP = Config.Get("IPAddress");
var hostPort = Config.Get("USPPort");

function Initialize() {
    System.Print("--- IPCBox Driver V3.5 Initialized ---\r\n");
    Connect();
}

function Connect() {
    tcpClient = new TCP(OnData, hostIP, hostPort);
    tcpClient.OnConnectFunc = function() {
        SystemVars.Write("ConnStatus", true, "BOOLEAN");
        System.Print("[System] Connected to IPCBox at " + hostIP + "\r\n");
        // Pull the device list now (it carries the MAC/id map the route
        // feedback needs) and the routes once that reply has landed.
        RefreshDevices();
        ScheduleRouteRefresh();
    };
    tcpClient.OnDisconnectFunc = function() {
        SystemVars.Write("ConnStatus", false, "BOOLEAN");
        System.Print("[System] Connection Lost. Retrying in 10s...\r\n");
        new Timer().Start(Connect, 10000);
    };
}

function SendCommand(cmd) {
    if (tcpClient && tcpClient.ConnectState == 1) {
        System.Print("[RTI -> IPCBox] " + cmd + "\r\n");
        SystemVars.Write("LastCommandSent", cmd);
        // Sending command + Newline. Semicolon removed from variable ends.
        tcpClient.Write(cmd + "\r\n");
    } else {
        System.Print("[ERROR] TCP Not Connected. Command Failed: " + cmd + "\r\n");
    }
}

// Resolve a ConfigSettings slot (e.g. "I1", "O3", "VW1") to its stored value.
function ResolveSlot(key) {
    var v = Config.Get(key);
    if (!v) {
        System.Print("[Error] Config slot '" + key + "' is empty.\r\n");
    }
    return v;
}

// =====================================================================
// FEEDBACK PARSING
// The CBOX replies with JSON-style strings: {"cmd":"...","info":...,"code":0}
// Some commands instead reply with a bare "OK". The RTI script engine does
// not document a native JSON object, so we parse defensively with string ops
// only (no JSON.parse, no RegExp dependency).
// =====================================================================

function OnData(data) {
    System.Print("[IPCBox -> RTI] " + data + "\r\n");
    if (!data) {
        return;
    }
    // A single callback may carry several newline-separated replies.
    var lines = ("" + data).split("\n");
    for (var i = 0; i < lines.length; i++) {
        var line = TrimStr(lines[i]);
        if (line.length === 0) {
            continue;
        }
        HandleResponseLine(line);
    }
}

function HandleResponseLine(line) {
    SystemVars.Write("LastResponseRaw", line);

    var code = ExtractInt(line, "code");
    var cmd = ExtractStr(line, "cmd");
    var info = ExtractStr(line, "info");

    // Bare "OK"/"ok" replies have no code field.
    if (code === null && line.toLowerCase() === "ok") {
        code = 0;
        info = "OK";
    }

    if (code !== null) {
        SystemVars.Write("LastResponseCode", code);
        SystemVars.Write("LastCommandSuccess", (code === 0), "BOOLEAN");
        if (code !== 0) {
            System.Print("[Warning] CBOX returned code " + code + ": " + info + "\r\n");
        }
    }
    if (cmd !== "") {
        SystemVars.Write("LastResponseCmd", cmd);
    }
    if (info !== "") {
        SystemVars.Write("LastResponseInfo", info);
    }

    // Derive active-state from the echoed command on the reply.
    if (cmd.length > 0) {
        DeriveActiveState(cmd);
    }
    if (line.indexOf("device status") >= 0 || line.indexOf("devicelist") >= 0) {
        SystemVars.Write("DeviceStatusRaw", line);
    }
    // Reply to "mvid layout get <name>" carries each window's current source.
    if (StartsWith(cmd, "mvid layout get ")) {
        ParseLayoutWindows(line);
    }
    // "config get device routes" answers with a Lua table rather than the
    // JSON-ish shape every other reply uses, and the API doc shows it without
    // the {"cmd":...,"code":0} envelope, so accept it by echo or by shape.
    if (StartsWith(cmd, "config get device routes") || LooksLikeRoutes(line)) {
        ParseRoutes(line);
    }
    // Live name lists pulled from the CBOX.
    if (StartsWith(cmd, "config get devicelist")) {
        ParseDeviceList(line);
    } else if (StartsWith(cmd, "mvid get")) {
        ParseLayouts(line);
    } else if (StartsWith(cmd, "play pl get")) {
        ParsePlaylists(line);
    }
}

// Parse the "windows":[{"host":..,"index":..},...] array from an
// "mvid layout get" reply and publish each window's source as WinSrc<index>.
function ParseLayoutWindows(line) {
    var wp = line.indexOf("\"windows\"");
    if (wp < 0) {
        return;
    }
    var arrStart = line.indexOf("[", wp);
    var arrEnd = (arrStart >= 0) ? line.indexOf("]", arrStart) : -1;
    if (arrStart < 0 || arrEnd < 0) {
        return;
    }
    var sub = line.substring(arrStart + 1, arrEnd);
    // Clear all window-source labels first, then fill from the reply.
    var i;
    for (i = 1; i <= WIN_COUNT; i++) {
        SystemVars.Write("WinSrc" + i, "");
    }
    var pos = 0;
    while (true) {
        var ob = sub.indexOf("{", pos);
        if (ob < 0) {
            break;
        }
        var cb = sub.indexOf("}", ob);
        if (cb < 0) {
            break;
        }
        var obj = sub.substring(ob, cb + 1);
        var host = ExtractStr(obj, "host");
        var idx = ExtractInt(obj, "index");
        if (idx !== null && idx >= 1 && idx <= WIN_COUNT && host !== "") {
            SystemVars.Write("WinSrc" + idx, host);
        }
        pos = cb + 1;
    }
}

function DeriveActiveState(cmd) {
    if (StartsWith(cmd, "matrix active ")) {
        SystemVars.Write("ActiveMatrix", TrimStr(cmd.substring("matrix active ".length)));
    } else if (StartsWith(cmd, "mvid layout active ")) {
        SystemVars.Write("ActiveLayout", TrimStr(cmd.substring("mvid layout active ".length)));
    } else if (StartsWith(cmd, "vwid layout active ")) {
        var rest = TrimStr(cmd.substring("vwid layout active ".length));
        var sp = rest.indexOf(" ");
        if (sp > 0) {
            SystemVars.Write("ActiveWall", rest.substring(0, sp));
            SystemVars.Write("ActiveWallLayout", TrimStr(rest.substring(sp + 1)));
        }
    }
}

// --- String helpers (ES3-safe, no RegExp) ---

function StartsWith(s, prefix) {
    return s.substring(0, prefix.length) === prefix;
}

// Trailing numeric index of a config slot key, e.g. "L1" -> 1, "L10" -> 10.
// Returns 0 if no digits are found.
function SlotIndex(key) {
    key = "" + key;
    var i = 0;
    while (i < key.length && !(key.charAt(i) >= "0" && key.charAt(i) <= "9")) {
        i++;
    }
    var n = parseInt(key.substring(i), 10);
    return (n >= 1) ? n : 0;
}

function TrimStr(s) {
    if (s == null) {
        return "";
    }
    s = "" + s;
    var start = 0;
    var end = s.length;
    while (start < end && IsTrimChar(s.charAt(start))) {
        start++;
    }
    while (end > start && IsTrimChar(s.charAt(end - 1))) {
        end--;
    }
    return s.substring(start, end);
}

function IsTrimChar(ch) {
    return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\"";
}

// Position just after the colon following "key" in a JSON-ish string.
function FindValueStart(str, key) {
    var marker = "\"" + key + "\"";
    var k = str.indexOf(marker);
    if (k < 0) {
        return -1;
    }
    var c = k + marker.length;
    while (c < str.length) {
        var ch = str.charAt(c);
        if (ch === " " || ch === ":" || ch === "\t") {
            c++;
        } else {
            break;
        }
    }
    return c;
}

function ExtractStr(str, key) {
    var c = FindValueStart(str, key);
    if (c < 0 || str.charAt(c) !== "\"") {
        return "";
    }
    var end = str.indexOf("\"", c + 1);
    if (end < 0) {
        return "";
    }
    return str.substring(c + 1, end);
}

function ExtractInt(str, key) {
    var c = FindValueStart(str, key);
    if (c < 0) {
        return null;
    }
    var neg = false;
    if (str.charAt(c) === "-") {
        neg = true;
        c++;
    }
    var num = "";
    while (c < str.length) {
        var ch = str.charAt(c);
        if (ch >= "0" && ch <= "9") {
            num += ch;
            c++;
        } else {
            break;
        }
    }
    if (num === "") {
        return null;
    }
    var v = parseInt(num, 10);
    return neg ? -v : v;
}

// =====================================================================
// EXPORTED MACRO FUNCTIONS
// =====================================================================

// --- Multiview (original v1.4 functions, unchanged behavior) ---

/**
 * Assign Layout to Display and Activate.
 * 1. mvid layout rx [Layout] [Output]
 * 2. mvid layout active [Layout]
 */
function ShowLayoutOnDisplay(layoutKey, outputKey) {
    var layoutVal = Config.Get(layoutKey);
    var outputVal = Config.Get(outputKey);

    if (layoutVal && outputVal) {
        SendCommand("mvid layout rx " + layoutVal + " " + outputVal);
        SendCommand("mvid layout active " + layoutVal);
    } else {
        System.Print("[Error] ShowLayoutOnDisplay failed: Slot L or O is empty in Config.\r\n");
    }
}

/**
 * Update Window Source and Activate.
 * 1. mvid layout tx [Layout] [WinID] [Input]
 * 2. mvid layout active [Layout]
 */
function UpdateWindowSource(layoutKey, winID, inputKey) {
    var layoutVal = Config.Get(layoutKey);
    var inputVal = Config.Get(inputKey);

    if (layoutVal && inputVal) {
        SendCommand("mvid layout tx " + layoutVal + " " + winID + " " + inputVal);
        // We activate as well to ensure the change is seen live on screen
        SendCommand("mvid layout active " + layoutVal);
        SystemVars.Write("WinSrc" + winID, inputVal);
    } else {
        System.Print("[Error] UpdateWindowSource failed: Slot L or I is empty in Config.\r\n");
    }
}

// --- Multiview Window Routing (arm-then-route workflow) ---
// Workflow: SelectLayout (armed by the page's layout button) -> SelectWindow
// (tap a window to arm it) -> RouteSelectedInput (tap an input to route it
// into the armed layout+window). Selection state lives in script globals and
// is mirrored to System Variables for touchpanel feedback.

var g_selWindow = 0;     // armed window ID (0 = none)
var g_selLayoutVal = ""; // armed layout name (resolved from a config slot)
var WIN_COUNT = 16;      // number of Select Window buttons / WinSelN booleans (Pro = 16-window MV)

/** Arm the multiview layout to route within (call from the page's layout button). */
function SelectLayout(layoutKey) {
    var v = Config.Get(layoutKey);
    if (!v) {
        System.Print("[Error] SelectLayout: config slot '" + layoutKey + "' is empty.\r\n");
        return;
    }
    g_selLayoutVal = v;
    SystemVars.Write("SelectedLayout", v);
    SystemVars.Write("SelectedLayoutID", SlotIndex(layoutKey));
    System.Print("[Select] Layout armed: " + v + " (slot " + layoutKey + ")\r\n");
    // Refresh per-window source feedback (WinSrcN) from the box for this layout.
    SendCommand("mvid layout get " + v);
}

/** Arm the window that the next input tap will be routed into. winID is 1..N. */
function SelectWindow(winID) {
    var w = parseInt("" + winID, 10);
    if (!(w >= 1)) {
        System.Print("[Error] SelectWindow: invalid window '" + winID + "'.\r\n");
        return;
    }
    g_selWindow = w;
    SystemVars.Write("SelectedWindowID", w);
    // Per-window booleans for direct "Reversed" button binding: true only for w.
    for (var i = 1; i <= WIN_COUNT; i++) {
        SystemVars.Write("WinSel" + i, (i === w), "BOOLEAN");
    }
    System.Print("[Select] Window armed: " + w + "\r\n");
}

/** Route the tapped input into the armed layout+window, then activate it live. */
function RouteSelectedInput(inputKey) {
    var input = Config.Get(inputKey);
    if (!input) {
        System.Print("[Error] RouteSelectedInput: config slot '" + inputKey + "' is empty.\r\n");
        return;
    }
    if (!g_selLayoutVal) {
        System.Print("[Error] RouteSelectedInput: no layout armed. Tap a layout first.\r\n");
        return;
    }
    if (!g_selWindow) {
        System.Print("[Error] RouteSelectedInput: no window armed. Tap a window first.\r\n");
        return;
    }
    SendCommand("mvid layout tx " + g_selLayoutVal + " " + g_selWindow + " " + input);
    SendCommand("mvid layout active " + g_selLayoutVal);
    SystemVars.Write("WinSrc" + g_selWindow, input);
}

// --- Matrix ---

/** Route one source (TX) video+audio to one display (RX). Effective immediately. */
function RouteSourceToDisplay(inputKey, outputKey) {
    var tx = ResolveSlot(inputKey);
    var rx = ResolveSlot(outputKey);
    if (tx && rx) {
        SendCommand("matrix aset :av " + tx + " " + rx);
        ScheduleRouteRefresh();
    }
}

/** Route one source to up to three displays in one shot (blank slots skipped). */
function RouteSourceMulti(inputKey, out1, out2, out3) {
    var tx = ResolveSlot(inputKey);
    if (!tx) {
        return;
    }
    var keys = [out1, out2, out3];
    var rxList = "";
    for (var i = 0; i < keys.length; i++) {
        if (keys[i]) {
            var r = Config.Get(keys[i]);
            if (r) {
                rxList += " " + r;
            }
        }
    }
    if (rxList === "") {
        System.Print("[Error] RouteSourceMulti: no output displays selected.\r\n");
        return;
    }
    SendCommand("matrix aset :av " + tx + rxList);
    ScheduleRouteRefresh();
}

/** Recall a previously-built named matrix preset. */
function RecallMatrix(matrixKey) {
    var name = ResolveSlot(matrixKey);
    if (name) {
        SendCommand("matrix active " + name);
        SystemVars.Write("ActiveMatrix", name);
        ScheduleRouteRefresh();
    }
}

// --- Matrix arm-then-route (select a source, then tap each destination) ---
// Tap a source once to arm it, then tap TV 1, TV 3, TV 4 and each routes the
// armed source immediately. The armed source stays armed until it is changed
// or cleared, so a run of destinations needs one source tap, not one each.
//
// The armed source is the same g_liveSrc the live Source List sets, so a
// source armed from a config slot also works with the live-list actions
// (and vice versa) rather than the two workflows each keeping their own.

var IN_COUNT = 64;   // SrcSel1..N booleans, matching the I1..I64 config slots

// Arm a source. slotIndex drives the per-source highlight booleans; pass 0
// when the source came from the live list and no config slot owns it.
function ArmSource(value, slotIndex) {
    g_liveSrc = value;
    SystemVars.Write("LiveSource", value);
    SystemVars.Write("SelectedSourceID", slotIndex);
    for (var i = 1; i <= IN_COUNT; i++) {
        SystemVars.Write("SrcSel" + i, (i === slotIndex), "BOOLEAN");
    }
}

/** Arm the source a following destination tap will route. */
function SelectMatrixSource(inputKey) {
    var tx = Config.Get(inputKey);
    if (!tx) {
        System.Print("[Error] SelectMatrixSource: config slot '" + inputKey + "' is empty.\r\n");
        return;
    }
    ArmSource(tx, SlotIndex(inputKey));
    System.Print("[Select] Source armed: " + tx + " (slot " + inputKey + ")\r\n");
}

/** Route the armed source to this display. Tap a run of these to fan out. */
function RouteSelectedToDisplay(outputKey) {
    var rx = ResolveSlot(outputKey);
    if (!rx) {
        return;
    }
    if (!g_liveSrc) {
        System.Print("[Error] RouteSelectedToDisplay: no source armed. Tap a source first.\r\n");
        return;
    }
    SendCommand("matrix aset :av " + g_liveSrc + " " + rx);
    ScheduleRouteRefresh();
}

/** Drop the armed source, so a stray destination tap cannot route. */
function ClearMatrixSelection() {
    ArmSource("", 0);
}

// --- Video Wall ---

/** Recall (activate) a layout on a video wall. */
function RecallWallLayout(wallKey, layoutKey) {
    var wall = ResolveSlot(wallKey);
    var lay = ResolveSlot(layoutKey);
    if (wall && lay) {
        SendCommand("vwid layout active " + wall + " " + lay);
        SystemVars.Write("ActiveWall", wall);
        SystemVars.Write("ActiveWallLayout", lay);
    }
}

/** Swap a source within a wall layout. target = "ALL" or "row:col" or an old TX id. */
function SwapWallSource(wallKey, layoutKey, target, inputKey) {
    var wall = ResolveSlot(wallKey);
    var lay = ResolveSlot(layoutKey);
    var tx = ResolveSlot(inputKey);
    if (wall && lay && tx && target) {
        SendCommand("vwid layout tx " + wall + " " + lay + " " + target + " " + tx);
    }
}

/** Swap the live-selected source (SourceList) into a wall cell. target = "ALL" or "row:col". */
function SwapWallSourceLive(wallKey, layoutKey, target) {
    var wall = ResolveSlot(wallKey);
    var lay = ResolveSlot(layoutKey);
    if (!wall || !lay || !target) {
        return;
    }
    if (!g_liveSrc) {
        System.Print("[Error] SwapWallSourceLive: no source selected (tap a source first).\r\n");
        return;
    }
    SendCommand("vwid layout tx " + wall + " " + lay + " " + target + " " + g_liveSrc);
}

// --- Media Player ---

/** Play a playlist on a single RX (output) display now. ("Play Now" in the web GUI.) */
function PlayPlaylist(playlistKey, outputKey) {
    var pl = ResolveSlot(playlistKey);
    var rx = ResolveSlot(outputKey);
    if (pl && rx) {
        SendCommand("play pl start " + pl + " " + rx);
    }
}
// NOTE: The CBOX has no playlist "stop" command. To stop playback on a display,
// route a different source to it (Matrix "Route Source to Display").

/** Upload a playlist's media to up to three RX displays (comma-separated list). */
function UploadPlaylist(playlistKey, out1, out2, out3) {
    var pl = ResolveSlot(playlistKey);
    if (!pl) {
        return;
    }
    var keys = [out1, out2, out3];
    var ids = "";
    for (var i = 0; i < keys.length; i++) {
        if (keys[i]) {
            var r = Config.Get(keys[i]);
            if (r) {
                ids += (ids === "" ? "" : ",") + r;
            }
        }
    }
    if (ids === "") {
        System.Print("[Error] UploadPlaylist: no target displays selected.\r\n");
        return;
    }
    SendCommand("play pl upload " + pl + " " + ids);
}

// --- Device Control ---

/**
 * Generic per-device control. The 'action' fragment is supplied by a hidden
 * parameter in SystemFunctions.xml (e.g. "reboot", "light on", "osd off",
 * "stream on"). Builds: config set device {action} {deviceID}.
 */
function DeviceControl(deviceKey, action) {
    var id = ResolveSlot(deviceKey);
    if (id && action) {
        SendCommand("config set device " + action + " " + id);
    }
}

// --- System ---

/**
 * Generic system control / query. The 'action' fragment is supplied by a
 * hidden parameter (e.g. "set reboot", "get devicelist",
 * "get device status ALL"). Builds: config {action}.
 */
function SystemControl(action) {
    if (action) {
        SendCommand("config " + action);
    }
}

/** Escape hatch: send any raw API command string verbatim. */
function SendRawCommand(cmd) {
    if (cmd) {
        SendCommand(cmd);
    }
}

// =====================================================================
// CEC
// API: config set device cec {hexData}[,{hexData}...] {device_id/device_mac}
//   - {hexData} is a single space-free block, e.g. "0036".
//   - The literals "poweron" / "poweroff" ask the CBOX to emit its own set
//     of common CEC power frames at the sink device from that endpoint.
//     Display power buttons should use these rather than a hand-built frame.
//   - Several frames ship in one command, separated by ",".
//   - Several endpoints ship in one command, separated by ":", or use the
//     ALL / ALLRX / ALLTX keywords. The API caps one command at fewer than
//     50 endpoints.
// The API exposes no CEC query, so there is no true display power state to
// read back. The driver publishes what it last sent, not what the sink did.
// =====================================================================

// Strip whitespace so a typed "0036, 0037" becomes the documented block form
// "0036,0037", and fold the power keywords to the lower case the CBOX expects.
function NormalizeCEC(data) {
    if (data == null) {
        return "";
    }
    var s = "" + data;
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") {
            out += ch;
        }
    }
    var lower = out.toLowerCase();
    if (lower === "poweron" || lower === "poweroff") {
        return lower;
    }
    return out;
}

// Resolve config slots to endpoint ids and join them with the API's ":".
function JoinCECTargets(keys) {
    var ids = "";
    for (var i = 0; i < keys.length; i++) {
        if (!keys[i]) {
            continue;
        }
        var id = Config.Get(keys[i]);
        if (id) {
            ids += (ids === "" ? "" : ":") + id;
        }
    }
    return ids;
}

/** Build and send one CEC command. payload is raw/keyword data, target an endpoint spec. */
function SendCEC(payload, target) {
    var data = NormalizeCEC(payload);
    if (!data) {
        System.Print("[Error] CEC: no command data.\r\n");
        return;
    }
    if (!target) {
        System.Print("[Error] CEC: no target endpoint.\r\n");
        return;
    }
    SendCommand("config set device cec " + data + " " + target);
    SystemVars.Write("LastCECData", data);
    SystemVars.Write("LastCECTarget", target);
}

/** Power a sink on/off through one endpoint. action = "poweron" / "poweroff". */
function CECPower(deviceKey, action) {
    var id = ResolveSlot(deviceKey);
    if (id) {
        SendCEC(action, id);
    }
}

/** Power every sink on/off. scope = "ALLRX" / "ALLTX" / "ALL". */
function CECPowerScope(scope, action) {
    SendCEC(action, scope);
}

/** Power sinks on/off through up to three endpoints in one command. */
function CECPowerMulti(out1, out2, out3, action) {
    var ids = JoinCECTargets([out1, out2, out3]);
    if (!ids) {
        System.Print("[Error] CECPowerMulti: no target displays selected.\r\n");
        return;
    }
    SendCEC(action, ids);
}

/** Send a stored CEC command (config slot C1..C16) to one endpoint. */
function CECSendSlot(cecKey, deviceKey) {
    var data = ResolveSlot(cecKey);
    var id = ResolveSlot(deviceKey);
    if (data && id) {
        SendCEC(data, id);
    }
}

/** Send a stored CEC command to up to three endpoints in one command. */
function CECSendSlotMulti(cecKey, out1, out2, out3) {
    var data = ResolveSlot(cecKey);
    if (!data) {
        return;
    }
    var ids = JoinCECTargets([out1, out2, out3]);
    if (!ids) {
        System.Print("[Error] CECSendSlotMulti: no target displays selected.\r\n");
        return;
    }
    SendCEC(data, ids);
}

/** Send a stored CEC command to every endpoint. scope = "ALLRX" / "ALLTX" / "ALL". */
function CECSendSlotScope(cecKey, scope) {
    var data = ResolveSlot(cecKey);
    if (data) {
        SendCEC(data, scope);
    }
}

/** Escape hatch: type CEC data (hex block, comma list, or a power keyword). */
function CECSendRaw(hexData, deviceKey) {
    var id = ResolveSlot(deviceKey);
    if (id) {
        SendCEC(hexData, id);
    }
}

// =====================================================================
// MATRIX ROUTE FEEDBACK (which source each display is tuned to)
// "config get device routes vaurs ALLRX" answers with a Lua table keyed by
// decoder MAC, not JSON:
//   { ["188a6a02c0b6"] = {audio = "188a11223368", ir = "none", rs232 =
//     "none", usb = "none", video = "188a11223368"}, ... }
// The doc only demonstrates the full "vaurs" selector, so the driver asks for
// that rather than "v" alone and reads the video field.
// Routes name devices by MAC; the panel wants names, so they are mapped back
// through the id/MAC pairs captured from "config get devicelist".
// =====================================================================

var OUT_COUNT = 64;          // OutSrc1..N, matching the O1..O64 config slots
var ROUTE_SETTLE_MS = 1500;  // let a route change land before re-reading it

var g_routes = {};    // decoder MAC (upper) -> MAC of the source feeding video
var g_macToId = {};   // device MAC (upper) -> friendly id
var g_idToMac = {};   // friendly id (upper) -> device MAC (upper)

// One timer instance, per the guide's one-per-usage rule. Start() requires an
// idle timer, and stopping an idle timer is allowed, so always stop first.
var g_routeTimer = new Timer();

function RefreshRoutes() {
    SendCommand("config get device routes vaurs ALLRX");
}

/** Re-read the routes shortly after something changes them. */
function ScheduleRouteRefresh() {
    g_routeTimer.Stop();
    g_routeTimer.Start(RefreshRoutes, ROUTE_SETTLE_MS);
}

// Only a Lua table writes ["key"] = { ... }; a JSON reply that happens to hold
// a string array gets as far as ["key"] but never the '= {' that follows, so
// recognising a bare routes reply means finding one complete entry.
function LooksLikeRoutes(line) {
    var found = false;
    ForEachLuaEntry(line, function () {
        found = true;
    });
    return found;
}

function IsIdentChar(ch) {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") ||
           (ch >= "0" && ch <= "9") || ch === "_";
}

// Iterate top-level ["key"] = { body } pairs of a Lua table; cb(key, body).
function ForEachLuaEntry(str, cb) {
    var i = 0;
    while (i < str.length) {
        var ks = str.indexOf("[\"", i);
        if (ks < 0) {
            break;
        }
        var ke = str.indexOf("\"]", ks + 2);
        if (ke < 0) {
            break;
        }
        var c = ke + 2;
        while (c < str.length && (str.charAt(c) === " " || str.charAt(c) === "\t")) {
            c++;
        }
        if (str.charAt(c) !== "=") {
            i = ke + 2;
            continue;
        }
        c++;
        while (c < str.length && (str.charAt(c) === " " || str.charAt(c) === "\t")) {
            c++;
        }
        if (str.charAt(c) !== "{") {
            i = ke + 2;
            continue;
        }
        var close = MatchBrace(str, c);
        if (close < 0) {
            break;
        }
        cb(str.substring(ks + 2, ke), str.substring(c + 1, close));
        i = close + 1;
    }
}

// Value of a  name = "value"  field inside a Lua table body ("" if absent).
function LuaField(body, name) {
    var i = 0;
    while (i < body.length) {
        if (!IsIdentChar(body.charAt(i))) {
            i++;
            continue;
        }
        var start = i;
        while (i < body.length && IsIdentChar(body.charAt(i))) {
            i++;
        }
        var key = body.substring(start, i);
        while (i < body.length && (body.charAt(i) === " " || body.charAt(i) === "\t")) {
            i++;
        }
        if (body.charAt(i) !== "=") {
            continue;
        }
        i++;
        while (i < body.length && (body.charAt(i) === " " || body.charAt(i) === "\t")) {
            i++;
        }
        if (body.charAt(i) !== "\"") {
            continue;
        }
        var vs = i + 1;
        var ve = body.indexOf("\"", vs);
        if (ve < 0) {
            return "";
        }
        if (key === name) {
            return body.substring(vs, ve);
        }
        i = ve + 1;
    }
    return "";
}

function ParseRoutes(line) {
    var routes = {};
    var seen = 0;
    ForEachLuaEntry(line, function (mac, body) {
        seen++;
        var video = LuaField(body, "video");
        if (video && video.toLowerCase() !== "none") {
            routes[mac.toUpperCase()] = video.toUpperCase();
        }
    });
    if (seen === 0) {
        System.Print("[Routes] No decoders in reply; keeping previous state.\r\n");
        return;
    }
    g_routes = routes;
    PublishOutputSources();
    System.Print("[Routes] " + seen + " decoder(s) reported.\r\n");
}

// Map lookups go through typeof so an odd device name can never pick up an
// inherited Object property instead of a real entry.
function MapGet(map, key) {
    var v = map[("" + key).toUpperCase()];
    return (typeof v === "string") ? v : "";
}

/** MAC of a device named by friendly id or MAC (falls back to what was given). */
function DeviceMac(idOrMac) {
    var mac = MapGet(g_idToMac, idOrMac);
    return mac ? mac : ("" + idOrMac).toUpperCase();
}

/** Friendly id for a MAC (falls back to the MAC when the list has not loaded). */
function DeviceId(mac) {
    var id = MapGet(g_macToId, mac);
    return id ? id : ("" + mac);
}

/** Source currently feeding a display, by friendly id or MAC. "" if none. */
function SourceForDevice(idOrMac) {
    if (!idOrMac) {
        return "";
    }
    var src = MapGet(g_routes, DeviceMac(idOrMac));
    return src ? DeviceId(src) : "";
}

// Publish the source feeding each configured output slot, plus the one
// feeding the display selected in the live list.
function PublishOutputSources() {
    for (var i = 1; i <= OUT_COUNT; i++) {
        SystemVars.Write("OutSrc" + i, SourceForDevice(Config.Get("O" + i)));
    }
    SystemVars.Write("LiveDisplaySource", SourceForDevice(g_liveDisp));
}

// =====================================================================
// LIVE NAME LISTS (pulled from the CBOX)
// Query the box and publish its real device / layout / playlist names as
// RTI Item Lists (type "list" system variables). The operator picks from a
// live list; the driver maps the tapped row index back to the device id and
// acts on it. No manual slot entry required; refresh on demand.
// =====================================================================

var g_sources = [];     // TX ids, parallel to SourceList rows
var g_displays = [];    // RX ids, parallel to DisplayList rows
var g_layouts = [];     // layout names, parallel to LayoutList rows
var g_playlists = [];   // playlist names, parallel to PlaylistList rows

var g_liveSrc = "";       // selected source id
var g_liveDisp = "";      // selected display id
var g_livePlaylist = "";  // selected playlist name

// ---- Exported: refresh the lists from the box ----
function RefreshDevices()   { SendCommand("config get devicelist"); }
function RefreshLayouts()   { SendCommand("mvid get layouts"); }
function RefreshPlaylists()  { SendCommand("play pl get"); }
function RefreshAll() {
    RefreshDevices();
    RefreshLayouts();
    RefreshPlaylists();
    RefreshRoutes();
}

// ---- Exported: selection handlers (wired to the panel Item List objects) ----
// The runtime appends the scroll-window-top index as a trailing arg (ignored).
function SelectSource(index, top) {
    if (index >= 0 && index < g_sources.length) {
        // Slot 0: armed from the list, so no config slot is highlighted.
        ArmSource(g_sources[index], 0);
    }
}
function SelectDisplay(index, top) {
    if (index >= 0 && index < g_displays.length) {
        g_liveDisp = g_displays[index];
        SystemVars.Write("LiveDisplay", g_liveDisp);
        SystemVars.Write("LiveDisplaySource", SourceForDevice(g_liveDisp));
    }
}
// Tap a display in the live list to route the armed source straight to it.
function SelectDisplayAndRoute(index, top) {
    if (index < 0 || index >= g_displays.length) {
        return;
    }
    SelectDisplay(index, top);
    if (!g_liveSrc) {
        System.Print("[Error] SelectDisplayAndRoute: no source armed. Tap a source first.\r\n");
        return;
    }
    SendCommand("matrix aset :av " + g_liveSrc + " " + g_liveDisp);
    ScheduleRouteRefresh();
}
function SelectLayoutItem(index, top) {
    if (index >= 0 && index < g_layouts.length) {
        var name = g_layouts[index];
        SystemVars.Write("LiveLayout", name);
        // Also arm this layout for the window-routing workflow + refresh feedback.
        g_selLayoutVal = name;
        SystemVars.Write("SelectedLayout", name);
        SendCommand("mvid layout active " + name);   // recall on tap
        SendCommand("mvid layout get " + name);      // refresh WinSrc feedback
    }
}
function SelectPlaylist(index, top) {
    if (index >= 0 && index < g_playlists.length) {
        g_livePlaylist = g_playlists[index];
        SystemVars.Write("LivePlaylist", g_livePlaylist);
    }
}

// ---- Exported: actions that use the live selections ----
function RouteLive() {
    if (g_liveSrc && g_liveDisp) {
        SendCommand("matrix aset :av " + g_liveSrc + " " + g_liveDisp);
        ScheduleRouteRefresh();
    } else {
        System.Print("[Error] RouteLive: select a source and a display first.\r\n");
    }
}
// Route the live-selected source into the armed multiview layout+window.
// Combines the live Source list with the arm-then-route window/layout arming.
function RouteLiveSourceToWindow() {
    if (!g_selLayoutVal) {
        System.Print("[Error] RouteLiveSourceToWindow: no layout armed (tap a layout first).\r\n");
        return;
    }
    if (!g_selWindow) {
        System.Print("[Error] RouteLiveSourceToWindow: no window armed (tap a window first).\r\n");
        return;
    }
    if (!g_liveSrc) {
        System.Print("[Error] RouteLiveSourceToWindow: no source selected (tap a source first).\r\n");
        return;
    }
    SendCommand("mvid layout tx " + g_selLayoutVal + " " + g_selWindow + " " + g_liveSrc);
    SendCommand("mvid layout active " + g_selLayoutVal);
    SystemVars.Write("WinSrc" + g_selWindow, g_liveSrc);
}

// Power the live-selected display on/off. action = "poweron" / "poweroff".
function CECPowerLive(action) {
    if (!g_liveDisp) {
        System.Print("[Error] CECPowerLive: no display selected (tap a display first).\r\n");
        return;
    }
    SendCEC(action, g_liveDisp);
}

// Send a stored CEC command (config slot) to the live-selected display.
function CECSendSlotLive(cecKey) {
    var data = ResolveSlot(cecKey);
    if (!data) {
        return;
    }
    if (!g_liveDisp) {
        System.Print("[Error] CECSendSlotLive: no display selected (tap a display first).\r\n");
        return;
    }
    SendCEC(data, g_liveDisp);
}

function PlayLivePlaylist() {
    if (g_livePlaylist && g_liveDisp) {
        SendCommand("play pl start " + g_livePlaylist + " " + g_liveDisp);
    } else {
        System.Print("[Error] PlayLivePlaylist: select a playlist and a display first.\r\n");
    }
}
function SendLivePlaylist() {
    if (g_livePlaylist && g_liveDisp) {
        SendCommand("play pl upload " + g_livePlaylist + " " + g_liveDisp);
    } else {
        System.Print("[Error] SendLivePlaylist: select a playlist and a display first.\r\n");
    }
}

// ---- List population + JSON-ish parsing (no native JSON / RegExp) ----
function FillList(varname, arr) {
    var lst = new SystemVarsList(varname);
    if (!lst) {
        return;
    }
    lst.Open();
    lst.RemoveAll();
    var i;
    for (i = 0; i < arr.length; i++) {
        lst.Insert(arr[i]);
    }
    lst.Close();   // propagate to panels
}

// Index of the matching close for the brace/bracket at position 'open'.
function MatchBrace(str, open) {
    var depth = 0, inStr = false, i, ch;
    for (i = open; i < str.length; i++) {
        ch = str.charAt(i);
        if (inStr) {
            if (ch === "\"") { inStr = false; }
        } else if (ch === "\"") {
            inStr = true;
        } else if (ch === "{" || ch === "[") {
            depth++;
        } else if (ch === "}" || ch === "]") {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
}

// Inner text (between braces) of the top-level "info" object, or null.
function InfoInner(line) {
    var k = line.indexOf("\"info\"");
    if (k < 0) { return null; }
    var open = line.indexOf("{", k);
    if (open < 0) { return null; }
    var close = MatchBrace(line, open);
    if (close < 0) { return null; }
    return line.substring(open + 1, close);
}

// Iterate top-level "key":value pairs of an object body; cb(key, valueStr).
function ForEachEntry(inner, cb) {
    var i = 0, n = inner.length;
    while (i < n) {
        if (inner.charAt(i) === "\"") {
            var ke = inner.indexOf("\"", i + 1);
            if (ke < 0) { break; }
            var key = inner.substring(i + 1, ke);
            var c = inner.indexOf(":", ke);
            if (c < 0) { break; }
            c++;
            while (c < n && (inner.charAt(c) === " " || inner.charAt(c) === "\t")) { c++; }
            var vc = inner.charAt(c), val, end;
            if (vc === "{" || vc === "[") {
                end = MatchBrace(inner, c);
                if (end < 0) { break; }
                val = inner.substring(c, end + 1);
                i = end + 1;
            } else if (vc === "\"") {
                end = inner.indexOf("\"", c + 1);
                if (end < 0) { break; }
                val = inner.substring(c + 1, end);
                i = end + 1;
            } else {
                end = c;
                while (end < n && inner.charAt(end) !== ",") { end++; }
                val = inner.substring(c, end);
                i = end;
            }
            cb(key, val);
        } else {
            i++;
        }
    }
}

// devicelist -> Sources (is_host) and Displays (ch_v), by device id/name.
function ParseDeviceList(line) {
    var inner = InfoInner(line);
    if (inner === null) { return; }
    g_sources = [];
    g_displays = [];
    g_macToId = {};
    g_idToMac = {};
    ForEachEntry(inner, function (mac, dev) {
        var id = ExtractStr(dev, "id");
        if (id === "") { id = mac; }
        g_macToId[mac.toUpperCase()] = id;
        g_idToMac[("" + id).toUpperCase()] = mac.toUpperCase();
        if (dev.indexOf("\"is_host\"") >= 0) { g_sources[g_sources.length] = id; }
        if (dev.indexOf("\"ch_v\"") >= 0) { g_displays[g_displays.length] = id; }
    });
    FillList("SourceList", g_sources);
    FillList("DisplayList", g_displays);
    // Names may have arrived after the routes did; restate them with real ids.
    PublishOutputSources();
    System.Print("[Lists] Sources: " + g_sources.length + ", Displays: " + g_displays.length + "\r\n");
}

// mvid get layouts -> layout names (the object keys).
function ParseLayouts(line) {
    var inner = InfoInner(line);
    if (inner === null) { return; }
    g_layouts = [];
    ForEachEntry(inner, function (name, v) { g_layouts[g_layouts.length] = name; });
    FillList("LayoutList", g_layouts);
    System.Print("[Lists] Layouts: " + g_layouts.length + "\r\n");
}

// play pl get -> playlist names (the object keys).
function ParsePlaylists(line) {
    var inner = InfoInner(line);
    if (inner === null) { return; }
    g_playlists = [];
    ForEachEntry(inner, function (name, v) { g_playlists[g_playlists.length] = name; });
    FillList("PlaylistList", g_playlists);
    System.Print("[Lists] Playlists: " + g_playlists.length + "\r\n");
}

Initialize();
