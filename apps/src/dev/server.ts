/**
 * Dev server — Bun.serve + bun.build, zero extra packages.
 * Static contract (the "download must succeed" rule): every asset from this
 * origin, no third-party requests required to boot the shell.
 */
import { serve } from "bun";

const result = await Bun.build({
  entrypoints: ["./src/main.tsx"],
  target: "browser",
  sourcemap: "inline",
});

serve({
  port: 5173,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file("./src/index.html"), { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/main.js") {
      return new Response(result.outputs[0], { headers: { "content-type": "application/javascript" } });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log("psx-web dev server → http://localhost:5173");
