import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  injectHooksServerTs,
  injectViteConfig,
  writeEnvFile,
} from "../src/init-helpers";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "searchsocket-init-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

describe("injectHooksServerTs", () => {
  it("creates src/hooks.server.ts in a fresh directory", async () => {
    const dir = await makeTempDir();
    const result = injectHooksServerTs(dir);

    expect(result).toBe("created");
    const content = fs.readFileSync(path.join(dir, "src", "hooks.server.ts"), "utf8");
    expect(content).toContain('import { searchsocketHandle } from "searchsocket/sveltekit"');
    expect(content).toContain("export const handle = searchsocketHandle()");
  });

  it("injects handle into existing file with no handle export", async () => {
    const dir = await makeTempDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "hooks.server.ts"),
      'import { env } from "$env/dynamic/private";\n\nexport const someOtherThing = 42;\n',
      "utf8",
    );

    const result = injectHooksServerTs(dir);

    expect(result).toBe("injected");
    const content = fs.readFileSync(path.join(dir, "src", "hooks.server.ts"), "utf8");
    expect(content).toContain("searchsocketHandle");
    expect(content).toContain("export");
  });

  it("composes with existing handle using sequence()", async () => {
    const dir = await makeTempDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "hooks.server.ts"),
      `import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  return resolve(event);
};
`,
      "utf8",
    );

    const result = injectHooksServerTs(dir);

    expect(result).toBe("composed");
    const content = fs.readFileSync(path.join(dir, "src", "hooks.server.ts"), "utf8");
    expect(content).toContain("@sveltejs/kit/hooks");
    // The app's handle must be the outer one. searchsocketHandle() answers its
    // endpoints without calling resolve(), so anything sequenced after it never
    // runs for a search request — see tests/hooks-composition.test.ts.
    expect(content).toMatch(
      /sequence\(\s*async \(\{ event, resolve \}\)[\s\S]*?,\s*searchsocketHandle\(\)\s*\)/,
    );
  });

  it("keeps a named existing handle first when composing", async () => {
    const dir = await makeTempDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "hooks.server.ts"),
      `import { sequence } from "@sveltejs/kit/hooks";
import { authHandle } from "$lib/server/auth";
import { loggingHandle } from "$lib/server/logging";

export const handle = sequence(authHandle, loggingHandle);
`,
      "utf8",
    );

    const result = injectHooksServerTs(dir);

    expect(result).toBe("composed");
    const content = fs.readFileSync(path.join(dir, "src", "hooks.server.ts"), "utf8");
    expect(content).toMatch(
      /sequence\(\s*sequence\(authHandle, loggingHandle\)\s*,\s*searchsocketHandle\(\)\s*\)/,
    );
  });

  it.each([
    ["a re-exported handle", 'export { handle } from "./auth";\n'],
    ["an aliased handle export", 'import { authHandle } from "./auth";\nexport { authHandle as handle };\n'],
    ["a star re-export", 'export * from "./auth";\n'],
  ])("returns 'fallback' for %s rather than shadowing it", async (_name, source) => {
    const dir = await makeTempDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "hooks.server.ts"), source, "utf8");

    // magicast cannot see these handles, so injecting our own would either
    // duplicate the export or silently shadow the app's middleware.
    const result = injectHooksServerTs(dir);

    expect(result).toBe("fallback");
    expect(fs.readFileSync(path.join(dir, "src", "hooks.server.ts"), "utf8")).toBe(source);
  });

  it("returns 'already-present' when searchsocketHandle is already imported", async () => {
    const dir = await makeTempDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "hooks.server.ts"),
      'import { searchsocketHandle } from "searchsocket/sveltekit";\n\nexport const handle = searchsocketHandle();\n',
      "utf8",
    );

    const result = injectHooksServerTs(dir);
    expect(result).toBe("already-present");
  });

  it("returns 'fallback' and leaves file unchanged on corrupt syntax", async () => {
    const dir = await makeTempDir();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    const corrupt = "export const handle = {{{{unparseable}}}};\n";
    fs.writeFileSync(path.join(dir, "src", "hooks.server.ts"), corrupt, "utf8");

    const result = injectHooksServerTs(dir);

    expect(result).toBe("fallback");
    const content = fs.readFileSync(path.join(dir, "src", "hooks.server.ts"), "utf8");
    expect(content).toBe(corrupt);
  });

  it("is idempotent — calling twice returns 'already-present' on second call", async () => {
    const dir = await makeTempDir();
    const first = injectHooksServerTs(dir);
    expect(first).toBe("created");

    const second = injectHooksServerTs(dir);
    expect(second).toBe("already-present");
  });
});

