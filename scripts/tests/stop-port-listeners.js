/* eslint-disable no-console */
const { spawnSync } = require("child_process");

function parsePorts(argv) {
  const values = argv
    .map((value) => Number.parseInt(String(value || "").trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Array.from(new Set(values));
}

function listWindowsPids(port) {
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  const lines = String(result.stdout || "").split(/\r?\n/);
  const suffix = `:${port}`;
  const pids = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("TCP")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddress = parts[1] || "";
    const state = (parts[3] || "").toUpperCase();
    const pid = Number.parseInt(parts[4] || "", 10);
    if (!localAddress.endsWith(suffix)) continue;
    if (state !== "LISTENING") continue;
    if (!Number.isFinite(pid) || pid <= 0) continue;
    pids.add(pid);
  }
  return Array.from(pids);
}

function listUnixPids(port) {
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function listPidsForPort(port) {
  return process.platform === "win32" ? listWindowsPids(port) : listUnixPids(port);
}

function stopPid(pid) {
  if (process.platform === "win32") {
    return spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], {
      encoding: "utf8",
      stdio: "ignore",
    });
  }
  return spawnSync("kill", ["-9", String(pid)], {
    encoding: "utf8",
    stdio: "ignore",
  });
}

function main() {
  const ports = parsePorts(process.argv.slice(2));
  if (ports.length === 0) return;

  const stopped = [];
  for (const port of ports) {
    const pids = listPidsForPort(port);
    for (const pid of pids) {
      stopPid(pid);
      stopped.push(`${port}:${pid}`);
    }
  }

  if (stopped.length > 0) {
    console.log(`[e2e] stopped listeners: ${stopped.join(", ")}`);
  }
}

main();
