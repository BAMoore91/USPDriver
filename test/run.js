// Dev-only test harness for USP_Driver.js. NOT shipped in the driver package.
// Loads the driver in a sandbox that stubs the RTI runtime (TCP/Config/
// SystemVars/System/Timer), then asserts each exported function emits the
// exact CBOX command string and that the feedback parser writes the right
// System Variables. Run: node test/run.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'USP_Driver.js');
const code = fs.readFileSync(SRC, 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   - ' + name); }
  else { failures++; console.log('  FAIL - ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// ---- Fixtures: ConfigSettings slot values ----
const CONFIG = {
  IPAddress: '192.168.1.100', USPPort: '24',
  L1: 'lay1', L10: 'lay10', O1: 'RX1', O2: 'RX2', O3: 'RX3',
  I1: 'TX1', I2: 'TX2',
  MX1: 'mx1', VW1: 'videowall2', WL1: 'vlayout1', PL1: '444',
  C1: '0036', C2: '0036, 0037', C3: 'POWERON',
  O4: '188a6a02c0d1', O5: '188a6a02c0ab',
};

// ---- Build a fresh sandbox + load the driver ----
function loadDriver() {
  const sent = [];
  const vars = {};
  let rxFunc = null;

  function TCP(rxfunc /*, host, port */) {
    rxFunc = rxfunc;
    this.ConnectState = 1;
    this.OpenState = 1;
    this.OnConnectFunc = null;
    this.OnDisconnectFunc = null;
    this.Write = function (data) { sent.push(data); return true; };
    this.Close = function () { return true; };
    return this;
  }
  const timers = [];
  function Timer() {
    this.Start = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return true; };
    this.Stop = function () { return true; };
  }

  const lists = {};
  function SystemVarsList(name) {
    this.name = name;
    this._buf = null;
    this.Open = function () { this._buf = (lists[name] || []).slice(); return true; };
    this.RemoveAll = function () { this._buf = []; return true; };
    this.Insert = function (d) { this._buf.push(d); return true; };
    this.Close = function () { lists[name] = this._buf.slice(); return true; };
  }

  const sandbox = {
    Config: { Get: function (k) { return Object.prototype.hasOwnProperty.call(CONFIG, k) ? CONFIG[k] : ''; } },
    SystemVars: { Write: function (n, v) { vars[n] = v; return true; }, Read: function (n) { return n in vars ? vars[n] : null; } },
    System: { Print: function () {} },
    TCP: TCP,
    Timer: Timer,
    SystemVarsList: SystemVarsList,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'USP_Driver.js' });

  return {
    call: function (fn) { return vm.runInContext(fn, sandbox, { filename: 'call' }); },
    feed: function (data) { rxFunc(data); },
    lastSent: function () { return sent.length ? sent[sent.length - 1].replace(/\r\n$/, '') : null; },
    allSent: function () { return sent.map(function (s) { return s.replace(/\r\n$/, ''); }); },
    vars: vars,
    lists: lists,
    timers: timers,
    runTimers: function () {
      const due = timers.splice(0, timers.length);
      due.forEach(function (t) { t.fn(); });
    },
  };
}

// =====================================================================
// 1. Command-string assertions
// =====================================================================
console.log('Command emission:');
const cases = [
  ['RouteSourceToDisplay("I1","O1")', 'matrix aset :av TX1 RX1'],
  ['RouteSourceMulti("I1","O1","O2","O3")', 'matrix aset :av TX1 RX1 RX2 RX3'],
  ['RouteSourceMulti("I1","O1","","O3")', 'matrix aset :av TX1 RX1 RX3'],
  ['RecallMatrix("MX1")', 'matrix active mx1'],
  ['RecallWallLayout("VW1","WL1")', 'vwid layout active videowall2 vlayout1'],
  ['SwapWallSource("VW1","WL1","2:2","I1")', 'vwid layout tx videowall2 vlayout1 2:2 TX1'],
  ['PlayPlaylist("PL1","O1")', 'play pl start 444 RX1'],
  ['UploadPlaylist("PL1","O1","O2","")', 'play pl upload 444 RX1,RX2'],
  ['DeviceControl("O1","reboot")', 'config set device reboot RX1'],
  ['DeviceControl("O1","light flash")', 'config set device light flash RX1'],
  ['DeviceControl("I1","osd on")', 'config set device osd on TX1'],
  ['DeviceControl("O1","stream off")', 'config set device stream off RX1'],
  ['SystemControl("set reboot")', 'config set reboot'],
  ['SystemControl("get devicelist")', 'config get devicelist'],
  ['SystemControl("get device status ALL")', 'config get device status ALL'],
  ['SendRawCommand("mvid layout add 14")', 'mvid layout add 14'],
  // CEC: config set device cec {hexData}[,{hexData}...] {device_id/device_mac}
  ['CECPower("O1","poweron")', 'config set device cec poweron RX1'],
  ['CECPower("O1","poweroff")', 'config set device cec poweroff RX1'],
  ['CECPowerScope("ALLRX","poweron")', 'config set device cec poweron ALLRX'],
  ['CECPowerMulti("O1","O2","O3","poweroff")', 'config set device cec poweroff RX1:RX2:RX3'],
  ['CECPowerMulti("O1","","O3","poweron")', 'config set device cec poweron RX1:RX3'],
  ['CECSendSlot("C1","O1")', 'config set device cec 0036 RX1'],
  ['CECSendSlot("C1","I1")', 'config set device cec 0036 TX1'],
  ['CECSendSlotMulti("C1","O1","O2","")', 'config set device cec 0036 RX1:RX2'],
  ['CECSendSlotScope("C1","ALL")', 'config set device cec 0036 ALL'],
  ['CECSendRaw("0036","O1")', 'config set device cec 0036 RX1'],
  // typed spaces collapse to the documented space-free block form
  ['CECSendSlot("C2","O1")', 'config set device cec 0036,0037 RX1'],
  ['CECSendRaw("00 36 , 00 37","O1")', 'config set device cec 0036,0037 RX1'],
  // power keywords fold to the lower case the CBOX expects
  ['CECSendSlot("C3","O1")', 'config set device cec poweron RX1'],
  ['CECSendRaw("PowerOff","O1")', 'config set device cec poweroff RX1'],
  // original Multiview behavior preserved
  ['ShowLayoutOnDisplay("L1","O1")', 'mvid layout active lay1'],
];
cases.forEach(function (c) {
  const d = loadDriver();
  d.call(c[0]);
  check(c[0], d.lastSent() === c[1], 'got: ' + d.lastSent());
});

// ShowLayoutOnDisplay emits two commands in order
(function () {
  const d = loadDriver();
  d.call('ShowLayoutOnDisplay("L1","O1")');
  const a = d.allSent();
  check('ShowLayoutOnDisplay emits rx then active',
    a.length === 2 && a[0] === 'mvid layout rx lay1 RX1' && a[1] === 'mvid layout active lay1',
    a.join(' | '));
})();

// SendCommand records LastCommandSent
(function () {
  const d = loadDriver();
  d.call('RecallMatrix("MX1")');
  check('LastCommandSent recorded', d.vars.LastCommandSent === 'matrix active mx1', d.vars.LastCommandSent);
})();

// Empty-slot guard: nothing sent
(function () {
  const d = loadDriver();
  d.call('RouteSourceToDisplay("I9","O9")'); // I9/O9 not in fixtures -> empty
  check('empty slots -> no command', d.allSent().length === 0, d.allSent().join('|'));
})();

// =====================================================================
// 2. Feedback parser assertions
// =====================================================================
console.log('Feedback parsing:');
(function () {
  const d = loadDriver();
  d.feed('{"cmd":"matrix active mx1","info":"OK","code":0}');
  check('success code -> LastCommandSuccess true', d.vars.LastCommandSuccess === true);
  check('parses code 0', d.vars.LastResponseCode === 0);
  check('parses cmd', d.vars.LastResponseCmd === 'matrix active mx1');
  check('parses info', d.vars.LastResponseInfo === 'OK');
  check('derives ActiveMatrix from echo', d.vars.ActiveMatrix === 'mx1', d.vars.ActiveMatrix);
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"config set device hdcp 1 RX1","info":"fail","code":13}');
  check('nonzero code -> LastCommandSuccess false', d.vars.LastCommandSuccess === false);
  check('parses negative-free int 13', d.vars.LastResponseCode === 13);
})();

