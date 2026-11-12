import { createLiveActivity } from "expo-widgets";
import { AgentActivity, type AgentActivityProps } from "../../widgets/AgentActivity";

export const selfHostedActivity = createLiveActivity<AgentActivityProps>(
  "SelfHostedAgentActivity",
  AgentActivity,
);
