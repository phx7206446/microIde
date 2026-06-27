import { randomUUID } from 'node:crypto';

export class SessionStore {
  #sessions = new Map();

  start(params = {}) {
    const session = {
      id: params.sessionId || randomUUID(),
      workspace: params.workspace || null,
      userDataDir: params.userDataDir || null,
      projectDataDir: params.projectDataDir || null,
      model: params.model || null,
      mode: params.mode || 'agent',
      autoApprove: Boolean(params.autoApprove),
      permissionMode: params.permissionMode || null,
      resume: Boolean(params.resume),
      // Optional per-session endpoint override for user-defined custom models.
      endpoint: params.endpoint || null,
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.#sessions.set(session.id, session);
    return session;
  }

  get(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  list() {
    return Array.from(this.#sessions.values());
  }

  updateStatus(sessionId, status) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    session.status = status;
    session.updatedAt = new Date().toISOString();
    return session;
  }

  updateModel(sessionId, model) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    session.model = model || null;
    session.updatedAt = new Date().toISOString();
    return session;
  }

  updateMode(sessionId, mode) {
    const session = this.get(sessionId);
    if (!session) {
      return null;
    }

    session.mode = mode || 'agent';
    session.updatedAt = new Date().toISOString();
    return session;
  }

  dispose(sessionId) {
    return this.#sessions.delete(sessionId);
  }
}
