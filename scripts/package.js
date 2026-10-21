import { packager } from "@electron/packager";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const paths = await packager({
  dir: root,
  name: "Obelisk",
  out: path.join(root, "dist"),
  icon: path.join(root, "desktop/assets/icon"),
  overwrite: true,
  asar: false,
  prune: true,
  ignore: [
    /^\/demo(?:\/|$)/,
    /^\/output(?:\/|$)/,
    /^\/dist(?:\/|$)/,
    /^\/\.git(?:\/|$)/,
    /^\/\.playwright-cli(?:\/|$)/,
    /^\/tests(?:\/|$)/,
  ],
  appBundleId: "org.obelisk.archive",
  appCategoryType: "public.app-category.productivity",
});
console.log(paths.join("\n"));
