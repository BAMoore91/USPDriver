var tcpClient = null;
var hostIP = Config.Get("IPAddress");
var hostPort = Config.Get("USPPort");

function Initialize() {
    System.Print("--- IPCBox Driver V2.0 Initialized ---\r\n");
    Connect();
}

function Connect() {
    tcpClient = new TCP(OnData, hostIP, hostPort);
    tcpClient.OnConnectFunc = function() {
        SystemVars.Write("ConnStatus", true, "BOOLEAN");
        System.Print("[System] Connected to IPCBox at " + hostIP + "\r\n");
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
}

/** Recall a previously-built named matrix preset. */
function RecallMatrix(matrixKey) {
    var name = ResolveSlot(matrixKey);
    if (name) {
        SendCommand("matrix active " + name);
        SystemVars.Write("ActiveMatrix", name);
    }
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
}

// ---- Exported: selection handlers (wired to the panel Item List objects) ----
// The runtime appends the scroll-window-top index as a trailing arg (ignored).
function SelectSource(index, top) {
    if (index >= 0 && index < g_sources.length) {
        g_liveSrc = g_sources[index];
        SystemVars.Write("LiveSource", g_liveSrc);
    }
}
function SelectDisplay(index, top) {
    if (index >= 0 && index < g_displays.length) {
        g_liveDisp = g_displays[index];
        SystemVars.Write("LiveDisplay", g_liveDisp);
    }
}
function SelectLayoutItem(index, top) {
    if (index >= 0 && index < g_layouts.length) {
        var name = g_layouts[index];
        SystemVars.Write("LiveLayout", name);
        SendCommand("mvid layout active " + name);   // recall on tap
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
    } else {
        System.Print("[Error] RouteLive: select a source and a display first.\r\n");
    }
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
    ForEachEntry(inner, function (mac, dev) {
        var id = ExtractStr(dev, "id");
        if (id === "") { id = mac; }
        if (dev.indexOf("\"is_host\"") >= 0) { g_sources[g_sources.length] = id; }
        if (dev.indexOf("\"ch_v\"") >= 0) { g_displays[g_displays.length] = id; }
    });
    FillList("SourceList", g_sources);
    FillList("DisplayList", g_displays);
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
