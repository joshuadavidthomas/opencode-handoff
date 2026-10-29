import solid from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./index.ts", "./tui.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  packages: "external",
  plugins: [solid],
})
if (!result.success) throw new AggregateError(result.logs, "Build failed")
