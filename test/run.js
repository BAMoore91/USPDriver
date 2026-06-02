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
  function Timer() { this.Start = function () { return true; }; }

  const sandbox = {
    Config: { Get: function (k) { return Object.prototype.hasOwnProperty.call(CONFIG, k) ? CONFIG[k] : ''; } },
    SystemVars: { Write: function (n, v) { vars[n] = v; return true; }, Read: function (n) { return n in vars ? vars[n] : null; } },
    System: { Print: function () {} },
    TCP: TCP,
    Timer: Timer,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'USP_Driver.js' });

  return {
    call: function (fn) { return vm.runInContext(fn, sandbox, { filename: 'call' }); },
    feed: function (data) { rxFunc(data); },
    lastSent: function () { return sent.length ? sent[sent.length - 1].replace(/\r\n$/, '') : null; },
    allSent: function () { return sent.map(function (s) { return s.replace(/\r\n$/, ''); }); },
    vars: vars,
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
  ['ApplyPlaylist("PL1","O1")', 'play pl apply 444 RX1'],
  ['UploadPlaylist("PL1","O1","O2","")', 'play pl upload 444 RX1,RX2'],
  ['DeviceControl("O1","reboot")', 'config set device reboot RX1'],
  ['DeviceControl("O1","light flash")', 'config set device light flash RX1'],
  ['DeviceControl("I1","osd on")', 'config set device osd on TX1'],
  ['DeviceControl("O1","stream off")', 'config set device stream off RX1'],
  ['SystemControl("set reboot")', 'config set reboot'],
  ['SystemControl("get devicelist")', 'config get devicelist'],
  ['SystemControl("get device status ALL")', 'config get device status ALL'],
  ['SendRawCommand("mvid layout add 14")', 'mvid layout add 14'],
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
  d.call('SelectWindow("5")');
  check('SelectWindow accepts string arg', d.vars.SelectedWindowID === 5, '' + d.vars.SelectedWindowID);
  // re-arm window 3 and route input
  d.call('SelectWindow(3)');
  d.call('RouteSelectedInput("I1")');
  const a = d.allSent();
  check('routes into armed layout+window then activates',
    a.length === 2 && a[0] === 'mvid layout tx lay1 3 TX1' && a[1] === 'mvid layout active lay1',
    a.join(' | '));
})();

(function () {
  const d = loadDriver();
  d.call('SelectWindow(2)');            // no layout armed
  d.call('RouteSelectedInput("I1")');
  check('route with no layout armed -> no command', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.call('SelectLayout("L1")');         // layout armed, no window
  d.call('RouteSelectedInput("I1")');
  check('route with no window armed -> no command', d.allSent().length === 0, d.allSent().join('|'));
})();

(function () {
  const d = loadDriver();
  d.call('SelectLayout("L1")');
  d.call('SelectWindow(1)');
  d.call('RouteSelectedInput("I9")');   // I9 not in fixtures -> empty slot
  check('route with empty input slot -> no command', d.allSent().length === 0, d.allSent().join('|'));
})();

console.log('');
if (failures) { console.log(failures + ' FAILURE(S)'); process.exit(1); }
console.log('All assertions passed.');
