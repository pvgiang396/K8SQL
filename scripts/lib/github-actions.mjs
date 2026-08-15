import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = process.env.GITHUB_REPOSITORY || "pvgiang396/K8SQL";
const WORKFLOW = "build.yml";

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();
}

export function dispatchGithubBuild({ projectRoot, targets }) {
  if (!targets.length) return;
  console.log(`[github-actions] Dispatch ${REPO} targets=${targets.join(",")}`);
  try {
    gh(["workflow", "run", WORKFLOW, "--repo", REPO, "--ref", currentBranch(projectRoot), "-f", `targets=${targets.join(",")}`]);
  } catch (error) {
    throw new Error(`Không dispatch được GitHub Actions. Kiểm tra gh auth/network: ${error.message}`);
  }

  let runId = "";
  for (let attempt = 0; attempt < 12 && !runId; attempt += 1) {
    try {
      runId = gh(["run", "list", "--workflow", WORKFLOW, "--repo", REPO, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"]);
    } catch {
      // Workflow dispatch propagation can take a few seconds.
    }
    if (!runId) sleep(5000);
  }
  if (!runId) throw new Error("Không tìm thấy GitHub Actions run sau khi dispatch.");

  console.log(`[github-actions] Theo dõi run ${runId}...`);
  gh(["run", "watch", runId, "--repo", REPO, "--exit-status"], { inherit: true });

  const artifactDir = path.join(projectRoot, "dist", "github-actions", runId);
  fs.mkdirSync(artifactDir, { recursive: true });
  gh(["run", "download", runId, "--repo", REPO, "--dir", artifactDir], { inherit: true });
  console.log(`[github-actions] Artifact đã tải vào ${artifactDir}`);
  return { distDir: artifactDir, files: [] };
}

function currentBranch(projectRoot) {
  try {
    return execFileSync("git", ["-C", projectRoot, "branch", "--show-current"], { encoding: "utf8" }).trim() || "main";
  } catch {
    return "main";
  }
}

function sleep(milliseconds) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {}
}
