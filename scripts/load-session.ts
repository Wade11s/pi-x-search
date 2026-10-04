import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/** Isolated loader: only this extension, no user/project extensions or other tools. */
export async function loadSearchSession(modelRuntime: ModelRuntime, agentDir: string, options: { codemode?: boolean } = {}) {
  const tools = options.codemode ? ["x_search", "codemode"] : ["x_search"];
  const settingsManager = SettingsManager.inMemory({ defaultTools: tools });
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(), agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
    extensionFactories: options.codemode ? [createCodemodeExtension()] : [],
  });
  await resourceLoader.reload();
  const errors = resourceLoader.getExtensions().errors;
  if (errors.length) throw new Error(`Extension failed to load: ${JSON.stringify(errors)}`);
  const { session } = await createAgentSession({
    modelRuntime, resourceLoader, settingsManager,
    sessionManager: SessionManager.inMemory(),
    tools,
    model: modelRuntime.getModel("xai", "grok-4.7"),
  });
  await session.bindExtensions({ mode: "print" });
  return session;
}
