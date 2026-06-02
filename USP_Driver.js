var tcpClient = null;
var hostIP = Config.Get("IPAddress");
var hostPort = Config.Get("USPPort");

function Initialize() {
    System.Print("--- IPCBox Simple Driver V1.4 Initialized ---\r\n");
    Connect();
}

function Connect() {
    tcpClient = new TCP(OnData, hostIP, hostPort);
    tcpClient.OnConnectFunc = function() {
        SystemVars.Write("ConnStatus", true);
        System.Print("[System] Connected to IPCBox at " + hostIP + "\r\n");
    };
    tcpClient.OnDisconnectFunc = function() {
        SystemVars.Write("ConnStatus", false);
        System.Print("[System] Connection Lost. Retrying in 10s...\r\n");
        new Timer().Start(Connect, 10000);
    };
}

function SendCommand(cmd) {
    if (tcpClient && tcpClient.ConnectState == 1) {
        System.Print("[RTI -> IPCBox] " + cmd + "\r\n");
        // Sending command + Newline. Semicolon removed from variable ends.
        tcpClient.Write(cmd + "\r\n"); 
    } else {
        System.Print("[ERROR] TCP Not Connected. Command Failed: " + cmd + "\r\n");
    }
}

function OnData(data) {
    System.Print("[IPCBox -> RTI] " + data + "\r\n");
}

// --- EXPORTED MACRO FUNCTIONS ---

/**
 * Function A: Assign Layout to Display and Activate
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
 * Function B: Update Window Source and Activate
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
    } else {
        System.Print("[Error] UpdateWindowSource failed: Slot L or I is empty in Config.\r\n");
    }
}

Initialize();