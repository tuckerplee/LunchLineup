import QRCode from 'qrcode';

export const MFA_QR_LABEL = 'MFA setup QR code';
export const MFA_QR_HINT = 'In Google Authenticator: + \u2192 Scan a QR code, or Enter a setup key.';

const QUIET_ZONE_MODULES = 4;

/**
 * Builds the SVG path for an otpauth URL entirely in the browser. The secret
 * stays in this process: no network request, external QR service or CDN is used,
 * and inline SVG needs no img-src allowance.
 */
export function buildMfaQrSvg(otpauthUrl: string): { size: number; path: string } | null {
    if (!otpauthUrl.startsWith('otpauth://totp/')) return null;
    try {
        const { modules } = QRCode.create(otpauthUrl, { errorCorrectionLevel: 'M' });
        const count = modules.size;
        let path = '';
        for (let row = 0; row < count; row += 1) {
            for (let col = 0; col < count; col += 1) {
                if (modules.get(row, col)) path += `M${col + QUIET_ZONE_MODULES} ${row + QUIET_ZONE_MODULES}h1v1h-1z`;
            }
        }
        return { size: count + QUIET_ZONE_MODULES * 2, path };
    } catch {
        return null;
    }
}

export function MfaQrCode({ otpauthUrl, className }: { otpauthUrl: string | null | undefined; className?: string }) {
    const qr = otpauthUrl ? buildMfaQrSvg(otpauthUrl) : null;
    if (!qr) return null;
    return (
        <svg
            className={className}
            role="img"
            aria-label={MFA_QR_LABEL}
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            shapeRendering="crispEdges"
            style={{ width: '100%', maxWidth: 180, aspectRatio: '1', background: '#fff' }}
        >
            <title>{MFA_QR_LABEL}</title>
            <rect width={qr.size} height={qr.size} fill="#fff" />
            <path d={qr.path} fill="#000" />
        </svg>
    );
}
