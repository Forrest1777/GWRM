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
        const message = "PID nao corresponde ao processo esperado; encerramento recusado.";
        await logger.warn(message, { pid, expected_fragment: expectedFragment });
        throw new Error(`${message} PID=${pid}.`);
      }
    }

    const result = await runAndCapture(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      config.service.shutdownTimeoutSeconds * 1000,
    ).catch((error) => ({ code: null, signal: null, stdout: "", stderr: error.message }));

    const exited = await waitForPidExit(
      pid,
      config.service.shutdownTimeoutSeconds * 1000,
    );

    if (!exited) {
      const detail = result.stderr?.trim() || result.stdout?.trim() || `codigo=${result.code}`;
      await logger.error("Processo permaneceu ativo apos taskkill.", { pid, detail });
      throw new Error(`Nao foi possivel encerrar a arvore do processo ${pid}: ${detail}`);
    }

    if (result.code !== 0 && result.code !== null) {
      await logger.warn("taskkill retornou codigo nao zero, mas o processo foi encerrado.", {
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

  const exited = await waitForPidExit(
    pid,
    config.service.shutdownTimeoutSeconds * 1000,
  );
  if (!exited) throw new Error(`Nao foi possivel encerrar o processo ${pid}.`);
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
