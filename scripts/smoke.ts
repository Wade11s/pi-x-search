import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { OutputSchema } from "../src/result.ts";
import { loadSearchSession } from "./load-session.ts";

// Opt-in real API call: reuses Pi credentials and consumes xAI quota/credits.
const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
const session = await loadSearchSession(runtime, getAgentDir());
try {
  const tool = session.agent.state.tools.find((tool) => tool.name === "x_search");
  if (!tool) throw new Error("x_search was not registered/activated by Pi.");
  const result = await tool.execute("x-search-smoke", {
    query: process.argv.slice(2).join(" ") || "Find one recent post from @xai about Grok. Return its date and original X post URL, in at most 80 words.",
    allowed_x_handles: ["xai"],
  }, new AbortController().signal);
  if (!Value.Check(OutputSchema, result.structuredContent)) throw new Error("X Search returned invalid structured output.");
  console.log(JSON.stringify({ registered: tool.name, result: result.structuredContent, pi_usage: result.usage }, null, 2));
  if (!result.structuredContent.success) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "X Search smoke test failed.");
  process.exitCode = 1;
} finally {
  session.dispose();
}
