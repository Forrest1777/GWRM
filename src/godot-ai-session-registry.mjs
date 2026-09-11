export const GODOT_AI_SESSION_CONFLICT = "GODOT_AI_SESSION_CONFLICT";
export const GODOT_AI_SESSION_MISS = "GODOT_AI_SESSION_MISS";
export const GODOT_AI_SESSION_NOT_USABLE = "GODOT_AI_SESSION_NOT_USABLE";

export const OBSERVED_STATES = Object.freeze([
  "runtime_stopped",
  "runtime_no_session",
  "session_ready",
  "session_invalid",
  "integration_error",
]);

const OBSERVED_STATE_SET = new Set(OBSERVED_STATES);
const USABLE_STATE = "session_ready";

function nowIso() {
  return new Date().toISOString();
}

function cloneRecord(record) {
  if (record == null) return null;
  return JSON.parse(JSON.stringify(record));
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function normalizeObservedState(value) {
  if (!OBSERVED_STATE_SET.has(value)) {
    throw new Error(`observed_state must be one of: ${OBSERVED_STATES.join(" | ")}.`);
  }
  return value;
}

function invalidObservedStateFromCode(code) {
  const text = typeof code === "string" ? code : "";
  if (text === "integration_error" || text.startsWith("INTEGRATION_")) {
    return "integration_error";
  }
  return "session_invalid";
}

function restoredObservedState(record) {
  if (typeof record?.session_id === "string" && record.session_id.trim() !== "") {
    return "session_invalid";
  }
  return "runtime_no_session";
}

function createConflictError(sessionId, ownerWorktree, requestedWorktree) {
  const error = new Error(
    `session_id '${sessionId}' already belongs to worktree '${ownerWorktree}' (requested '${requestedWorktree}').`,
  );
  error.code = GODOT_AI_SESSION_CONFLICT;
  return error;
}

/**
 * In-process owner of worktree -> runtime -> Godot AI session_id.
 * One instance holds many worktrees. No module-level mutable session pointer.
 */
export class GodotAiSessionRegistry {
  #byWorktree = new Map();
  #bySessionId = new Map();

  bind(input = {}) {
    const worktreeName = requireNonEmptyString(input.worktree_name, "worktree_name");
    const sessionId = requireNonEmptyString(input.session_id, "session_id");
    const observedState = normalizeObservedState(input.observed_state ?? USABLE_STATE);

    const owner = this.#bySessionId.get(sessionId);
    if (owner && owner !== worktreeName) {
      throw createConflictError(sessionId, owner, worktreeName);
    }

    const previous = this.#byWorktree.get(worktreeName) || null;
    if (previous?.session_id && previous.session_id !== sessionId) {
      this.#bySessionId.delete(previous.session_id);
    }

    const timestamp = nowIso();
    const generation = previous
      ? (previous.session_id === sessionId ? previous.generation : previous.generation + 1)
      : 1;

    const record = {
      worktree_name: worktreeName,
      runtime_pid: input.runtime_pid ?? null,
      session_id: sessionId,
      http_port: input.http_port ?? null,
      ws_port: input.ws_port ?? null,
      observed_state: observedState,
      last_error: null,
      attached_at: input.attached_at ?? previous?.attached_at ?? timestamp,
      updated_at: timestamp,
      generation,
    };

    this.#byWorktree.set(worktreeName, record);
    this.#bySessionId.set(sessionId, worktreeName);
    return cloneRecord(record);
  }

  getByWorktree(worktreeName) {
    if (typeof worktreeName !== "string" || worktreeName.trim() === "") return null;
    return cloneRecord(this.#byWorktree.get(worktreeName) ?? null);
  }

  getBySessionId(sessionId) {
    if (typeof sessionId !== "string" || sessionId.trim() === "") return null;
    const worktreeName = this.#bySessionId.get(sessionId);
    if (!worktreeName) return null;
    return this.getByWorktree(worktreeName);
  }

  markInvalid(worktreeName, details = {}) {
    const name = requireNonEmptyString(worktreeName, "worktree_name");
    const record = this.#byWorktree.get(name);
    if (!record) return null;

    record.observed_state = invalidObservedStateFromCode(details.code);
    record.last_error = {
      code: details.code ?? null,
      message: details.message ?? null,
    };
    record.updated_at = nowIso();
    return cloneRecord(record);
  }

  release(worktreeName) {
    if (typeof worktreeName !== "string" || worktreeName.trim() === "") return null;
    const record = this.#byWorktree.get(worktreeName);
    if (!record) return null;

    this.#byWorktree.delete(worktreeName);
    if (record.session_id) this.#bySessionId.delete(record.session_id);

    const released = cloneRecord(record);
    released.observed_state = "runtime_no_session";
    released.updated_at = nowIso();
    released.last_error = null;
    return released;
  }

  usable(worktreeName) {
    const record = this.#byWorktree.get(worktreeName);
    return Boolean(record && record.observed_state === USABLE_STATE && record.session_id);
  }

  resolveUsableSession(worktreeName) {
    if (typeof worktreeName !== "string" || worktreeName.trim() === "") {
      return {
        ok: false,
        code: GODOT_AI_SESSION_MISS,
        session_id: null,
        observed_state: null,
        message: "worktree_name is required.",
      };
    }

    const record = this.#byWorktree.get(worktreeName);
    if (!record) {
      return {
        ok: false,
        code: GODOT_AI_SESSION_MISS,
        session_id: null,
        observed_state: null,
        message: `No Godot AI session is registered for worktree '${worktreeName}'.`,
      };
    }

    if (record.observed_state !== USABLE_STATE || !record.session_id) {
      return {
        ok: false,
        code: GODOT_AI_SESSION_NOT_USABLE,
        session_id: null,
        observed_state: record.observed_state,
        message: `Godot AI session for worktree '${worktreeName}' is not usable (observed_state=${record.observed_state}).`,
      };
    }

    return {
      ok: true,
      code: null,
      session_id: record.session_id,
      observed_state: record.observed_state,
      message: null,
    };
  }

  snapshot() {
    const records = [...this.#byWorktree.values()]
      .map((record) => cloneRecord(record))
      .sort((a, b) => a.worktree_name.localeCompare(b.worktree_name));
    return {
      schema_version: 1,
      records,
    };
  }

  restore(snapshot) {
    this.#byWorktree.clear();
    this.#bySessionId.clear();

    const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
    const timestamp = nowIso();

    for (const raw of records) {
      if (!raw || typeof raw !== "object") continue;
      if (typeof raw.worktree_name !== "string" || raw.worktree_name.trim() === "") continue;

      const sessionId = typeof raw.session_id === "string" && raw.session_id.trim() !== ""
        ? raw.session_id
        : null;

      if (sessionId) {
        const owner = this.#bySessionId.get(sessionId);
        if (owner && owner !== raw.worktree_name) {
          // Skip conflicting restored rows rather than invent cross-worktree ownership.
          continue;
        }
      }

      const record = {
        worktree_name: raw.worktree_name,
        runtime_pid: raw.runtime_pid ?? null,
        session_id: sessionId,
        http_port: raw.http_port ?? null,
        ws_port: raw.ws_port ?? null,
        observed_state: restoredObservedState({ session_id: sessionId }),
        last_error: {
          code: "RESTORED_UNVERIFIED",
          message: "Restored session_id is not trusted until a reconciler revalidates it.",
        },
        attached_at: raw.attached_at ?? null,
        updated_at: timestamp,
        generation: Number.isInteger(raw.generation) && raw.generation > 0 ? raw.generation : 1,
      };

      this.#byWorktree.set(record.worktree_name, record);
      if (sessionId) this.#bySessionId.set(sessionId, record.worktree_name);
    }

    return this.snapshot();
  }
}