(function () {
  const d = loadDriver();
  d.feed('"OK"');
  check('bare OK -> success', d.vars.LastCommandSuccess === true, JSON.stringify(d.vars));
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"vwid layout active videowall2 vlayout1","info":"OK","code":0}');
  check('derives ActiveWall', d.vars.ActiveWall === 'videowall2', d.vars.ActiveWall);
  check('derives ActiveWallLayout', d.vars.ActiveWallLayout === 'vlayout1', d.vars.ActiveWallLayout);
})();

(function () {
  const d = loadDriver();
  // two replies in one chunk, newline separated
  d.feed('{"cmd":"mvid layout active 15","info":"OK","code":0}\n{"cmd":"matrix active mx1","info":"OK","code":0}\n');
  check('multi-line: ActiveLayout from first', d.vars.ActiveLayout === '15', d.vars.ActiveLayout);
  check('multi-line: ActiveMatrix from second', d.vars.ActiveMatrix === 'mx1', d.vars.ActiveMatrix);
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"config get device status ALL","info":{"188A6ACE87DC":{"online":1}},"code":0}');
  check('devicelist/status -> DeviceStatusRaw set', typeof d.vars.DeviceStatusRaw === 'string' && d.vars.DeviceStatusRaw.indexOf('device status') >= 0);
})();

