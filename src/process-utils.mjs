import { spawn } from "node:child_process";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForPidExit(pid, timeoutMs = 10000) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

export async function terminateProcessTree(pid, config, logger, expectedFragment = "") {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (!isPidAlive(pid)) return true;

  if (process.platform === "win32") {
    if (expectedFragment) {
      const commandLine = await getWindowsCommandLine(pid, config).catch(() => "");
      if (commandLine && !commandLine.toLowerCase().includes(expectedFragment.toLowerCase())) {
        const message = "PID does not match the expected process; termination refused.";
        await logger.warn(message, { pid, expected_fragment: expectedFragment });
        throw new Error(`${message} PID=${pid}.`);
      }
    }

    const result = await runAndCapture(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      config.service.shutdownTimeoutSeconds * 1000,
    ).catch((error) => ({ code: null, signal: null, stdout: "", stderr: error.message }));

    const exited = await waitForPidExit(pid, config.service.shutdownTimeoutSeconds * 1000);
    if (!exited) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || `code=${result.code}`;
      await logger.error("Process remained active after taskkill.", { pid, detail });
      throw new Error(`Unable to terminate process tree ${pid}: ${detail}`);
    }

    if (result.code !== 0 && result.code !== null) {
      await logger.warn("taskkill returned a non-zero code, but the process exited.", {
        pid,
        code: result.code,
        stderr: result.stderr?.trim(),
      });
    }
    return true;
  }

  try { process.kill(pid, "SIGTERM"); } catch {}
  if (await waitForPidExit(pid, 500)) return true;
  try { process.kill(pid, "SIGKILL"); } catch {}
  const exited = await waitForPidExit(pid, config.service.shutdownTimeoutSeconds * 1000);
  if (!exited) throw new Error(`Unable to terminate process ${pid}.`);
  return true;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function getWindowsCommandLine(pid, config) {
  if (process.platform !== "win32") return "";
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"; if($p){[Console]::Out.Write($p.CommandLine)}`;
  const result = await runAndCapture(config.paths.powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", script], 10000);
  return result.stdout.trim();
}

export function runAndWait(command, args, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`Timed out executing ${command}.`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(code);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export function runAndCapture(command, args, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`Timed out executing ${command}.`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''");
}

export function buildWindowsProcessPathProbeScript(pathFragment, processNames = []) {
  const needle = escapePowerShellSingleQuoted(pathFragment);
  const normalizedNames = processNames
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim().toLowerCase());
  const namesJson = escapePowerShellSingleQuoted(JSON.stringify(normalizedNames));

  // Keep the whole predicate in one PowerShell statement. Splitting it with
  // semicolons can produce invalid tokens such as "-and;" on Windows PowerShell 5.1.
  const predicate = [
    `($_.ProcessId -ne $PID)`,
    `($null -ne $_.CommandLine)`,
    `($_.CommandLine.IndexOf($needle,[System.StringComparison]::OrdinalIgnoreCase) -ge 0)`,
    `(($allowed.Count -eq 0) -or ($allowed -contains $_.Name.ToLowerInvariant()))`,
  ].join(" -and ");

  return [
    `$needle='${needle}'`,
    `$allowed=ConvertFrom-Json '${namesJson}'`,
    `$items=Get-CimInstance Win32_Process | Where-Object { ${predicate} } | Select-Object ProcessId,Name,CommandLine`,
    `if($items){$items | ConvertTo-Json -Compress}else{'[]'}`,
  ].join("; ");
}

export async function listWindowsProcessesReferencingPath(pathFragment, config, processNames = []) {
  if (process.platform !== "win32" || !pathFragment) return [];
  const script = buildWindowsProcessPathProbeScript(pathFragment, processNames);
  const result = await runAndCapture(
    config.paths.powershellExecutable,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    15000,
  );
  if (result.code !== 0) {
    throw new Error(`Failed to query residual processes: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const parsed = JSON.parse(result.stdout.trim() || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    name: String(row.Name || ""),
    command_line: String(row.CommandLine || ""),
  })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

export async function terminateWindowsProcessesReferencingPath(pathFragment, config, logger, processNames = []) {
  if (process.platform !== "win32") return { terminated: [], residual: [] };
  const found = await listWindowsProcessesReferencingPath(pathFragment, config, processNames);
  const terminated = [];
  for (const processInfo of found) {
    if (!isPidAlive(processInfo.pid)) continue;
    await logger.warn("Residual process associated with the worktree will be terminated.", {
      pid: processInfo.pid,
      name: processInfo.name,
      path: pathFragment,
    });
    await terminateProcessTree(processInfo.pid, config, logger);
    terminated.push(processInfo.pid);
  }
  const residual = await listWindowsProcessesReferencingPath(pathFragment, config, processNames);
  return { terminated, residual };
}
