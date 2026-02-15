import { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu } from "electron"
import { execSync } from "child_process";
import { config as dotenvConfig } from "dotenv";
import { join } from "path";
import { ipcMainHandle, isDev, DEV_PORT } from "./util.js";

// Load .env file from project root
dotenvConfig({ path: join(process.cwd(), ".env") });

// Default to Letta Cloud if no base URL set
if (!process.env.LETTA_BASE_URL) {
  process.env.LETTA_BASE_URL = "https://api.letta.com";
}

// Set dummy API key for localhost (local server doesn't check it)
if (!process.env.LETTA_API_KEY && process.env.LETTA_BASE_URL?.includes("localhost")) {
  process.env.LETTA_API_KEY = "local-dev-key";
}

// Find letta CLI
try {
  const whichCmd = process.platform === 'win32' ? 'where letta' : 'which letta';
  const lettaPath = execSync(whichCmd, { encoding: "utf-8" }).trim();
  if (lettaPath) {
    // On Windows, 'where' may return multiple lines - take the first one
    const firstPath = lettaPath.split('\n')[0].trim();
    process.env.LETTA_CLI_PATH = firstPath;
    console.log("Found letta CLI at:", firstPath);
  }
} catch (e) {
  console.warn("Could not find letta CLI:", e);
}
import { getPreloadPath, getUIPath, getIconPath } from "./pathResolver.js";
import { getStaticData, pollResources, stopPolling } from "./test.js";
import { handleClientEvent, cleanupAllSessions } from "./ipc-handlers.js";
import type { ClientEvent } from "./types.js";

let cleanupComplete = false;
let mainWindow: BrowserWindow | null = null;

function killViteDevServer(): void {
    if (!isDev()) return;
    try {
        if (process.platform === 'win32') {
            execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${DEV_PORT}') do taskkill /PID %a /F`, { stdio: 'ignore', shell: 'cmd.exe' });
        } else {
            execSync(`lsof -ti:${DEV_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
        }
    } catch {
        // Process may already be dead
    }
}

function cleanup(): void {
    if (cleanupComplete) return;
    cleanupComplete = true;

    globalShortcut.unregisterAll();
    stopPolling();
    cleanupAllSessions();
    killViteDevServer();
}

function handleSignal(): void {
    cleanup();
    app.quit();
}

// Initialize everything when app is ready
app.on("ready", () => {
    Menu.setApplicationMenu(null);
    // Setup event handlers
    app.on("before-quit", cleanup);
    app.on("will-quit", cleanup);
    app.on("window-all-closed", () => {
        cleanup();
        app.quit();
    });

    process.on("SIGTERM", handleSignal);
    process.on("SIGINT", handleSignal);
    process.on("SIGHUP", handleSignal);

    // Create main window
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        webPreferences: {
            preload: getPreloadPath(),
        },
        icon: getIconPath(),
        titleBarStyle: "hiddenInset",
        backgroundColor: "#FAF9F6",
        trafficLightPosition: { x: 15, y: 18 }
    });

    if (isDev()) mainWindow.loadURL(`http://localhost:${DEV_PORT}`)
    else mainWindow.loadFile(getUIPath());

    globalShortcut.register('CommandOrControl+Q', () => {
        cleanup();
        app.quit();
    });

    pollResources(mainWindow);

    ipcMainHandle("getStaticData", () => {
        return getStaticData();
    });

    // Handle client events
    ipcMain.on("client-event", (_: Electron.IpcMainEvent, event: ClientEvent) => {
        handleClientEvent(event);
    });

    // Handle recent cwds request (simplified - no local storage)
    ipcMainHandle("get-recent-cwds", () => {
        return [process.cwd()]; // Just return current directory
    });

    // Handle directory selection
    ipcMainHandle("select-directory", async () => {
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openDirectory']
        });

        if (result.canceled) {
            return null;
        }

        return result.filePaths[0];
    });
})
