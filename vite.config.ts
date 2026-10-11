import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// One build for both halves: @cloudflare/vite-plugin bundles the Worker
// (wrangler.jsonc `main`) and the web app (index.html) together, and `vite dev`
// runs the Worker in workerd with the real D1 bindings (local) and HMR.
//
// Bundle split:
// the public entry (src/web/main.tsx) holds only the sign-in gate. The app is
// reached through one `lazy(() => import("./app/AuthedApp"))`, so it becomes an
// async chunk; every chunk containing src/web/app/ source is renamed to
// protected/*, which the Worker 404s without a session. No manualChunks: a
// forced named chunk becomes a load-time dependency and the sign-in page would
// fetch it eagerly and die on the 404.

const root = fileURLToPath(new URL(".", import.meta.url));
const PROTECTED = "/src/web/app/";

/**
 * Hash of everything that decides what the API answers (the Worker and the
 * shared types). Stored dashboard answers in KV are keyed by it
 * (src/worker/lib/cache.ts), so a deploy that changes only the web app keeps
 * them, and any server change starts clean.
 */
function serverHash(): string {
  const hash = createHash("sha256");
  for (const dir of ["src/worker", "src/shared"]) {
    const files = (readdirSync(join(root, dir), { recursive: true }) as string[]).filter((f) => statSync(join(root, dir, f)).isFile()).sort();
    for (const f of files) hash.update(`${dir}/${f}\0`).update(readFileSync(join(root, dir, f)));
  }
  return hash.digest("hex").slice(0, 16);
}

/** Fail the build if signed-in app source ever lands in a public file. */
function publicBundleGuard(): Plugin {
  return {
    name: "public-bundle-guard",
    applyToEnvironment: (env) => env.name === "client",
    generateBundle(_options, bundle) {
      for (const [file, out] of Object.entries(bundle)) {
        if (file.startsWith("protected/") || out.type !== "chunk") continue;
        const leaked = out.moduleIds.filter((id) => id.includes(PROTECTED));
        if (leaked.length) this.error(`${file} is public but contains ${leaked.join(", ")}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [cloudflare(), react(), tailwindcss(), publicBundleGuard()],
  define: { __SERVER_HASH__: JSON.stringify(serverHash()) },
  resolve: {
    alias: {
      "@/": `${root}src/web/`,
      "@shared/": `${root}src/shared/`,
    },
  },
  environments: {
    client: {
      build: {
        sourcemap: false, // readable source would hand over the protected code anyway
        // No <link rel="modulepreload">: the sign-in page must never touch /protected/*.
        modulePreload: false,
        chunkSizeWarningLimit: 900,
        rolldownOptions: {
          output: {
            chunkFileNames: (chunk) =>
              chunk.moduleIds.some((id) => id.includes(PROTECTED))
                ? "protected/[name]-[hash].js"
                : "assets/[name]-[hash].js",
          },
        },
      },
    },
  },
  server: {
    // 127.0.0.1:8787 is the local redirect URI registered on the Spotify app.
    host: "127.0.0.1",
    port: 8787,
    strictPort: true,
  },
  preview: { host: "127.0.0.1", port: 8787, strictPort: true },
});
