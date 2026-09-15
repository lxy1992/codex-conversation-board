import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_GLOBAL_STATE_PATH = resolve(homedir(), ".codex/.codex-global-state.json");

function normalizeRoot(path) {
  if (!path || typeof path !== "string") return null;
  const result = normalize(resolve(path));
  return result.endsWith(sep) && result !== sep ? result.slice(0, -1) : result;
}

function containsPath(root, cwd) {
  return cwd === root || cwd.startsWith(`${root}${sep}`);
}

function fallbackProject(cwd) {
  const normalized = normalizeRoot(cwd);
  if (!normalized || normalized === homedir()) {
    return { id: "unassigned", name: "未归属", rootPaths: [], source: "fallback" };
  }
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  return {
    id: `path-${digest}`,
    name: basename(normalized) || normalized,
    rootPaths: [normalized],
    source: "cwd",
  };
}

export class ProjectResolver {
  constructor({ statePath = DEFAULT_GLOBAL_STATE_PATH, logger = console } = {}) {
    this.statePath = statePath;
    this.logger = logger;
  }

  async loadState() {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") this.logger.error(`读取 Codex 项目配置失败: ${error.message}`);
      return {};
    }
  }

  async createSnapshot() {
    const state = await this.loadState();
    const projectsById = new Map();

    for (const [key, rawProject] of Object.entries(state["local-projects"] ?? {})) {
      const project = {
        id: rawProject.id ?? key,
        name: rawProject.name || basename(rawProject.rootPaths?.[0] ?? "") || "未命名项目",
        rootPaths: (rawProject.rootPaths ?? []).map(normalizeRoot).filter(Boolean),
        source: "codex",
      };
      projectsById.set(project.id, project);
    }

    const assignments = state["thread-project-assignments"] ?? {};
    const projectsByRoot = [...projectsById.values()]
      .flatMap((project) => project.rootPaths.map((root) => ({ root, project })))
      .sort((a, b) => b.root.length - a.root.length);

    return {
      resolveThread: (thread) => {
        const assignedProjectIds = [
          thread.projectId,
          assignments[thread.id]?.projectId,
          assignments[thread.id]?.id,
        ].filter(Boolean);
        for (const projectId of assignedProjectIds) {
          if (projectsById.has(projectId)) return projectsById.get(projectId);
        }

        const cwd = normalizeRoot(thread.cwd);
        if (cwd) {
          const matched = projectsByRoot.find(({ root }) => containsPath(root, cwd));
          if (matched) return matched.project;
        }

        return fallbackProject(thread.cwd);
      },
    };
  }
}

export const projectResolverInternals = { normalizeRoot, containsPath, fallbackProject };
