import { app, BrowserWindow, ipcMain, dialog, globalShortcut, Menu } from "electron"
import { execSync } from "child_process";
import { ipcMainHandle, isDev, DEV_PORT } from "./util.js";

// Find letta CLI and load shell env before anything else
try {
  // Get env from shell (to get LETTA_API_KEY etc)
  const shellEnv = execSync("bash -l -c 'env'", { encoding: "utf-8" });
  for (const line of shellEnv.split("\n")) {
    const [key, ...valueParts] = line.split("=");
    if (key && valueParts.length > 0) {
      const value = valueParts.join("=");
      if (key.startsWith("LETTA_") || key === "ANTHROPIC_API_KEY") {
        process.env[key] = value;
        console.log(`Loaded env: ${key}=${value.substring(0, 10)}...`);
      }
    }
  }
  
  // Default to Letta Cloud if no base URL set
  if (!process.env.LETTA_BASE_URL) {
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    console.log("Set LETTA_BASE_URL to Letta Cloud (api.letta.com)");
  }
  
  // Set dummy API key for localhost (local server doesn't check it)
  if (!process.env.LETTA_API_KEY && process.env.LETTA_BASE_URL?.includes("localhost")) {
    process.env.LETTA_API_KEY = "local-dev-key";
    console.log("Set dummy LETTA_API_KEY for localhost");
  }
  
  const lettaPath = execSync("which letta", { encoding: "utf-8" }).trim();
  if (lettaPath) {
    process.env.LETTA_CLI_PATH = lettaPath;
    console.log("Found letta CLI at:", lettaPath);
  }
} catch (e) {
  console.warn("Could not load shell env:", e);
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
    ipcMain.on("client-event", (_: any, event: ClientEvent) => {
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

    // API config handlers (simplified - use env vars)
    ipcMainHandle("get-api-config", () => {
        return null; // Letta uses its own config
    });

    ipcMainHandle("check-api-config", () => {
        return { hasConfig: true, config: null }; // Letta handles auth
    });

    ipcMainHandle("save-api-config", () => {
        return { success: true }; // No-op, Letta handles config
    });
})
