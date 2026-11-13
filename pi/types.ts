import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorFocus } from "./interaction.ts";
import type { DeliveryView, Owner } from "../core/contracts.ts";
import type { Store } from "../core/store.mjs";

export interface Runtime {
  id: string;
  stateDir: string;
  projectRoot: string;
  role: "coordinator" | "thread";
  coordinator: string;
  store: Store;
  sessionFile: string;
  transcriptObserved: boolean;
  terminal: string;
  space?: string;
  title: string;
  pendingTitle?: string;
  locks: { owner: Owner; release(): void }[];
  ctx: ExtensionContext;
  paused: boolean;
  promptOpen: number;
  lastInteraction: number;
  inFlight: boolean;
  wakeAt: number;
  recorded: Map<string, DeliveryView>;
  lastStatus?: string;
  lastError?: string;
  editor?: EditorFocus;
}
