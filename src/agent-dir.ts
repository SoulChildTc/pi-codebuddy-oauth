import { homedir } from "os";
import { join } from "path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), CONFIG_DIR_NAME || ".pi", "agent");
}