// =====================================================================
// 3. Multiview arm-then-route workflow
// =====================================================================
console.log('Multiview arm-then-route:');
(function () {
  const d = loadDriver();
  d.call('SelectLayout("L1")');
  check('SelectLayout writes SelectedLayout', d.vars.SelectedLayout === 'lay1', d.vars.SelectedLayout);
  check('SelectLayout writes SelectedLayoutID (slot index)', d.vars.SelectedLayoutID === 1, '' + d.vars.SelectedLayoutID);
  d.call('SelectLayout("L10")');
  check('SelectLayoutID handles two-digit slot', d.vars.SelectedLayoutID === 10, '' + d.vars.SelectedLayoutID);
  d.call('SelectLayout("L1")');
  d.call('SelectWindow(3)');
  check('SelectWindow writes SelectedWindowID (int)', d.vars.SelectedWindowID === 3, '' + d.vars.SelectedWindowID);
  check('WinSel3 true when window 3 armed', d.vars.WinSel3 === true, '' + d.vars.WinSel3);
  check('WinSel1 false when window 3 armed', d.vars.WinSel1 === false, '' + d.vars.WinSel1);
  d.call('SelectWindow(5)');
  check('re-arm clears old boolean (WinSel3 false)', d.vars.WinSel3 === false, '' + d.vars.WinSel3);
  check('re-arm sets new boolean (WinSel5 true)', d.vars.WinSel5 === true, '' + d.vars.WinSel5);
  d.call('SelectWindow(16)');
  check('supports window 16 (WinSel16 true)', d.vars.WinSel16 === true, '' + d.vars.WinSel16);
  check('window 16 sets SelectedWindowID 16', d.vars.SelectedWindowID === 16, '' + d.vars.SelectedWindowID);
  d.call('SelectWindow("5")');
  check('SelectWindow accepts string arg', d.vars.SelectedWindowID === 5, '' + d.vars.SelectedWindowID);
  // re-arm window 3 and route input
  d.call('SelectWindow(3)');
  d.call('RouteSelectedInput("I1")');
  const a = d.allSent();
  const n = a.length;
  check('SelectLayout queries layout windows', a.indexOf('mvid layout get lay1') >= 0, a.join(' | '));
  check('routes into armed layout+window then activates',
    n >= 2 && a[n - 2] === 'mvid layout tx lay1 3 TX1' && a[n - 1] === 'mvid layout active lay1',
    a.join(' | '));
  check('WinSrc3 reflects routed source', d.vars.WinSrc3 === 'TX1', d.vars.WinSrc3);
})();

