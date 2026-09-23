import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const LOG_DIR = "data/logs";

let logFile = null;

function getLogFile() {
  if (!logFile) {
    const date = new Date().toISOString().slice(0, 10); // "2026-09-10"
    logFile = join(LOG_DIR, `${date}.log`);
  }
  return logFile;
}

function ts() {
  return new Date().toISOString();
}

async function writeLog(level, message, data) {
  const file = getLogFile();
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
  }

  let line = `[${ts()}] [${level}] ${message}`;
  if (data !== undefined) {
    if (typeof data === "string") {
      line += ` ${data}`;
    } else {
      line += ` ${JSON.stringify(data)}`;
    }
  }
  line += "\n";

  // Also output to the terminal
  const prefix = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️" : "  ";
  console.log(`${prefix} ${message}${data !== undefined ? " " + (typeof data === "string" ? data : JSON.stringify(data)) : ""}`);

  await appendFile(file, line, "utf-8");
}

export const log = {
  info(msg, data) {
    return writeLog("INFO", msg, data);
  },
  warn(msg, data) {
    return writeLog("WARN", msg, data);
  },
  error(msg, data) {
    return writeLog("ERROR", msg, data);
  },
  debug(msg, data) {
    return writeLog("DEBUG", msg, data);
  },
};