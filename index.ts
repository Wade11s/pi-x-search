import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createXSearchTool } from "./src/tool.ts";

export default function xSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool(createXSearchTool());
}