const routes = (d) => d.allSent().filter((c) => c.indexOf('mvid layout tx') === 0);
(function () {
  const d = loadDriver();
  d.call('SelectWindow(2)');            // no layout armed
  d.call('RouteSelectedInput("I1")');
  check('route with no layout armed -> no route command', routes(d).length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.call('SelectLayout("L1")');         // layout armed, no window
  d.call('RouteSelectedInput("I1")');
  check('route with no window armed -> no route command', routes(d).length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.call('SelectLayout("L1")');
  d.call('SelectWindow(1)');
  d.call('RouteSelectedInput("I9")');   // I9 not in fixtures -> empty slot
  check('route with empty input slot -> no route command', routes(d).length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"mvid layout get lay1","info":{"windows":[{"host":"TX1","index":1},{"host":"TX2","index":2}],"client":"RX1"},"code":0}');
  check('layout-get populates WinSrc1', d.vars.WinSrc1 === 'TX1', d.vars.WinSrc1);
  check('layout-get populates WinSrc2', d.vars.WinSrc2 === 'TX2', d.vars.WinSrc2);
  check('layout-get clears empty windows', d.vars.WinSrc3 === '', JSON.stringify(d.vars.WinSrc3));
})();

// =====================================================================
// 4. Live name lists pulled from the CBOX
// =====================================================================
console.log('Live name lists:');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"config get devicelist","info":{"AAA":{"id":"TX-Apple","mac":"AAA","is_host":1,"dtype":"x"},"BBB":{"id":"RX-LED","mac":"BBB","ch_v":"0002","ch_a":"0002"},"CCC":{"id":"TX-PC","mac":"CCC","is_host":1}},"code":0}');
  check('devicelist -> SourceList', eq(d.lists.SourceList, ['TX-Apple', 'TX-PC']), JSON.stringify(d.lists.SourceList));
  check('devicelist -> DisplayList', eq(d.lists.DisplayList, ['RX-LED']), JSON.stringify(d.lists.DisplayList));
  d.call('SelectSource(0,0)');
  d.call('SelectDisplay(0,0)');
  check('SelectSource sets LiveSource', d.vars.LiveSource === 'TX-Apple', d.vars.LiveSource);
  check('SelectDisplay sets LiveDisplay', d.vars.LiveDisplay === 'RX-LED', d.vars.LiveDisplay);
  d.call('RouteLive()');
  check('RouteLive routes the selection', d.lastSent() === 'matrix aset :av TX-Apple RX-LED', d.lastSent());
  d.call('SelectSource(1,0)');
  check('SelectSource index 1 -> TX-PC', d.vars.LiveSource === 'TX-PC', d.vars.LiveSource);
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"mvid get layouts","info":{"15":{"windows":[]},"222":{"windows":[]}},"code":0}');
  check('mvid get -> LayoutList', eq(d.lists.LayoutList, ['15', '222']), JSON.stringify(d.lists.LayoutList));
  d.feed('{"cmd":"config get devicelist","info":{"AAA":{"id":"TX-Apple","is_host":1}},"code":0}');
  d.call('SelectLayoutItem(1,0)');                 // arms + recalls "222"
  const a1 = d.allSent();
  check('SelectLayoutItem recalls layout', a1.indexOf('mvid layout active 222') >= 0, a1.join(' | '));
  check('SelectLayoutItem arms layout', d.vars.SelectedLayout === '222', d.vars.SelectedLayout);
  check('SelectLayoutItem refreshes window sources', a1.indexOf('mvid layout get 222') >= 0, a1.join(' | '));
  d.call('SelectWindow(2)');
  d.call('SelectSource(0,0)');                      // live source TX-Apple
  d.call('RouteLiveSourceToWindow()');
  const a2 = d.allSent(); const n2 = a2.length;
  check('RouteLiveSourceToWindow routes live source into armed window',
    a2[n2 - 2] === 'mvid layout tx 222 2 TX-Apple' && a2[n2 - 1] === 'mvid layout active 222', a2.join(' | '));
  check('RouteLiveSourceToWindow updates WinSrc2', d.vars.WinSrc2 === 'TX-Apple', d.vars.WinSrc2);
})();

