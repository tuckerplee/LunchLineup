export type OidcProviderEndpoints = Readonly<{
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
}>;

/** Provider endpoints are not necessarily beneath the issuer URL. */
export function resolveOidcProviderEndpoints(issuerUrl: string): OidcProviderEndpoints {
    const normalizedIssuer = new URL(issuerUrl).toString().replace(/\/$/, '');
    if (normalizedIssuer === 'https://accounts.google.com') {
        // https://developers.google.com/identity/openid-connect/openid-connect
        return {
            authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenEndpoint: 'https://oauth2.googleapis.com/token',
            userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
        };
    }

    // Preserve the existing custom-issuer behavior, including issuer paths.
    // This compatibility fallback is not generic discovery or provider qualification.
    return {
        authorizationEndpoint: new URL('o/oauth2/auth', issuerUrl.endsWith('/') ? issuerUrl : `${issuerUrl}/`).toString(),
        tokenEndpoint: `${normalizedIssuer}/o/oauth2/token`,
        userInfoEndpoint: `${normalizedIssuer}/o/oauth2/userinfo`,
    };
}
