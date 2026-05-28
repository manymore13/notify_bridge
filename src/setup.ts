import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface SetupOptions {
  global: boolean;
}

export async function runSetup(opts: SetupOptions) {
  if (opts.global) {
    setupGlobal();
  } else {
    setupProject();
  }
}

function addEntry(configPath: string, entry: any) {
  const dir = join(configPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let config: any = {};
  let existingKeys: string[] = [];

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
      existingKeys = Object.keys(config);
    } catch {
      console.error(`错误: ${configPath} 不是合法的 JSON，请手动修复后再试`);
      process.exit(1);
    }
  }

  const isNew = !existsSync(configPath);

  // Preserve ALL existing content, only add/update mcpServers.notify-bridge
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const existed = "notify-bridge" in config.mcpServers;
  config.mcpServers["notify-bridge"] = entry;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const fileName = configPath.split(/[/\\]/).slice(-2).join("/");

  if (isNew) {
    console.log(`✅ 创建 ${fileName}`);
  } else if (existed) {
    console.log(`✅ 更新 ${fileName} (notify-bridge 配置已刷新)`);
  } else {
    console.log(`✅ 追加 notify-bridge 到 ${fileName} (保留已有 ${existingKeys.length} 个顶层键)`);
  }
}

function setupProject() {
  const projectRoot = process.cwd();
  const configPath = join(projectRoot, ".claude", "mcp.json");

  console.log(`项目级配置: ${projectRoot}`);
  console.log(`文件: .claude/mcp.json`);

  addEntry(configPath, {
    command: "notify-bridge",
    args: [],
    cwd: projectRoot,
  });
}

function setupGlobal() {
  const configPath = join(homedir(), ".claude", "settings.json");

  console.log(`全局配置 (所有项目生效)`);
  console.log(`文件: ~/.claude/settings.json`);

  addEntry(configPath, {
    command: "notify-bridge",
    args: [],
  });
}