(function () {
  const d = loadDriver();
  d.call('RouteLiveSourceToWindow()');             // nothing armed/selected
  check('RouteLiveSourceToWindow guards when unarmed', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"config get devicelist","info":{"AAA":{"id":"TX-Apple","is_host":1}},"code":0}');
  d.call('SelectSource(0,0)');
  d.call('SwapWallSourceLive("VW1","WL1","2:2")');
  check('SwapWallSourceLive drops live source into wall cell',
    d.lastSent() === 'vwid layout tx videowall2 vlayout1 2:2 TX-Apple', d.lastSent());
})();

(function () {
  const d = loadDriver();
  d.call('SwapWallSourceLive("VW1","WL1","2:2")');  // no source selected
  check('SwapWallSourceLive guards with no source', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"play pl get","info":{"CAZLogo":[{"url":"a.jpg","time":10,"index":1}],"LFLogo":[]},"code":0}');
  check('play pl get -> PlaylistList', eq(d.lists.PlaylistList, ['CAZLogo', 'LFLogo']), JSON.stringify(d.lists.PlaylistList));
  d.feed('{"cmd":"config get devicelist","info":{"BBB":{"id":"RX-LED","ch_v":"1"}},"code":0}');
  d.call('SelectDisplay(0,0)');
  d.call('SelectPlaylist(0,0)');
  d.call('PlayLivePlaylist()');
  check('PlayLivePlaylist uses live selections', d.lastSent() === 'play pl start CAZLogo RX-LED', d.lastSent());
  d.call('SendLivePlaylist()');
  check('SendLivePlaylist uploads to selection', d.lastSent() === 'play pl upload CAZLogo RX-LED', d.lastSent());
})();

(function () {
  const d = loadDriver();
  d.call('RouteLive()');
  check('RouteLive guards with no selection', d.allSent().length === 0, d.allSent().join('|'));
  d.call('RefreshAll()');
  const a = d.allSent();
  check('RefreshAll queries all three',
    a.indexOf('config get devicelist') >= 0 && a.indexOf('mvid get layouts') >= 0 && a.indexOf('play pl get') >= 0,
    a.join(' | '));
})();

// =====================================================================
// 6. CEC
// =====================================================================
console.log('CEC:');
(function () {
  const d = loadDriver();
  d.call('CECPower("O1","poweron")');
  check('CEC writes LastCECData', d.vars.LastCECData === 'poweron', d.vars.LastCECData);
  check('CEC writes LastCECTarget', d.vars.LastCECTarget === 'RX1', d.vars.LastCECTarget);
})();

(function () {
  const d = loadDriver();
  d.call('CECPower("O9","poweron")');          // O9 not in fixtures -> empty slot
  check('CEC empty device slot -> no command', d.allSent().length === 0, d.allSent().join('|'));
  d.call('CECSendSlot("C9","O1")');            // C9 not in fixtures -> empty payload
  check('CEC empty command slot -> no command', d.allSent().length === 0, d.allSent().join('|'));
  d.call('CECSendRaw("","O1")');
  check('CEC empty raw data -> no command', d.allSent().length === 0, d.allSent().join('|'));
  d.call('CECPowerMulti("","","","poweron")');
  check('CEC no targets -> no command', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"config get devicelist","info":{"BBB":{"id":"RX-LED","ch_v":"1"}},"code":0}');
  d.call('SelectDisplay(0,0)');
  d.call('CECPowerLive("poweron")');
  check('CECPowerLive targets the live display',
    d.lastSent() === 'config set device cec poweron RX-LED', d.lastSent());
  d.call('CECSendSlotLive("C1")');
  check('CECSendSlotLive targets the live display',
    d.lastSent() === 'config set device cec 0036 RX-LED', d.lastSent());
})();

