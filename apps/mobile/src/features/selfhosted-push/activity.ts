import type { AgentActivityProps } from "../../widgets/AgentActivity";
import type { LiveActivity } from "expo-widgets";

export const selfHostedActivity = {
  dismissEnded: (): void => {},
  getInstances: (): LiveActivity<AgentActivityProps>[] => [],
  start: (
    _props: AgentActivityProps,
    _url?: string,
    _staleDate?: Date,
  ): LiveActivity<AgentActivityProps> | null => null,
};
