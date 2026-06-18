// scripts/contrib_config.js
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT = {
  subjects: [],
  l4: { prevalence_threshold: 0.6 },
  ingest: { max_retries: 3, max_wait_per_retry_sec: 120 },
};

function configPath(dir) { return path.join(dir, "contributors", "subjects.json"); }

function loadConfig(dir) {
  const fp = configPath(dir);
  if (!fs.existsSync(fp)) return JSON.parse(JSON.stringify(DEFAULT));
  const cfg = JSON.parse(fs.readFileSync(fp, "utf8"));
  return { ...DEFAULT, ...cfg, l4: { ...DEFAULT.l4, ...cfg.l4 }, ingest: { ...DEFAULT.ingest, ...cfg.ingest } };
}

function addSubject(dir, { github_user, repo, since, max_prs }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo || "")) throw new Error("invalid repo (want owner/name)");
  const repoName = repo.split("/")[1];
  const id = `${github_user}@${repoName}`;
  const cfg = loadConfig(dir);
  if (cfg.subjects.some((s) => s.id === id)) throw new Error("duplicate subject");
  const subject = { id, github_user, repo, since: since || "2020-01-01", max_prs: max_prs || 100 };
  cfg.subjects.push(subject);
  const fp = configPath(dir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2));
  return subject;
}

module.exports = { loadConfig, addSubject, configPath };