(function () {
  const d = loadDriver();
  d.call('CECPowerLive("poweron")');
  check('CECPowerLive guards with no display selected', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"config set device cec poweron 188A6A45C4A5","info":"OK","code":0}');
  check('CEC reply parses as success', d.vars.LastCommandSuccess === true);
  check('CEC reply echoes cmd', d.vars.LastResponseCmd === 'config set device cec poweron 188A6A45C4A5',
    d.vars.LastResponseCmd);
})();

// =====================================================================
// 7. Matrix route feedback (which source each display is tuned to)
// =====================================================================
console.log('Matrix route feedback:');

// The reply exactly as the API doc prints it (Lua table, no JSON envelope).
const ROUTES = '{ ["188a6a02c0ab"] = {audio = "none", ir = "none",rs232 = "none",usb = "none",video = "none"  },'
  + '  ["188a6a02c0b6"] = {audio = "188a11223368", ir = "none", rs232 = "none", usb = "none", video = "188a11223368"  },'
  + ' ["188a6a02c0bd"] = {audio = "none", ir = "none", rs232 = "none", usb = "none", video = "none" },'
  + '["188a6a02c0d1"] = { audio = "188a11223368", ir = "none",    rs232 = "none", usb = "none",  video = "188a11223368" },'
  + ' ["188a6a02c0de"] = { audio = "none", ir = "none", rs232 = "none",    usb = "none", video = "none"} }';

const DEVLIST = '{"cmd":"config get devicelist","info":{'
  + '"188a6a02c0b6":{"id":"RX1","ch_v":"0002"},'
  + '"188a11223368":{"id":"TX-MAIN","is_host":"1"}},"code":0}';

(function () {
  const d = loadDriver();
  d.call('RefreshRoutes()');
  check('RefreshRoutes queries all decoders',
    d.lastSent() === 'config get device routes vaurs ALLRX', d.lastSent());
})();

(function () {
  const d = loadDriver();
  d.feed(DEVLIST);          // names first, then routes
  d.feed(ROUTES);
  check('OutSrc1 resolves slot id -> source name', d.vars.OutSrc1 === 'TX-MAIN', d.vars.OutSrc1);
  check('OutSrc4 resolves a slot holding a raw MAC', d.vars.OutSrc4 === 'TX-MAIN', d.vars.OutSrc4);
  check('video "none" -> empty OutSrc', d.vars.OutSrc5 === '', JSON.stringify(d.vars.OutSrc5));
  check('unconfigured slot -> empty OutSrc', d.vars.OutSrc9 === '', JSON.stringify(d.vars.OutSrc9));
})();

(function () {
  const d = loadDriver();
  d.feed(ROUTES);           // routes first: names not known yet
  check('routes before devicelist fall back to the MAC',
    d.vars.OutSrc4 === '188A11223368', d.vars.OutSrc4);
  d.feed(DEVLIST);          // devicelist restates them with real ids
  check('devicelist restates OutSrc with the friendly id',
    d.vars.OutSrc4 === 'TX-MAIN', d.vars.OutSrc4);
  check('devicelist restates OutSrc1 too', d.vars.OutSrc1 === 'TX-MAIN', d.vars.OutSrc1);
})();

(function () {
  const d = loadDriver();
  // Same table, but wrapped in the usual envelope in case firmware sends it that way.
  d.feed('{"cmd":"config get device routes vaurs ALLRX","info":' + ROUTES + ',"code":0}');
  d.feed(DEVLIST);
  check('enveloped routes reply parses too', d.vars.OutSrc1 === 'TX-MAIN', d.vars.OutSrc1);
})();