describe("injectViteConfig", () => {
  it("returns 'no-config' when no vite config exists", async () => {
    const dir = await makeTempDir();
    const result = injectViteConfig(dir);
    expect(result).toBe("no-config");
  });

  it("injects plugin into vite.config.ts with defineConfig wrapper", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(
      path.join(dir, "vite.config.ts"),
      `import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
});
`,
      "utf8",
    );

    const result = injectViteConfig(dir);

    expect(result).toBe("injected");
    const content = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
    expect(content).toContain("searchsocketVitePlugin");
    expect(content).toContain("sveltekit");
    expect(content).toContain('from "searchsocket/sveltekit"');
  });

  it("injects plugin into bare object export", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(
      path.join(dir, "vite.config.ts"),
      `import { sveltekit } from "@sveltejs/kit/vite";

export default {
  plugins: [sveltekit()],
};
`,
      "utf8",
    );

    const result = injectViteConfig(dir);

    expect(result).toBe("injected");
    const content = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
    expect(content).toContain("searchsocketVitePlugin");
  });

  it("creates plugins array when missing", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(
      path.join(dir, "vite.config.ts"),
      `import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3000 },
});
`,
      "utf8",
    );

    const result = injectViteConfig(dir);

    expect(result).toBe("injected");
    const content = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
    expect(content).toContain("searchsocketVitePlugin");
    expect(content).toContain("plugins");
  });

  it("returns 'already-present' when plugin already imported", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(
      path.join(dir, "vite.config.ts"),
      `import { sveltekit } from "@sveltejs/kit/vite";
import { searchsocketVitePlugin } from "searchsocket/sveltekit";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit(), searchsocketVitePlugin()],
});
`,
      "utf8",
    );

    const result = injectViteConfig(dir);
    expect(result).toBe("already-present");
  });

  it("prefers vite.config.ts over vite.config.js", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(
      path.join(dir, "vite.config.ts"),
      `import { defineConfig } from "vite";
export default defineConfig({ plugins: [] });
`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "vite.config.js"),
      `export default { plugins: [] };
`,
      "utf8",
    );

    injectViteConfig(dir);

    const tsContent = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
    const jsContent = fs.readFileSync(path.join(dir, "vite.config.js"), "utf8");
    expect(tsContent).toContain("searchsocketVitePlugin");
    expect(jsContent).not.toContain("searchsocketVitePlugin");
  });

  it("returns 'fallback' and leaves file unchanged on corrupt syntax", async () => {
    const dir = await makeTempDir();
    const corrupt = "export default {{{{ broken }}}};\n";
    fs.writeFileSync(path.join(dir, "vite.config.ts"), corrupt, "utf8");

    const result = injectViteConfig(dir);

    expect(result).toBe("fallback");
    const content = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");
    expect(content).toBe(corrupt);
  });

  it("is idempotent — second call returns 'already-present'", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(
      path.join(dir, "vite.config.ts"),
      `import { defineConfig } from "vite";
export default defineConfig({ plugins: [] });
`,
      "utf8",
    );

    const first = injectViteConfig(dir);
    expect(first).toBe("injected");

    const second = injectViteConfig(dir);
    expect(second).toBe("already-present");
  });
});

describe("writeEnvFile", () => {
  it("creates .env with credentials in a fresh directory", async () => {
    const dir = await makeTempDir();
    writeEnvFile(dir, "https://example.upstash.io", "token123");

    const content = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(content).toContain("UPSTASH_VECTOR_REST_URL=https://example.upstash.io");
    expect(content).toContain("UPSTASH_VECTOR_REST_TOKEN=token123");
  });

  it("appends to existing .env without duplicating", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(path.join(dir, ".env"), "OTHER_VAR=hello\n", "utf8");

    writeEnvFile(dir, "https://example.upstash.io", "token123");

    const content = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(content).toContain("OTHER_VAR=hello");
    expect(content).toContain("UPSTASH_VECTOR_REST_URL=https://example.upstash.io");
  });

  it("does not duplicate keys that already exist", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(
      path.join(dir, ".env"),
      "UPSTASH_VECTOR_REST_URL=existing\nUPSTASH_VECTOR_REST_TOKEN=existing\n",
      "utf8",
    );

    writeEnvFile(dir, "https://new.upstash.io", "newtoken");

    const content = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(content).toBe("UPSTASH_VECTOR_REST_URL=existing\nUPSTASH_VECTOR_REST_TOKEN=existing\n");
  });

  it("adds .env to .gitignore", async () => {
    const dir = await makeTempDir();
    writeEnvFile(dir, "https://example.upstash.io", "token123");

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".env");
  });

  it("does not duplicate .env in existing .gitignore", async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n.env\n", "utf8");

    writeEnvFile(dir, "https://example.upstash.io", "token123");

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    const envCount = gitignore.split("\n").filter((l) => l.trim() === ".env").length;
    expect(envCount).toBe(1);
  });
});
