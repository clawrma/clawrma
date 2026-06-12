import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

import { createClawrmaWebSearchProvider } from "./openclaw-web-search-provider.js";

const clawrmaPlugin: OpenClawPluginDefinition = definePluginEntry({
  id: "clawrma",
  name: "Clawrma Plugin",
  description: "Clawrma managed web search provider",
  register(api) {
    api.registerWebSearchProvider(createClawrmaWebSearchProvider());
  },
});

export default clawrmaPlugin;