(function () {
  const d = loadDriver();
  d.feed('{"cmd":"matrix active mx1","info":"OK","code":0}');
  check('a normal JSON reply is not mistaken for routes',
    d.vars.OutSrc1 === undefined, JSON.stringify(d.vars.OutSrc1));
  // A JSON array of strings also contains ["..."]; it must not look like Lua.
  d.feed('{"cmd":"matrix add mx1 video","info":{"tx":["TX1","TX2"]},"code":0}');
  check('a JSON string array is not mistaken for routes',
    d.vars.OutSrc1 === undefined, JSON.stringify(d.vars.OutSrc1));
})();

(function () {
  const d = loadDriver();
  d.feed(DEVLIST);
  d.feed(ROUTES);
  check('baseline OutSrc1 before a bad reply', d.vars.OutSrc1 === 'TX-MAIN', d.vars.OutSrc1);
  // A truncated chunk that yields no entries must not blank live feedback.
  d.feed('{"cmd":"config get device routes vaurs ALLRX","info":"","code":0}');
  check('an empty routes reply keeps the previous state',
    d.vars.OutSrc1 === 'TX-MAIN', d.vars.OutSrc1);
})();

(function () {
  const d = loadDriver();
  d.feed(DEVLIST);
  d.feed(ROUTES);
  d.call('SelectDisplay(0,0)');   // devicelist gives one display: RX1
  check('SelectDisplay publishes LiveDisplaySource',
    d.vars.LiveDisplaySource === 'TX-MAIN', d.vars.LiveDisplaySource);
})();

(function () {
  const d = loadDriver();
  d.call('RouteSourceToDisplay("I1","O1")');
  check('routing schedules a route re-read', d.timers.length === 1, '' + d.timers.length);
  d.runTimers();
  check('the scheduled timer queries the routes',
    d.lastSent() === 'config get device routes vaurs ALLRX', d.lastSent());
})();

(function () {
  const d = loadDriver();
  d.call('RecallMatrix("MX1")');
  check('preset recall schedules a route re-read', d.timers.length === 1, '' + d.timers.length);
  const e = loadDriver();
  e.call('RouteSourceMulti("I1","O1","O2","O3")');
  check('multi-route schedules a route re-read', e.timers.length === 1, '' + e.timers.length);
})();

(function () {
  const d = loadDriver();
  d.call('tcpClient.OnConnectFunc()');
  check('connect queries the device list', d.allSent().indexOf('config get devicelist') >= 0,
    d.allSent().join(' | '));
  d.runTimers();
  check('connect then queries the routes',
    d.lastSent() === 'config get device routes vaurs ALLRX', d.lastSent());
})();

(function () {
  const d = loadDriver();
  d.call('RefreshAll()');
  check('RefreshAll includes the routes',
    d.allSent().indexOf('config get device routes vaurs ALLRX') >= 0, d.allSent().join(' | '));
})();

// =====================================================================
// 8. Matrix arm-then-route (select source, then tap destinations)
// =====================================================================
console.log('Matrix arm-then-route:');

