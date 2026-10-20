declare module "pi-web-access/dist/index.js" {
  import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

  const extension: ExtensionFactory;
  export default extension;
}
