import { normalizeGitlabBaseUrl } from "../config";

export function gitlabSsoMatchesInstance(
  baseUrl: string,
  endpoints: { userInfoUrl?: string; discoveryUrl?: string } = {
    userInfoUrl: process.env.CUSTOM_OAUTH_USER_INFO_URL,
    discoveryUrl: process.env.CUSTOM_OAUTH_DISCOVERY_URL,
  },
): boolean {
  const identityUrl = endpoints.discoveryUrl || endpoints.userInfoUrl;
  if (!identityUrl) return false;
  try {
    const base = normalizeGitlabBaseUrl(baseUrl);
    const endpoint = new URL(identityUrl);
    return (
      !endpoint.username &&
      !endpoint.password &&
      `${endpoint.origin}${endpoint.pathname}`.startsWith(`${base}/`)
    );
  } catch {
    return false;
  }
}