(function () {
  const d = loadDriver();
  d.call('SelectMatrixSource("I1")');
  check('arming writes LiveSource', d.vars.LiveSource === 'TX1', d.vars.LiveSource);
  check('arming writes SelectedSourceID', d.vars.SelectedSourceID === 1, '' + d.vars.SelectedSourceID);
  check('arming sets that source boolean', d.vars.SrcSel1 === true, '' + d.vars.SrcSel1);
  check('arming clears the others', d.vars.SrcSel2 === false, '' + d.vars.SrcSel2);
  check('arming sends nothing on its own', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  // The whole point: one source tap, then a run of destinations.
  d.call('SelectMatrixSource("I1")');
  d.call('RouteSelectedToDisplay("O1")');
  d.call('RouteSelectedToDisplay("O2")');
  d.call('RouteSelectedToDisplay("O3")');
  const a = d.allSent();
  check('each destination tap routes the armed source',
    a.length === 3 &&
    a[0] === 'matrix aset :av TX1 RX1' &&
    a[1] === 'matrix aset :av TX1 RX2' &&
    a[2] === 'matrix aset :av TX1 RX3', a.join(' | '));
  check('the source stays armed across the run', d.vars.LiveSource === 'TX1', d.vars.LiveSource);
})();

(function () {
  const d = loadDriver();
  d.call('SelectMatrixSource("I1")');
  d.call('SelectMatrixSource("I2")');
  check('re-arming moves the highlight off the old source', d.vars.SrcSel1 === false, '' + d.vars.SrcSel1);
  check('re-arming highlights the new source', d.vars.SrcSel2 === true, '' + d.vars.SrcSel2);
  d.call('RouteSelectedToDisplay("O1")');
  check('routing follows the re-armed source',
    d.lastSent() === 'matrix aset :av TX2 RX1', d.lastSent());
})();

(function () {
  const d = loadDriver();
  d.call('RouteSelectedToDisplay("O1")');
  check('destination tap with no source armed does nothing',
    d.allSent().length === 0, d.allSent().join('|'));
  d.call('SelectMatrixSource("I9")');           // empty slot
  check('arming an empty slot arms nothing', !d.vars.LiveSource, d.vars.LiveSource);
  d.call('SelectMatrixSource("I1")');
  d.call('RouteSelectedToDisplay("O9")');       // empty slot
  check('routing to an empty display slot does nothing',
    d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.call('SelectMatrixSource("I1")');
  d.call('ClearMatrixSelection()');
  check('clearing drops the armed source', d.vars.LiveSource === '', JSON.stringify(d.vars.LiveSource));
  check('clearing drops the highlight', d.vars.SrcSel1 === false, '' + d.vars.SrcSel1);
  d.call('RouteSelectedToDisplay("O1")');
  check('a stray tap after clearing does nothing', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.call('SelectMatrixSource("I1")');
  d.call('RouteSelectedToDisplay("O1")');
  check('routing schedules a route re-read', d.timers.length === 1, '' + d.timers.length);
})();

(function () {
  const d = loadDriver();
  d.feed(DEVLIST);
  // Arm from a config slot, then route by tapping the live Display List.
  d.call('SelectMatrixSource("I1")');
  d.call('SelectDisplayAndRoute(0,0)');
  check('display-list tap routes the slot-armed source',
    d.lastSent() === 'matrix aset :av TX1 RX1', d.lastSent());
  check('display-list tap still sets LiveDisplay', d.vars.LiveDisplay === 'RX1', d.vars.LiveDisplay);
})();

(function () {
  const d = loadDriver();
  d.feed(DEVLIST);
  d.call('SelectDisplayAndRoute(0,0)');
  check('display-list tap with no source armed does nothing',
    d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.feed(DEVLIST);
  // Arm from the live Source List instead; the same destination taps work.
  d.call('SelectSource(0,0)');
  check('list-armed source clears the slot highlight',
    d.vars.SelectedSourceID === 0 && d.vars.SrcSel1 === false,
    d.vars.SelectedSourceID + '/' + d.vars.SrcSel1);
  d.call('RouteSelectedToDisplay("O1")');
  check('list-armed source routes to a slot destination',
    d.lastSent() === 'matrix aset :av TX-MAIN RX1', d.lastSent());
})();

// =====================================================================
// 9. Button-text names published from the configuration
// =====================================================================
console.log('Slot name publishing:');
(function () {
  const d = loadDriver();
  check('input name published at startup', d.vars.InName1 === 'TX1', d.vars.InName1);
  check('output name published at startup', d.vars.OutName1 === 'RX1', d.vars.OutName1);
  check('output slot holding a MAC publishes it', d.vars.OutName4 === '188a6a02c0d1', d.vars.OutName4);
  check('unconfigured slot publishes empty', d.vars.InName9 === '', JSON.stringify(d.vars.InName9));
  check('names cover the full ceiling', d.vars.OutName64 === '', JSON.stringify(d.vars.OutName64));
  check('publishing names sends no commands', d.allSent().length === 0, d.allSent().join('|'));
})();

console.log('');
if (failures) { console.log(failures + ' FAILURE(S)'); process.exit(1); }
console.log('All assertions passed.');
