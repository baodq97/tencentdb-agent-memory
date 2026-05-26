#!/usr/bin/env node
/**
 * Thin HTTP client for the memory-tencentdb Gateway sidecar.
 *
 * Mirrors the Python gateway_client.py — endpoint shapes stay in lockstep.
 * Includes a process-local circuit breaker to keep hook overhead bounded.
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_HOST = process.env.MEMORY_TENCENTDB_GATEWAY_HOST || "127.0.0.1";
const DEFAULT_PORT = parseInt(process.env.MEMORY_TENCENTDB_GATEWAY_PORT || "8420", 10);
const DEFAULT_BASE_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
const DEFAULT_TIMEOUT = 5000;

const BREAKER_PATH = path.join(os.homedir(), ".memory-tencentdb", "breaker.json");
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_SEC = 60;

function loadBreaker() {
  try { return JSON.parse(fs.readFileSync(BREAKER_PATH, "utf-8")); } catch { return { failures: 0, open_until: 0 }; }
}

function saveBreaker(state) {
  try {
    fs.mkdirSync(path.dirname(BREAKER_PATH), { recursive: true });
    fs.writeFileSync(BREAKER_PATH, JSON.stringify(state), "utf-8");
  } catch {}
}

function breakerOpen() {
  return (loadBreaker().open_until || 0) > Date.now() / 1000;
}

function recordSuccess() { saveBreaker({ failures: 0, open_until: 0 }); }

function recordFailure() {
  const s = loadBreaker();
  s.failures = (s.failures || 0) + 1;
  if (s.failures >= BREAKER_THRESHOLD) s.open_until = Date.now() / 1000 + BREAKER_COOLDOWN_SEC;
  saveBreaker(s);
}

function httpRequest(method, url, body, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      timeout: timeout || DEFAULT_TIMEOUT,
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

class GatewayClient {
  constructor(baseUrl, timeout) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = timeout || DEFAULT_TIMEOUT;
  }

  async _post(urlPath, body, timeout) {
    if (breakerOpen()) throw new Error("gateway circuit breaker open");
    try {
      const r = await httpRequest("POST", `${this.baseUrl}${urlPath}`, body, timeout || this.timeout);
      recordSuccess();
      return r;
    } catch (e) {
      recordFailure();
      throw e;
    }
  }

  async _get(urlPath, timeout) {
    if (breakerOpen()) throw new Error("gateway circuit breaker open");
    try {
      const r = await httpRequest("GET", `${this.baseUrl}${urlPath}`, null, timeout || this.timeout);
      recordSuccess();
      return r;
    } catch (e) {
      recordFailure();
      throw e;
    }
  }

  health(timeout) { return this._get("/health", timeout || 3000); }

  recall(query, sessionKey, userId = "") {
    const body = { query, session_key: sessionKey };
    if (userId) body.user_id = userId;
    return this._post("/recall", body);
  }

  capture(userContent, assistantContent, sessionKey, sessionId = "", userId = "") {
    const body = { user_content: userContent, assistant_content: assistantContent, session_key: sessionKey };
    if (sessionId) body.session_id = sessionId;
    if (userId) body.user_id = userId;
    return this._post("/capture", body);
  }

  searchMemories(query, limit = 5, typeFilter = "") {
    const body = { query, limit };
    if (typeFilter) body.type = typeFilter;
    return this._post("/search/memories", body);
  }

  searchConversations(query, limit = 5, sessionKey = "") {
    const body = { query, limit };
    if (sessionKey) body.session_key = sessionKey;
    return this._post("/search/conversations", body);
  }

  endSession(sessionKey, userId = "") {
    const body = { session_key: sessionKey };
    if (userId) body.user_id = userId;
    return this._post("/session/end", body);
  }
}

module.exports = { GatewayClient, breakerOpen, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_BASE_URL };
