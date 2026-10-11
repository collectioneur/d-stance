import { test } from "@playwright/test";
import { openEditor } from "../helpers";
test("dbg", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(async () => {
    const { EXAMPLES } = await import("/src/scene/examples.ts");
    const root = await EXAMPLES.find((e) => e.id === "button")!.build();
    return JSON.stringify(root.items.map((i: any) => i.kind === "group" ? i.items.map((x: any) => [x.name, x.shapeType, x.position, x.rotation, x.params, !!x.image]) : [i.name]));
  });
  console.log("TREE", r);
});
