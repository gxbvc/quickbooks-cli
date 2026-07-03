// Minimal ambient types for the official `intuit-oauth` package (ships without types).
// We only use it for the OAuth2 token dance; API calls are plain fetch.
declare module "intuit-oauth" {
  export interface IntuitTokenJson {
    access_token: string;
    refresh_token: string;
    token_type?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    realmId?: string;
    id_token?: string;
    createdAt?: number;
  }

  export interface IntuitAuthResponse {
    getJson?(): IntuitTokenJson;
    json?: IntuitTokenJson;
    getToken?(): IntuitTokenJson;
    token?: IntuitTokenJson;
  }

  export default class OAuthClient {
    constructor(config: {
      clientId: string;
      clientSecret: string;
      environment: "sandbox" | "production";
      redirectUri: string;
      logging?: boolean;
    });
    static scopes: {
      Accounting: string;
      OpenId: string;
      Payment: string;
      Payroll: string;
      TimeTracking: string;
      Benefits: string;
      Profile: string;
      Email: string;
      Phone: string;
      Address: string;
    };
    authorizeUri(options: { scope: string[] | string; state?: string }): string;
    createToken(uri: string): Promise<IntuitAuthResponse>;
    refreshUsingToken(refreshToken: string): Promise<IntuitAuthResponse>;
    setToken(token: Partial<IntuitTokenJson>): void;
    getToken(): IntuitTokenJson;
  }
}
