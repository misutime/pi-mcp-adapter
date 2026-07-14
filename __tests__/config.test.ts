import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function setHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

describe("config discovery", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    process.chdir(originalCwd);
  });

  it("loads Pi global config first, then Pi project overrides", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-config-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-config-project-"));
    setHome(home);
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      settings: { toolPrefix: "short", directTools: true },
      mcpServers: {
        shared: { command: "pi-global" },
        piOnly: { command: "pi-only" },
      },
    });

    writeJson(join(project, ".pi", "mcp.json"), {
      settings: { autoAuth: true },
      mcpServers: {
        shared: { command: "project-pi" },
        projectPiOnly: { command: "project-pi-only" },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.shared).toMatchObject({ command: "project-pi" });
    expect(config.mcpServers.piOnly).toMatchObject({ command: "pi-only" });
    expect(config.mcpServers.projectPiOnly).toMatchObject({ command: "project-pi-only" });
    expect(config.settings).toEqual({
      toolPrefix: "short",
      directTools: true,
      autoAuth: true,
    });
  });

  it("prefers modern Claude Code config detection over legacy paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-import-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-import-project-"));
    setHome(home);
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".claude", "mcp.json"), { mcpServers: { modern: { command: "modern" } } });
    writeJson(join(home, ".claude.json"), { mcpServers: { old: { command: "old" } } });
    writeJson(join(project, ".vscode", "mcp.json"), { mcpServers: { editor: { command: "code" } } });

    const { findAvailableImportConfigs } = await import("../config.ts");
    const imports = findAvailableImportConfigs();

    expect(imports).toEqual(
      expect.arrayContaining([
        { kind: "claude-code", path: join(home, ".claude", "mcp.json") },
        { kind: "vscode", path: resolve(realProject, ".vscode", "mcp.json") },
      ]),
    );
  });

  it("merges partial Pi overrides into imported server definitions", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-merge-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-merge-project-"));
    setHome(home);
    process.chdir(project);

    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        importedStdio: { command: "cursor-stdio", args: ["--from-cursor"], env: { TOKEN: "cursor-token" } },
        importedHttp: {
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer imported" },
          auth: "bearer",
        },
      },
    });

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      imports: ["cursor"],
      mcpServers: {
        importedStdio: { directTools: ["search"] },
        importedHttp: { directTools: true, auth: false },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.importedStdio).toEqual({
      command: "cursor-stdio",
      args: ["--from-cursor"],
      env: { TOKEN: "cursor-token" },
      directTools: ["search"],
    });
    expect(config.mcpServers.importedHttp).toEqual({
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer imported" },
      auth: false,
      directTools: true,
    });
  });

  it("tracks provenance for pi-global and pi-project configs", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-provenance-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-provenance-project-"));
    setHome(home);
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      imports: ["cursor"],
      mcpServers: {
        userServer: { command: "user" },
      },
    });

    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        importedServer: { command: "cursor" },
      },
    });

    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        projectPiServer: { command: "project-pi" },
      },
    });

    const { getServerProvenance, getPiGlobalConfigPath } = await import("../config.ts");
    const provenance = getServerProvenance();
    const piConfigPath = getPiGlobalConfigPath();

    expect(provenance.get("importedServer")).toEqual({
      path: piConfigPath,
      kind: "import",
      importKind: "cursor",
    });
    expect(provenance.get("userServer")).toEqual({
      path: piConfigPath,
      kind: "user",
      importKind: undefined,
    });
    expect(provenance.get("projectPiServer")).toEqual({
      path: resolve(realProject, ".pi", "mcp.json"),
      kind: "project",
      importKind: undefined,
    });
  });

  it("summarizes discovery and detects RepoPrompt suggestions", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-summary-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-summary-project-"));
    setHome(home);
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: {
        globalServer: { command: "global" },
      },
    });

    writeJson(join(project, "package.json"), { name: "fixture" });
    writeJson(join(home, "RepoPrompt", "repoprompt_cli"), "#!/bin/sh\n");
    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        importedServer: { command: "cursor" },
      },
    });

    const { getMcpDiscoverySummary } = await import("../config.ts");
    const summary = getMcpDiscoverySummary();

    expect(summary.sources.find((source) => source.id === "pi-global")?.serverCount).toBe(1);
    expect(summary.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "cursor", serverCount: 1 }),
      ]),
    );
    expect(summary.repoPrompt).toMatchObject({
      configured: false,
      executablePath: join(home, "RepoPrompt", "repoprompt_cli"),
      targetPath: resolve(realProject, ".pi", "mcp.json"),
      serverName: "repoprompt",
    });
  });

  it("writes direct tools configs to the correct Pi-owned files", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-write-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-write-project-"));
    setHome(home);
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: {
        globalServer: { command: "global" },
      },
    });

    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        projectServer: { command: "project" },
      },
    });

    const { getServerProvenance, loadMcpConfig, writeDirectToolsConfig, getPiGlobalConfigPath } = await import("../config.ts");
    const fullConfig = loadMcpConfig();
    const provenance = getServerProvenance();

    writeDirectToolsConfig(
      new Map([
        ["globalServer", true],
        ["projectServer", ["search"]],
      ]),
      provenance,
      fullConfig,
    );

    const userConfig = JSON.parse(readFileSync(getPiGlobalConfigPath(), "utf-8"));
    expect(userConfig.mcpServers.globalServer).toMatchObject({ command: "global", directTools: true });

    const projectConfig = JSON.parse(readFileSync(join(project, ".pi", "mcp.json"), "utf-8"));
    expect(projectConfig.mcpServers.projectServer).toMatchObject({ command: "project", directTools: ["search"] });
  });

  it("builds real diff previews for compatibility imports", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-preview-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-preview-project-"));
    setHome(home);
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      imports: ["cursor"],
      mcpServers: {
        existing: { command: "demo" },
      },
    });

    const { previewCompatibilityImports } = await import("../config.ts");

    const importsPreview = previewCompatibilityImports(["cursor", "codex"]);
    expect(importsPreview.path).toMatch(/\.pi[/\\]agent[/\\]mcp\.json$/);
    expect(importsPreview.changed).toBe(true);
    expect(importsPreview.diffText).toContain("+++ after");
    expect(importsPreview.diffText).toContain('+     "codex"');
  });

  it("writes selected compatibility imports to Pi config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-setup-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-setup-project-"));
    setHome(home);
    process.chdir(project);

    const { ensureCompatibilityImports, getPiGlobalConfigPath } = await import("../config.ts");
    const importResult = ensureCompatibilityImports(["cursor", "codex"]);
    expect(importResult.added).toEqual(["cursor", "codex"]);

    const piConfig = JSON.parse(readFileSync(getPiGlobalConfigPath(), "utf-8"));
    expect(piConfig.imports).toEqual(["cursor", "codex"]);
  });
});
