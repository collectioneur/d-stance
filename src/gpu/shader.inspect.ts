import { createShader } from "./shader";
import { compileScene } from "./sceneCompiler";
import { kitchenSink } from "../test/fixtures";

/**
 * TypeGPU Runtime Inspector entry.
 * MCP (`inspect_typegpu` / module) and `npm run inspect:gpu` both hit this.
 * Construction stays inside `create` so attribution sees the real pipeline.
 * The scene SDF is generated per scene; a kitchen-sink scene (every shape,
 * op, nested transforms, an image layer) exercises the whole generator.
 */
export async function inspect({
  root,
}: {
  root: Parameters<typeof createShader>[0];
}) {
  return {
    kind: "render-pipeline" as const,
    create: () =>
      createShader(root).createScenePipeline(
        compileScene(kitchenSink(), { imageLayer: () => 0 }).code,
      ),
  };
}
