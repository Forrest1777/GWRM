import { spawn } from "node:child_process";

export async function terminateProcessTree(pid, config, logger, expectedFragment = "") {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    if (expectedFragment) {
      const commandLine = await getWindowsCommandLine(pid, config).catch(() => "");
      if (commandLine && !commandLine.toLowerCase().includes(expectedFragment.toLowerCase())) {
        await logger.warn("PID nao corresponde ao processo esperado; encerramento ignorado.", { pid });
        return;
      }
    }
    await runAndWait("taskkill.exe", ["/PID", String(pid), "/T", "/F"], config.service.shutdownTimeoutSeconds * 1000).catch(async (error) => {
      await logger.warn("Falha ao encerrar arvore de processos.", { pid, error: error.message });
    });
    return;
  }

  try { process.kill(pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { process.kill(pid, "SIGKILL"); } catch {}
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
      reject(new Error(`Timeout executando ${command}.`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(code);
      else reject(new Error(`${command} encerrou com codigo ${code}: ${stderr.trim()}`));
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
      reject(new Error(`Timeout executando ${command}.`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
