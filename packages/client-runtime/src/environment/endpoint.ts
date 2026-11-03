export * from "@t3tools/shared/advertisedEndpoint";
import { relayEndpointPath } from "@t3tools/relay-transport/protocol";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(relayEndpointPath(httpBaseUrl, pathname));
  url.search = "";
  url.hash = "";
  return url.toString();
};
